/**
 * Access Points page (DECISIONS.md D-045):
 *
 *  - `GET  /api/v1/orgs/{orgId}/access-points/overview[?site_id=]` (`nas:read`): the setup
 *    progress computed from real data (NAS added → RADIUS secret configured → AP MAC registered →
 *    first RADIUS request seen → first accepted guest login), the NAS of the scope with their
 *    vendor and observed RADIUS activity, the access points joined with their NAS vendor, and
 *    the optional support address (PUBLIC_SUPPORT_EMAIL).
 *  - `POST /api/v1/orgs/{orgId}/nas/{id}/secret/reveal` (`nas:secret:reveal`, org_admin + platform_super_admin):
 *    returns the stored RADIUS secret after a FRESH TOTP code (MFA step-up). Administrator
 *    session only, refused while impersonating, rate limited per administrator and locked out
 *    after repeated wrong codes (login lockout semantics, fails closed), a code is accepted once,
 *    audited `nas:secret:revealed` WITHOUT the value, `Cache-Control: no-store`.
 *  - `GET  /api/v1/orgs/{orgId}/nas/{id}/mikrotik-script` (`nas:read`, `mikrotik-hotspot`
 *    only): RouterOS script download; never contains the secret.
 *  - `GET  /api/v1/orgs/{orgId}/nas/{id}/mikrotik-login-html` (`nas:read`, `mikrotik-hotspot`
 *    only): the Cycle B login.html (no secret, no script) as a download.
 */
import {
  GALLERY_ENTRIES,
  MIKROTIK_PORTAL_PATH,
  POSTBACK_ADAPTER_KEY,
  getGalleryEntry,
  renderMikrotikLoginHtml,
} from '@ecloud/adapters';
import { withPlatform } from '@ecloud/db';
import { AppError, NotFoundError, ValidationError } from '@ecloud/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requestIsImpersonating } from '../auth/middleware.js';
import { MfaCodec } from '../auth/mfa.js';
import { AUTHN_ACCESS } from '../auth/principal.js';
import {
  SECRET_REVEAL_LIMITS,
  assertKeyNotLocked,
  clearKeyFailures,
  hitLimit,
  recordKeyFailure,
} from '../auth/rate-limit.js';
import type { AppDeps, Principal } from '../context.js';
import { Envelope, NAS_SECRET_PURPOSE, SECRET_REF_PREFIX, openSecretRef } from '../crypto.js';
import { nasActivity, nasFilter, resolveScope, siteFilter } from '../dashboard-queries.js';
import { activityDefinition, activityThresholds } from '../dashboard-views.js';
import { OrgIdParams, OrgParams, problemResponses } from '../http/common.js';
import { ImpersonationForbiddenError, ServiceUnavailableError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec, type HandlerResult } from '../http/route.js';
import { mikrotikScriptFilename, renderMikrotikScript } from '../mikrotik-script.js';
import { logAuthFailure } from '../security-events.js';
import { inTenant, requireOnSite } from '../tenant.js';
import { loose } from './crud.js';

export const MIKROTIK_ADAPTER = 'mikrotik-hotspot';
/** Access points returned by the overview (newest first); beyond it `truncated` is set. */
export const OVERVIEW_AP_CAP = 1_000;
/** A TOTP code is accepted once per administrator within its validity window (±1 step). */
const USED_CODE_TTL_S = 120;

export const SETUP_STEP_KEYS = [
  'nas_added',
  'radius_secret',
  'ap_registered',
  'radius_seen',
  'guest_login',
] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export const SETUP_STEP_LABELS: Readonly<Record<SetupStepKey, string>> = {
  nas_added: 'NAS added',
  radius_secret: 'RADIUS secret configured',
  ap_registered: 'AP MAC registered',
  radius_seen: 'First RADIUS request seen',
  guest_login: 'First successful guest login',
};

export interface SetupFacts {
  nasCount: number;
  nasWithSecret: number;
  accessPoints: number;
  nasWithActivity: number;
  acceptedLogins: boolean;
}

/** The five setup steps in order; `completed` counts the steps that are done. */
export function setupProgress(f: SetupFacts): {
  steps: { key: SetupStepKey; label: string; done: boolean }[];
  completed: number;
  total: number;
} {
  const done: Record<SetupStepKey, boolean> = {
    nas_added: f.nasCount > 0,
    radius_secret: f.nasWithSecret > 0,
    ap_registered: f.accessPoints > 0,
    radius_seen: f.nasWithActivity > 0,
    guest_login: f.acceptedLogins,
  };
  const steps = SETUP_STEP_KEYS.map((key) => ({
    key,
    label: SETUP_STEP_LABELS[key],
    done: done[key],
  }));
  return {
    steps,
    completed: steps.filter((s) => s.done).length,
    total: steps.length,
  };
}

/**
 * The setup-guide vendor of a NAS: the vendor chosen in the wizard (migration 033), else the
 * first non-long-tail gallery entry of its adapter (and post-back profile); the generic
 * post-back profile maps to "Any vendor: external portal".
 */
export function nasVendor(nas: {
  vendor_key: string | null;
  adapter_key: string | null;
  adapter_config: unknown;
}): { vendor_key: string; vendor_name: string } | null {
  if (nas.vendor_key !== null) {
    const chosen = getGalleryEntry(nas.vendor_key);
    if (chosen !== null) return { vendor_key: chosen.vendorKey, vendor_name: chosen.displayName };
  }
  if (nas.adapter_key === null) return null;
  const profile =
    nas.adapter_key === POSTBACK_ADAPTER_KEY &&
    typeof nas.adapter_config === 'object' &&
    nas.adapter_config !== null
      ? (nas.adapter_config as { profile?: unknown }).profile
      : undefined;
  const candidates = GALLERY_ENTRIES.filter(
    (e) =>
      e.adapterKey === nas.adapter_key &&
      (nas.adapter_key !== POSTBACK_ADAPTER_KEY || e.profile === profile),
  );
  const entry =
    candidates.find((e) => !e.longTail) ??
    candidates.find((e) => e.vendorKey === 'generic-portal') ??
    candidates[0];
  return entry === undefined
    ? null
    : { vendor_key: entry.vendorKey, vendor_name: entry.displayName };
}

const ActivityEnum = z.enum(['active', 'quiet', 'silent', 'never']);

const OverviewSchema = z.object({
  progress: z.object({
    steps: z.array(
      z.object({ key: z.enum(SETUP_STEP_KEYS), label: z.string(), done: z.boolean() }),
    ),
    completed: z.number(),
    total: z.number(),
  }),
  /** PUBLIC_SUPPORT_EMAIL; null = no "contact us" link. */
  support_email: z.string().nullable(),
  activity_definition: z.string(),
  nas: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      site_id: z.string(),
      site_name: z.string(),
      adapter_key: z.string().nullable(),
      vendor_key: z.string().nullable(),
      vendor_name: z.string().nullable(),
      nas_ip: z.string().nullable(),
      status: z.string(),
      has_secret: z.boolean(),
      activity: ActivityEnum,
      last_activity_at: z.string().nullable(),
      access_points: z.number(),
    }),
  ),
  access_points: z.array(
    z.object({
      id: z.string(),
      mac: z.string(),
      name: z.string().nullable(),
      status: z.string(),
      site_id: z.string(),
      nas_client_id: z.string(),
      nas_name: z.string(),
      adapter_key: z.string().nullable(),
      vendor_key: z.string().nullable(),
      vendor_name: z.string().nullable(),
      verified: z.boolean(),
      verified_at: z.string().nullable(),
      verification_source: z.string().nullable(),
      activity: ActivityEnum,
      created_at: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

/** `code` is required only with ADMIN_MFA_MODE=required (D-046); with `off` the body is `{}`. */
const RevealBody = z.strictObject({
  code: z
    .string()
    .regex(/^[0-9]{6}$/, '6-digit code')
    .optional(),
});

const iso = (d: Date | null | undefined): string | null =>
  d instanceof Date ? d.toISOString() : null;

export function accessPointsPageRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = () => (deps.now ?? (() => new Date()))();
  const mfa = new MfaCodec(deps.config.mfaEncryptionKey);
  const nasEnvelope = new Envelope(deps.config.dataEncryptionKey, NAS_SECRET_PURPOSE);

  const overview = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/access-points/overview',
    summary:
      'Access Points page: setup progress, NAS with vendor and observed activity, access points (D-045)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:read',
    scope: 'any-site',
    params: OrgParams,
    query: z.object({ site_id: z.uuid().optional() }),
    responses: { 200: { description: 'Overview', schema: OverviewSchema }, ...problemResponses },
    handler: async ({ params, query, ctx }) => {
      const at = now();
      const t = activityThresholds(deps.config.aaaInterimIntervalS);
      const body = await inTenant(deps, params.orgId, async (trx) => {
        const scope = await resolveScope(trx, ctx, params.orgId, 'nas:read', query.site_id);
        const activity = await nasActivity(trx, [scope.orgId], scope, at, t);
        const extra = await sql<{
          id: string;
          vendor_key: string | null;
          adapter_key: string | null;
          adapter_config: unknown;
          secret_ref: string;
        }>`
          SELECT n.id, n.vendor_key, n.adapter_key, n.adapter_config, n.secret_ref
          FROM nas_clients n
          WHERE n.organization_id = ${scope.orgId} AND n.deleted_at IS NULL
            AND ${siteFilter(scope, 'n.site_id')}
            AND ${
              activity.rows.length === 0
                ? sql<boolean>`false`
                : sql<boolean>`n.id IN (${sql.join(activity.rows.map((r) => r.nas_client_id))})`
            }
        `.execute(trx);
        const byId = new Map(extra.rows.map((r) => [r.id, r]));
        const aps = await sql<{
          id: string;
          mac: string;
          name: string | null;
          status: string;
          site_id: string;
          nas_client_id: string;
          verified_at: Date | null;
          verification_source: string | null;
          created_at: Date;
          nas_name: string;
          adapter_key: string | null;
          vendor_key: string | null;
          adapter_config: unknown;
        }>`
          SELECT ap.id, ap.mac::text AS mac, ap.name, ap.status, ap.site_id, ap.nas_client_id,
                 ap.verified_at, ap.verification_source, ap.created_at,
                 n.name AS nas_name, n.adapter_key, n.vendor_key, n.adapter_config
          FROM nas_access_points ap
          JOIN nas_clients n ON n.id = ap.nas_client_id AND n.deleted_at IS NULL
          WHERE ap.organization_id = ${scope.orgId} AND ap.deleted_at IS NULL
            AND ${siteFilter(scope, 'ap.site_id')}
          ORDER BY ap.created_at DESC, ap.id
          LIMIT ${OVERVIEW_AP_CAP + 1}
        `.execute(trx);
        const apCount = await sql<{ n: string }>`
          SELECT count(*) AS n FROM nas_access_points ap
          WHERE ap.organization_id = ${scope.orgId} AND ap.deleted_at IS NULL
            AND ${siteFilter(scope, 'ap.site_id')}
        `.execute(trx);
        const apsPerNas = await sql<{ nas_client_id: string; n: string }>`
          SELECT ap.nas_client_id, count(*) AS n FROM nas_access_points ap
          WHERE ap.organization_id = ${scope.orgId} AND ap.deleted_at IS NULL
            AND ${siteFilter(scope, 'ap.site_id')}
          GROUP BY ap.nas_client_id
        `.execute(trx);
        const accepted = await sql<{ one: number }>`
          SELECT 1 AS one FROM auth_events ae
          WHERE ae.organization_id = ${scope.orgId} AND ae.result = 'accept'
            AND ae.nas_client_id IS NOT NULL AND ${nasFilter(scope, 'ae.nas_client_id')}
          LIMIT 1
        `.execute(trx);

        const apsByNas = new Map(apsPerNas.rows.map((r) => [r.nas_client_id, Number(r.n)]));
        const activityByNas = new Map(activity.rows.map((r) => [r.nas_client_id, r.activity]));
        const nas = activity.rows.map((r) => {
          const x = byId.get(r.nas_client_id);
          const vendor =
            x === undefined
              ? null
              : nasVendor({
                  vendor_key: x.vendor_key,
                  adapter_key: x.adapter_key,
                  adapter_config: x.adapter_config,
                });
          return {
            id: r.nas_client_id,
            name: r.name,
            site_id: r.site_id,
            site_name: r.site_name,
            adapter_key: x?.adapter_key ?? null,
            vendor_key: vendor?.vendor_key ?? null,
            vendor_name: vendor?.vendor_name ?? null,
            nas_ip: r.nas_ip === '' ? null : r.nas_ip,
            status: r.admin_status,
            has_secret: x?.secret_ref.startsWith(SECRET_REF_PREFIX) ?? false,
            activity: r.activity,
            last_activity_at: r.last_activity_at,
            access_points: apsByNas.get(r.nas_client_id) ?? 0,
          };
        });
        const accessPoints = aps.rows.slice(0, OVERVIEW_AP_CAP).map((r) => {
          const vendor = nasVendor(r);
          return {
            id: r.id,
            mac: r.mac,
            name: r.name,
            status: r.status,
            site_id: r.site_id,
            nas_client_id: r.nas_client_id,
            nas_name: r.nas_name,
            adapter_key: r.adapter_key,
            vendor_key: vendor?.vendor_key ?? null,
            vendor_name: vendor?.vendor_name ?? null,
            verified: r.verified_at !== null,
            verified_at: iso(r.verified_at),
            verification_source: r.verification_source,
            activity: activityByNas.get(r.nas_client_id) ?? ('never' as const),
            created_at: r.created_at.toISOString(),
          };
        });
        return {
          progress: setupProgress({
            nasCount: nas.length,
            nasWithSecret: nas.filter((n) => n.has_secret).length,
            accessPoints: Number(apCount.rows[0]?.n ?? 0),
            nasWithActivity: nas.filter((n) => n.activity !== 'never').length,
            acceptedLogins: accepted.rows.length > 0,
          }),
          support_email: deps.config.supportEmail,
          activity_definition: activityDefinition(t),
          nas,
          access_points: accessPoints,
          truncated: activity.truncated || aps.rows.length > OVERVIEW_AP_CAP,
        };
      });
      return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
    },
  });

  const reveal = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/nas/:id/secret/reveal',
    summary:
      'Reveal the RADIUS shared secret of a NAS after a fresh MFA code (D-045; audited, never cached)',
    tags: ['nas'],
    auth: 'session',
    permission: 'nas:secret:reveal',
    scope: 'any-site',
    params: OrgIdParams,
    body: RevealBody,
    secretFields: ['secret'],
    responses: {
      200: { description: 'The secret (no-store)', schema: z.object({ secret: z.string() }) },
      ...problemResponses,
    },
    handler: async ({ params, body, req, ctx }): Promise<HandlerResult> => {
      if (requestIsImpersonating(req)) throw new ImpersonationForbiddenError('nas:secret:reveal');
      const principal = ctx.principal as Extract<Principal, { kind: 'admin' }>;
      const adminId = principal.administratorId;
      const lockKey = `nas-reveal:${adminId}`;
      await hitLimit(
        deps,
        `nas-reveal:admin:${adminId}`,
        SECRET_REVEAL_LIMITS.perAdministrator,
        SECRET_REVEAL_LIMITS.windowSeconds,
      );
      // Per NAS (within the organization, so another tenant cannot burn this NAS's budget).
      await hitLimit(
        deps,
        `nas-reveal:nas:${params.orgId}:${params.id}`,
        SECRET_REVEAL_LIMITS.perNas,
        SECRET_REVEAL_LIMITS.windowSeconds,
      );
      // D-046: a fresh TOTP code only with ADMIN_MFA_MODE=required (replay-protected, lockout);
      // with `off` the reveal is a one-click action behind the same permission / site /
      // impersonation checks, the same rate limits and the same audit.
      if (deps.config.adminMfaMode === 'required') {
        if (body.code === undefined) {
          throw new ValidationError([{ path: 'body.code', message: '6-digit code required' }]);
        }
        await assertKeyNotLocked(deps, lockKey);
        const credential = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, (trx) =>
          trx
            .selectFrom('mfa_credentials')
            .select(['id', 'secret_enc'])
            .where('administrator_id', '=', adminId)
            .where('type', '=', 'totp')
            .where('verified_at', 'is not', null)
            .executeTakeFirst(),
        );
        if (credential === undefined) {
          throw new AppError(403, 'mfa-enrolment-required', 'MFA enrolment required', {
            detail: 'Enrol an authenticator app (MFA) before revealing a secret.',
          });
        }
        let fresh = false;
        const code = body.code ?? '';
        if (await mfa.check(mfa.open(credential.secret_enc), code)) {
          // A code proves presence once: a replayed (observed) code is refused like a wrong one.
          try {
            fresh = await deps.kv.set(
              `nas-reveal:used:${adminId}:${code}`,
              '1',
              USED_CODE_TTL_S,
              true,
            );
          } catch {
            throw new ServiceUnavailableError('Rate limiter unavailable; the reveal is refused.');
          }
        }
        if (!fresh) {
          await recordKeyFailure(deps, lockKey, SECRET_REVEAL_LIMITS.mfaFailures);
          logAuthFailure(deps.logger, 'admin_mfa_failed', ctx.ip, ctx.requestId);
          throw new AppError(403, 'mfa-code-invalid', 'Invalid MFA code', {
            detail: 'The MFA code is wrong or was already used. Enter a new code.',
          });
        }
        await clearKeyFailures(deps, lockKey);
      }

      const secret = await inTenant(deps, params.orgId, async (trx) => {
        const nas = await loose(trx)
          .selectFrom('nas_clients')
          .select(['id', 'site_id', 'secret_ref'])
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (nas === undefined) throw new NotFoundError('nas_client', params.id);
        requireOnSite(
          ctx,
          'nas:secret:reveal',
          params.orgId,
          nas.site_id as string,
          'nas_client',
          'nas:read',
        );
        const value = openSecretRef(nasEnvelope, nas.secret_ref as string);
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'nas:secret:revealed',
          targetType: 'nas_client',
          targetId: params.id,
          // Never the value: who revealed what, and how the step-up was proven.
          after: { revealed: true, mfa: 'totp' },
        });
        return value;
      });
      return {
        status: 200,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
        body: { secret },
      };
    },
  });

  /** The live MikroTik NAS the caller may read, or 404 / 422. */
  async function mikrotikNas(
    orgId: string,
    id: string,
    ctx: Parameters<typeof requireOnSite>[0],
  ): Promise<{
    id: string;
    name: string;
    nas_ip: string | null;
    nas_identifier: string | null;
    coa_port: number | null;
  }> {
    const nas = await inTenant(deps, orgId, (trx) =>
      loose(trx)
        .selectFrom('nas_clients')
        .select([
          'id',
          'name',
          'site_id',
          'adapter_key',
          sql<string | null>`host(nas_ip)`.as('nas_ip'),
          'nas_identifier',
          'coa_port',
        ])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    );
    if (nas === undefined) throw new NotFoundError('nas_client', id);
    requireOnSite(ctx, 'nas:read', orgId, nas.site_id as string, 'nas_client');
    if (nas.adapter_key !== MIKROTIK_ADAPTER) {
      throw new AppError(422, 'adapter-mismatch', 'Not a MikroTik NAS', {
        detail: `Only ${MIKROTIK_ADAPTER} NAS have a MikroTik installation script.`,
      });
    }
    return {
      id: nas.id as string,
      name: nas.name as string,
      nas_ip: nas.nas_ip ?? null,
      nas_identifier: (nas.nas_identifier as string | null) ?? null,
      coa_port: (nas.coa_port as number | null) ?? null,
    };
  }

  const script = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/nas/:id/mikrotik-script',
    summary:
      'Download the RouterOS installation script of a MikroTik NAS (no secret inside; D-045)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: {
      200: {
        description: 'RouterOS script (attachment)',
        schema: z.string(),
        contentType: 'text/plain',
      },
      422: { description: 'Not a mikrotik-hotspot NAS (application/problem+json)' },
      ...problemResponses,
    },
    handler: async ({ params, ctx }): Promise<HandlerResult> => {
      const nas = await mikrotikNas(params.orgId, params.id, ctx);
      const text = renderMikrotikScript({
        nas: {
          id: nas.id,
          name: nas.name,
          nasIp: nas.nas_ip,
          nasIdentifier: nas.nas_identifier,
          coaPort: nas.coa_port,
        },
        radiusAddress: deps.config.setupGuide.radiusAddress,
        authPort: deps.config.setupGuide.authPort,
        acctPort: deps.config.setupGuide.acctPort,
        portalOrigin: deps.config.base.origins.portal,
        generatedAt: now(),
      });
      return {
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        headers: {
          'Content-Disposition': `attachment; filename="${mikrotikScriptFilename(nas.name, nas.id)}"`,
          'Cache-Control': 'no-store',
        },
        body: text,
      };
    },
  });

  const loginHtml = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/nas/:id/mikrotik-login-html',
    summary: 'Download the ECLOUD login.html of a MikroTik NAS HotSpot (Cycle B generator)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: {
      200: {
        description: 'login.html (attachment)',
        schema: z.string(),
        contentType: 'text/html',
      },
      409: { description: 'The portal origin is not https (application/problem+json)' },
      422: { description: 'Not a mikrotik-hotspot NAS (application/problem+json)' },
      ...problemResponses,
    },
    handler: async ({ params, ctx }): Promise<HandlerResult> => {
      await mikrotikNas(params.orgId, params.id, ctx);
      let html: string;
      try {
        html = renderMikrotikLoginHtml(`${deps.config.base.origins.portal}${MIKROTIK_PORTAL_PATH}`);
      } catch {
        throw new AppError(409, 'portal-origin-not-https', 'Portal origin is not https', {
          detail:
            'The MikroTik login.html needs an https PUBLIC_PORTAL_ORIGIN (RouterOS forwards the guest to it).',
        });
      }
      return {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: {
          'Content-Disposition': 'attachment; filename="login.html"',
          'Cache-Control': 'no-store',
        },
        body: html,
      };
    },
  });

  return [overview, reveal, script, loginHtml];
}
