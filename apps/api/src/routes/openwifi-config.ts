/**
 * `openwifi-config` export route (Phase 7 P7-B AC2): the uCentral SSID rate-limit fragment of a
 * site's baseline policy, as an EXPORT / PREVIEW only. Nothing here contacts the EZE controller
 * (no push in Phase 7 — EZECONTROL is unchanged); the operator downloads the fragment and applies
 * it out of band. The fragment is schema-validated in `@ecloud/adapters` against the vendored
 * `ucentral.full.json`.
 *
 * "Site baseline" = the layers an SSID-wide setting can honestly represent: site assignments
 * and the organization default. User/group/device layers are never folded into an SSID cap
 * (per-SSID granularity, POLICY_ENGINE.md §3.1 row rate_limit openwifi-config).
 */
import {
  exportRateLimitFragment,
  getAdapter,
  isFragmentExport,
  type FragmentOmission,
} from '@ecloud/adapters';
import { resolveEffectivePolicy, toJsonValue } from '@ecloud/policy-engine';
import { AppError } from '@ecloud/shared';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { problemResponses } from '../http/common.js';
import { defineRoute, type AnyRouteSpec, type HandlerResult } from '../http/route.js';
import { loadResolutionInput } from '../policy-data.js';
import { assertRef, inTenant } from '../tenant.js';

/**
 * Resolution subject for the site baseline: a client-device id that can match no assignment,
 * usage counter or session, so only site + organization-default layers resolve.
 */
export const SITE_BASELINE_SUBJECT_ID = '00000000-0000-0000-0000-000000000000';

export const RATE_LIMIT_FRAGMENT_PATH =
  '/api/v1/orgs/:orgId/sites/:siteId/openwifi-config/rate-limit-fragment';

const Params = z.object({ orgId: z.uuid(), siteId: z.uuid() });
const Query = z.object({
  // uCentral interface.ssid.name: 1..32 characters.
  ssid: z.string().min(1).max(32),
  at: z.iso.datetime({ offset: true }).optional(),
  /** `1`/`true`: answer with the bare fragment as a JSON file download. */
  download: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

const Omission = z.object({
  field: z.string(),
  path: z.string().nullable(),
  reason: z.string(),
});

const ExportSchema = z.object({
  available: z.boolean(),
  mode: z.literal('export_preview_only'),
  pushed: z.literal(false),
  site_id: z.uuid(),
  ssid: z.string(),
  reason: z.string().nullable(),
  resolution: z.object({
    decision: z.enum(['accept', 'reject']),
    reason_code: z.string().nullable(),
    policy_id: z.string().nullable(),
    policy_version: z.number().nullable(),
    snapshot_hash: z.string(),
  }),
  fragment: z.looseObject({}).nullable(),
  changes: z.array(z.looseObject({})),
  omitted: z.array(Omission),
  validation: z.looseObject({}).nullable(),
  device_enforced: z.boolean(),
  warnings: z.array(z.string()),
  adapter: z.literal('openwifi-config'),
  adapter_version: z.string(),
});

function fileName(ssid: string): string {
  const safe = ssid.replace(/[^A-Za-z0-9._-]/g, '_');
  return `ucentral-rate-limit-${safe}.json`;
}

export function openwifiConfigRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = deps.now ?? (() => new Date());

  const fragment = defineRoute({
    method: 'get',
    path: RATE_LIMIT_FRAGMENT_PATH,
    summary:
      'Export (preview only, never pushed) the uCentral SSID rate-limit fragment of the site baseline policy',
    tags: ['policies'],
    auth: 'principal',
    permission: 'policy:preview',
    scope: (_req, params) => ({
      organizationId: params.orgId ?? null,
      siteId: params.siteId ?? null,
    }),
    params: Params,
    query: Query,
    responses: {
      200: {
        description:
          'Export envelope (`available=false` with a reason when no rate-limit translates); with `download=1` the bare fragment as an attachment',
        schema: ExportSchema,
      },
      422: { description: 'download=1 but no fragment is available (application/problem+json)' },
      ...problemResponses,
    },
    handler: async ({ params, query }): Promise<HandlerResult> => {
      const at = query.at ? new Date(query.at) : now();
      const input = await inTenant(deps, params.orgId, async (trx) => {
        await assertRef(trx, 'sites', params.siteId, 'site');
        const site = await trx
          .selectFrom('sites')
          .select(['timezone'])
          .where('id', '=', params.siteId)
          .executeTakeFirstOrThrow();
        return loadResolutionInput(trx, {
          organizationId: params.orgId,
          siteId: params.siteId,
          timeZone: site.timezone,
          now: at,
          subject: { kind: 'client_device', client_device_id: SITE_BASELINE_SUBJECT_ID },
          clientDeviceId: null,
          mac: null,
          groupIds: [],
          voucherBatchId: null,
        });
      });
      const resolution = resolveEffectivePolicy({ ...input, trigger: 'preview' });
      const adapter = getAdapter('openwifi-config');
      const plan = adapter.translate(resolution.effective, {
        now: at,
        clip: resolution.clip,
        controls: resolution.controls,
        ssidRef: query.ssid,
      });
      const out = exportRateLimitFragment(
        resolution.decision === 'reject'
          ? { ...plan, decision: 'reject', reasonCode: resolution.reasonCode }
          : plan,
        query.ssid,
      );

      if (query.download) {
        if (!isFragmentExport(out)) {
          throw new AppError(422, 'fragment-unavailable', 'No rate-limit fragment to export', {
            detail: out.reason,
            extensions: { omitted: out.omitted },
          });
        }
        return {
          status: 200,
          contentType: 'application/json',
          headers: {
            'Content-Disposition': `attachment; filename="${fileName(query.ssid)}"`,
            'Cache-Control': 'no-store',
          },
          body: `${JSON.stringify(out.fragment, null, 2)}\n`,
        };
      }

      const omitted: readonly FragmentOmission[] = out.omitted;
      return {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
        body: toJsonValue({
          available: isFragmentExport(out),
          mode: 'export_preview_only',
          pushed: false,
          site_id: params.siteId,
          ssid: query.ssid,
          reason: isFragmentExport(out) ? null : out.reason,
          resolution: {
            decision: resolution.decision,
            reason_code: resolution.reasonCode,
            policy_id: resolution.snapshot.policy_id,
            policy_version: resolution.snapshot.policy_version,
            snapshot_hash: resolution.snapshot.hash,
          },
          fragment: isFragmentExport(out) ? out.fragment : null,
          changes: isFragmentExport(out)
            ? out.changes.map((c) => ({
                path: c.path,
                value: c.value,
                field: c.field,
                status: c.status,
                evidence_level: c.evidenceLevel,
                device_enforced: c.deviceEnforced,
                evidence: c.evidence,
              }))
            : [],
          omitted,
          validation: isFragmentExport(out)
            ? {
                valid: out.validation.valid,
                schema_id: out.validation.schemaId,
                schema_sha256: out.validation.schemaSha256,
                errors: out.validation.errors,
              }
            : null,
          device_enforced: isFragmentExport(out) ? out.deviceEnforced : false,
          warnings: isFragmentExport(out) ? out.warnings : [],
          adapter: 'openwifi-config',
          adapter_version: adapter.version,
        }),
      };
    },
  });

  return [fragment];
}
