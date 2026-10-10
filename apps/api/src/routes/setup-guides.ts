/**
 * "How to configure your access points" gallery (multi-vendor Cycle F;
 * docs/VENDOR_INTEGRATION_RESEARCH.md §5):
 *
 *  - `GET /api/v1/orgs/{orgId}/setup-guides`: the vendor catalogue (one entry per vendor or
 *    product line) with the adapter / profile the "Add this access point" form preselects and a
 *    status derived from registry evidence ("Tested on device" only with LAB_VALIDATED /
 *    PRODUCTION_VALIDATED device-test evidence, none today).
 *  - `GET /api/v1/orgs/{orgId}/setup-guides/{vendorKey}[?site_id=]`: a NAS-independent guide with
 *    the ECLOUD values filled in from configuration (PUBLIC_PORTAL_ORIGIN, RADIUS_ADVERTISED_*,
 *    RADIUS_COA_PORT). Secrets are NEVER returned: they stay placeholders and the guide points to
 *    the NAS secret that is shown once when the NAS is added (D-033).
 *
 * Permission `nas:read` (any site of the organization); `site_id`, when given, must be a live
 * site of this organization that the caller may read NAS on.
 */
import {
  GALLERY_ENTRIES,
  GALLERY_FAMILIES,
  GALLERY_FAMILY_LABELS,
  GALLERY_STATUSES,
  GALLERY_STATUS_LABELS,
  buildGalleryGuide,
  builtinPostbackProfile,
  galleryRows,
  galleryStatus,
  getGalleryEntry,
  type GalleryEntry,
  type GalleryGuide,
} from '@ecloud/adapters';
import { LIFECYCLES, NotFoundError, merakiCloudRadiusState } from '@ecloud/shared';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { OrgParams, problemResponses } from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inTenant, requireOnSite } from '../tenant.js';
import { loose } from './crud.js';
import { merakiStatusBody } from './meraki.js';

const FamilySchema = z.enum(GALLERY_FAMILIES);
const StatusSchema = z.enum(GALLERY_STATUSES);

const CatalogueEntrySchema = z.object({
  vendor_key: z.string(),
  display_name: z.string(),
  product_line: z.string(),
  adapter_key: z.string(),
  /** Post-back profile key (external-portal-postback), else null. */
  profile: z.string().nullable(),
  family: FamilySchema,
  family_label: z.string(),
  status: StatusSchema,
  status_label: z.string(),
  /** Most advanced registry lifecycle of the entry's rows (null = no registry row). */
  lifecycle: z.string().nullable(),
});

const CatalogueSchema = z.object({
  data: z.array(CatalogueEntrySchema),
  families: z.array(z.object({ key: FamilySchema, label: z.string() })),
});

const MerakiStateSchema = z.object({
  enabled: z.boolean(),
  state: z.string(),
  message: z.string(),
  source_cidrs: z.array(z.string()),
  port_range: z.object({ min: z.number(), max: z.number() }).nullable(),
  das_port: z.number(),
  radius_reachable_from_meraki: z.string(),
});

const GuideSchema = CatalogueEntrySchema.extend({
  site: z.object({ id: z.string(), name: z.string() }).nullable(),
  portal_url: z.string().nullable(),
  walled_garden: z.array(z.string()),
  radius: z
    .object({
      /** RADIUS_ADVERTISED_ADDRESS; null = not configured (REQUIRES_CLARIFICATION). */
      address: z.string().nullable(),
      auth_port: z.number(),
      acct_port: z.number(),
      coa_port: z.number(),
    })
    .nullable(),
  preflight: z.array(z.string()),
  vendor_notes: z.array(z.string()),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      setting: z.string(),
      /** Filled from configuration; secrets and per-NAS values stay `<PLACEHOLDERS>`. */
      value: z.string(),
      evidence: z.array(z.string()),
      /** True when the value holds a secret placeholder (never filled, not copyable). */
      secret: z.boolean(),
    }),
  ),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  secret_note: z.string(),
  /** What "Add this access point" preselects in the NAS form. */
  add_nas: z.object({ adapter_key: z.string(), profile: z.string().nullable() }),
  meraki: MerakiStateSchema.nullable(),
});

function lifecycleOf(entry: GalleryEntry): string | null {
  const rows = galleryRows(entry);
  if (rows.length === 0) return null;
  return rows
    .map((r) => r.lifecycle)
    .reduce((best, l) => (LIFECYCLES.indexOf(l) > LIFECYCLES.indexOf(best) ? l : best));
}

function catalogueEntry(entry: GalleryEntry): z.infer<typeof CatalogueEntrySchema> {
  const status = galleryStatus(entry);
  return {
    vendor_key: entry.vendorKey,
    display_name: entry.displayName,
    product_line: entry.productLine,
    adapter_key: entry.adapterKey,
    profile: entry.profile,
    family: entry.family,
    family_label: GALLERY_FAMILY_LABELS[entry.family],
    status,
    status_label: GALLERY_STATUS_LABELS[status],
    lifecycle: lifecycleOf(entry),
  };
}

export const SECRET_NOTE =
  'Secrets are never shown in a guide. The RADIUS shared secret of a NAS is shown once when you add the NAS (or rotate its secret); UAM secrets and controller credentials are entered by you and stored sealed.';

/** Honest warnings of a guide (configuration and evidence driven). */
export function guideWarnings(
  deps: AppDeps,
  entry: GalleryEntry,
  guide: GalleryGuide,
): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = [];
  const status = galleryStatus(entry);
  if (status === 'generic_profile') {
    out.push({
      code: 'needs_captured_redirect',
      message:
        'No documented parameter names exist for this vendor. Capture one real redirect from the device in a lab, enter its parameter names in the "Any vendor" post-back profile, and test before guests use it.',
    });
  } else if (status === 'documented') {
    out.push({
      code: 'not_device_tested',
      message:
        'Built from vendor documentation only: ECLOUD has not tested this on a device yet. Validate it in a lab before production use.',
    });
  }
  if (guide.portalUrl !== null && guide.portalUrl.startsWith('http://')) {
    out.push({
      code: 'http_portal_cleartext',
      message:
        'The ECLOUD portal origin uses http:// (cleartext): guest logins cross the network unencrypted. Use it only in a lab; production portals need https://.',
    });
  }
  const profile = entry.profile === null ? null : builtinPostbackProfile(entry.profile);
  if (entry.family === 'external-portal' && (entry.longTail || profile?.httpsDefault === false)) {
    out.push({
      code: 'http_postback_cleartext',
      message:
        'By default the browser posts the single-use login credential back to the device over http://, in clear text on the guest network (valid 90 s, bound to this NAS and client). Turn on HTTPS for the NAS when the device has a trusted certificate.',
    });
  }
  if (guide.radius !== null && guide.radius.address === null) {
    out.push({
      code: 'radius_address_not_configured',
      message:
        'The RADIUS address for access points is not configured on this ECLOUD instance (RADIUS_ADVERTISED_ADDRESS): REQUIRES_CLARIFICATION. Ask your platform operator.',
    });
  }
  if (guide.radius !== null) {
    out.push({
      code: 'lab_mode_attributes',
      message:
        'Lab mode: "Device-test attributes (lab only)" on a NAS sends attributes that are not device-verified to every user of that NAS. Leave it off outside a lab test.',
    });
  }
  if (entry.family === 'controller-api') {
    out.push({
      code: 'no_radius_accounting',
      message:
        'No RADIUS in this mode: ECLOUD authorises guests through the controller API, so there is no RADIUS accounting or RFC 5176 Disconnect.',
    });
  }
  if (entry.adapterKey === 'meraki-splash') {
    const settings = deps.config.merakiCloudRadius;
    const state = merakiCloudRadiusState(settings);
    if (state !== 'enabled') {
      out.push({ code: `meraki_${state}`, message: merakiStatusBody(settings).message });
    }
    out.push({
      code: 'meraki_public_address_unknown',
      message:
        'The public ECLOUD RADIUS address for Meraki is not defined for this deployment (REQUIRES_CLARIFICATION, D-043).',
    });
  }
  return out;
}

function merakiFill(deps: AppDeps, text: string): string {
  const s = deps.config.merakiCloudRadius;
  const values: Record<string, string> = {
    '<MERAKI_CLOUD_RADIUS_STATE>': merakiCloudRadiusState(s),
    '<MERAKI_AUTH_PORT>': '<MERAKI_AUTH_PORT: allocated when you add the NAS>',
    '<MERAKI_ACCT_PORT>': '<MERAKI_ACCT_PORT: allocated when you add the NAS>',
    '<MERAKI_SOURCE_CIDRS>':
      s.sourceCidrs.length === 0 ? 'not configured' : s.sourceCidrs.join(', '),
    '<REQUIRE_MESSAGE_AUTHENTICATOR>': 'yes',
  };
  return text.replace(/<[A-Z_]+>/g, (t) => values[t] ?? t);
}

const VendorParams = OrgParams.extend({ vendorKey: z.string().regex(/^[a-z0-9-]{1,64}$/) });
const GuideQuery = z.object({ site_id: z.uuid().optional() });

export function setupGuideRoutes(deps: AppDeps): AnyRouteSpec[] {
  const catalogue = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/setup-guides',
    summary: 'Setup-guide gallery: vendor catalogue (Cycle F)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:read',
    scope: 'any-site',
    params: OrgParams,
    responses: { 200: { description: 'Catalogue', schema: CatalogueSchema }, ...problemResponses },
    handler: () =>
      Promise.resolve({
        status: 200,
        body: {
          data: GALLERY_ENTRIES.map(catalogueEntry),
          families: GALLERY_FAMILIES.map((key) => ({ key, label: GALLERY_FAMILY_LABELS[key] })),
        },
      }),
  });

  const guide = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/setup-guides/:vendorKey',
    summary: 'Setup guide of a vendor, ECLOUD values filled in, secrets never shown (Cycle F)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:read',
    scope: 'any-site',
    params: VendorParams,
    query: GuideQuery,
    responses: { 200: { description: 'Guide', schema: GuideSchema }, ...problemResponses },
    handler: async ({ params, query, ctx }) => {
      const entry = getGalleryEntry(params.vendorKey);
      if (entry === null) throw new NotFoundError('setup_guide', params.vendorKey);
      let site: { id: string; name: string } | null = null;
      if (query.site_id !== undefined) {
        const siteId = query.site_id;
        const row = (await inTenant(deps, params.orgId, (trx) =>
          loose(trx)
            .selectFrom('sites')
            .select(['id', 'name'])
            .where('id', '=', siteId)
            .where('deleted_at', 'is', null)
            .executeTakeFirst(),
        )) as { id: string; name: string } | undefined;
        // A missing site and a site the caller may not read NAS on answer the same 404 (same
        // detail, same id), so the query parameter is not a site-existence oracle.
        if (row === undefined) throw new NotFoundError('site', siteId);
        try {
          requireOnSite(ctx, 'nas:read', params.orgId, row.id, 'site');
        } catch (err) {
          if (err instanceof NotFoundError) throw new NotFoundError('site', siteId);
          throw err;
        }
        site = { id: row.id, name: row.name };
      }
      const cfg = deps.config.setupGuide;
      const built = buildGalleryGuide(entry, {
        portalOrigin: deps.config.base.origins.portal,
        radiusAddress: cfg.radiusAddress,
        authPort: cfg.authPort,
        acctPort: cfg.acctPort,
        coaPort: cfg.coaPort,
        interimS: deps.config.aaaInterimIntervalS,
      });
      const isMeraki = entry.adapterKey === 'meraki-splash';
      return {
        status: 200,
        body: {
          ...catalogueEntry(entry),
          site,
          portal_url: built.portalUrl,
          walled_garden: [...built.walledGarden],
          radius:
            built.radius === null
              ? null
              : {
                  address: built.radius.address,
                  auth_port: built.radius.authPort,
                  acct_port: built.radius.acctPort,
                  coa_port: built.radius.coaPort,
                },
          preflight: [...entry.preflight],
          vendor_notes: [...(entry.vendorNotes ?? [])],
          steps: built.steps.map((s) => ({
            id: s.id,
            title: s.title,
            setting: s.setting,
            value: isMeraki ? merakiFill(deps, s.value) : s.value,
            evidence: [...s.evidence],
            secret: s.secret,
          })),
          warnings: guideWarnings(deps, entry, built),
          secret_note: SECRET_NOTE,
          add_nas: { adapter_key: entry.adapterKey, profile: entry.profile },
          meraki: isMeraki ? merakiStatusBody(deps.config.merakiCloudRadius) : null,
        },
      };
    },
  });

  return [catalogue, guide];
}
