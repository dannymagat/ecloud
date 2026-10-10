/**
 * Cisco Meraki cloud-sourced RADIUS (multi-vendor Cycle E, D-044; SECURITY_ARCHITECTURE.md §3.5;
 * migration 032):
 *
 *  - NAS create / patch rules for `adapter_key = 'meraki-splash'` (called from resources.ts):
 *    no `nas_ip` (RADIUS comes from the Meraki Cloud), a NAS-Identifier is mandatory
 *    (`MERAKI_NAS_IDENTIFIER_RE`, unique among live Meraki NAS: generic 409), `das_host` only in
 *    the documented `n<digits>.meraki.com` shape, and a dedicated listener port pair allocated
 *    from MERAKI_RADIUS_PORT_RANGE (none when the range is not configured).
 *  - `GET /api/v1/orgs/{orgId}/nas/{id}/setup-guide`: the adapter's setup steps with the
 *    non-secret placeholder values resolved and honest warnings (the RADIUS secret is never
 *    shown here; it is returned once at creation / rotation).
 *  - `GET /api/v1/orgs/{orgId}/meraki/cloud-radius`: the platform flag state, so the admin UI
 *    can say plainly whether RADIUS from the Meraki Cloud can reach ECLOUD at all.
 */
import {
  MERAKI_DAS_HOST_RE,
  POSTBACK_ADAPTER_KEY,
  getVendorAdapter,
  postbackAdapterForNas,
  type SetupStep,
} from '@ecloud/adapters';
import { withPlatform, type DbTransaction } from '@ecloud/db';
import {
  MERAKI_DAS_PORT,
  NotFoundError,
  isMerakiSourceAddress,
  merakiCloudRadiusState,
  merakiPortPairs,
  type MerakiCloudRadiusSettings,
  type MerakiCloudRadiusState,
} from '@ecloud/shared';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { OrgIdParams, OrgParams, problemResponses } from '../http/common.js';
import { UnprocessableError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inPlatform, inTenant, requireOnSite } from '../tenant.js';
import { writeAudit } from '../audit.js';
import { requestIsImpersonating } from '../auth/middleware.js';
import { ImpersonationForbiddenError } from '../http/errors.js';
import { softDeleteAccessPointsOf } from './access-points.js';
import { loose, type Row } from './crud.js';

export const MERAKI_ADAPTER = 'meraki-splash';

/** Advisory lock key serialising port allocation across concurrent NAS creations. */
const PORT_LOCK = 'ecloud:meraki:listener-port-allocation';

function unprocessable(field: string, detail: string): UnprocessableError {
  return new UnprocessableError(detail, { field });
}

/**
 * Picks a free listener pair (auth even, acct = auth + 1). The advisory lock is taken in the
 * creating TENANT transaction (held until it commits), then live ports of ALL organizations are
 * read through the platform role (RLS would hide other tenants' ports). The unique index
 * `uq_nas_clients_cloud_radius_auth_port` is the final backstop (generic 409).
 */
export async function allocateMerakiPortPair(
  deps: AppDeps,
  trx: DbTransaction,
): Promise<{ auth: number; acct: number } | null> {
  const range = deps.config.merakiCloudRadius.portRange;
  if (range === null) return null;
  await sql`SELECT pg_advisory_xact_lock(hashtext(${PORT_LOCK}))`.execute(trx);
  const used = await withPlatform(
    deps.dbPlatform,
    { reason: 'nas:meraki:port-allocation', audit: false },
    (p) =>
      p
        .selectFrom('nas_clients')
        .select(['cloud_radius_auth_port'])
        .where('deleted_at', 'is', null)
        .where('cloud_radius_auth_port', 'is not', null)
        .execute(),
  );
  const taken = new Set(used.map((r) => Number(r.cloud_radius_auth_port)));
  return merakiPortPairs(range).find((p) => !taken.has(p.auth)) ?? null;
}

/** Server-generated Meraki NAS-Identifier shape (migration 032 CHECKs; review F3). */
export const MERAKI_GENERATED_IDENTIFIER_RE = /^ecloud-[0-9a-f]{16}$/;

/** `ecloud-<16 hex>`: unguessable, so nobody can pre-register or squat a tenant's identifier. */
export function generateMerakiIdentifier(): string {
  return `ecloud-${randomBytes(8).toString('hex')}`;
}

function checkDasHost(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !MERAKI_DAS_HOST_RE.test(value)) {
    throw unprocessable(
      'das_host',
      'das_host must be the Meraki dashboard host shown in the Dashboard URL (n<digits>.meraki.com).',
    );
  }
}

function checkMessageAuthenticator(deps: AppDeps, value: unknown): void {
  if (value === false && !deps.config.merakiCloudRadius.allowRelaxedMessageAuthenticator) {
    throw unprocessable(
      'require_message_authenticator',
      'Meraki NAS always require Message-Authenticator unless the platform sets MERAKI_ALLOW_RELAXED_MSGAUTH=true.',
    );
  }
}

/** Non-Meraki rules shared by create and patch (review F2 / F3). */
function checkNonMeraki(deps: AppDeps, body: Row): void {
  if (
    typeof body.nas_ip === 'string' &&
    isMerakiSourceAddress(deps.config.merakiCloudRadius, body.nas_ip)
  ) {
    throw unprocessable(
      'nas_ip',
      'This address is a Meraki Cloud RADIUS source shared by every Meraki customer; it cannot identify a NAS.',
    );
  }
  if (
    typeof body.nas_identifier === 'string' &&
    MERAKI_GENERATED_IDENTIFIER_RE.test(body.nas_identifier)
  ) {
    throw unprocessable(
      'nas_identifier',
      'NAS-Identifiers of the form ecloud-<16 hex> are reserved for Meraki NAS.',
    );
  }
  if (body.das_host !== undefined && body.das_host !== null) {
    throw unprocessable('das_host', 'das_host applies to Meraki NAS only.');
  }
}

/** NAS create rules (resources.ts prepareCreate); returns the extra / overridden columns. */
export async function prepareNasCreate(deps: AppDeps, body: Row, trx: DbTransaction): Promise<Row> {
  if (body.adapter_key !== MERAKI_ADAPTER) {
    if (body.nas_ip === undefined || body.nas_ip === null) {
      throw unprocessable('nas_ip', 'nas_ip is required for this adapter.');
    }
    checkNonMeraki(deps, body);
    return {};
  }
  if (body.nas_ip !== undefined && body.nas_ip !== null) {
    throw unprocessable(
      'nas_ip',
      'A Meraki NAS has no nas_ip: its RADIUS comes from the Meraki Cloud (D-044).',
    );
  }
  if (body.nas_identifier !== undefined && body.nas_identifier !== null) {
    throw unprocessable(
      'nas_identifier',
      'The NAS-Identifier of a Meraki NAS is generated by ECLOUD (set it as the custom NAS-ID in Meraki).',
    );
  }
  checkDasHost(body.das_host);
  checkMessageAuthenticator(deps, body.require_message_authenticator);
  // Review F6: every Meraki NAS opens a public listener pair; cap them per organization.
  const live = await loose(trx)
    .selectFrom('nas_clients')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('adapter_key', '=', MERAKI_ADAPTER)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (Number(live?.n ?? 0) >= deps.config.merakiCloudRadius.maxNasPerOrg) {
    throw new UnprocessableError(
      `This organization already has the maximum of ${String(deps.config.merakiCloudRadius.maxNasPerOrg)} Meraki NAS (MERAKI_MAX_NAS_PER_ORG).`,
      { field: 'adapter_key' },
    );
  }
  const pair = await allocateMerakiPortPair(deps, trx);
  return {
    nas_ip: null,
    nas_identifier: generateMerakiIdentifier(),
    require_message_authenticator: body.require_message_authenticator === false ? false : true,
    cloud_radius_auth_port: pair?.auth ?? null,
    cloud_radius_acct_port: pair?.acct ?? null,
  };
}

/** NAS patch rules (resources.ts preparePatch). The adapter family cannot be switched. */
export function checkNasPatch(deps: AppDeps, body: Row, before: Row): void {
  const wasMeraki = before.adapter_key === MERAKI_ADAPTER;
  if (typeof body.adapter_key === 'string' && (body.adapter_key === MERAKI_ADAPTER) !== wasMeraki) {
    throw unprocessable(
      'adapter_key',
      'A NAS cannot be switched to or from meraki-splash; create a new NAS instead.',
    );
  }
  if (wasMeraki) {
    if (body.nas_ip !== undefined && body.nas_ip !== null) {
      throw unprocessable('nas_ip', 'A Meraki NAS has no nas_ip (D-044).');
    }
    if (body.nas_identifier !== undefined && body.nas_identifier !== before.nas_identifier) {
      throw unprocessable(
        'nas_identifier',
        'The NAS-Identifier of a Meraki NAS is generated by ECLOUD and read-only.',
      );
    }
    checkDasHost(body.das_host);
    checkMessageAuthenticator(deps, body.require_message_authenticator);
    return;
  }
  if (body.nas_ip === null) throw unprocessable('nas_ip', 'nas_ip is required for this adapter.');
  checkNonMeraki(deps, body);
}

// ---------------------------------------------------------------------------------------------
// Status + setup guide
// ---------------------------------------------------------------------------------------------

const STATE_TEXT: Readonly<Record<MerakiCloudRadiusState, string>> = {
  disabled:
    'OFF (platform setting MERAKI_CLOUD_RADIUS_ENABLED=false). RADIUS from the Meraki Cloud cannot reach ECLOUD: no Meraki listener is rendered and Meraki requests are refused. The LAN-only pilot (D-043) does not allow public RADIUS exposure.',
  enabled_missing_source_cidrs:
    'ENABLED but MERAKI_RADIUS_SOURCE_CIDRS is empty: no Meraki listener is rendered (fail closed).',
  enabled_missing_port_range:
    'ENABLED but MERAKI_RADIUS_PORT_RANGE is not set: no listener port can be allocated.',
  enabled:
    'ENABLED in configuration. Public reachability of the listener ports from the Meraki Cloud is a deployment step ECLOUD cannot observe (REQUIRES_DEVICE_TEST).',
};

export function merakiStatusBody(s: MerakiCloudRadiusSettings): z.infer<typeof StatusSchema> {
  const state = merakiCloudRadiusState(s);
  return {
    enabled: s.enabled,
    state,
    message: STATE_TEXT[state],
    source_cidrs: [...s.sourceCidrs],
    port_range: s.portRange === null ? null : { min: s.portRange.min, max: s.portRange.max },
    das_port: MERAKI_DAS_PORT,
    radius_reachable_from_meraki: state === 'enabled' ? 'unverified' : 'no',
  };
}

const StatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum([
    'disabled',
    'enabled_missing_source_cidrs',
    'enabled_missing_port_range',
    'enabled',
  ]),
  message: z.string(),
  source_cidrs: z.array(z.string()),
  port_range: z.object({ min: z.number(), max: z.number() }).nullable(),
  das_port: z.number(),
  radius_reachable_from_meraki: z.enum(['no', 'unverified']),
});

const SetupGuideSchema = z.object({
  /** Cycle C name of the NAS id (kept alongside Cycle E's `nas_id`). */
  id: z.string(),
  nas_id: z.string(),
  adapter_key: z.string().nullable(),
  /** Cycle C: the post-back profile key of an `external-portal-postback` NAS, else null. */
  profile: z.string().nullable(),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      setting: z.string(),
      value: z.string(),
      evidence: z.array(z.string()),
    }),
  ),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  meraki: StatusSchema.nullable(),
});

interface GuideRow {
  id: string;
  site_id: string;
  adapter_key: string | null;
  nas_identifier: string | null;
  cloud_radius_auth_port: number | null;
  cloud_radius_acct_port: number | null;
  das_host: string | null;
  require_message_authenticator: boolean;
  nas_ip: string | null;
  adapter_config: Record<string, unknown> | null;
}

/** Fills the non-secret placeholders of the Meraki guide; `<RADIUS_SECRET>` is never filled. */
export function resolveMerakiGuide(
  steps: readonly SetupStep[],
  row: GuideRow,
  settings: MerakiCloudRadiusSettings,
  portalOrigin: string,
): { steps: SetupStep[]; warnings: { code: string; message: string }[] } {
  const origin = portalOrigin.replace(/\/+$/, '');
  const state = merakiCloudRadiusState(settings);
  const warnings: { code: string; message: string }[] = [];
  if (state !== 'enabled') warnings.push({ code: `meraki_${state}`, message: STATE_TEXT[state] });
  if (row.cloud_radius_auth_port === null) {
    warnings.push({
      code: 'meraki_no_listener_port',
      message:
        'No listener port is allocated to this NAS (MERAKI_RADIUS_PORT_RANGE not configured when it was created). REQUIRES_CLARIFICATION.',
    });
  }
  if (row.das_host === null) {
    warnings.push({
      code: 'meraki_no_das_host',
      message: 'No Disconnect host registered: ECLOUD cannot disconnect sessions of this NAS.',
    });
  }
  warnings.push({
    code: 'meraki_public_address_unknown',
    message:
      'The public ECLOUD RADIUS address for Meraki is not defined for this deployment (REQUIRES_CLARIFICATION, D-043).',
  });
  const identifier = row.nas_identifier ?? '<NAS_IDENTIFIER>';
  const values: Record<string, string> = {
    '<MERAKI_CLOUD_RADIUS_STATE>': state,
    '<MERAKI_AUTH_PORT>':
      row.cloud_radius_auth_port === null ? 'not allocated' : String(row.cloud_radius_auth_port),
    '<MERAKI_ACCT_PORT>':
      row.cloud_radius_acct_port === null ? 'not allocated' : String(row.cloud_radius_acct_port),
    '<NAS_IDENTIFIER>': identifier,
    '<PORTAL_MERAKI_URL>': `${origin}/meraki/${encodeURIComponent(identifier)}/`,
    '<PORTAL_HOST>': new URL(origin).host,
    '<MERAKI_SOURCE_CIDRS>':
      settings.sourceCidrs.length === 0 ? 'not configured' : settings.sourceCidrs.join(', '),
    '<MERAKI_DAS_HOST>': row.das_host ?? 'not registered',
    '<REQUIRE_MESSAGE_AUTHENTICATOR>': row.require_message_authenticator ? 'yes' : 'no',
  };
  const fill = (text: string) =>
    text.replace(/<[A-Z_]+>/g, (token) => (token in values ? (values[token] as string) : token));
  return {
    steps: steps.map((s) => ({ ...s, value: fill(s.value) })),
    warnings,
  };
}

export function merakiRoutes(deps: AppDeps): AnyRouteSpec[] {
  const status = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/meraki/cloud-radius',
    summary: 'Meraki cloud-sourced RADIUS platform state (Cycle E, D-044)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:read',
    scope: 'organization',
    params: OrgParams,
    responses: { 200: { description: 'State', schema: StatusSchema }, ...problemResponses },
    handler: () =>
      Promise.resolve({ status: 200, body: merakiStatusBody(deps.config.merakiCloudRadius) }),
  });

  const guide = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/nas/:id/setup-guide',
    summary: 'Setup guide of a NAS (non-secret values resolved; secrets never shown)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: { 200: { description: 'Guide', schema: SetupGuideSchema }, ...problemResponses },
    handler: async ({ params, ctx }) => {
      const row = (await inTenant(deps, params.orgId, (trx) =>
        loose(trx)
          .selectFrom('nas_clients')
          .select([
            'id',
            'site_id',
            'adapter_key',
            'nas_identifier',
            'cloud_radius_auth_port',
            'cloud_radius_acct_port',
            'das_host',
            'require_message_authenticator',
            'nas_ip',
            'adapter_config',
          ])
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      )) as GuideRow | undefined;
      if (row === undefined) throw new NotFoundError('nas_client', params.id);
      requireOnSite(ctx, 'nas:read', params.orgId, row.site_id, 'nas_client', 'nas:read');
      // Cycle C: values filled from the NAS (portal URL with its NAS identifier); Cycle E: the
      // Meraki placeholders are resolved below by resolveMerakiGuide.
      const site = { siteId: row.site_id, nasId: row.nas_identifier ?? '<NAS_IDENTIFIER>' };
      let profile: string | null = null;
      let steps: readonly SetupStep[] = [];
      if (row.adapter_key === POSTBACK_ADAPTER_KEY) {
        const built = postbackAdapterForNas({
          adapterConfig: row.adapter_config ?? {},
          nasIp: String(row.nas_ip),
        });
        profile = built?.profile.key ?? null;
        steps = built === null ? [] : built.adapter.buildSetupGuide(site);
      } else if (row.adapter_key !== null) {
        try {
          steps = getVendorAdapter(row.adapter_key).buildSetupGuide(site);
        } catch {
          steps = [];
        }
      }
      const isMeraki = row.adapter_key === MERAKI_ADAPTER;
      const resolved = isMeraki
        ? resolveMerakiGuide(
            steps,
            row,
            deps.config.merakiCloudRadius,
            deps.config.base.origins.portal,
          )
        : { steps: [...steps], warnings: [] };
      return {
        status: 200,
        body: {
          id: row.id,
          nas_id: row.id,
          adapter_key: row.adapter_key,
          profile,
          steps: resolved.steps.map((s) => ({
            id: s.id,
            title: s.title,
            setting: s.setting,
            value: s.value,
            evidence: s.evidenceRefs.map((r) => r.ref),
          })),
          warnings: resolved.warnings,
          meraki: isMeraki ? merakiStatusBody(deps.config.merakiCloudRadius) : null,
        },
      };
    },
  });

  return [status, guide];
}

// ---------------------------------------------------------------------------------------------
// Platform: release a Meraki NAS-Identifier (review F3; same pattern as the Cycle A AP-MAC release)
// ---------------------------------------------------------------------------------------------

export const ReleaseMerakiIdentifierBody = z.strictObject({
  nas_identifier: z.string().regex(MERAKI_GENERATED_IDENTIFIER_RE),
  /** Ticket / justification, kept in the audit row. */
  reason: z.string().trim().min(10).max(500),
});

/**
 * `POST /api/v1/platform/meraki/nas-identifiers/release`: soft-deletes the live Meraki NAS that
 * holds the identifier in WHICHEVER organization (its listener disappears at the next render), so
 * the support path can free it. Platform scope, `organization:update`, refused while
 * impersonating, audited in the owning organization with the reason.
 */
export function merakiPlatformRoutes(deps: AppDeps): AnyRouteSpec[] {
  const release = defineRoute({
    method: 'post',
    path: '/api/v1/platform/meraki/nas-identifiers/release',
    summary: 'Release a Meraki NAS-Identifier held by any organization (support path)',
    tags: ['platform'],
    auth: 'principal',
    permission: 'organization:update',
    scope: 'platform',
    body: ReleaseMerakiIdentifierBody,
    responses: {
      200: {
        description: 'Released',
        schema: z.object({
          nas_identifier: z.string(),
          released: z.boolean(),
          organization_id: z.string().nullable(),
        }),
      },
      ...problemResponses,
    },
    handler: async ({ body, req, ctx }) => {
      if (requestIsImpersonating(req)) {
        throw new ImpersonationForbiddenError('organization:update');
      }
      const row = await inPlatform(deps, ctx, 'release meraki nas identifier', async (trx) => {
        const nas = await trx
          .updateTable('nas_clients')
          .set({ deleted_at: new Date() })
          .where('nas_identifier', '=', body.nas_identifier)
          .where('adapter_key', '=', MERAKI_ADAPTER)
          .where('deleted_at', 'is', null)
          .returning(['id', 'organization_id'])
          .executeTakeFirst();
        if (nas === undefined) return null;
        await softDeleteAccessPointsOf(trx, nas.id);
        await writeAudit(trx, ctx, {
          organizationId: nas.organization_id,
          action: 'nas:meraki_identifier:release',
          targetType: 'nas_client',
          targetId: nas.id,
          before: { nas_identifier: body.nas_identifier },
          after: { released: true, reason: body.reason },
        });
        return nas;
      });
      if (row === null) throw new NotFoundError('nas_client', body.nas_identifier);
      return {
        status: 200,
        body: {
          nas_identifier: body.nas_identifier,
          released: true,
          organization_id: row.organization_id,
        },
      };
    },
  });
  return [release];
}
