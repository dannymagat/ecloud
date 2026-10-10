/**
 * Post-back redirects (Cycle C, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md §2 F3, §3.4):
 *
 *   POST /internal/portal/postback/redirects   {profile, nasid?, raw_query, client_ip?}
 *
 * The portal forwards `GET /pb/<profile>[/<nasid>]/?<raw query>` here. The NAS is resolved
 * server-side BEFORE any query value is trusted: by NAS identifier (portal path or the profile's
 * NAS-ID parameter) when present, otherwise by a VERIFIED AP MAC only (`findNasByIdentity`,
 * Cycle A rule: unverified / unknown / ambiguous rows fail closed). The NAS must use the
 * `external-portal-postback` adapter with THIS profile in its validated `adapter_config`; the
 * adapter then validates the redirect (login URL must be the AP / controller, vendor nonce not
 * replayed). Every refusal answers the same `{kind:"error"}`; the reason goes to the log only.
 *
 * The anti-forgery login token (Cycle A `vendor/login-token.ts`) is issued with the flow view and
 * consumed exactly once by `identify` before a portal credential is handed out (portal.ts).
 */
import {
  GENERIC_POSTBACK_PROFILE_KEY,
  POSTBACK_ADAPTER_KEY,
  POSTBACK_NASID_SEGMENT_RE,
  builtinPostbackProfile,
  postbackAdapterForNas,
  postbackVendorNonce,
  splitPostbackQuery,
  type NasLookup,
  type RegisteredNas,
} from '@ecloud/adapters';
import { withPlatform } from '@ecloud/db';
import { canonicalUnicastMac, newId, type Logger } from '@ecloud/shared';
import type { Request, Response, Router } from 'express';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { logPortalSecurityEvent } from '../security-events.js';
import { findNasByIdentity } from './nas-lookup.js';
import { indexFlow, isReplayed, saveFlow, FLOW_TTL_S, type PortalFlow } from './portal-store.js';

const ACCESS = Object.freeze({ reason: 'portal', audit: false });

export interface PostbackRouteHelpers {
  /** Fixed-window counter; throws the portal's RateLimited error when exceeded. */
  readonly counter: (key: string, max: number, windowS: number) => Promise<void>;
  readonly isRateLimited: (error: unknown) => error is { retryAfter: number };
  readonly limits: {
    readonly redirectsPerIp: { readonly max: number; readonly windowS: number };
    readonly flowsPerNas: { readonly max: number; readonly windowS: number };
  };
  /** Captive portal of the NAS (pinned, else the only unpinned one) of the given type. */
  readonly pickPortalId: (
    rows: { id: string; adapter_config: Record<string, unknown> }[],
    nasId: string,
  ) => string | null;
  readonly previousSessionExpired: (nas: RegisteredNas, mac: string, now: Date) => Promise<boolean>;
}

export const PostbackRedirectBody = z.strictObject({
  profile: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  nasid: z.string().regex(POSTBACK_NASID_SEGMENT_RE).nullable().optional(),
  raw_query: z.string().max(4096),
  client_ip: z.string().max(64).optional(),
});

interface NasExtra {
  /** NULL only for `meraki-splash` rows (migration 032), never for a post-back NAS. */
  nas_ip: string | null;
  adapter_key: string | null;
  adapter_config: Record<string, unknown>;
  hotspot_address: string | null;
}

/** Identity fields a built-in profile reads before the NAS is known. */
function preIdentity(
  profileKey: string,
  pathNasId: string | null,
  rawQuery: string,
): { nasid: string | null; apMac: string | null } | null {
  if (profileKey === GENERIC_POSTBACK_PROFILE_KEY) {
    // Parameter names are per NAS: the path must name it.
    return pathNasId === null ? null : { nasid: pathNasId, apMac: null };
  }
  const profile = builtinPostbackProfile(profileKey);
  if (profile === null) return null;
  const q = splitPostbackQuery(rawQuery);
  const first = (names: readonly string[] | undefined): string | null => {
    for (const n of names ?? []) {
      const v = q.params[n];
      if (v !== undefined && v !== '') return v;
    }
    return null;
  };
  const paramNasId = first(profile.params.nasId);
  if (pathNasId !== null && paramNasId !== null && paramNasId !== pathNasId) return null;
  return {
    nasid: pathNasId ?? paramNasId,
    apMac: canonicalUnicastMac(first(profile.params.apMac)),
  };
}

export function registerPostbackRoutes(
  router: Router,
  deps: AppDeps,
  helpers: PostbackRouteHelpers,
  now: () => Date,
): void {
  router.post('/postback/redirects', async (req: Request, res: Response) => {
    const body = PostbackRedirectBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ kind: 'error' });
      return;
    }
    const { profile: profileKey, raw_query: raw } = body.data;
    const pathNasId = body.data.nasid ?? null;
    const clientIp =
      typeof body.data.client_ip === 'string' && isIP(body.data.client_ip) !== 0
        ? body.data.client_ip
        : null;
    const at = now();
    const log: Logger = req.log;
    const generic = (reason: string, detail?: string) => {
      log.info({ reason, detail, profile: profileKey }, 'portal post-back redirect refused');
      res.json({ kind: 'error' });
    };
    try {
      if (clientIp !== null) {
        const l = helpers.limits.redirectsPerIp;
        await helpers.counter(`pf:rl:redir:${clientIp}`, l.max, l.windowS);
      }
      const identity = preIdentity(profileKey, pathNasId, raw);
      if (identity === null) {
        generic('malformed', 'unknown profile, missing path NAS id, or conflicting NAS ids');
        return;
      }
      const found = await findNasByIdentity(deps, identity);
      if (!found.ok) {
        generic(found.reason);
        return;
      }
      if (found.apMacClaimedElsewhere) {
        logPortalSecurityEvent(log, 'ap_mac_claimed_elsewhere', { apMac: identity.apMac });
      }
      const n = found.nas;
      const loaded = await withPlatform(deps.dbPlatform, ACCESS, async (trx) => {
        const extra: NasExtra | undefined = await trx
          .selectFrom('nas_clients')
          .select(['nas_ip', 'adapter_key', 'adapter_config', 'hotspot_address'])
          .where('id', '=', n.id)
          .where('organization_id', '=', n.organization_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (
          extra === undefined ||
          extra.adapter_key !== POSTBACK_ADAPTER_KEY ||
          extra.nas_ip === null
        ) {
          return null;
        }
        const portals = (await trx
          .selectFrom('captive_portals')
          .select(['id', 'adapter_config'])
          .where('site_id', '=', n.site_id)
          .where('organization_id', '=', n.organization_id)
          .where('status', '=', 'active')
          .where('portal_type', '=', 'external')
          .execute()) as { id: string; adapter_config: Record<string, unknown> }[];
        const portalId = helpers.pickPortalId(portals, n.id);
        return portalId === null ? null : { extra, portalId };
      });
      if (loaded === null) {
        generic('unknown_nas', 'NAS is not a post-back NAS or its site has no external portal');
        return;
      }
      const nasIp = String(loaded.extra.nas_ip).replace(/\/32$/, '');
      // Cycle B/C merge: a registered hotspot_address is a known NAS login host as well.
      const hotspotAddress =
        loaded.extra.hotspot_address === null
          ? null
          : String(loaded.extra.hotspot_address).replace(/\/32$/, '');
      const built = postbackAdapterForNas({
        adapterConfig: loaded.extra.adapter_config,
        nasIp,
        hotspotAddress,
      });
      if (built === null || built.profile.key !== profileKey) {
        generic('unknown_nas', 'NAS is not configured for this profile');
        return;
      }
      const registered: RegisteredNas = {
        id: n.id,
        organizationId: n.organization_id,
        siteId: n.site_id,
        identifier: n.nas_identifier,
        adapterKey: n.adapter_key,
        controllerId: n.controller_id,
        deploymentMode: n.deployment_mode,
        uamServerUrl: null,
        uamSecret: null,
        nasIp,
        hotspotAddress,
        adapterConfig: loaded.extra.adapter_config,
      };
      const path = `/pb/${profileKey}/${pathNasId === null ? '' : `${pathNasId}/`}`;
      const parsed = built.adapter.parseRedirect({ url: `${path}?${raw}`, method: 'GET' });
      if ('unsupported' in parsed) {
        generic('malformed', parsed.reason);
        return;
      }
      const lookup: NasLookup = {
        findNas: () => Promise.resolve(registered),
        expectedOrganizationId: null,
        isReplay: (k) => isReplayed(deps.kv, k),
        now: () => at,
      };
      const validation = await built.adapter.validateContext(parsed, lookup);
      if (!validation.ok) {
        generic(validation.reason, validation.detail);
        return;
      }
      const ctx = validation.context;
      const l = helpers.limits.flowsPerNas;
      await helpers.counter(`pf:rl:flows:${ctx.nas.id}`, l.max, l.windowS);
      const flow: PortalFlow = {
        id: newId(),
        organizationId: ctx.organizationId,
        siteId: ctx.siteId,
        nasId: ctx.nas.id,
        nasIdentifier: ctx.nas.identifier,
        adapterKey: POSTBACK_ADAPTER_KEY,
        vendorKey: ctx.vendorKey,
        deploymentMode: ctx.deploymentMode,
        controllerId: ctx.controllerId,
        captivePortalId: loaded.portalId,
        clientMac: ctx.clientMac,
        apMac: ctx.apMac,
        clientIp: ctx.clientIp,
        ssid: ctx.ssid,
        sessionId: null,
        challenge: '',
        fields: ctx.vendorOpaque.fields,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + FLOW_TTL_S * 1000).toISOString(),
        state: 'ARRIVED',
        credentialUsername: null,
        previousSessionExpired: await helpers.previousSessionExpired(registered, ctx.clientMac, at),
        postback: {
          profile: profileKey,
          rawQuery: parsed.rawQuery,
          adapterConfig: loaded.extra.adapter_config,
          nasIp,
          hotspotAddress,
          vendorNonce: postbackVendorNonce(built.profile, parsed.rawQuery),
        },
      };
      await saveFlow(deps.kv, flow, at);
      await indexFlow(deps.kv, flow);
      log.info(
        {
          flowId: flow.id,
          organizationId: flow.organizationId,
          nasClientId: flow.nasId,
          profileKey,
        },
        'portal post-back flow started',
      );
      res.json({ kind: 'flow', flow_id: flow.id, expires_at: flow.expiresAt });
    } catch (error) {
      if (helpers.isRateLimited(error)) {
        res.status(429).json({ kind: 'rate_limited', retry_after: error.retryAfter });
        return;
      }
      log.error({ err: error }, 'portal post-back redirect failed: backend unavailable');
      res.status(503).json({ result: 'unavailable' });
    }
  });
}
