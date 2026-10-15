/**
 * Captive-portal administration (Phase 6 P6-B; API_ARCHITECTURE.md §3.2 "Organization — portal",
 * ADMIN_UI_ARCHITECTURE.md §3/§4):
 *
 *   {o}/captive-portals            CRUD, per site (captive_portal:*)
 *   {o}/captive-portals/{id}/terms GET versions / POST a new immutable version
 *   {o}/portal-themes              CRUD (portal_theme:*), tokens validated + WCAG AA contrast
 *   {o}/portal-assets              branding uploads into @ecloud/storage (portal_asset:*)
 *   {o}/portal-previews            designer preview rendered with sample data (portal_theme:read)
 *
 * Every mutation writes one audit row in the tenant transaction. Assets are stored under the
 * tenant prefix `org/{orgId}/branding/{assetId}` (forTenant) and the DB pins that key (021).
 */
import { withPlatform } from '@ecloud/db';
import {
  AppError,
  ValidationError,
  HEX_COLOR_RE,
  NotFoundError,
  DEFAULT_PORTAL_TEMPLATE,
  PORTAL_COLOR_TOKENS,
  PORTAL_DEPENDENCY_REASON,
  PORTAL_LOGIN_METHODS,
  PORTAL_METHOD_KEYS,
  PORTAL_PREVIEW_PAGES,
  PORTAL_STRING_KEYS,
  PORTAL_STRING_MAX_LENGTH,
  PORTAL_TEMPLATE_KEYS,
  contrastIssues,
  localeDirection,
  methodAvailability,
  newId,
  portalTemplate,
  resolvePortalColors,
  resolvePortalStrings,
  type PortalLoginMethod,
} from '@ecloud/shared';
import {
  STORAGE_PURPOSES,
  forTenant,
  type ObjectStorage,
  type StoredObject,
} from '@ecloud/storage';
import type { RequestHandler } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import type { AppDeps, RequestContext } from '../context.js';
import { randomToken } from '../crypto.js';
import {
  OrgIdParams,
  OrgParams,
  PaginationQuery,
  decodeCursor,
  problemResponses,
  toPage,
} from '../http/common.js';
import {
  ImpersonationForbiddenError,
  ServiceUnavailableError,
  UnprocessableError,
} from '../http/errors.js';
import { requestIsImpersonating } from '../auth/middleware.js';
import { UAM_FLAVOURS, sealUamSecret } from '../internal/portal.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { crudRoutes, type Row } from '../routes/crud.js';
import { assertRef, inTenant, requireOnSite } from '../tenant.js';
import { PREVIEW_HEADERS, renderPortalPreview } from './preview.js';
import {
  RegistrationFieldsInput,
  buildSnapshot,
  portalCapabilities,
  publishProblems,
  type PortalDraft,
} from '../internal/portal-snapshot.js';

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const name = z.string().trim().min(1).max(200);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const localeKey = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'BCP 47 language tag, e.g. en or ar-AE');
const hex = z
  .string()
  .regex(HEX_COLOR_RE, '#rrggbb')
  .transform((v) => v.toLowerCase());
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'host name');

export const PortalColorsInput = z.strictObject(
  Object.fromEntries(PORTAL_COLOR_TOKENS.map((t) => [t, hex.optional()])) as Record<
    (typeof PORTAL_COLOR_TOKENS)[number],
    z.ZodOptional<typeof hex>
  >,
);
const LocaleStrings = z.strictObject(
  Object.fromEntries(
    PORTAL_STRING_KEYS.map((k) => [k, z.string().max(PORTAL_STRING_MAX_LENGTH).optional()]),
  ) as Record<(typeof PORTAL_STRING_KEYS)[number], z.ZodOptional<z.ZodString>>,
);
export const PortalStringsInput = z
  .record(localeKey, LocaleStrings)
  .refine((v) => Object.keys(v).length <= 10, 'at most 10 locales');

export const ThemeCreate = z.strictObject({
  name,
  colors: PortalColorsInput.optional(),
  strings: PortalStringsInput.optional(),
  logo_asset_id: z.uuid().nullable().optional(),
});
export const ThemeUpdate = ThemeCreate.partial();

/**
 * Migration 038: the full method registry, not the three pilot methods. A row may record a method
 * whose adapter has not shipped; whether a GUEST is offered it is decided at publish and render
 * time by `methodAvailability`, which refuses any method with an unconfigured dependency (§5).
 */
const loginMethods = z
  .array(z.enum(PORTAL_METHOD_KEYS))
  .max(PORTAL_METHOD_KEYS.length)
  .transform((v) => [...new Set(v)]);

/** Display order (§4.6); may name any registered method and need not be complete. */
const methodOrder = z
  .array(z.enum(PORTAL_METHOD_KEYS))
  .max(PORTAL_METHOD_KEYS.length)
  .transform((v) => [...new Set(v)]);

export const PortalCreate = z.strictObject({
  site_id: z.uuid(),
  name,
  public_slug: slug,
  /** Migration 029 (Cycle B): `mikrotik` = RouterOS Hotspot login.html entry. */
  portal_type: z.enum(['uspot', 'coovachilli', 'external', 'mikrotik']),
  /** SSID / interface reference on the site's NAS (unique per site). */
  network_ref: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/),
  theme_id: z.uuid().nullable().optional(),
  /** Login methods (social / IdP is not configurable in the pilot, Q64). */
  auth_methods: loginMethods.optional(),
  redirect_url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .nullable()
    .optional(),
  walled_garden: z.array(hostname).max(64).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  /**
   * `adapter_config.uam_server_url`: the URL the hotspot redirects to (part of the md check).
   * Must be on the portal origin with the UAM path of the portal type; null = default.
   */
  uam_server_url: z.url().max(2048).nullable().optional(),
  /** `adapter_config.nas_client_id`: pins this portal to one NAS of the same site; null = unpinned. */
  nas_client_id: z.uuid().nullable().optional(),
  /** Migration 038 (§4): page composition. Independent of `auth_methods`. */
  template_key: z.enum(PORTAL_TEMPLATE_KEYS).optional(),
  method_order: methodOrder.optional(),
  /** SSIDs this portal serves; empty = every SSID at the site (§8 resolution chain). */
  ssids: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(32),
    )
    .max(32)
    .optional(),
  /** Registration form definition (§7); the published copy lives in the snapshot. */
  registration_fields: RegistrationFieldsInput.optional(),
  /** Selectable languages; the first entry is the default. Empty = English only (§12). */
  locales: z.array(localeKey).max(10).optional(),
});
export const PortalUpdate = PortalCreate.partial().omit({ site_id: true });

const TermsCreate = z.strictObject({
  /** One text per locale; all rows of one POST share the new version number. */
  texts: z
    .record(localeKey, z.string().trim().min(1).max(20_000))
    .refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 10, '1-10 locales'),
});

const PreviewCreate = z.strictObject({
  page: z.enum(PORTAL_PREVIEW_PAGES),
  locale: localeKey.default('en'),
  captive_portal_id: z.uuid().optional(),
  theme_id: z.uuid().optional(),
  /** Unsaved designer state; overrides the stored theme field by field. */
  draft: z
    .strictObject({
      colors: PortalColorsInput.optional(),
      strings: PortalStringsInput.optional(),
      logo_asset_id: z.uuid().nullable().optional(),
    })
    .optional(),
});
type PreviewRequest = z.output<typeof PreviewCreate>;

// Response schemas (documented in OpenAPI; the admin client is generated from them)

const AssetSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  purpose: z.literal('branding'),
  content_type: z.string(),
  byte_size: z.number().int(),
  sha256: z.string(),
  original_filename: z.string().nullable(),
  url: z.string(),
  created_at: z.string(),
});
const AssetPageSchema = z.object({
  data: z.array(AssetSchema),
  next_cursor: z.string().nullable(),
});
const TermsVersionSchema = z.object({
  id: z.uuid(),
  captive_portal_id: z.uuid(),
  version: z.number().int(),
  locale: z.string(),
  body: z.string(),
  created_at: z.string(),
});
const PortalVersionSchema = z.object({
  id: z.uuid(),
  captive_portal_id: z.uuid(),
  version: z.number().int(),
  published_by: z.uuid().nullable(),
  published_at: z.string(),
  /** True for the version guests are currently served. */
  current: z.boolean(),
});
const PreviewTicketSchema = z.object({ preview_url: z.string(), expires_in: z.number().int() });

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const BRANDING = 'branding' as const;
export const BRANDING_MAX_BYTES = STORAGE_PURPOSES.branding.maxBytes;
const PREVIEW_TTL_SECONDS = 300;
/** Larger logos are not inlined into previews (live pages serve them from /a/{id}). */
const PREVIEW_LOGO_MAX_BYTES = 1024 * 1024;
const PREVIEW_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function requireStorage(deps: AppDeps): ObjectStorage {
  if (deps.storage === undefined) {
    throw new ServiceUnavailableError('Object storage is not configured.');
  }
  return deps.storage;
}

/** Public URL of an asset on the portal origin (served by the portal at /a/{assetId}). */
export function portalAssetUrl(deps: AppDeps, assetId: string): string {
  return new URL(`/a/${assetId}`, deps.config.base.origins.portal).toString();
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

function serializeAsset(deps: AppDeps, row: Row): Row {
  return {
    id: row.id,
    organization_id: row.organization_id,
    purpose: row.purpose,
    content_type: row.content_type,
    byte_size: row.byte_size,
    sha256: row.sha256,
    original_filename: row.original_filename ?? null,
    url: portalAssetUrl(deps, row.id as string),
    created_at: iso(row.created_at),
  };
}

function serializeTheme(deps: AppDeps, row: Row): Row {
  const logo = (row.logo_asset_ref as string | null) ?? null;
  return {
    id: row.id,
    organization_id: row.organization_id,
    name: row.name,
    colors: resolvePortalColors(row.colors as Record<string, unknown>),
    strings: row.strings ?? {},
    logo_asset_id: logo,
    logo_url: logo === null ? null : portalAssetUrl(deps, logo),
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function serializePortal(row: Row): Row {
  const { uam_secret_ref, ...rest } = row;
  return {
    ...rest,
    uam_secret_configured: uam_secret_ref !== null && uam_secret_ref !== undefined,
    // Migration 038: NULL means draft only, so guests are served nothing yet (§8).
    published: rest.published_version_id !== null && rest.published_version_id !== undefined,
    // Q64: no identity providers in the pilot; the designer shows social login as such.
    social_login: 'not_configured',
  };
}

/** UAM paths served by the portal per portal type (`UAM_FLAVOURS`, P6-A). */
const UAM_PATH_BY_TYPE: Readonly<Record<string, string>> = Object.freeze({
  uspot: UAM_FLAVOURS.uspot.path,
  coovachilli: UAM_FLAVOURS.chilli.path,
  mikrotik: UAM_FLAVOURS.mikrotik.path,
});

/**
 * Validates and merges the admin-settable keys of `captive_portals.adapter_config`
 * (`undefined` = keep, `null` = remove). Other keys written by other components are preserved.
 *  - `uam_server_url`: same origin as PUBLIC_PORTAL_ORIGIN (never an arbitrary host), https
 *    (http only when the configured portal origin itself is http, i.e. local dev), no
 *    userinfo/query/fragment, path = the UAM path of the portal type.
 *  - `nas_client_id`: a live NAS of the same organization (G9, RLS) and the portal's site.
 */
export async function portalAdapterConfig(
  trx: Parameters<typeof assertRef>[0],
  current: Record<string, unknown>,
  input: { uam_server_url?: unknown; nas_client_id?: unknown },
  portalType: string,
  siteId: string,
  portalOriginUrl: string,
): Promise<Record<string, unknown>> {
  const next: Record<string, unknown> = { ...current };
  if (input.uam_server_url === null) delete next.uam_server_url;
  else if (typeof input.uam_server_url === 'string') next.uam_server_url = input.uam_server_url;
  if (input.nas_client_id === null) delete next.nas_client_id;
  else if (typeof input.nas_client_id === 'string') next.nas_client_id = input.nas_client_id;

  if (typeof next.uam_server_url === 'string') {
    const portalOrigin = new URL(portalOriginUrl);
    let url: URL;
    try {
      url = new URL(next.uam_server_url);
    } catch {
      throw uamUrlError('uam_server_url is not a URL');
    }
    if (url.origin !== portalOrigin.origin) {
      throw uamUrlError(`uam_server_url must be on the portal origin ${portalOrigin.origin}`);
    }
    if (url.protocol !== 'https:' && portalOrigin.protocol === 'https:') {
      throw uamUrlError('uam_server_url must use https');
    }
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      throw uamUrlError('uam_server_url must not carry credentials, a query or a fragment');
    }
    const expected = UAM_PATH_BY_TYPE[portalType];
    if (expected === undefined || url.pathname !== expected) {
      throw uamUrlError(
        expected === undefined
          ? `portal type ${portalType} has no UAM endpoint on the portal`
          : `uam_server_url path must be ${expected} for portal type ${portalType}`,
      );
    }
    next.uam_server_url = url.toString();
  }
  if (typeof next.nas_client_id === 'string') {
    const nas = await assertRef(trx, 'nas_clients', next.nas_client_id, 'nas_client');
    if (nas.site_id !== siteId) {
      throw new UnprocessableError('nas_client_id must be a NAS of the portal site.', {
        field: 'nas_client_id',
      });
    }
  }
  return next;
}

function uamUrlError(detail: string): ValidationError {
  return new ValidationError([{ path: 'body.uam_server_url', message: detail }]);
}

function checkContrast(colors: Record<string, string>): void {
  const issues = contrastIssues(resolvePortalColors(colors));
  if (issues.length > 0) {
    throw new UnprocessableError(
      'Theme colours do not reach the WCAG 2.2 AA contrast ratio of 4.5:1.',
      { contrast_issues: issues },
    );
  }
}

/** Filename hint from `?filename=` (display only; never used to build keys or content types). */
const FilenameQuery = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
      // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
      (v) => !/[\u0000-\u001f\u007f/\\]/.test(v),
      'plain file name',
    )
    .optional(),
});

async function readAll(object: StoredObject): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

class UnsupportedMediaTypeError extends AppError {
  constructor() {
    super(415, 'unsupported-media-type', 'Unsupported Media Type', {
      detail:
        'Upload the image as the request body with Content-Type image/png, image/jpeg or image/webp.',
    });
  }
}

interface PreviewTicket {
  orgId: string;
  principal: string;
  request: PreviewRequest;
}

function principalKey(ctx: RequestContext): string {
  const p = ctx.principal;
  if (p === null) return 'anonymous';
  return p.kind === 'admin' ? `admin:${p.administratorId}` : `api_key:${p.apiKeyId}`;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export function portalAdminRoutes(deps: AppDeps): AnyRouteSpec[] {
  const tag = 'captive-portal';

  const portals = crudRoutes(deps, {
    table: 'captive_portals',
    path: '/captive-portals',
    resource: 'captive_portal',
    tag,
    permissions: {
      read: 'captive_portal:read',
      create: 'captive_portal:create',
      update: 'captive_portal:update',
      delete: 'captive_portal:delete',
    },
    siteMode: 'column',
    softDelete: false,
    createSchema: PortalCreate,
    updateSchema: PortalUpdate,
    filters: {
      status: z.enum(['active', 'disabled']).optional(),
      /**
       * Migration 041: answers "which of my sites are serving the anonymous platform default"
       * in one request. The owner chose generous fallback limits (10/10 Mbps for a day), so a
       * forgotten site will not announce itself through a poor guest experience — this filter
       * and the badge are the only things that surface it.
       */
      is_platform_default: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => (v === undefined ? undefined : v === 'true')),
    },
    prepareCreate: async (body, { trx }) => {
      await assertRef(trx, 'sites', body.site_id as string, 'site');
      if (typeof body.theme_id === 'string') {
        await assertRef(trx, 'portal_themes', body.theme_id, 'portal_theme');
      }
      const { uam_server_url, nas_client_id, ...rest } = body;
      const adapterConfig = await portalAdapterConfig(
        trx,
        {},
        { uam_server_url, nas_client_id },
        body.portal_type as string,
        body.site_id as string,
        deps.config.base.origins.portal,
      );
      const templateKey = (body.template_key as string | undefined) ?? DEFAULT_PORTAL_TEMPLATE;
      const template = portalTemplate(templateKey);
      const { registration_fields, ...withoutFields } = rest;
      return {
        ...withoutFields,
        template_key: templateKey,
        // §3: a new portal starts with its template's dependency-free methods, not every method.
        auth_methods: body.auth_methods ?? [...(template?.defaultMethods ?? ['click_through'])],
        ...(registration_fields === undefined
          ? {}
          : { registration_fields: JSON.stringify(registration_fields) }),
        adapter_config: JSON.stringify(adapterConfig),
      };
    },
    preparePatch: async (body, before, { trx }) => {
      if (typeof body.theme_id === 'string') {
        await assertRef(trx, 'portal_themes', body.theme_id, 'portal_theme');
      }
      const { uam_server_url, nas_client_id, ...rest } = body;
      if (rest.registration_fields !== undefined) {
        rest.registration_fields = JSON.stringify(rest.registration_fields);
      }
      const touchesConfig =
        uam_server_url !== undefined ||
        nas_client_id !== undefined ||
        (body.portal_type !== undefined && body.portal_type !== before.portal_type);
      if (!touchesConfig) return rest;
      const adapterConfig = await portalAdapterConfig(
        trx,
        (before.adapter_config as Record<string, unknown> | null) ?? {},
        { uam_server_url, nas_client_id },
        (body.portal_type as string | undefined) ?? (before.portal_type as string),
        before.site_id as string,
        deps.config.base.origins.portal,
      );
      return { ...rest, adapter_config: JSON.stringify(adapterConfig) };
    },
    serialize: serializePortal,
  });

  const themes = crudRoutes(deps, {
    table: 'portal_themes',
    path: '/portal-themes',
    resource: 'portal_theme',
    tag,
    permissions: {
      read: 'portal_theme:read',
      create: 'portal_theme:create',
      update: 'portal_theme:update',
      delete: 'portal_theme:delete',
    },
    siteMode: 'none',
    softDelete: false,
    createSchema: ThemeCreate,
    updateSchema: ThemeUpdate,
    prepareCreate: async (body, { trx }) => {
      const colors = resolvePortalColors((body.colors as Record<string, unknown>) ?? {});
      checkContrast(colors);
      const logo = (body.logo_asset_id as string | null | undefined) ?? null;
      if (logo !== null) await assertRef(trx, 'portal_assets', logo, 'portal_asset');
      return {
        name: body.name,
        colors: JSON.stringify(colors),
        strings: JSON.stringify(body.strings ?? {}),
        logo_asset_ref: logo,
      };
    },
    preparePatch: async (body, before, { trx }) => {
      const set: Row = { version: (before.version as number) + 1 };
      if (body.name !== undefined) set.name = body.name;
      if (body.colors !== undefined) {
        const colors = resolvePortalColors({
          ...(before.colors as Record<string, unknown>),
          ...(body.colors as Record<string, unknown>),
        });
        checkContrast(colors);
        set.colors = JSON.stringify(colors);
      }
      if (body.strings !== undefined) set.strings = JSON.stringify(body.strings);
      if (body.logo_asset_id !== undefined) {
        const logo = body.logo_asset_id as string | null;
        if (logo !== null) await assertRef(trx, 'portal_assets', logo, 'portal_asset');
        set.logo_asset_ref = logo;
      }
      return set;
    },
    serialize: (row) => serializeTheme(deps, row),
  });

  const base = '/api/v1/orgs/:orgId';
  const PortalParams = z.object({ orgId: z.uuid(), id: z.uuid() });

  const assets: AnyRouteSpec[] = [
    defineRoute({
      method: 'get',
      path: `${base}/portal-assets`,
      summary: 'List portal branding assets',
      tags: [tag],
      auth: 'principal',
      permission: 'portal_asset:read',
      scope: 'organization',
      params: OrgParams,
      query: PaginationQuery,
      responses: {
        200: { description: 'Asset page', schema: AssetPageSchema },
        ...problemResponses,
      },
      handler: async ({ params, query }) => {
        const cursor = decodeCursor(query.cursor);
        const rows = await inTenant(deps, params.orgId, (trx) => {
          let sel = trx.selectFrom('portal_assets').selectAll();
          if (typeof cursor === 'string') sel = sel.where('id', '>', cursor);
          return sel
            .orderBy('id')
            .limit(query.limit + 1)
            .execute();
        });
        const page = toPage(rows as Row[], query.limit, (r) => r.id as string);
        return {
          status: 200,
          body: { ...page, data: page.data.map((r) => serializeAsset(deps, r)) },
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: `${base}/portal-assets/:id`,
      summary: 'Get portal branding asset metadata',
      tags: [tag],
      auth: 'principal',
      permission: 'portal_asset:read',
      scope: 'organization',
      params: OrgIdParams,
      responses: { 200: { description: 'Asset', schema: AssetSchema }, ...problemResponses },
      handler: async ({ params }) => {
        const row = await inTenant(deps, params.orgId, (trx) =>
          trx
            .selectFrom('portal_assets')
            .selectAll()
            .where('id', '=', params.id)
            .executeTakeFirst(),
        );
        if (row === undefined) throw new NotFoundError('portal_asset', params.id);
        return { status: 200, body: serializeAsset(deps, row) };
      },
    }),
    defineRoute({
      method: 'get',
      path: `${base}/portal-assets/:id/content`,
      summary: 'Download a portal branding asset (admin designer thumbnails)',
      tags: [tag],
      auth: 'principal',
      permission: 'portal_asset:read',
      scope: 'organization',
      params: OrgIdParams,
      responses: {
        200: {
          description: 'Image bytes (Content-Type from stored metadata, nosniff)',
          contentType: 'image/*',
          schema: z.string().meta({ format: 'binary' }),
        },
        ...problemResponses,
      },
      handler: async ({ params }) => {
        const storage = requireStorage(deps);
        const row = await inTenant(deps, params.orgId, (trx) =>
          trx
            .selectFrom('portal_assets')
            .selectAll()
            .where('id', '=', params.id)
            .executeTakeFirst(),
        );
        if (row === undefined) throw new NotFoundError('portal_asset', params.id);
        const tenant = forTenant(storage, params.orgId);
        tenant.assertOwnKey(row.storage_key);
        const object = await tenant.get(BRANDING, row.id);
        const bytes = await readAll(object);
        return {
          status: 200,
          body: bytes,
          contentType: object.contentType,
          headers: assetHeaders(object.contentType, row.sha256, 'private, max-age=300'),
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: `${base}/portal-assets`,
      summary: 'Upload a portal branding asset (raw image body, PNG/JPEG/WebP, ≤ 5 MiB)',
      tags: [tag],
      auth: 'principal',
      permission: 'portal_asset:create',
      scope: 'organization',
      params: OrgParams,
      query: FilenameQuery,
      rawBody: {
        contentTypes: STORAGE_PURPOSES.branding.allowedContentTypes,
        limitBytes: BRANDING_MAX_BYTES,
        description:
          'The image bytes. Content-Type must be image/png, image/jpeg or image/webp and match the file signature.',
      },
      idempotency: 'optional',
      responses: {
        201: { description: 'Stored', schema: AssetSchema },
        413: { description: 'Larger than 5 MiB' },
        415: { description: 'Not PNG/JPEG/WebP, or bytes do not match the declared type' },
        ...problemResponses,
      },
      handler: async ({ params, query, req, ctx }) => {
        const storage = requireStorage(deps);
        const bytes: unknown = req.body;
        if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
          throw new UnsupportedMediaTypeError();
        }
        const id = newId();
        const tenant = forTenant(storage, params.orgId);
        // Validates type allow-list, magic bytes and size before anything is written.
        const meta = await tenant.put(BRANDING, id, bytes, {
          contentType: req.get('Content-Type') ?? '',
        });
        try {
          const row = await inTenant(deps, params.orgId, async (trx) => {
            const created = await trx
              .insertInto('portal_assets')
              .values({
                id,
                organization_id: params.orgId,
                purpose: BRANDING,
                storage_key: meta.key,
                content_type: meta.contentType as 'image/png' | 'image/jpeg' | 'image/webp',
                byte_size: meta.size,
                sha256: meta.sha256 ?? '',
                original_filename: query.filename ?? null,
                created_by: ctx.principal?.kind === 'admin' ? ctx.principal.administratorId : null,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await writeAudit(trx, ctx, {
              organizationId: params.orgId,
              action: 'portal_asset:create',
              targetType: 'portal_asset',
              targetId: id,
              after: created,
            });
            return created;
          });
          return { status: 201, body: serializeAsset(deps, row) };
        } catch (error) {
          // No row → no reference: remove the object so storage holds nothing unaccounted.
          await tenant.delete(BRANDING, id).catch(() => undefined);
          throw error;
        }
      },
    }),
    defineRoute({
      method: 'delete',
      path: `${base}/portal-assets/:id`,
      summary: 'Delete a portal branding asset (refused while a theme uses it)',
      tags: [tag],
      auth: 'principal',
      permission: 'portal_asset:delete',
      scope: 'organization',
      params: OrgIdParams,
      responses: {
        204: { description: 'Deleted' },
        409: { description: 'Still referenced by a portal theme' },
        ...problemResponses,
      },
      handler: async ({ params, ctx, req }) => {
        const storage = requireStorage(deps);
        const tenant = forTenant(storage, params.orgId);
        await inTenant(deps, params.orgId, async (trx) => {
          const before = await trx
            .selectFrom('portal_assets')
            .selectAll()
            .where('id', '=', params.id)
            .executeTakeFirst();
          // No FOR UPDATE: ecloud_app has no UPDATE on portal_assets (rows are immutable, 021).
          if (before === undefined) throw new NotFoundError('portal_asset', params.id);
          tenant.assertOwnKey(before.storage_key);
          const used = await trx
            .selectFrom('portal_themes')
            .select(['id', 'name'])
            .where('logo_asset_ref', '=', params.id)
            .execute();
          if (used.length > 0) throw assetInUse(used.map((t) => t.id));
          try {
            await trx.deleteFrom('portal_assets').where('id', '=', params.id).execute();
          } catch (error) {
            // 022: a theme assigned the logo concurrently (FK portal_themes -> portal_assets)
            if ((error as { code?: unknown }).code === '23503') throw assetInUse([]);
            throw error;
          }
          await writeAudit(trx, ctx, {
            organizationId: params.orgId,
            action: 'portal_asset:delete',
            targetType: 'portal_asset',
            targetId: params.id,
            before,
          });
        });
        // After commit: an object without a row is unreachable; a failure here is only logged.
        await tenant.delete(BRANDING, params.id).catch((error: unknown) => {
          req.log.warn({ err: error, assetId: params.id }, 'portal asset object delete failed');
        });
        return { status: 204 };
      },
    }),
  ];

  const terms: AnyRouteSpec[] = [
    defineRoute({
      method: 'get',
      path: `${base}/captive-portals/:id/terms`,
      summary: 'List the terms versions of a captive portal',
      tags: [tag],
      auth: 'principal',
      permission: 'captive_portal:read',
      scope: 'any-site',
      params: PortalParams,
      responses: {
        200: {
          description: 'Versions, newest first',
          schema: z.object({
            current_version: z.string().nullable(),
            data: z.array(TermsVersionSchema),
          }),
        },
        ...problemResponses,
      },
      handler: async ({ params, ctx }) => {
        const result = await inTenant(deps, params.orgId, async (trx) => {
          const portal = await trx
            .selectFrom('captive_portals')
            .select(['id', 'site_id', 'terms_version'])
            .where('id', '=', params.id)
            .executeTakeFirst();
          if (portal === undefined) throw new NotFoundError('captive_portal', params.id);
          requireOnSite(ctx, 'captive_portal:read', params.orgId, portal.site_id, 'captive_portal');
          const rows = await trx
            .selectFrom('portal_terms_versions')
            .select(['id', 'captive_portal_id', 'version', 'locale', 'body', 'created_at'])
            .where('captive_portal_id', '=', params.id)
            .orderBy('version', 'desc')
            .orderBy('locale')
            .limit(200)
            .execute();
          return { portal, rows };
        });
        return {
          status: 200,
          body: {
            current_version: result.portal.terms_version,
            data: result.rows.map((r) => ({ ...r, created_at: iso(r.created_at) })),
          },
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: `${base}/captive-portals/:id/terms`,
      summary: 'Publish a new terms version (immutable; becomes the current version)',
      tags: [tag],
      auth: 'principal',
      permission: 'captive_portal:update',
      scope: 'any-site',
      params: PortalParams,
      body: TermsCreate,
      idempotency: 'optional',
      responses: {
        201: {
          description: 'Published',
          schema: z.object({ version: z.string(), data: z.array(TermsVersionSchema) }),
        },
        ...problemResponses,
      },
      handler: async ({ params, body, ctx }) => {
        const result = await inTenant(deps, params.orgId, async (trx) => {
          const before = await trx
            .selectFrom('captive_portals')
            .selectAll()
            .where('id', '=', params.id)
            .forUpdate()
            .executeTakeFirst();
          if (before === undefined) throw new NotFoundError('captive_portal', params.id);
          requireOnSite(
            ctx,
            'captive_portal:update',
            params.orgId,
            before.site_id,
            'captive_portal',
            'captive_portal:read',
          );
          const max = await trx
            .selectFrom('portal_terms_versions')
            .select(sql<number>`coalesce(max(version), 0)`.as('v'))
            .where('captive_portal_id', '=', params.id)
            .executeTakeFirstOrThrow();
          const version = Number(max.v) + 1;
          const createdBy = ctx.principal?.kind === 'admin' ? ctx.principal.administratorId : null;
          const rows = await trx
            .insertInto('portal_terms_versions')
            .values(
              Object.entries(body.texts).map(([locale, text]) => ({
                id: newId(),
                organization_id: params.orgId,
                captive_portal_id: params.id,
                version,
                locale,
                body: text,
                created_by: createdBy,
              })),
            )
            .returning(['id', 'captive_portal_id', 'version', 'locale', 'body', 'created_at'])
            .execute();
          const after = await trx
            .updateTable('captive_portals')
            .set({ terms_version: String(version) })
            .where('id', '=', params.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, ctx, {
            organizationId: params.orgId,
            action: 'captive_portal:update',
            targetType: 'captive_portal',
            targetId: params.id,
            before: { terms_version: before.terms_version },
            after: {
              terms_version: after.terms_version,
              locales: rows.map((r) => r.locale),
            },
          });
          return { version, rows };
        });
        return {
          status: 201,
          body: {
            version: String(result.version),
            data: result.rows.map((r) => ({ ...r, created_at: iso(r.created_at) })),
          },
        };
      },
    }),
  ];

  const previews: AnyRouteSpec[] = [
    defineRoute({
      method: 'post',
      path: `${base}/portal-previews`,
      summary: 'Prepare a designer preview (sample data; returns a short-lived same-origin URL)',
      tags: [tag],
      auth: 'principal',
      permission: 'portal_theme:read',
      scope: 'organization',
      params: OrgParams,
      body: PreviewCreate,
      audit: false,
      responses: {
        201: { description: 'Preview ticket', schema: PreviewTicketSchema },
        ...problemResponses,
      },
      handler: async ({ params, body, ctx }) => {
        // Validate references now so the GET only renders.
        await loadPreviewInput(deps, ctx, params.orgId, body);
        const token = randomToken(24);
        const ticket: PreviewTicket = {
          orgId: params.orgId,
          principal: principalKey(ctx),
          request: body,
        };
        await deps.kv.set(`portal-preview:${token}`, JSON.stringify(ticket), PREVIEW_TTL_SECONDS);
        return {
          status: 201,
          body: {
            preview_url: `/api/v1/orgs/${params.orgId}/portal-previews/${token}`,
            expires_in: PREVIEW_TTL_SECONDS,
          },
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: `${base}/portal-previews/:token`,
      summary: 'Rendered designer preview (HTML, strict CSP sandbox; frame from the admin app)',
      tags: [tag],
      auth: 'principal',
      permission: 'portal_theme:read',
      scope: 'organization',
      params: z.object({ orgId: z.uuid(), token: z.string().regex(PREVIEW_TOKEN_RE) }),
      responses: {
        200: { description: 'HTML document', contentType: 'text/html', schema: z.string() },
        ...problemResponses,
      },
      handler: async ({ params, ctx }) => {
        const raw = await deps.kv.get(`portal-preview:${params.token}`);
        const ticket = raw === null ? null : (JSON.parse(raw) as PreviewTicket);
        if (
          ticket === null ||
          ticket.orgId !== params.orgId ||
          ticket.principal !== principalKey(ctx)
        ) {
          throw new NotFoundError('portal_preview');
        }
        const input = await loadPreviewInput(deps, ctx, params.orgId, ticket.request);
        const html = renderPortalPreview(input.theme, ticket.request.page, input.sample);
        return {
          status: 200,
          body: html,
          contentType: 'text/html; charset=utf-8',
          headers: { ...PREVIEW_HEADERS },
        };
      },
    }),
  ];

  const secrets: AnyRouteSpec[] = [
    defineRoute({
      method: 'post',
      path: `${base}/captive-portals/:id/rotate-uam-secret`,
      summary:
        'Generate / rotate the UAM shared secret of a captive portal (returned once; configure it on the AP or gateway)',
      tags: [tag],
      auth: 'principal',
      permission: 'captive_portal:secret:rotate',
      scope: 'organization',
      params: PortalParams,
      idempotency: 'required',
      secretFields: ['uam_secret'],
      responses: {
        200: {
          description: 'New secret (shown once, never stored in clear or returned again)',
          schema: z.object({
            id: z.uuid(),
            uam_secret: z.string(),
            uam_secret_configured: z.literal(true),
          }),
        },
        ...problemResponses,
      },
      handler: async ({ params, req, ctx }) => {
        // D-027: support administrators never see or set tenant secrets.
        if (requestIsImpersonating(req)) {
          throw new ImpersonationForbiddenError('captive_portal:secret:rotate');
        }
        const secret = randomToken(24);
        await inTenant(deps, params.orgId, async (trx) => {
          const before = await trx
            .selectFrom('captive_portals')
            .select(['id', 'uam_secret_ref', 'uam_secret_version'])
            .where('id', '=', params.id)
            .forUpdate()
            .executeTakeFirst();
          if (before === undefined) throw new NotFoundError('captive_portal', params.id);
          // Task 10: the version is bound into the AAD, so a rotation MUST bump it in the same
          // UPDATE as the new ciphertext. Without the bump a pre-rotation ciphertext written back
          // into this row would still verify, and rollback protection would be decorative.
          const nextVersion = before.uam_secret_version + 1;
          await trx
            .updateTable('captive_portals')
            .set({
              uam_secret_ref: sealUamSecret(deps.config.dataEncryptionKey, secret, {
                organizationId: params.orgId,
                portalId: params.id,
                secretVersion: nextVersion,
              }),
              uam_secret_version: nextVersion,
            })
            .where('id', '=', params.id)
            .execute();
          await writeAudit(trx, ctx, {
            organizationId: params.orgId,
            action: 'captive_portal:secret:rotate',
            targetType: 'captive_portal',
            targetId: params.id,
            before: { uam_secret_configured: before.uam_secret_ref !== null },
            after: { uam_secret_configured: true, rotated: true },
          });
        });
        return {
          status: 200,
          body: { id: params.id, uam_secret: secret, uam_secret_configured: true },
          headers: { 'Cache-Control': 'no-store' },
        };
      },
    }),
  ];


  // -------------------------------------------------------------------------------------------
  // Publishing (§8): an immutable validated snapshot, an atomic pointer move, and a rollback
  // that leaves drafts alone. The runtime reads the snapshot, never the draft rows.
  // -------------------------------------------------------------------------------------------

  const VersionParams = z.object({ orgId: z.uuid(), id: z.uuid(), versionId: z.uuid() });

  /** Loads the draft (portal + its theme) for a snapshot, with the portal row locked. */
  async function loadDraft(
    trx: Parameters<Parameters<typeof inTenant>[2]>[0],
    portalId: string,
  ): Promise<{ portal: Row; draft: PortalDraft; termsTextAvailable: boolean }> {
    const portal = (await trx
      .selectFrom('captive_portals')
      .selectAll()
      .where('id', '=', portalId)
      .forUpdate()
      .executeTakeFirst()) as Row | undefined;
    if (portal === undefined) throw new NotFoundError('captive_portal', portalId);
    const themeId = portal.theme_id as string | null;
    const theme =
      themeId === null
        ? null
        : ((await trx
            .selectFrom('portal_themes')
            .select(['colors', 'strings', 'logo_asset_ref', 'custom_css'])
            .where('id', '=', themeId)
            .executeTakeFirst()) ?? null);
    // A named terms version must have text, or the page promises a document it cannot show.
    const termsVersion = portal.terms_version as string | null;
    const termsRow =
      termsVersion === null || !/^\d{1,9}$/.test(termsVersion)
        ? undefined
        : await trx
            .selectFrom('portal_terms_versions')
            .select(['id'])
            .where('captive_portal_id', '=', portalId)
            .where('version', '=', Number(termsVersion))
            .executeTakeFirst();
    return {
      portal,
      termsTextAvailable: termsRow !== undefined,
      draft: {
        name: portal.name as string,
        template_key: (portal.template_key as string | null) ?? DEFAULT_PORTAL_TEMPLATE,
        auth_methods: (portal.auth_methods as string[] | null) ?? [],
        method_order: (portal.method_order as string[] | null) ?? [],
        identity_provider_ids: (portal.identity_provider_ids as string[] | null) ?? [],
        redirect_url: (portal.redirect_url as string | null) ?? null,
        terms_version: (portal.terms_version as string | null) ?? null,
        registration_fields: portal.registration_fields,
        locales: (portal.locales as string[] | null) ?? [],
        theme:
          theme === null
            ? null
            : {
                colors: (theme.colors ?? {}),
                strings: (theme.strings ?? {}),
                logo_asset_ref: theme.logo_asset_ref,
                custom_css: theme.custom_css,
              },
      },
    };
  }

  const versions: AnyRouteSpec[] = [
    defineRoute({
      method: 'get',
      path: `${base}/captive-portals/:id/versions`,
      summary: 'List the published versions of a captive portal, and the draft publish check',
      tags: [tag],
      auth: 'principal',
      permission: 'captive_portal:read',
      scope: 'any-site',
      params: PortalParams,
      responses: {
        200: {
          description: 'Versions newest first, plus whether the current draft could be published',
          schema: z.object({
            published_version_id: z.uuid().nullable(),
            draft_publishable: z.boolean(),
            draft_problems: z.array(z.object({ path: z.string(), message: z.string() })),
            unavailable_methods: z.array(
              z.object({
                method: z.string(),
                missing: z.array(z.string()),
                reasons: z.array(z.string()),
              }),
            ),
            data: z.array(PortalVersionSchema),
          }),
        },
        ...problemResponses,
      },
      handler: async ({ params, ctx }) => {
        const result = await inTenant(deps, params.orgId, async (trx) => {
          const portal = await trx
            .selectFrom('captive_portals')
            .select(['id', 'site_id', 'published_version_id'])
            .where('id', '=', params.id)
            .executeTakeFirst();
          if (portal === undefined) throw new NotFoundError('captive_portal', params.id);
          requireOnSite(ctx, 'captive_portal:read', params.orgId, portal.site_id, 'captive_portal');
          const { draft, termsTextAvailable } = await loadDraft(trx, params.id);
          const capabilities = await portalCapabilities(trx, {
            mailerConfigured: deps.config.base.mail !== null,
          });
          const rows = await trx
            .selectFrom('portal_versions')
            .select(['id', 'captive_portal_id', 'version', 'published_by', 'published_at'])
            .where('captive_portal_id', '=', params.id)
            .orderBy('version', 'desc')
            .limit(100)
            .execute();
          return {
            portal,
            rows,
            problems: publishProblems(buildSnapshot(draft), capabilities, { termsTextAvailable }),
            unavailable: draft.auth_methods
              .map((method) => ({ method, availability: methodAvailability(method, capabilities) }))
              .filter((m) => !m.availability.available)
              .map((m) => ({
                method: m.method,
                missing: m.availability.available ? [] : [...m.availability.missing],
                reasons: m.availability.available
                  ? []
                  : m.availability.missing.map((d) => PORTAL_DEPENDENCY_REASON[d]),
              })),
          };
        });
        return {
          status: 200,
          body: {
            published_version_id: result.portal.published_version_id,
            draft_publishable: result.problems.length === 0,
            draft_problems: result.problems,
            unavailable_methods: result.unavailable,
            data: result.rows.map((r) => ({
              ...r,
              published_at: iso(r.published_at),
              current: r.id === result.portal.published_version_id,
            })),
          },
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: `${base}/captive-portals/:id/publish`,
      summary: 'Publish the current draft as a new immutable version and serve it to guests',
      tags: [tag],
      auth: 'principal',
      permission: 'captive_portal:update',
      scope: 'any-site',
      params: PortalParams,
      idempotency: 'optional',
      responses: {
        201: { description: 'Published', schema: PortalVersionSchema },
        ...problemResponses,
      },
      handler: async ({ params, ctx }) => {
        const published = await inTenant(deps, params.orgId, async (trx) => {
          const { portal, draft, termsTextAvailable } = await loadDraft(trx, params.id);
          requireOnSite(
            ctx,
            'captive_portal:update',
            params.orgId,
            portal.site_id as string,
            'captive_portal',
            'captive_portal:read',
          );
          const capabilities = await portalCapabilities(trx, {
            mailerConfigured: deps.config.base.mail !== null,
          });
          const snapshot = buildSnapshot(draft);
          const problems = publishProblems(snapshot, capabilities, { termsTextAvailable });
          // §16: an incomplete template is never silently published.
          if (problems.length > 0) {
            throw new ValidationError(
              problems.map((p) => ({ path: `draft.${p.path}`, message: p.message })),
            );
          }
          const max = await trx
            .selectFrom('portal_versions')
            .select(sql<number>`coalesce(max(version), 0)`.as('v'))
            .where('captive_portal_id', '=', params.id)
            .executeTakeFirstOrThrow();
          const version = Number(max.v) + 1;
          const publishedBy =
            ctx.principal?.kind === 'admin' ? ctx.principal.administratorId : null;
          const row = await trx
            .insertInto('portal_versions')
            .values({
              id: newId(),
              organization_id: params.orgId,
              captive_portal_id: params.id,
              version,
              snapshot: JSON.stringify(snapshot),
              published_by: publishedBy,
            })
            .returning(['id', 'captive_portal_id', 'version', 'published_by', 'published_at'])
            .executeTakeFirstOrThrow();
          // The atomic step: one column, so no guest can observe a half-published portal.
          await trx
            .updateTable('captive_portals')
            .set({ published_version_id: row.id })
            .where('id', '=', params.id)
            .execute();
          await writeAudit(trx, ctx, {
            organizationId: params.orgId,
            action: 'captive_portal:update',
            targetType: 'captive_portal',
            targetId: params.id,
            before: { published_version_id: portal.published_version_id },
            after: { published_version_id: row.id, version },
          });
          return row;
        });
        return {
          status: 201,
          body: { ...published, published_at: iso(published.published_at), current: true },
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: `${base}/captive-portals/:id/versions/:versionId/restore`,
      summary: 'Roll back to an earlier published version (drafts and history are kept)',
      tags: [tag],
      auth: 'principal',
      permission: 'captive_portal:update',
      scope: 'any-site',
      params: VersionParams,
      idempotency: 'optional',
      responses: {
        200: { description: 'Restored', schema: PortalVersionSchema },
        ...problemResponses,
      },
      handler: async ({ params, ctx }) => {
        const restored = await inTenant(deps, params.orgId, async (trx) => {
          const portal = await trx
            .selectFrom('captive_portals')
            .select(['id', 'site_id', 'published_version_id'])
            .where('id', '=', params.id)
            .forUpdate()
            .executeTakeFirst();
          if (portal === undefined) throw new NotFoundError('captive_portal', params.id);
          requireOnSite(
            ctx,
            'captive_portal:update',
            params.orgId,
            portal.site_id,
            'captive_portal',
            'captive_portal:read',
          );
          const row = await trx
            .selectFrom('portal_versions')
            .select(['id', 'captive_portal_id', 'version', 'published_by', 'published_at'])
            .where('id', '=', params.versionId)
            .where('captive_portal_id', '=', params.id)
            .executeTakeFirst();
          // Scoped to this portal as well as this tenant: a version id of another portal is a
          // not-found, never a cross-portal restore.
          if (row === undefined) throw new NotFoundError('portal_version', params.versionId);
          await trx
            .updateTable('captive_portals')
            .set({ published_version_id: row.id })
            .where('id', '=', params.id)
            .execute();
          await writeAudit(trx, ctx, {
            organizationId: params.orgId,
            action: 'captive_portal:update',
            targetType: 'captive_portal',
            targetId: params.id,
            before: { published_version_id: portal.published_version_id },
            after: { published_version_id: row.id, version: row.version, restored: true },
          });
          return row;
        });
        return {
          status: 200,
          body: { ...restored, published_at: iso(restored.published_at), current: true },
        };
      },
    }),
  ];

  return [...portals, ...secrets, ...terms, ...versions, ...themes, ...assets, ...previews];
}

/**
 * Assets are served with a one-day public cache (P6-B review finding 4): an id never changes
 * content, but a deleted logo must stop being served by caches within a bounded time.
 */
export const ASSET_CACHE_CONTROL = 'public, max-age=86400';

function assetInUse(themeIds: string[]): AppError {
  return new AppError(409, 'conflict', 'Conflict', {
    detail: 'The asset is used by a portal theme; remove it from the theme first.',
    extensions: { theme_ids: themeIds },
  });
}

export function assetHeaders(
  contentType: string,
  sha256: string,
  cacheControl: string,
): Record<string, string> {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': 'inline',
    'Cache-Control': cacheControl,
    ETag: `"${sha256}"`,
  };
}

/** Resolves the theme (stored + draft), the logo (as data: URI) and sample data for a preview. */
async function loadPreviewInput(
  deps: AppDeps,
  ctx: RequestContext,
  orgId: string,
  request: PreviewRequest,
): Promise<{
  theme: Parameters<typeof renderPortalPreview>[0];
  sample: Parameters<typeof renderPortalPreview>[2];
}> {
  const loaded = await inTenant(deps, orgId, async (trx) => {
    let portal: Row | undefined;
    let siteName = 'Sample site';
    if (request.captive_portal_id !== undefined) {
      portal = await trx
        .selectFrom('captive_portals')
        .selectAll()
        .where('id', '=', request.captive_portal_id)
        .executeTakeFirst();
      if (portal === undefined)
        throw new NotFoundError('captive_portal', request.captive_portal_id);
      requireOnSite(ctx, 'captive_portal:read', orgId, portal.site_id as string, 'captive_portal');
      const site = await trx
        .selectFrom('sites')
        .select('name')
        .where('id', '=', portal.site_id as string)
        .executeTakeFirst();
      siteName = site?.name ?? siteName;
    }
    const themeId = request.theme_id ?? (portal?.theme_id as string | null | undefined) ?? null;
    let theme: Row | undefined;
    if (themeId !== null) {
      theme = await trx
        .selectFrom('portal_themes')
        .selectAll()
        .where('id', '=', themeId)
        .executeTakeFirst();
      if (theme === undefined) throw new NotFoundError('portal_theme', themeId);
    }
    let termsText: string | null = null;
    const termsVersion = (portal?.terms_version as string | null | undefined) ?? null;
    if (portal !== undefined && termsVersion !== null) {
      const rows = await trx
        .selectFrom('portal_terms_versions')
        .select(['locale', 'body'])
        .where('captive_portal_id', '=', portal.id as string)
        .where('version', '=', Number(termsVersion))
        .execute();
      termsText =
        (rows.find((r) => r.locale === request.locale) ?? rows.find((r) => r.locale === 'en'))
          ?.body ?? null;
    }
    const logoId =
      request.draft?.logo_asset_id !== undefined
        ? request.draft.logo_asset_id
        : ((theme?.logo_asset_ref as string | null | undefined) ?? null);
    let logo: { id: string; storage_key: string; byte_size: number } | undefined;
    if (logoId !== null) {
      logo = await trx
        .selectFrom('portal_assets')
        .select(['id', 'storage_key', 'byte_size'])
        .where('id', '=', logoId)
        .executeTakeFirst();
      if (logo === undefined) throw new NotFoundError('portal_asset', logoId);
    }
    return { portal, siteName, theme, termsText, termsVersion, logo };
  });

  const colors = resolvePortalColors({
    ...((loaded.theme?.colors as Record<string, unknown> | undefined) ?? {}),
    ...(request.draft?.colors ?? {}),
  });
  const strings = resolvePortalStrings(
    request.draft?.strings ?? (loaded.theme?.strings as Record<string, unknown> | undefined),
    request.locale,
  );
  let logoSrc: string | null = null;
  if (loaded.logo !== undefined && loaded.logo.byte_size <= PREVIEW_LOGO_MAX_BYTES) {
    const tenant = forTenant(requireStorage(deps), orgId);
    tenant.assertOwnKey(loaded.logo.storage_key);
    const object = await tenant.get(BRANDING, loaded.logo.id);
    logoSrc = `data:${object.contentType};base64,${(await readAll(object)).toString('base64')}`;
  }
  const methods = (
    (loaded.portal?.auth_methods as string[] | undefined) ?? [...PORTAL_LOGIN_METHODS]
  ).filter((m): m is PortalLoginMethod => (PORTAL_LOGIN_METHODS as readonly string[]).includes(m));
  return {
    theme: {
      colors,
      strings,
      logoSrc,
      locale: request.locale,
      dir: localeDirection(request.locale),
    },
    sample: {
      portalName: (loaded.portal?.name as string | undefined) ?? 'Guest Wi-Fi',
      siteName: loaded.siteName,
      loginMethods: methods,
      termsText: loaded.termsText,
      termsVersion: loaded.termsVersion,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Internal: asset bytes for the portal origin (/a/{assetId})
// ---------------------------------------------------------------------------------------------

const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSET_LOOKUP = Object.freeze({ reason: 'portal-asset-serve', audit: false });

/**
 * `GET /internal/portal-assets/:assetId` (internal listener, X-Internal-Token): the portal
 * process proxies its public `/a/{assetId}` to this endpoint (the portal holds no database or
 * storage credentials). Branding assets are public by design (shown before login); the id is a
 * random UUID. Bytes come from the owning tenant's prefix only, with the stored content type,
 * `nosniff`, a sandbox CSP and immutable caching (an asset id never changes content).
 */
export function internalAssetHandler(deps: AppDeps): RequestHandler {
  return async (req, res) => {
    const assetId = String(req.params.assetId ?? '').toLowerCase();
    if (!ASSET_ID_RE.test(assetId) || deps.storage === undefined) {
      res.status(404).end();
      return;
    }
    const row = await withPlatform(deps.dbPlatform, ASSET_LOOKUP, (trx) =>
      trx
        .selectFrom('portal_assets')
        .select(['id', 'organization_id', 'storage_key', 'sha256'])
        .where('id', '=', assetId)
        .executeTakeFirst(),
    );
    if (row === undefined) {
      res.status(404).end();
      return;
    }
    const tenant = forTenant(deps.storage, row.organization_id);
    tenant.assertOwnKey(row.storage_key);
    const etag = `"${row.sha256}"`;
    if (req.get('If-None-Match') === etag) {
      res.status(304).setHeader('ETag', etag).end();
      return;
    }
    const object = await tenant.get(BRANDING, row.id);
    const bytes = await readAll(object);
    for (const [k, v] of Object.entries(
      assetHeaders(object.contentType, row.sha256, ASSET_CACHE_CONTROL),
    )) {
      res.setHeader(k, v);
    }
    res.status(200).send(bytes);
  };
}
