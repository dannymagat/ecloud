/**
 * Internal captive-portal endpoints (`/internal/portal/*`, X-Internal-Token; API_ARCHITECTURE.md
 * "Internal" table). The portal process holds no DB credentials and no UAM secret: it forwards
 * the raw UAM query here, and this module runs the L2 VendorAdapter contract
 * (MULTI_VENDOR_INTEGRATION_PLAN.md §6.2) — `parseRedirect` → `validateContext` (md signature,
 * NAS lookup, tenant, replay store, private uamip) → identity broker → single-use portal
 * credential → `authorizeSession` (browser-form 302 to `uamip:uamport/logon`, PAP-encoded).
 *
 *   POST /internal/portal/redirects            UAM entry and `res=` callbacks (one generic error)
 *   GET  /internal/portal/flows/:id            page data: methods, theme, terms, notices
 *   POST /internal/portal/flows/:id/identify   password | voucher | click_through → hand-off URL
 *   GET  /internal/portal/flows/:id/status     session status for the status page
 *   POST /internal/portal/flows/:id/logout     NAS logoff URL
 *
 * Branding bytes for the portal's `/a/{assetId}` come from `/internal/portal-assets/:assetId`
 * (portal administration, P6-B).
 *
 * `resolve-nas` of the API_ARCHITECTURE table is folded into `redirects`: resolving a NAS
 * without validating the signed redirect in the same step would hand the portal an unverified
 * tenant. Every validation failure (unknown NAS, bad signature, tenant mismatch, replay,
 * malformed) answers the same `{kind:"error"}`; the reason goes to the log only.
 */
import {
  getVendorAdapter,
  isPrivateIpv4,
  safeUserUrl,
  splitUamQuery,
  type HotspotContext,
  type NasLookup,
  type RegisteredNas,
} from '@ecloud/adapters';
import { withPlatform, withTenant, type DbTransaction } from '@ecloud/db';
import { isUuid, newId } from '@ecloud/shared';
import express, { type Request, type Response, type Router } from 'express';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { Envelope, openSecretRef, sealSecretRef, sha256Hex } from '../crypto.js';
import {
  IdentityRejected,
  checkSubscriberLoginPassword,
  confirmSubscriberLogin,
  findSubscriberByUsername,
  verifyVoucherCode,
  type PasswordCheck,
} from './portal-identity.js';
import {
  CREDENTIAL_TTL_S,
  FLOW_TTL_S,
  findIndexedFlow,
  indexFlow,
  isReplayed,
  loadFlow,
  newCredentialPair,
  replayKey,
  revokeCredential,
  saveFlow,
  storeCredential,
  type BrokerIdentity,
  type PortalFlow,
  type PortalMethod,
} from './portal-store.js';

/** UAM secrets are per-NAS shared secrets sealed like RADIUS secrets (SECURITY §5.2). */
// HKDF purpose label, not a secret. check-no-secrets: allow
export const UAM_SECRET_PURPOSE = 'ecloud:nas:secret:v1'; // check-no-secrets: allow

/** `captive_portals.uam_secret_ref` value for a UAM secret (`enc:v1…`, data key). */
export function sealUamSecret(dataEncryptionKey: string, secret: string): string {
  return sealSecretRef(new Envelope(dataEncryptionKey, UAM_SECRET_PURPOSE), secret);
}

const PORTAL_ACCESS = Object.freeze({ reason: 'portal', audit: false });

/** Path-based adapter selection (`/uam/uspot/`, `/uam/chilli/`; API_ARCHITECTURE portal table). */
export const UAM_FLAVOURS = Object.freeze({
  uspot: {
    adapterKeys: ['openwifi-uspot-uam', 'uspot-upstream-uam'],
    portalType: 'uspot',
    path: '/uam/uspot/',
  },
  chilli: { adapterKeys: ['coovachilli-uam'], portalType: 'coovachilli', path: '/uam/chilli/' },
} as const);
export type UamFlavour = keyof typeof UAM_FLAVOURS;

/** Methods the pilot portal implements (Q64: no social IdP providers; MAC-auth has no page). */
export const PORTAL_METHODS: readonly PortalMethod[] = ['password', 'voucher', 'click_through'];

/**
 * Abuse limits (SECURITY_ARCHITECTURE.md §5.4-§5.5, API_ARCHITECTURE portal CSRF/rate-limit
 * note). Failures per NAS + client MAC lock the method for `lockS`; failures per (site,
 * lower(username)) lock that account at the portal however often the attacker rotates MAC/IP;
 * voucher failures per site lock voucher entry for the whole site (enumeration cap); per-IP and
 * per-site counters cap attempts of any outcome; flows per NAS and redirects per IP cap flow
 * creation. Every lock answers the same generic 429.
 */
export const PORTAL_LIMITS = Object.freeze({
  failures: {
    password: { max: 5, windowS: 300, lockS: 900 },
    voucher: { max: 10, windowS: 3600, lockS: 3600 },
    click_through: { max: 20, windowS: 300, lockS: 300 },
  } satisfies Record<PortalMethod, { max: number; windowS: number; lockS: number }>,
  accountFailures: { max: 10, windowS: 900, lockS: 900 },
  voucherFailuresPerSite: { max: 100, windowS: 3600, lockS: 900 },
  attemptsPerIp: { max: 60, windowS: 600 },
  attemptsPerSite: { max: 2000, windowS: 600 },
  redirectsPerIp: { max: 60, windowS: 60 },
  flowsPerNas: { max: 300, windowS: 3600 },
});

class RateLimited extends Error {
  constructor(readonly retryAfter: number) {
    super('rate limited');
  }
}

interface ResolvedPortal {
  readonly nas: RegisteredNas;
  readonly captivePortalId: string;
}

interface PortalRow {
  id: string;
  name: string;
  site_id: string;
  auth_methods: string[];
  theme_id: string | null;
  terms_version: string | null;
  redirect_url: string | null;
  uam_secret_ref: string | null;
  adapter_config: Record<string, unknown>;
  status: string;
}

function clientIpOf(value: unknown): string | null {
  return typeof value === 'string' && isIP(value) !== 0 ? value : null;
}

function uamServerUrl(deps: AppDeps, flavour: UamFlavour, config: Record<string, unknown>) {
  const configured = config.uam_server_url;
  if (typeof configured === 'string' && /^https?:\/\/[^?#\s]+$/.test(configured)) return configured;
  return `${deps.config.base.origins.portal.replace(/\/+$/, '')}${UAM_FLAVOURS[flavour].path}`;
}

/** The captive portal serving a NAS: pinned by `adapter_config.nas_client_id`, else the only one. */
function pickPortal(rows: PortalRow[], nasId: string): PortalRow | null {
  const pinned = rows.filter((r) => r.adapter_config.nas_client_id === nasId);
  if (pinned.length === 1) return pinned[0] ?? null;
  if (pinned.length > 1) return null;
  const unpinned = rows.filter((r) => typeof r.adapter_config.nas_client_id !== 'string');
  return unpinned.length === 1 ? (unpinned[0] ?? null) : null;
}

function openUamSecret(deps: AppDeps, ref: string | null): string | null {
  if (ref === null || ref === '') return null;
  try {
    return openSecretRef(new Envelope(deps.config.dataEncryptionKey, UAM_SECRET_PURPOSE), ref);
  } catch {
    return null;
  }
}

/**
 * NAS by `nasid` (= the ECLOUD-assigned NAS identifier, CP §7.3). NAS identifiers are not unique
 * across tenants (`idx_nas_clients_identifier`), so anything but exactly one active row fails
 * closed. `called` is not used as a fallback: no NAS column stores the AP MAC.
 */
async function resolvePortal(
  deps: AppDeps,
  flavour: UamFlavour,
  nasid: string | undefined,
): Promise<ResolvedPortal | null> {
  if (nasid === undefined || nasid === '' || nasid.length > 253) return null;
  return withPlatform(deps.dbPlatform, PORTAL_ACCESS, async (trx) => {
    const rows = await trx
      .selectFrom('nas_clients as n')
      .innerJoin('sites as s', 's.id', 'n.site_id')
      .innerJoin('organizations as o', 'o.id', 'n.organization_id')
      .select([
        'n.id',
        'n.organization_id',
        'n.site_id',
        'n.nas_identifier',
        'n.adapter_key',
        'n.deployment_mode',
        'n.controller_id',
      ])
      .where('n.nas_identifier', '=', nasid)
      .where('n.status', '=', 'active')
      .where('n.deleted_at', 'is', null)
      .where('s.deleted_at', 'is', null)
      .where('s.status', '=', 'active')
      .where('o.status', '=', 'active')
      .execute();
    if (rows.length !== 1 || rows[0] === undefined) return null;
    const n = rows[0];
    if (!(UAM_FLAVOURS[flavour].adapterKeys as readonly string[]).includes(n.adapter_key ?? '')) {
      return null;
    }
    const portals = (await trx
      .selectFrom('captive_portals')
      .select([
        'id',
        'name',
        'site_id',
        'auth_methods',
        'theme_id',
        'terms_version',
        'redirect_url',
        'uam_secret_ref',
        'adapter_config',
        'status',
      ])
      .where('site_id', '=', n.site_id)
      .where('organization_id', '=', n.organization_id)
      .where('status', '=', 'active')
      .where('portal_type', '=', UAM_FLAVOURS[flavour].portalType)
      .execute()) as PortalRow[];
    const portal = pickPortal(portals, n.id);
    if (portal === null) return null;
    const deploymentMode = n.deployment_mode;
    return {
      captivePortalId: portal.id,
      nas: {
        id: n.id,
        organizationId: n.organization_id,
        siteId: n.site_id,
        identifier: n.nas_identifier,
        adapterKey: n.adapter_key,
        controllerId: n.controller_id,
        deploymentMode,
        uamServerUrl: uamServerUrl(deps, flavour, portal.adapter_config),
        uamSecret: openUamSecret(deps, portal.uam_secret_ref),
      },
    };
  });
}

async function loadPortalRow(trx: DbTransaction, id: string): Promise<PortalRow | undefined> {
  return await trx
    .selectFrom('captive_portals')
    .select([
      'id',
      'name',
      'site_id',
      'auth_methods',
      'theme_id',
      'terms_version',
      'redirect_url',
      'uam_secret_ref',
      'adapter_config',
      'status',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
}

function enabledMethods(portal: PortalRow): PortalMethod[] {
  return PORTAL_METHODS.filter((m) => portal.auth_methods.includes(m));
}

async function counter(deps: AppDeps, key: string, max: number, windowS: number): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  const n = await deps.kv.incr(key, windowS);
  if (n > max) throw new RateLimited((await deps.kv.ttl(key)) || windowS);
}

const lockKey = (m: PortalMethod, nasId: string, mac: string) => `pf:lock:${m}:${nasId}:${mac}`;
const failKey = (m: PortalMethod, nasId: string, mac: string) => `pf:fail:${m}:${nasId}:${mac}`;

/** Per-account key: (site, lower(username)), hashed so no username lands in Redis. */
const accountKey = (siteId: string, username: string) =>
  `${siteId}:${sha256Hex(username.toLowerCase())}`;

interface FailureCounter {
  readonly fail: string;
  readonly lock: string;
  readonly limit: { readonly max: number; readonly windowS: number; readonly lockS: number };
}

/** The failure counters an identify attempt with `input` is subject to. */
function failureCounters(flow: PortalFlow, input: { method: PortalMethod; username?: string }) {
  const m = input.method;
  const counters: FailureCounter[] = [
    {
      fail: failKey(m, flow.nasId, flow.clientMac),
      lock: lockKey(m, flow.nasId, flow.clientMac),
      limit: PORTAL_LIMITS.failures[m],
    },
  ];
  if (m === 'password' && input.username !== undefined) {
    const k = accountKey(flow.siteId, input.username);
    counters.push({
      fail: `pf:fail:acct:${k}`,
      lock: `pf:lock:acct:${k}`,
      limit: PORTAL_LIMITS.accountFailures,
    });
  }
  if (m === 'voucher') {
    counters.push({
      fail: `pf:fail:voucher-site:${flow.siteId}`,
      lock: `pf:lock:voucher-site:${flow.siteId}`,
      limit: PORTAL_LIMITS.voucherFailuresPerSite,
    });
  }
  return counters;
}

async function assertNotLocked(deps: AppDeps, counters: readonly FailureCounter[]): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  for (const c of counters) {
    const ttl = await deps.kv.ttl(c.lock);
    if (ttl > 0) throw new RateLimited(ttl);
  }
}

/**
 * Counts one failure against every counter; returns true when it activated a lock (recorded as
 * `portal_login_attempts.triggered_lockout`, migration 026, so lockouts are reportable).
 */
async function recordFailure(deps: AppDeps, counters: readonly FailureCounter[]): Promise<boolean> {
  if (deps.config.rateLimitDisabled) return false;
  let locked = false;
  for (const c of counters) {
    const n = await deps.kv.incr(c.fail, c.limit.windowS);
    if (n >= c.limit.max) {
      await deps.kv.set(c.lock, '1', c.limit.lockS);
      await deps.kv.del(c.fail);
      locked = true;
    }
  }
  return locked;
}

/** Success clears the per-device and per-account counters (never the site-wide voucher cap). */
async function clearFailures(deps: AppDeps, counters: readonly FailureCounter[]): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  for (const c of counters) {
    if (!c.fail.startsWith('pf:fail:voucher-site:')) await deps.kv.del(c.fail);
  }
}

/** Was the last session of this device on this NAS ended by a timeout? (expired notice) */
async function previousSessionExpired(
  deps: AppDeps,
  nas: RegisteredNas,
  mac: string,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const last = await withTenant(deps.db, nas.organizationId, (trx) =>
    trx
      .selectFrom('sessions')
      .select(['terminate_cause', 'stopped_at'])
      .where('nas_client_id', '=', nas.id)
      .where('mac', '=', mac)
      .where('started_at', '>=', since)
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
  );
  const cause = (last?.terminate_cause ?? '').toLowerCase().replace(/[^a-z]+/g, '_');
  return (
    last !== undefined &&
    last.stopped_at !== null &&
    (cause === 'session_timeout' || cause === 'idle_timeout')
  );
}

function contextOf(flow: PortalFlow, now: Date): HotspotContext {
  return {
    organizationId: flow.organizationId,
    siteId: flow.siteId,
    vendorKey: flow.vendorKey,
    controllerId: flow.controllerId,
    nas: { id: flow.nasId, identifier: flow.nasIdentifier, adapterKey: flow.adapterKey },
    apMac: flow.apMac,
    clientMac: flow.clientMac,
    ssid: flow.ssid,
    clientIp: flow.clientIp,
    nasSessionId: flow.sessionId,
    policyRef: null,
    deploymentMode: flow.deploymentMode,
    vendorOpaque: { raw: '', fields: flow.fields },
    receivedAt: now,
  };
}

/** `http://uamip:uamport` of the flow, only for a private uamip and a numeric port. */
function nasBase(flow: PortalFlow): string | null {
  const ip = flow.fields.uamip ?? '';
  const port = flow.fields.uamport ?? '';
  if (!isPrivateIpv4(ip) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return null;
  }
  return `http://${ip}:${port}`;
}

const RedirectBody = z.object({
  flavour: z.enum(['uspot', 'chilli']),
  raw_query: z.string().max(8192),
  client_ip: z.string().max(64).optional(),
});

const IdentifyBody = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('password'),
    username: z.string().min(1).max(253),
    password: z.string().min(1).max(256),
    client_ip: z.string().max(64).optional(),
  }),
  z.object({
    method: z.literal('voucher'),
    code: z.string().min(1).max(64),
    client_ip: z.string().max(64).optional(),
  }),
  z.object({
    method: z.literal('click_through'),
    accept_terms: z.literal(true),
    client_ip: z.string().max(64).optional(),
  }),
]);

function unavailable(res: Response): void {
  res.status(503).json({ result: 'unavailable' });
}

export function portalInternalRouter(deps: AppDeps): Router {
  const now = deps.now ?? (() => new Date());
  const router = express.Router();

  // ------------------------------------------------------------------ UAM entry + callbacks
  router.post('/redirects', async (req: Request, res: Response) => {
    const parsedBody = RedirectBody.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ kind: 'error' });
      return;
    }
    const { flavour, raw_query: raw } = parsedBody.data;
    const clientIp = clientIpOf(parsedBody.data.client_ip);
    const at = now();
    const generic = (reason: string, detail?: string) => {
      req.log.info({ reason, detail, flavour }, 'portal redirect refused');
      res.json({ kind: 'error' });
    };
    try {
      if (clientIp !== null) {
        const l = PORTAL_LIMITS.redirectsPerIp;
        await counter(deps, `pf:rl:redir:${clientIp}`, l.max, l.windowS);
      }
      const split = splitUamQuery(raw);
      const resolved = await resolvePortal(deps, flavour, split.params.nasid);
      const adapter = getVendorAdapter(
        resolved?.nas.adapterKey ?? UAM_FLAVOURS[flavour].adapterKeys[0],
      );
      const parsed = adapter.parseRedirect({ url: `/?${raw}`, method: 'GET' });
      if ('unsupported' in parsed) {
        generic('malformed', parsed.reason);
        return;
      }
      const callback =
        parsed.result === 'success' ||
        parsed.result === 'already' ||
        parsed.result === 'failed' ||
        parsed.result === 'logoff';
      const lookup: NasLookup = {
        findNas: () => Promise.resolve(resolved?.nas ?? null),
        expectedOrganizationId: null,
        // Callbacks legitimately repeat a consumed redirect identity (same sessionid/challenge).
        isReplay: (k) => (callback ? Promise.resolve(false) : isReplayed(deps.kv, replayKey(k))),
        now: () => at,
      };
      const validation = await adapter.validateContext(parsed, lookup);
      if (!validation.ok || resolved === null) {
        generic(
          validation.ok ? 'unknown_nas' : validation.reason,
          validation.ok ? undefined : validation.detail,
        );
        return;
      }
      const ctx = validation.context;
      const indexKey = { nasId: ctx.nas.id, clientMac: ctx.clientMac, sessionId: ctx.nasSessionId };

      if (callback) {
        const flow = await findIndexedFlow(deps.kv, indexKey, at);
        if (parsed.result === 'success' || parsed.result === 'already') {
          // SECURITY §5.6: success only for a flow that handed a credential to this NAS.
          if (flow !== null && (flow.state === 'LOGON_SENT' || flow.state === 'AUTHORIZED')) {
            flow.state = 'AUTHORIZED';
            await saveFlow(deps.kv, flow, at);
            res.json({ kind: 'success', flow_id: flow.id });
            return;
          }
          if (parsed.result === 'already') {
            res.json({ kind: 'already', flow_id: null });
            return;
          }
          generic('success_without_flow');
          return;
        }
        if (parsed.result === 'failed') {
          if (flow !== null && flow.state !== 'ENDED') {
            if (flow.credentialUsername !== null) {
              await revokeCredential(deps.kv, flow.credentialUsername);
            }
            flow.state = 'REJECTED';
            flow.credentialUsername = null;
            await saveFlow(deps.kv, flow, at);
            res.json({ kind: 'failed', flow_id: flow.id });
            return;
          }
          generic('failed_without_flow');
          return;
        }
        if (flow !== null) {
          flow.state = 'ENDED';
          await saveFlow(deps.kv, flow, at);
        }
        res.json({ kind: 'logoff' });
        return;
      }

      const l = PORTAL_LIMITS.flowsPerNas;
      await counter(deps, `pf:rl:flows:${ctx.nas.id}`, l.max, l.windowS);
      const { md: _md, ...fields } = ctx.vendorOpaque.fields;
      const flow: PortalFlow = {
        id: newId(),
        organizationId: ctx.organizationId,
        siteId: ctx.siteId,
        nasId: ctx.nas.id,
        nasIdentifier: ctx.nas.identifier,
        adapterKey: resolved.nas.adapterKey ?? '',
        vendorKey: ctx.vendorKey,
        deploymentMode: ctx.deploymentMode,
        controllerId: ctx.controllerId,
        captivePortalId: resolved.captivePortalId,
        clientMac: ctx.clientMac,
        apMac: ctx.apMac,
        clientIp: ctx.clientIp,
        ssid: ctx.ssid,
        sessionId: ctx.nasSessionId,
        challenge: fields.challenge ?? '',
        fields,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + FLOW_TTL_S * 1000).toISOString(),
        state: 'ARRIVED',
        credentialUsername: null,
        previousSessionExpired: await previousSessionExpired(deps, resolved.nas, ctx.clientMac, at),
      };
      await saveFlow(deps.kv, flow, at);
      await indexFlow(deps.kv, flow);
      req.log.info(
        { flowId: flow.id, organizationId: flow.organizationId, nasClientId: flow.nasId },
        'portal flow started',
      );
      res.json({ kind: 'flow', flow_id: flow.id, expires_at: flow.expiresAt });
    } catch (error) {
      if (error instanceof RateLimited) {
        res.status(429).json({ kind: 'rate_limited', retry_after: error.retryAfter });
        return;
      }
      req.log.error({ err: error }, 'portal redirect failed: backend unavailable');
      unavailable(res);
    }
  });

  // ---------------------------------------------------------------------- flow page data
  router.get('/flows/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const flow = isUuid(id) ? await loadFlow(deps.kv, id, now()) : null;
      if (flow === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      const view = await withTenant(deps.db, flow.organizationId, async (trx) => {
        const portal = await loadPortalRow(trx, flow.captivePortalId);
        if (portal === undefined || portal.status !== 'active') return null;
        const site = await trx
          .selectFrom('sites')
          .select(['name'])
          .where('id', '=', flow.siteId)
          .executeTakeFirst();
        const theme =
          portal.theme_id === null
            ? undefined
            : await trx
                .selectFrom('portal_themes')
                .select(['colors', 'strings', 'logo_asset_ref'])
                .where('id', '=', portal.theme_id)
                .executeTakeFirst();
        let terms: { version: string; text: string } | null = null;
        if (portal.terms_version !== null && /^\d{1,9}$/.test(portal.terms_version)) {
          const row = await trx
            .selectFrom('portal_terms_versions')
            .select(['body'])
            .where('captive_portal_id', '=', portal.id)
            .where('version', '=', Number(portal.terms_version))
            .where('locale', '=', 'en')
            .executeTakeFirst();
          if (row !== undefined) terms = { version: portal.terms_version, text: row.body };
        }
        const base = nasBase(flow);
        const fallback =
          portal.redirect_url !== null ? safeUserUrl(portal.redirect_url, null) : null;
        return {
          id: flow.id,
          state: flow.state,
          expires_at: flow.expiresAt,
          methods: enabledMethods(portal),
          portal: { id: portal.id, name: portal.name, site_name: site?.name ?? '' },
          theme:
            theme === undefined
              ? null
              : {
                  colors: theme.colors,
                  strings: theme.strings,
                  logo_asset_id:
                    theme.logo_asset_ref !== null && isUuid(theme.logo_asset_ref)
                      ? theme.logo_asset_ref
                      : null,
                },
          terms,
          nas: base === null ? null : { origin: base },
          continue_url: safeUserUrl(flow.fields.userurl, flow.fields.uamip ?? null) ?? fallback,
          notice: flow.previousSessionExpired ? 'session_expired' : null,
        };
      });
      if (view === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      res.json(view);
    } catch (error) {
      req.log.error({ err: error }, 'portal flow read failed');
      unavailable(res);
    }
  });

  // ------------------------------------------------------------------------ identity broker
  router.post('/flows/:id/identify', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = IdentifyBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ result: 'invalid' });
      return;
    }
    const input = body.data;
    const method = input.method;
    const clientIp = clientIpOf(input.client_ip);
    const at = now();
    try {
      const flow = isUuid(id) ? await loadFlow(deps.kv, id, at) : null;
      if (flow === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      if (flow.state === 'AUTHORIZED' || flow.state === 'ENDED') {
        res.status(409).json({ result: 'flow_state' });
        return;
      }
      const counters = failureCounters(flow, input);
      await assertNotLocked(deps, counters);
      if (clientIp !== null) {
        const l = PORTAL_LIMITS.attemptsPerIp;
        await counter(deps, `pf:rl:ip:${clientIp}`, l.max, l.windowS);
      }
      const ls = PORTAL_LIMITS.attemptsPerSite;
      await counter(deps, `pf:rl:site:${flow.siteId}`, ls.max, ls.windowS);

      // B-3: the Argon2id verify (~45 ms CPU) runs with no pg connection held. A short tenant
      // transaction reads the credential, the verify runs outside it, and the decision
      // transaction below re-reads the user and requires the credential unchanged.
      let passwordCheck: PasswordCheck | null = null;
      if (input.method === 'password') {
        const pre = await withTenant(deps.db, flow.organizationId, async (trx) => {
          const portal = await loadPortalRow(trx, flow.captivePortalId);
          if (
            portal === undefined ||
            portal.status !== 'active' ||
            !enabledMethods(portal).includes('password')
          ) {
            return null; // refused by the decision transaction without any verify (as before)
          }
          return { user: await findSubscriberByUsername(trx, input.username) };
        });
        if (pre !== null) {
          passwordCheck = await checkSubscriberLoginPassword(pre.user, input.password, {
            argon2MemoryKib: deps.config.base.argon2.memoryKib,
            verify: deps.verifyPassword,
          });
        }
      }

      type Outcome =
        | { ok: true; identity: BrokerIdentity; uamSecret: string | null }
        | { ok: false; reason: string; status: 403 | 404 | 422 };
      const outcome: Outcome = await withTenant(deps.db, flow.organizationId, async (trx) => {
        const portal = await loadPortalRow(trx, flow.captivePortalId);
        if (portal === undefined || portal.status !== 'active') {
          return { ok: false, reason: 'portal_inactive', status: 404 } as const;
        }
        if (!enabledMethods(portal).includes(method)) {
          return { ok: false, reason: 'method_not_allowed', status: 403 } as const;
        }
        let identity: BrokerIdentity;
        let prefix: string | null = null;
        let failure: string | null = null;
        try {
          if (input.method === 'password') {
            prefix = input.username.slice(0, 3);
            const user = await confirmSubscriberLogin(trx, {
              username: input.username,
              check: passwordCheck,
              siteId: flow.siteId,
              now: at,
            });
            identity = { kind: 'user', userId: user.id };
          } else if (input.method === 'voucher') {
            prefix = input.code.replace(/[\s-]/g, '').toUpperCase().slice(0, 2);
            const voucher = await verifyVoucherCode(trx, {
              pepper: deps.config.voucherPepper,
              code: input.code,
              siteId: flow.siteId,
              now: at,
            });
            identity = { kind: 'voucher', voucherId: voucher.id };
          } else {
            identity = { kind: 'click_through' };
          }
        } catch (error) {
          if (!(error instanceof IdentityRejected)) throw error;
          failure = error.reason;
          identity = { kind: 'click_through' };
        }
        // Counted before the attempt row so the row can say whether it activated a lock.
        const triggeredLockout = failure !== null ? await recordFailure(deps, counters) : false;
        await trx
          .insertInto('portal_login_attempts')
          .values({
            organization_id: flow.organizationId,
            captive_portal_id: portal.id,
            method,
            username_or_code_prefix: prefix,
            mac: flow.clientMac,
            client_ip: clientIp,
            result: failure === null ? 'accept' : 'reject',
            reason: failure,
            triggered_lockout: triggeredLockout,
          })
          .execute();
        if (failure !== null) return { ok: false, reason: failure, status: 422 } as const;
        return { ok: true, identity, uamSecret: openUamSecret(deps, portal.uam_secret_ref) };
      });

      if (!outcome.ok) {
        req.log.info(
          { flowId: flow.id, method, reason: outcome.reason },
          'portal identify refused',
        );
        const result =
          outcome.status === 422
            ? 'rejected'
            : outcome.status === 403
              ? 'method_not_allowed'
              : 'flow_not_found';
        res.status(outcome.status).json({ result });
        return;
      }
      await clearFailures(deps, counters);

      // Identity broker: a fresh single-use credential bound to NAS + MAC + sessionid.
      if (flow.credentialUsername !== null) {
        await revokeCredential(deps.kv, flow.credentialUsername);
      }
      const pair = newCredentialPair();
      const expiresAt = new Date(at.getTime() + CREDENTIAL_TTL_S * 1000);
      const handoff = getVendorAdapter(flow.adapterKey).authorizeSession(
        contextOf(flow, at),
        {
          username: pair.username,
          password: pair.password,
          expiresAt,
          boundNasId: flow.nasId,
          boundClientMac: flow.clientMac,
        },
        { uamSecret: outcome.uamSecret },
      );
      if ('unsupported' in handoff || handoff.browser === undefined) {
        req.log.warn(
          { flowId: flow.id, reason: 'unsupported' in handoff ? handoff.reason : 'no browser' },
          'portal hand-off unavailable',
        );
        res.status(422).json({ result: 'handoff_unavailable' });
        return;
      }
      await storeCredential(deps.kv, {
        username: pair.username,
        passwordSha256: sha256Hex(pair.password),
        flowId: flow.id,
        organizationId: flow.organizationId,
        siteId: flow.siteId,
        nasId: flow.nasId,
        clientMac: flow.clientMac,
        sessionId: flow.sessionId,
        replayKey: replayKey({
          nasId: flow.nasId,
          sessionId: flow.sessionId,
          challenge: flow.challenge,
          clientMac: flow.clientMac,
        }),
        identity: outcome.identity,
        expiresAt: expiresAt.toISOString(),
      });
      flow.state = 'LOGON_SENT';
      flow.credentialUsername = pair.username;
      await saveFlow(deps.kv, flow, at);
      req.log.info({ flowId: flow.id, method }, 'portal credential issued');
      res.json({
        result: 'ok',
        handoff: { method: handoff.browser.method, url: handoff.browser.url },
        expires_at: expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof RateLimited) {
        res.status(429).json({ result: 'rate_limited', retry_after: error.retryAfter });
        return;
      }
      req.log.error({ err: error }, 'portal identify failed: backend unavailable');
      unavailable(res);
    }
  });

  // -------------------------------------------------------------------------- status/logout
  router.get('/flows/:id/status', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const flow = isUuid(id) ? await loadFlow(deps.kv, id, now()) : null;
      if (flow === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      const session = await withTenant(deps.db, flow.organizationId, (trx) => {
        let q = trx
          .selectFrom('sessions')
          .select(['status', 'started_at', 'input_octets', 'output_octets', 'session_time_s'])
          .where('nas_client_id', '=', flow.nasId)
          .where('mac', '=', flow.clientMac)
          .where('started_at', '>=', new Date(Date.parse(flow.createdAt)));
        if (flow.sessionId !== null) q = q.where('acct_session_id', '=', flow.sessionId);
        return q.orderBy('started_at', 'desc').limit(1).executeTakeFirst();
      });
      res.json({
        flow_state: flow.state,
        session:
          session === undefined
            ? null
            : {
                status: session.status,
                started_at: session.started_at.toISOString(),
                input_octets: String(session.input_octets),
                output_octets: String(session.output_octets),
                session_time_s: Number(session.session_time_s),
              },
      });
    } catch (error) {
      req.log.error({ err: error }, 'portal status failed');
      unavailable(res);
    }
  });

  router.post('/flows/:id/logout', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const flow = isUuid(id) ? await loadFlow(deps.kv, id, now()) : null;
      const base = flow === null ? null : nasBase(flow);
      if (flow === null || base === null) {
        res.status(404).json({ result: 'flow_not_found' });
        return;
      }
      // CP §3.3 / §7.4: `GET http://uamip:uamport/logoff` (uspot T/U and CoovaChilli).
      res.json({ result: 'ok', url: `${base}/logoff` });
    } catch (error) {
      req.log.error({ err: error }, 'portal logout failed');
      unavailable(res);
    }
  });

  return router;
}
