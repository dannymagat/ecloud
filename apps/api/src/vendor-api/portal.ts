/**
 * Cycle D internal portal endpoints for the controller-API / signed-grant vendors
 * (`/internal/vendor-portal/*`, X-Internal-Token; docs/VENDOR_INTEGRATION_RESEARCH.md §3.6–§3.8):
 *
 *   POST /internal/vendor-portal/redirects   UniFi / Omada (API mode) / Mist redirect → flow
 *
 * and the completion step called by `/internal/portal/flows/:id/identify` once the guest has
 * proved an identity (password / voucher / click-through, unchanged broker code):
 * {@link completeVendorApiAuthorization}.
 *
 * Trust model. None of these redirects is signed, so:
 *  - the NAS (and so the tenant) is resolved ONLY from a VERIFIED AP MAC (`findNasByIdentity`,
 *    `nas_access_points.verified_at`: RADIUS-observed or controller-inventory), fail-closed;
 *  - the NAS must use the matching adapter and a controller of this organization that has an API
 *    credential of the matching kind; Mist additionally needs the WLAN id in the credential's
 *    `mist_wlan_ids`; UniFi's path site must equal `unifi_site_name` when that is set;
 *  - UniFi: the client MAC must be a client the controller itself reports on the configured
 *    site (a forged MAC can only authorise a device that is actually there);
 *  - every refusal answers the same `{kind:"error"}`; the reason goes to the log only.
 *
 * Accounting. These vendors send NO RADIUS accounting in this mode. The authorisation is recorded
 * in `vendor_api_sessions` (migration 031) with the granted duration / limits, the per-field
 * D-028 status, `accounting = 'none'` and `usage_source = 'unknown'`. No usage is ever claimed.
 */
import { withTenant, type DbTransaction } from '@ecloud/db';
import {
  resolveEffectivePolicy,
  translateApiLimits,
  type ApiLimitTarget,
  type Subject,
} from '@ecloud/policy-engine';
import { safeUserUrl } from '@ecloud/adapters';
import { isUuid, newId, type Logger } from '@ecloud/shared';
import {
  MIST_GRANT_DEFAULT_TTL_S,
  VendorApiError,
  buildMistGrant,
  omadaClientOf,
  openVendorCredential,
  parseMistRedirect,
  parseOmadaRedirect,
  parseUnifiRedirect,
  unifiClientOf,
  type OpenedVendorCredential,
  type VendorApiAdapterKey,
  type VendorRedirect,
} from '@ecloud/vendor-api';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { consumeVoucher } from '../internal/aaa.js';
import { findNasByIdentity } from '../internal/nas-lookup.js';
import {
  IdentityRejected,
  clickThroughDevice,
  recheckUser,
  recheckVoucher,
} from '../internal/portal-identity.js';
import {
  FLOW_TTL_S,
  saveFlow,
  type BrokerIdentity,
  type PortalFlow,
} from '../internal/portal-store.js';
import { loadResolutionInput } from '../policy-data.js';
import { logPortalSecurityEvent } from '../security-events.js';
import { ADAPTER_API_KIND, loadStoredCredential, vendorHttpOf } from './store.js';

export const VENDOR_REDIRECT_LIMITS = Object.freeze({
  redirectsPerIp: { max: 60, windowS: 60 },
  flowsPerNas: { max: 300, windowS: 3600 },
});

const RedirectBody = z.object({
  adapter: z.enum(['unifi', 'omada', 'mist']),
  /** Request path as received by the portal (UniFi carries the site name in it). */
  path: z.string().max(256),
  raw_query: z.string().max(8192),
  client_ip: z.string().max(64).optional(),
});

class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function parse(
  adapter: 'unifi' | 'omada' | 'mist',
  path: string,
  raw: string,
): VendorRedirect | null {
  if (adapter === 'unifi') return parseUnifiRedirect(path, raw);
  if (adapter === 'omada') return parseOmadaRedirect(raw);
  return parseMistRedirect(raw);
}

async function bump(deps: AppDeps, key: string, max: number, windowS: number): Promise<boolean> {
  if (deps.config.rateLimitDisabled) return true;
  return (await deps.kv.incr(key, windowS)) <= max;
}

interface PortalPick {
  id: string;
  adapter_config: Record<string, unknown>;
}

/** Same rule as the UAM portal: pinned by `adapter_config.nas_client_id`, else the only one. */
function pickPortal(rows: PortalPick[], nasId: string): PortalPick | null {
  const pinned = rows.filter((r) => r.adapter_config.nas_client_id === nasId);
  if (pinned.length === 1) return pinned[0] ?? null;
  if (pinned.length > 1) return null;
  const unpinned = rows.filter((r) => typeof r.adapter_config.nas_client_id !== 'string');
  return unpinned.length === 1 ? (unpinned[0] ?? null) : null;
}

export function vendorPortalInternalRouter(deps: AppDeps): Router {
  const now = deps.now ?? (() => new Date());
  const router = express.Router();

  router.post('/redirects', async (req: Request, res: Response) => {
    const body = RedirectBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ kind: 'error' });
      return;
    }
    const { adapter, path, raw_query: raw } = body.data;
    const at = now();
    const refuse = (reason: string): void => {
      req.log.info({ reason, adapter }, 'vendor portal redirect refused');
      res.json({ kind: 'error' });
    };
    try {
      const clientIp = body.data.client_ip;
      if (clientIp !== undefined) {
        const l = VENDOR_REDIRECT_LIMITS.redirectsPerIp;
        if (!(await bump(deps, `pf:rl:vredir:${clientIp}`, l.max, l.windowS))) {
          res.status(429).json({ kind: 'rate_limited', retry_after: l.windowS });
          return;
        }
      }
      const parsed = parse(adapter, path, raw);
      if (parsed === null) return refuse('malformed');
      if (parsed.apMac === null) return refuse('no_ap_mac');
      const found = await findNasByIdentity(deps, { nasid: null, apMac: parsed.apMac });
      if (!found.ok) return refuse(found.reason);
      if (found.apMacClaimedElsewhere) {
        logPortalSecurityEvent(req.log, 'ap_mac_claimed_elsewhere', { apMac: parsed.apMac });
      }
      const nas = found.nas;
      if (nas.adapter_key !== parsed.adapterKey || nas.controller_id === null) {
        return refuse('adapter_mismatch');
      }
      const controllerId = nas.controller_id;
      const picked = await withTenant(deps.db, nas.organization_id, async (trx) => {
        const cred = await loadStoredCredential(trx, controllerId);
        if (cred === null || cred.apiKind !== ADAPTER_API_KIND[parsed.adapterKey]) {
          return 'no_credential' as const;
        }
        if (parsed.adapterKey === 'unifi-external-portal') {
          const expected = cred.settings.unifi_site_name;
          if (expected !== undefined && expected !== parsed.fields.unifi_site)
            return 'site_mismatch' as const;
          if (cred.externalSiteId === null) return 'no_site_id' as const;
        }
        if (parsed.adapterKey === 'mist-guest-portal') {
          const wlans = cred.settings.mist_wlan_ids ?? [];
          if (!wlans.includes(parsed.fields.wlan_id ?? '')) return 'wlan_not_registered' as const;
        }
        const portals = (await trx
          .selectFrom('captive_portals')
          .select(['id', 'adapter_config'])
          .where('organization_id', '=', nas.organization_id)
          .where('site_id', '=', nas.site_id)
          .where('status', '=', 'active')
          .where('portal_type', '=', 'external')
          .execute()) as PortalPick[];
        return pickPortal(portals, nas.id) ?? ('no_portal' as const);
      });
      if (typeof picked === 'string') return refuse(picked);
      const lf = VENDOR_REDIRECT_LIMITS.flowsPerNas;
      if (!(await bump(deps, `pf:rl:flows:${nas.id}`, lf.max, lf.windowS))) {
        res.status(429).json({ kind: 'rate_limited', retry_after: 60 });
        return;
      }
      const fields: Record<string, string> = { ...parsed.fields };
      // `userurl` is what the shared flow view validates with safeUserUrl (continue link).
      if (parsed.continueUrl !== null) fields.userurl = parsed.continueUrl;
      const flow: PortalFlow = {
        id: newId(),
        organizationId: nas.organization_id,
        siteId: nas.site_id,
        nasId: nas.id,
        nasIdentifier: nas.nas_identifier,
        adapterKey: parsed.adapterKey,
        vendorKey: parsed.adapterKey,
        deploymentMode: nas.deployment_mode,
        controllerId,
        captivePortalId: picked.id,
        clientMac: parsed.clientMac,
        apMac: parsed.apMac,
        clientIp: parsed.clientIp,
        ssid: parsed.ssid,
        sessionId: null,
        challenge: '',
        fields,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + FLOW_TTL_S * 1000).toISOString(),
        state: 'ARRIVED',
        credentialUsername: null,
        previousSessionExpired: false,
      };
      await saveFlow(deps.kv, flow, at);
      req.log.info(
        {
          flowId: flow.id,
          organizationId: flow.organizationId,
          nasClientId: flow.nasId,
          adapter: parsed.adapterKey,
        },
        'vendor portal flow started',
      );
      res.json({ kind: 'flow', flow_id: flow.id, expires_at: flow.expiresAt });
    } catch (error) {
      req.log.error(
        { err: error instanceof Error ? error.message : 'error' },
        'vendor portal redirect failed',
      );
      res.status(503).json({ kind: 'unavailable' });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------------------------
// Completion (called from /internal/portal/flows/:id/identify)
// ---------------------------------------------------------------------------------------------

export interface VendorCompletion {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const TARGET: Readonly<Record<VendorApiAdapterKey, ApiLimitTarget>> = ADAPTER_API_KIND;

/** Voucher state before this authorisation consumed one use (review F3 compensation). */
interface VoucherBefore {
  readonly id: string;
  readonly useCount: number;
  readonly status: string;
  readonly activatedAt: Date | null;
  readonly expiresAt: Date | null;
}

/** Review F6: where the guest may be sent, and whether the tenant vouches for that host. */
interface ContinueTarget {
  readonly url: string | null;
  readonly host: string | null;
  readonly trusted: boolean;
  /** The tenant's configured landing page (always trusted), if any. */
  readonly landingUrl: string | null;
}

/** Review F5: one completion per flow at a time (TTL = flow TTL). */
export const flowClaimKey = (flowId: string): string => `pf:claim:${flowId}`;

interface Reserved {
  readonly voucherBefore: VoucherBefore | null;
  readonly continueTarget: ContinueTarget;
  readonly sessionRowId: string;
  readonly target: ApiLimitTarget;
  readonly plan: ReturnType<typeof translateApiLimits>;
  readonly cred: NonNullable<Awaited<ReturnType<typeof loadStoredCredential>>>;
}

/** Subject + ids of the broker identity, re-checked inside the transaction (as AAA does). */
async function recheckIdentity(
  trx: DbTransaction,
  flow: PortalFlow,
  identity: BrokerIdentity,
  now: Date,
): Promise<{
  subject: Subject;
  userId: string | null;
  voucherId: string | null;
  voucherBatchId: string | null;
  groupIds: string[];
  clientDeviceId: string | null;
}> {
  if (identity.kind === 'user') {
    const user = await recheckUser(trx, { userId: identity.userId, siteId: flow.siteId, now });
    return {
      subject: { kind: 'user', user_id: user.id },
      userId: user.id,
      voucherId: null,
      voucherBatchId: null,
      groupIds: user.userGroupId === null ? [] : [user.userGroupId],
      clientDeviceId: null,
    };
  }
  if (identity.kind === 'voucher') {
    const v = await recheckVoucher(trx, {
      voucherId: identity.voucherId,
      siteId: flow.siteId,
      now,
    });
    return {
      subject: {
        kind: 'voucher',
        user_id: v.boundUserId,
        voucher: {
          batch_id: v.batchId,
          expires_at: v.expiresAt,
          activated_at: v.activatedAt,
          duration_s: v.durationS,
          batch_valid_from: v.batchValidFrom,
          batch_valid_until: v.batchValidUntil,
        },
      },
      userId: v.boundUserId,
      voucherId: v.id,
      voucherBatchId: v.batchId,
      groupIds: [],
      clientDeviceId: null,
    };
  }
  const deviceId = await clickThroughDevice(trx, {
    organizationId: flow.organizationId,
    mac: flow.clientMac,
    now,
  });
  return {
    subject: { kind: 'client_device', client_device_id: deviceId },
    userId: null,
    voucherId: null,
    voucherBatchId: null,
    groupIds: [],
    clientDeviceId: deviceId,
  };
}

/**
 * Policy → API limits → reserve (`pending` row, voucher use) → vendor call (no DB connection
 * held, secret opened in-process) → `authorized` / `granted_url_issued` / `failed`.
 */
export async function completeVendorApiAuthorization(
  deps: AppDeps,
  flow: PortalFlow,
  identity: BrokerIdentity,
  at: Date,
  log: Logger,
): Promise<VendorCompletion> {
  const adapterKey = flow.adapterKey as VendorApiAdapterKey;
  const target = TARGET[adapterKey];
  if (flow.controllerId === null || !isUuid(flow.controllerId)) {
    return { status: 422, body: { result: 'handoff_unavailable' } };
  }
  const controllerId = flow.controllerId;
  // Review F5: a vendor flow completes once. A Mist grant (LOGON_SENT) or an authorised flow is
  // never re-identified, and two concurrent identifies cannot both reach the controller.
  if (flow.state !== 'ARRIVED') return { status: 409, body: { result: 'flow_state' } };
  if (!(await deps.kv.set(flowClaimKey(flow.id), '1', FLOW_TTL_S, true))) {
    return { status: 409, body: { result: 'flow_state' } };
  }
  const release = async (): Promise<void> => {
    await deps.kv.del(flowClaimKey(flow.id));
  };

  let reserved: Reserved | VendorCompletion;
  try {
    reserved = await withTenant(
      deps.db,
      flow.organizationId,
      async (trx): Promise<Reserved | VendorCompletion> => {
        const nas = await trx
          .selectFrom('nas_clients')
          .select(['id', 'site_id', 'adapter_key', 'controller_id', 'status'])
          .where('id', '=', flow.nasId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (
          nas?.status !== 'active' ||
          nas.adapter_key !== adapterKey ||
          nas.controller_id !== controllerId
        ) {
          return { status: 422, body: { result: 'handoff_unavailable' } };
        }
        const cred = await loadStoredCredential(trx, controllerId);
        if (cred?.apiKind !== target)
          return { status: 422, body: { result: 'handoff_unavailable' } };
        const site = await trx
          .selectFrom('sites')
          .select(['timezone'])
          .where('id', '=', flow.siteId)
          .executeTakeFirstOrThrow();
        const who = await recheckIdentity(trx, flow, identity, at);
        const device = await trx
          .selectFrom('client_devices')
          .select(['id', 'blocked'])
          .where('mac', '=', flow.clientMac)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (device?.blocked === true) throw new Refused('device_blocked');
        const input = await loadResolutionInput(trx, {
          organizationId: flow.organizationId,
          siteId: flow.siteId,
          timeZone: site.timezone,
          now: at,
          subject: who.subject,
          clientDeviceId: who.clientDeviceId ?? device?.id ?? null,
          mac: flow.clientMac,
          groupIds: who.groupIds,
          voucherBatchId: who.voucherBatchId,
        });
        const resolution = resolveEffectivePolicy({ ...input, trigger: 'authorize' });
        if (resolution.decision === 'reject')
          throw new Refused(resolution.reasonCode ?? 'policy_reject');
        const caps = [
          resolution.clip.window_end_s,
          resolution.clip.validity_end_s,
          resolution.clip.voucher_end_s,
        ].filter((v): v is number => typeof v === 'number' && v > 0);
        const plan = translateApiLimits(target, {
          fields: resolution.effective.fields,
          sessionCapS: caps.length > 0 ? Math.min(...caps) : null,
        });
        // ECLOUD_SIDE_ONLY concurrency over API-authorised sessions (no device sessions exist).
        // Review F5: the voucher / user row is locked so two concurrent completions for the same
        // identity are serialised before they count live sessions.
        const f = resolution.effective.fields;
        let voucherBefore: VoucherBefore | null = null;
        if (who.voucherId !== null) {
          const v = await trx
            .selectFrom('vouchers')
            .select(['id', 'use_count', 'status', 'activated_at', 'expires_at'])
            .where('id', '=', who.voucherId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          voucherBefore = {
            id: v.id,
            useCount: v.use_count,
            status: v.status,
            activatedAt: v.activated_at,
            expiresAt: v.expires_at,
          };
        } else if (who.userId !== null) {
          await trx
            .selectFrom('users')
            .select('id')
            .where('id', '=', who.userId)
            .forUpdate()
            .execute();
        }
        if (who.userId !== null || who.voucherId !== null) {
          const live = await trx
            .selectFrom('vendor_api_sessions')
            .select(['client_mac'])
            .where('status', 'in', ['authorized', 'granted_url_issued', 'pending'])
            .where('expires_at', '>', at)
            .where((eb) =>
              who.voucherId !== null
                ? eb('voucher_id', '=', who.voucherId)
                : eb('user_id', '=', who.userId),
            )
            .execute();
          if (f.max_concurrent_sessions !== null && live.length >= f.max_concurrent_sessions) {
            throw new Refused('concurrency_limit');
          }
          const macs = new Set(live.map((r) => r.client_mac));
          if (f.max_devices !== null && !macs.has(flow.clientMac) && macs.size >= f.max_devices) {
            throw new Refused('device_limit');
          }
        }
        if (who.voucherId !== null) await consumeVoucher(trx, who.voucherId, at);
        const sessionRowId = newId();
        await trx
          .insertInto('vendor_api_sessions')
          .values({
            id: sessionRowId,
            organization_id: flow.organizationId,
            site_id: flow.siteId,
            nas_client_id: flow.nasId,
            controller_id: controllerId,
            adapter_key: adapterKey,
            api_kind: target,
            client_mac: flow.clientMac,
            ap_mac: flow.apMac,
            identity_kind: identity.kind,
            user_id: who.userId,
            voucher_id: who.voucherId,
            status: 'pending',
            requested_at: at,
            expires_at: new Date(at.getTime() + plan.limits.durationS * 1000),
            granted_duration_s: plan.limits.durationS,
            requested_limits: JSON.stringify({
              duration_s: plan.limits.durationS,
              data_limit_bytes:
                plan.limits.dataLimitBytes === null ? null : plan.limits.dataLimitBytes.toString(),
              download_kbps: plan.limits.downloadKbps,
              upload_kbps: plan.limits.uploadKbps,
              body: plan.unifi ?? plan.omada ?? plan.mist,
              policy_id: resolution.snapshot.policy_id,
              policy_version: resolution.snapshot.policy_version,
            }),
            field_statuses: JSON.stringify(
              plan.fields.map((x) => ({
                field: x.field,
                status: x.status,
                evidence_level: x.evidenceLevel,
                mechanism: x.mechanism,
                api_field: x.apiField,
              })),
            ),
          })
          .execute();
        // Review F6: continue only automatically to a host the tenant configured.
        const portal = await trx
          .selectFrom('captive_portals')
          .select(['redirect_url', 'adapter_config'])
          .where('id', '=', flow.captivePortalId)
          .executeTakeFirst();
        const landingUrl =
          portal?.redirect_url !== null && portal?.redirect_url !== undefined
            ? safeUserUrl(portal.redirect_url, null)
            : null;
        const trustedHosts = new Set<string>();
        if (landingUrl !== null) trustedHosts.add(new URL(landingUrl).hostname.toLowerCase());
        const extra = portal?.adapter_config?.allowed_continue_hosts;
        if (Array.isArray(extra)) {
          for (const h of extra) if (typeof h === 'string') trustedHosts.add(h.toLowerCase());
        }
        const requested = safeUserUrl(flow.fields.userurl, null);
        const host = requested === null ? null : new URL(requested).hostname.toLowerCase();
        const continueTarget: ContinueTarget = {
          url: requested,
          host,
          trusted: host !== null && trustedHosts.has(host),
          landingUrl,
        };
        return { sessionRowId, target, plan, cred, voucherBefore, continueTarget };
      },
    );
  } catch (error) {
    await release();
    if (error instanceof Refused || error instanceof IdentityRejected) {
      log.info({ flowId: flow.id, reason: error.reason }, 'vendor api authorisation refused');
      return { status: 422, body: { result: 'rejected' } };
    }
    throw error;
  }
  if ('status' in reserved) {
    await release();
    return reserved;
  }

  // ---- vendor call: outside any transaction; the secret is opened here and dropped after ----
  const { sessionRowId, plan, cred, voucherBefore, continueTarget } = reserved;
  let outcome:
    | { kind: 'authorized'; vendorRef: string | null }
    | { kind: 'grant'; url: string }
    | { kind: 'failed'; code: string };
  try {
    const opened: OpenedVendorCredential = openVendorCredential(
      deps.config.dataEncryptionKey,
      cred,
    );
    // Omada `originUrl` is informational for the controller; Mist `forward` is where Mist sends
    // the guest, so it is only the requested URL when the tenant trusts its host (review F6).
    const continueUrl = continueTarget.url;
    const mistForward = continueTarget.trusted ? continueTarget.url : continueTarget.landingUrl;
    if (adapterKey === 'unifi-external-portal') {
      const client = unifiClientOf(vendorHttpOf(deps), opened);
      const found = await client.findClientByMac(flow.clientMac);
      if (found === null) throw new VendorApiError('client_not_found');
      // Extra refusal only: a controller that reports a non-guest client is never authorised.
      if (found.accessType !== null && found.accessType.toUpperCase() !== 'GUEST') {
        throw new VendorApiError('vendor_rejected');
      }
      await client.authorizeGuest(found.id, plan.unifi ?? {});
      outcome = { kind: 'authorized', vendorRef: found.id };
    } else if (adapterKey === 'omada-api') {
      const fl = flow.fields;
      const body = plan.omada;
      if (body === null) throw new VendorApiError('invalid_target');
      await omadaClientOf(vendorHttpOf(deps), opened).authorizeClient({
        clientMac: fl.clientMac ?? '',
        ...(fl.clientIp !== undefined ? { clientIp: fl.clientIp } : {}),
        ...(fl.apMac !== undefined
          ? {
              apMac: fl.apMac,
              ssidName: fl.ssidName ?? '',
              radioId: fl.radioId ?? '',
              originUrl: continueUrl ?? '',
            }
          : { gatewayMac: fl.gatewayMac ?? '', vid: fl.vid ?? '' }),
        timeMs: body.timeMs,
        ...(body.totalTrafficLimitBytes !== undefined
          ? { totalTrafficLimitBytes: body.totalTrafficLimitBytes }
          : {}),
        ...(body.downloadRateLimitKbps !== undefined
          ? { downloadRateLimitKbps: body.downloadRateLimitKbps }
          : {}),
        ...(body.uploadRateLimitKbps !== undefined
          ? { uploadRateLimitKbps: body.uploadRateLimitKbps }
          : {}),
      });
      outcome = { kind: 'authorized', vendorRef: null };
    } else {
      const grant = buildMistGrant({
        secret: opened.secret,
        wlanId: flow.fields.wlan_id ?? '',
        apMac: flow.fields.ap_mac ?? '',
        clientMac: flow.fields.client_mac ?? '',
        authorizeMinutes: plan.mist?.authorizeMinutes ?? 1,
        expires: Math.floor(at.getTime() / 1000) + MIST_GRANT_DEFAULT_TTL_S,
        forward: mistForward,
        ...(opened.settings.mist_portal_host !== undefined
          ? { host: opened.settings.mist_portal_host }
          : {}),
      });
      outcome = { kind: 'grant', url: grant.url };
    }
  } catch (error) {
    const code = error instanceof VendorApiError ? error.code : 'internal_error';
    if (!(error instanceof VendorApiError)) {
      log.error(
        { flowId: flow.id, controllerId, err: error instanceof Error ? error.name : 'error' },
        'vendor api authorisation crashed',
      );
    }
    outcome = { kind: 'failed', code };
  }

  await withTenant(deps.db, flow.organizationId, async (trx) => {
    await trx
      .updateTable('vendor_api_sessions')
      .set(
        outcome.kind === 'failed'
          ? { status: 'failed', error_code: outcome.code, expires_at: null }
          : outcome.kind === 'grant'
            ? { status: 'granted_url_issued', authorized_at: at }
            : { status: 'authorized', authorized_at: at, vendor_client_ref: outcome.vendorRef },
      )
      .where('id', '=', sessionRowId)
      .execute();
    // Review F3: a vendor outage never consumes a voucher. Undo exactly this use, atomically and
    // only if nobody used the voucher since (use_count still ours).
    if (outcome.kind === 'failed' && voucherBefore !== null) {
      await trx
        .updateTable('vouchers')
        .set({
          use_count: voucherBefore.useCount,
          status: voucherBefore.status as 'unused' | 'active' | 'exhausted' | 'expired' | 'revoked',
          ...(voucherBefore.activatedAt === null ? { activated_at: null, expires_at: null } : {}),
        })
        .where('id', '=', voucherBefore.id)
        .where('use_count', '=', voucherBefore.useCount + 1)
        .execute();
    }
  });
  if (outcome.kind === 'failed') await release();
  log.info(
    {
      flowId: flow.id,
      controllerId,
      adapter: adapterKey,
      result: outcome.kind,
      code: outcome.kind === 'failed' ? outcome.code : 'ok',
    },
    'vendor api authorisation',
  );
  if (outcome.kind === 'failed') {
    return { status: 502, body: { result: 'vendor_unavailable' } };
  }
  flow.state = outcome.kind === 'grant' ? 'LOGON_SENT' : 'AUTHORIZED';
  await saveFlow(deps.kv, flow, at);
  const expiresAt = new Date(at.getTime() + plan.limits.durationS * 1000).toISOString();
  return outcome.kind === 'grant'
    ? {
        status: 200,
        body: {
          result: 'ok',
          handoff: { method: 'GET-302', kind: 'vendor-grant', url: outcome.url },
          expires_at: expiresAt,
        },
      }
    : {
        status: 200,
        body: {
          result: 'ok',
          handoff: {
            method: 'none',
            kind: 'vendor-api',
            url: continueTarget.url,
            host: continueTarget.host,
            trusted: continueTarget.trusted,
            landing_url: continueTarget.landingUrl,
          },
          expires_at: expiresAt,
          accounting: 'none',
        },
      };
}
