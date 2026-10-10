/**
 * Tenant resources built on the generic CRUD factory: sites, network devices, NAS clients,
 * subscribers, user groups, client devices, schedules.
 */
import {
  POSTBACK_ADAPTER_KEY,
  getVendorAdapter,
  parsePostbackNasConfig,
  postbackAdapterForNas,
  serializePostbackNasConfig,
} from '@ecloud/adapters';
import { hashPassword, withPlatform } from '@ecloud/db';
import { ScheduleRuleSchema, isValidTimeZone } from '@ecloud/policy-engine';
import {
  ConflictError,
  NAS_ADDRESS_RULE,
  NotFoundError,
  ValidationError,
  canonicalNasAddress,
} from '@ecloud/shared';
import type { DbTransaction } from '@ecloud/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requestIsImpersonating } from '../auth/middleware.js';
import type { AppDeps } from '../context.js';
import { Envelope, NAS_SECRET_PURPOSE, randomToken, sealSecretRef } from '../crypto.js';
import { OrgIdParams, ResourceSchema, problemResponses } from '../http/common.js';
import { ImpersonationForbiddenError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { assertRef, inTenant, requireOnSite } from '../tenant.js';
import { NAS_ADAPTER_KEYS, nasAdapter } from '../nas-adapter.js';
import { isPrivateIpv4 } from '@ecloud/adapters';
import { ForbiddenError } from '@ecloud/shared';
import { evaluate } from '../auth/authorize.js';
import type { CrudHookContext } from './crud.js';
import { releaseGlobalSlots } from '../global-slots.js';
import { softDeleteAccessPointsOf } from './access-points.js';
import { assertControllerFor, resolveDeploymentMode } from './controllers.js';
import { crudRoutes, loose, type Row } from './crud.js';

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]?){5}[0-9A-Fa-f]{2}$/;

/** `aa:bb:cc:dd:ee:ff` (API_ARCHITECTURE.md §3.2 client-devices). */
export function canonicalMac(value: string): string {
  const hex = value.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.match(/.{2}/g)?.join(':') ?? hex;
}

const mac = z.string().trim().regex(MAC_RE, 'MAC address').transform(canonicalMac);
const timezone = z
  .string()
  .trim()
  .min(1)
  .refine((tz) => isValidTimeZone(tz), 'IANA time zone');
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const name = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().max(500).nullable().optional();
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

// ---------------------------------------------------------------------------------------------

const SiteCreate = z.strictObject({
  slug,
  name,
  timezone: timezone.default('UTC'),
  address: optionalText,
  settings: z.record(z.string(), z.unknown()).optional(),
});
const SiteUpdate = z.strictObject({
  name: name.optional(),
  timezone: timezone.optional(),
  address: optionalText,
  status: z.enum(['active', 'suspended', 'archived']).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const DEPLOYMENT_MODES = ['native', 'gateway'] as const;

const NetworkDeviceCreate = z.strictObject({
  site_id: z.uuid(),
  serial: z.string().trim().min(1).max(128),
  mac: mac.nullable().optional(),
  model: optionalText,
  firmware: optionalText,
  mode: z.enum(['bridge', 'routed', 'unknown']).optional(),
  adapter_type_key: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{1,63}$/)
    .nullable()
    .optional(),
  /** Migration 019: compatibility-registry references and the managing controller. */
  hardware_model_id: z.uuid().nullable().optional(),
  firmware_version_id: z.uuid().nullable().optional(),
  controller_id: z.uuid().nullable().optional(),
  /** false for third-party APs behind a gateway that ECLOUD does not configure. */
  managed: z.boolean().optional(),
});
const NetworkDeviceUpdate = NetworkDeviceCreate.partial().omit({ serial: true });

const NasCreate = z.strictObject({
  site_id: z.uuid(),
  name,
  /** F-P10-07 review: a single unicast host (no mapped / loopback / link-local / multicast). */
  nas_ip: z
    .union([z.ipv4(), z.ipv6()])
    .refine((ip) => canonicalNasAddress(ip) !== null, { message: NAS_ADDRESS_RULE }),
  nas_identifier: z.string().trim().min(1).max(253).nullable().optional(),
  /** D-035: the @ecloud/adapters key; `adapter_type_key` is derived from it. */
  adapter_key: z.enum(NAS_ADAPTER_KEYS),
  network_device_id: z.uuid().nullable().optional(),
  coa_port: z.number().int().min(1).max(65535).nullable().optional(),
  coa_supported: z.boolean().nullable().optional(),
  require_message_authenticator: z.boolean().optional(),
  /**
   * Migration 029 (Cycle B): lab opt-in — the AAA layer also emits REQUIRES_DEVICE_TEST reply
   * attributes (marked experimental) for this NAS so a device test can observe them (D-028/D-034).
   */
  device_test_attributes: z.boolean().optional(),
  /**
   * Migration 029 (review F1): the NAS's browser login address (MikroTik: the HotSpot interface
   * IP behind `$(link-login-only)`), unicast private IPv4; REQUIRED for `mikrotik-hotspot`.
   * The portal refuses any login target on another host / port.
   */
  hotspot_address: z
    .ipv4()
    .refine((ip) => isPrivateIpv4(ip), { message: 'must be an RFC 1918 / RFC 6598 IPv4 address' })
    .nullable()
    .optional(),
  hotspot_port: z.number().int().min(1).max(65535).nullable().optional(),
  /** Migration 019: defaults from the compatibility registry rows of `adapter_key`. */
  deployment_mode: z.enum(DEPLOYMENT_MODES).optional(),
  /** Migration 019: a controller of the same organization (and of the NAS site when site-bound). */
  controller_id: z.uuid().nullable().optional(),
  /**
   * Migration 030 (Cycle C): adapter settings; only `external-portal-postback` uses them (post-back
   * profile, login hosts, generic parameter names). Validated by `parsePostbackNasConfig`.
   */
  adapter_config: z.record(z.string(), z.unknown()).optional(),
});
const NasUpdate = NasCreate.partial().extend({ status: z.enum(['active', 'disabled']).optional() });

/**
 * Cycle C: the stored `adapter_config` for `adapterKey`. The post-back adapter needs a valid
 * profile config (strict allow-list, normalised); every other adapter takes none (`{}`).
 */
export function nasAdapterConfigFor(adapterKey: string | null, input: unknown): string {
  if (adapterKey === POSTBACK_ADAPTER_KEY) {
    const parsed = parsePostbackNasConfig(input ?? null);
    if (!parsed.ok) {
      throw new ValidationError(
        parsed.errors.map((e) => ({
          path: `body.adapter_config${e.path === '' || e.path.startsWith('adapter_config') ? e.path.replace(/^adapter_config/, '') : `.${e.path}`}`,
          message: e.message,
        })),
      );
    }
    return JSON.stringify(serializePostbackNasConfig(parsed.config));
  }
  if (
    input !== undefined &&
    input !== null &&
    !(typeof input === 'object' && Object.keys(input).length === 0)
  ) {
    throw new ValidationError([
      { path: 'body.adapter_config', message: `only used by the ${POSTBACK_ADAPTER_KEY} adapter` },
    ]);
  }
  return '{}';
}

/**
 * Review L1: adapters whose NAS identifier is part of a public portal URL
 * (`/pb/<profile>/<nasid>/`) or of the redirect itself (MikroTik `identity`). The portal resolves
 * a NAS identifier before any tenant is known and refuses an ambiguous one, so another
 * organization registering the same identifier would deny service. For these adapters the
 * identifier is unique across organizations among live NAS (in both directions); identifiers of
 * other adapters keep the per-organization rule (unchanged).
 */
export const PUBLIC_NAS_IDENTIFIER_ADAPTERS: ReadonlySet<string> = new Set([
  POSTBACK_ADAPTER_KEY,
  'mikrotik-hotspot',
]);

const IDENTIFIER_CHECK_ACCESS = Object.freeze({ reason: 'nas-identifier-check', audit: false });

/** Generic 409 (no tenant detail) when the identifier collides across organizations (L1). */
export async function assertNasIdentifierAvailable(
  deps: AppDeps,
  input: { orgId: string; identifier: unknown; adapterKey: unknown },
): Promise<void> {
  if (typeof input.identifier !== 'string' || input.identifier === '') return;
  const identifier = input.identifier;
  const others = await withPlatform(deps.dbPlatform, IDENTIFIER_CHECK_ACCESS, (trx) =>
    trx
      .selectFrom('nas_clients')
      .select(['adapter_key'])
      .where('nas_identifier', '=', identifier)
      .where('organization_id', '<>', input.orgId)
      .where('deleted_at', 'is', null)
      .limit(20)
      .execute(),
  );
  const mine =
    typeof input.adapterKey === 'string' && PUBLIC_NAS_IDENTIFIER_ADAPTERS.has(input.adapterKey);
  if (
    others.length > 0 &&
    (mine || others.some((o) => PUBLIC_NAS_IDENTIFIER_ADAPTERS.has(o.adapter_key ?? '')))
  ) {
    throw new ConflictError();
  }
}

const AUTH_METHODS = ['password', 'mac', 'voucher', 'idp'] as const;
export const UserCreate = z.strictObject({
  username: z.string().trim().min(1).max(253).regex(/^\S+$/, 'no whitespace'),
  password: z.string().min(8).max(256).optional(),
  site_id: z.uuid().nullable().optional(),
  user_group_id: z.uuid().nullable().optional(),
  display_name: optionalText,
  email: z.email().nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  status: z.enum(['active', 'suspended', 'expired', 'disabled']).optional(),
  valid_from: instant.nullable().optional(),
  valid_until: instant.nullable().optional(),
  max_devices: z.number().int().positive().nullable().optional(),
  auth_methods: z.array(z.enum(AUTH_METHODS)).min(1).optional(),
});
const UserUpdate = UserCreate.partial().omit({ username: true });

const UserGroupCreate = z.strictObject({
  name,
  description: z.string().trim().max(500).optional(),
  site_id: z.uuid().nullable().optional(),
  is_default: z.boolean().optional(),
});
const UserGroupUpdate = UserGroupCreate.partial();

const ClientDeviceCreate = z.strictObject({
  mac,
  user_id: z.uuid().nullable().optional(),
  name: optionalText,
  device_type: optionalText,
  mac_auth_enabled: z.boolean().optional(),
  blocked: z.boolean().optional(),
});
const ClientDeviceUpdate = ClientDeviceCreate.partial().omit({ mac: true });

const ScheduleCreate = z.strictObject({
  name,
  timezone,
  rules: z.array(ScheduleRuleSchema).min(1).max(50),
});
const ScheduleUpdate = ScheduleCreate.partial();

// ---------------------------------------------------------------------------------------------

/** Effective value of a PATCHed column: the body's when present (null clears), else the row's. */
function patched(body: Row, before: Row, key: string): unknown {
  return body[key] !== undefined ? body[key] : before[key];
}

/** controller_id on PATCH: re-check when the controller or the site changes (G9 + site rule). */
async function assertControllerOnPatch(trx: DbTransaction, body: Row, before: Row): Promise<void> {
  const controllerId = patched(body, before, 'controller_id');
  if (typeof controllerId !== 'string') return;
  if (body.controller_id === undefined && body.site_id === undefined) return;
  await assertControllerFor(
    trx,
    controllerId,
    patched(body, before, 'site_id') as string,
    'body.controller_id',
  );
}

/**
 * Registry references of a network device (019): the model / firmware must exist in the
 * platform mirror and agree with each other; the controller must belong to the organization.
 */
async function assertDeviceRefs(trx: DbTransaction, body: Row, before: Row): Promise<void> {
  const modelId = patched(body, before, 'hardware_model_id');
  const firmwareId = patched(body, before, 'firmware_version_id');
  if (typeof body.hardware_model_id === 'string') {
    const model = await trx
      .selectFrom('hardware_models')
      .select('id')
      .where('id', '=', body.hardware_model_id)
      .executeTakeFirst();
    if (model === undefined) {
      throw new ValidationError([
        { path: 'body.hardware_model_id', message: 'unknown hardware model' },
      ]);
    }
  }
  if (
    typeof firmwareId === 'string' &&
    (body.firmware_version_id !== undefined || body.hardware_model_id !== undefined)
  ) {
    const firmware = await sql<{ hardware_model_id: string | null }>`
      SELECT hardware_model_id FROM firmware_versions WHERE id = ${firmwareId}
    `.execute(trx);
    const row = firmware.rows[0];
    if (row === undefined) {
      throw new ValidationError([
        { path: 'body.firmware_version_id', message: 'unknown firmware version' },
      ]);
    }
    if (row.hardware_model_id !== null && row.hardware_model_id !== modelId) {
      throw new ValidationError([
        {
          path: 'body.firmware_version_id',
          message: 'the firmware version belongs to another hardware model',
        },
      ]);
    }
  }
  await assertControllerOnPatch(trx, body, before);
}

function withoutKeys(row: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v;
  return out;
}

export function resourceRoutes(deps: AppDeps): AnyRouteSpec[] {
  const dataEnvelope = new Envelope(deps.config.dataEncryptionKey, NAS_SECRET_PURPOSE);
  const argonMemory = deps.config.base.argon2.memoryKib;

  const sites = crudRoutes(deps, {
    table: 'sites',
    path: '/sites',
    resource: 'site',
    tag: 'sites',
    permissions: {
      read: 'site:read',
      create: 'site:create',
      update: 'site:update',
      delete: 'site:delete',
    },
    siteMode: 'self',
    softDelete: true,
    createSchema: SiteCreate,
    updateSchema: SiteUpdate,
    serialize: (row) => withoutKeys(row, ['geo']),
    prepareCreate: (body) => Promise.resolve({ ...body, settings: body.settings ?? {} }),
    // Review M2: a deleted site frees its globally unique slots (AP MACs, NAS IPs, devices).
    beforeDelete: async (before, { trx, orgId }) => {
      await releaseGlobalSlots(trx, { organizationId: orgId, siteId: before.id as string });
    },
  });

  const networkDevices = crudRoutes(deps, {
    table: 'network_devices',
    path: '/network-devices',
    resource: 'network_device',
    tag: 'network-devices',
    permissions: {
      read: 'network_device:read',
      create: 'network_device:create',
      update: 'network_device:update',
      delete: 'network_device:delete',
    },
    siteMode: 'column',
    softDelete: true,
    createSchema: NetworkDeviceCreate,
    updateSchema: NetworkDeviceUpdate,
    prepareCreate: async (body, { trx }) => {
      await assertRef(trx, 'sites', body.site_id as string, 'site');
      await assertDeviceRefs(trx, body, {});
      return body;
    },
    preparePatch: async (body, before, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      await assertDeviceRefs(trx, body, before);
      return body;
    },
  });

  /**
   * Review F3: the lab opt-in makes REQUIRES_DEVICE_TEST attributes live, so it needs the
   * platform-only permission `platform:adapter:manage` (never while impersonating) and every
   * change is audited `nas:lab_mode_changed`.
   */
  function assertLabModePermission(hook: CrudHookContext): void {
    if (!evaluate(hook.ctx.principal, 'platform:adapter:manage', { organizationId: hook.orgId })) {
      throw new ForbiddenError({
        detail: 'device_test_attributes needs the platform permission platform:adapter:manage.',
      });
    }
  }

  async function auditLabMode(
    hook: CrudHookContext,
    nasId: string,
    before: boolean,
    after: boolean,
  ): Promise<void> {
    await writeAudit(hook.trx, hook.ctx, {
      organizationId: hook.orgId,
      action: 'nas:lab_mode_changed',
      targetType: 'nas_client',
      targetId: nasId,
      before: { device_test_attributes: before },
      after: { device_test_attributes: after },
    });
  }

  /** Review F1: a MikroTik NAS must name its HotSpot login address. */
  function assertHotspotAddress(adapterKey: unknown, address: unknown, port: unknown): void {
    if (adapterKey === 'mikrotik-hotspot' && (address === null || address === undefined)) {
      throw new ValidationError([
        {
          path: 'body.hotspot_address',
          message: 'required for mikrotik-hotspot (the router HotSpot interface IP)',
        },
      ]);
    }
    if (port !== null && port !== undefined && (address === null || address === undefined)) {
      throw new ValidationError([{ path: 'body.hotspot_port', message: 'needs hotspot_address' }]);
    }
  }

  const nas = crudRoutes(deps, {
    table: 'nas_clients',
    path: '/nas',
    resource: 'nas_client',
    tag: 'nas',
    permissions: {
      read: 'nas:read',
      create: 'nas:create',
      update: 'nas:update',
      delete: 'nas:delete',
    },
    siteMode: 'column',
    softDelete: true,
    createSchema: NasCreate,
    updateSchema: NasUpdate,
    filters: { status: z.enum(['active', 'disabled']).optional() },
    idempotency: 'optional',
    secretFields: ['secret'],
    serialize: (row) => withoutKeys(row, ['secret_ref']),
    prepareCreate: async (body, hook) => {
      await assertRef(hook.trx, 'sites', body.site_id as string, 'site');
      await assertNasIdentifierAvailable(deps, {
        orgId: hook.orgId,
        identifier: body.nas_identifier,
        adapterKey: body.adapter_key,
      });
      if (typeof body.network_device_id === 'string') {
        await assertRef(hook.trx, 'network_devices', body.network_device_id, 'network_device');
      }
      if (typeof body.controller_id === 'string') {
        await assertControllerFor(
          hook.trx,
          body.controller_id,
          body.site_id as string,
          'body.controller_id',
        );
      }
      const deploymentMode = resolveDeploymentMode(
        body.adapter_key as string,
        body.deployment_mode as 'native' | 'gateway' | undefined,
      );
      assertHotspotAddress(body.adapter_key, body.hotspot_address, body.hotspot_port);
      if (body.device_test_attributes === true) assertLabModePermission(hook);
      // 32 random bytes → 43 base64url chars; RADIUS shared secrets ≤ 128 octets.
      const secret = randomToken(32);
      hook.scratch.secret = secret;
      // Cycle B: without an explicit CoA port the adapter's documented DAS default is stored
      // (MikroTik /radius incoming 1700); other adapters keep NULL (deployment default).
      const defaultCoaPort = nasAdapter(body.adapter_key as string)?.capabilities().disconnect
        .defaultPort;
      return {
        ...body,
        ...(body.coa_port === undefined && defaultCoaPort !== undefined
          ? { coa_port: defaultCoaPort }
          : {}),
        adapter_config: nasAdapterConfigFor(body.adapter_key as string, body.adapter_config),
        deployment_mode: deploymentMode,
        adapter_type_key: body.adapter_key,
        secret_ref: sealSecretRef(dataEnvelope, secret),
      };
    },
    afterCreate: async (row, hook) => {
      if (row.device_test_attributes === true) {
        await auditLabMode(hook, row.id as string, false, true);
      }
      return { ...row, secret: hook.scratch.secret };
    },
    // Cycle A (migration 028): a deleted NAS takes its access points along (frees their MACs).
    beforeDelete: (before, { trx }) => softDeleteAccessPointsOf(trx, before.id as string),
    preparePatch: async (body, before, hook) => {
      const { trx, orgId } = hook;
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      if (typeof body.network_device_id === 'string') {
        await assertRef(trx, 'network_devices', body.network_device_id, 'network_device');
      }
      await assertControllerOnPatch(trx, body, before);
      assertHotspotAddress(
        patched(body, before, 'adapter_key'),
        patched(body, before, 'hotspot_address'),
        patched(body, before, 'hotspot_port'),
      );
      if (
        body.device_test_attributes !== undefined &&
        body.device_test_attributes !== before.device_test_attributes
      ) {
        assertLabModePermission(hook);
        await auditLabMode(
          hook,
          before.id as string,
          before.device_test_attributes === true,
          body.device_test_attributes === true,
        );
      }
      // Review L1: the resulting identifier / adapter pair must not collide across organizations.
      if (body.nas_identifier !== undefined || body.adapter_key !== undefined) {
        await assertNasIdentifierAvailable(deps, {
          orgId,
          identifier:
            body.nas_identifier !== undefined ? body.nas_identifier : before.nas_identifier,
          adapterKey: body.adapter_key !== undefined ? body.adapter_key : before.adapter_key,
        });
      }
      const next: Row =
        typeof body.adapter_key === 'string'
          ? { ...body, adapter_type_key: body.adapter_key }
          : { ...body };
      // Cycle C: re-validate the adapter config whenever it or the adapter changes.
      // Review L8: an adapter_key set to null (not accepted by the API schema today) clears too.
      if (body.adapter_config !== undefined || body.adapter_key !== undefined) {
        const effectiveKey = (
          body.adapter_key !== undefined ? body.adapter_key : before.adapter_key
        ) as string | null;
        const input =
          body.adapter_config !== undefined
            ? body.adapter_config
            : effectiveKey === POSTBACK_ADAPTER_KEY
              ? before.adapter_config
              : undefined;
        next.adapter_config = nasAdapterConfigFor(effectiveKey, input);
      }
      if (body.deployment_mode !== undefined || typeof body.adapter_key === 'string') {
        const adapterKey = (body.adapter_key ?? before.adapter_key) as string | null;
        if (adapterKey !== null) {
          if (body.deployment_mode !== undefined) {
            next.deployment_mode = resolveDeploymentMode(
              adapterKey,
              body.deployment_mode as 'native' | 'gateway',
            );
          } else {
            // adapter changed without a mode: keep the current mode when the new adapter allows
            // it, else fall back to the new adapter's default
            try {
              next.deployment_mode = resolveDeploymentMode(
                adapterKey,
                before.deployment_mode as 'native' | 'gateway',
              );
            } catch {
              next.deployment_mode = resolveDeploymentMode(adapterKey, undefined);
            }
          }
        }
      }
      return next;
    },
  });

  const rotateNasSecret = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/nas/:id/rotate-secret',
    summary: 'Rotate the RADIUS shared secret of a NAS (returned once)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:secret:rotate',
    scope: 'any-site',
    params: OrgIdParams,
    idempotency: 'required',
    secretFields: ['secret'],
    responses: { 200: { description: 'New secret', schema: ResourceSchema }, ...problemResponses },
    handler: async ({ params, req, ctx }) => {
      if (requestIsImpersonating(req)) throw new ImpersonationForbiddenError('nas:secret:rotate');
      const secret = randomToken(32);
      const row = await inTenant(deps, params.orgId, async (trx) => {
        const before = await loose(trx)
          .selectFrom('nas_clients')
          .select(['id', 'site_id', 'name'])
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (before === undefined) throw new NotFoundError('nas_client', params.id);
        requireOnSite(
          ctx,
          'nas:secret:rotate',
          params.orgId,
          before.site_id as string,
          'nas_client',
          'nas:read',
        );
        await trx
          .updateTable('nas_clients')
          .set({ secret_ref: sealSecretRef(dataEnvelope, secret) })
          .where('id', '=', params.id)
          .execute();
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'nas:secret:rotate',
          targetType: 'nas_client',
          targetId: params.id,
          after: { rotated: true },
        });
        return before;
      });
      return { status: 200, body: { id: row.id, secret } };
    },
  });

  /**
   * Cycle C: "how to configure your device" steps for a NAS (docs/VENDOR_INTEGRATION_RESEARCH.md
   * §5): ECLOUD wording, values filled from the NAS (portal URL with its identifier), every
   * secret a placeholder. Read-only; never returns a secret.
   */
  const nasSetupGuide = defineRoute({
    method: 'get',
    path: '/api/v1/orgs/:orgId/nas/:id/setup-guide',
    summary: 'Setup guide steps for a NAS (filled values; secrets as placeholders)',
    tags: ['nas'],
    auth: 'principal',
    permission: 'nas:read',
    scope: 'any-site',
    params: OrgIdParams,
    responses: {
      200: { description: 'Setup guide', schema: ResourceSchema },
      ...problemResponses,
    },
    handler: async ({ params, ctx }) => {
      const row = await inTenant(deps, params.orgId, async (trx) => {
        const r = await loose(trx)
          .selectFrom('nas_clients')
          .select(['id', 'site_id', 'nas_identifier', 'nas_ip', 'adapter_key', 'adapter_config'])
          .where('id', '=', params.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (r === undefined) throw new NotFoundError('nas_client', params.id);
        requireOnSite(ctx, 'nas:read', params.orgId, r.site_id as string, 'nas_client', 'nas:read');
        return r;
      });
      const adapterKey = row.adapter_key as string | null;
      const site = {
        siteId: row.site_id as string,
        nasId: (row.nas_identifier as string | null) ?? '<NAS_IDENTIFIER>',
      };
      let profile: string | null = null;
      let steps: readonly unknown[] = [];
      if (adapterKey === POSTBACK_ADAPTER_KEY) {
        const built = postbackAdapterForNas({
          adapterConfig: row.adapter_config as Record<string, unknown>,
          nasIp: String(row.nas_ip),
        });
        profile = built?.profile.key ?? null;
        steps = built === null ? [] : built.adapter.buildSetupGuide(site);
      } else if (adapterKey !== null) {
        try {
          steps = getVendorAdapter(adapterKey).buildSetupGuide(site);
        } catch {
          steps = [];
        }
      }
      return {
        status: 200,
        body: { id: row.id as string, adapter_key: adapterKey, profile, steps },
      };
    },
  });

  const users = crudRoutes(deps, {
    table: 'users',
    path: '/users',
    resource: 'user',
    tag: 'users',
    permissions: {
      read: 'user:read',
      create: 'user:create',
      update: 'user:update',
      delete: 'user:delete',
    },
    siteMode: 'column',
    softDelete: true,
    createSchema: UserCreate,
    updateSchema: UserUpdate,
    filters: {
      status: z.enum(['active', 'suspended', 'expired', 'disabled']).optional(),
      user_group_id: z.uuid().optional(),
    },
    serialize: (row) => withoutKeys(row, ['password_hash']),
    patchPermission: (body, before) => {
      if (body.password !== undefined) return 'user:password:reset';
      if (body.status !== undefined && body.status !== before.status) return 'user:suspend';
      return undefined;
    },
    prepareCreate: async (body, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      if (typeof body.user_group_id === 'string') {
        await assertRef(trx, 'user_groups', body.user_group_id, 'user_group');
      }
      const { password, auth_methods, ...rest } = body;
      return {
        ...rest,
        auth_methods: auth_methods ?? ['password'],
        password_hash:
          typeof password === 'string'
            ? await hashPassword(password, { memoryKib: argonMemory })
            : null,
      };
    },
    preparePatch: async (body, _before, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      if (typeof body.user_group_id === 'string') {
        await assertRef(trx, 'user_groups', body.user_group_id, 'user_group');
      }
      const { password, ...rest } = body;
      return typeof password === 'string'
        ? { ...rest, password_hash: await hashPassword(password, { memoryKib: argonMemory }) }
        : rest;
    },
  });

  const userGroups = crudRoutes(deps, {
    table: 'user_groups',
    path: '/user-groups',
    resource: 'user_group',
    tag: 'user-groups',
    permissions: {
      read: 'user_group:read',
      create: 'user_group:create',
      update: 'user_group:update',
      delete: 'user_group:delete',
    },
    siteMode: 'column',
    softDelete: false,
    createSchema: UserGroupCreate,
    updateSchema: UserGroupUpdate,
    prepareCreate: async (body, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      return body;
    },
    preparePatch: async (body, _before, { trx }) => {
      if (typeof body.site_id === 'string') await assertRef(trx, 'sites', body.site_id, 'site');
      return body;
    },
  });

  const clientDevices = crudRoutes(deps, {
    table: 'client_devices',
    path: '/client-devices',
    resource: 'client_device',
    tag: 'client-devices',
    permissions: {
      read: 'client_device:read',
      create: 'client_device:create',
      update: 'client_device:update',
      delete: 'client_device:delete',
    },
    siteMode: 'none',
    softDelete: true,
    createSchema: ClientDeviceCreate,
    updateSchema: ClientDeviceUpdate,
    filters: { user_id: z.uuid().optional(), mac: mac.optional() },
    patchPermission: (body, before) =>
      body.blocked !== undefined && body.blocked !== before.blocked
        ? 'client_device:block'
        : undefined,
    prepareCreate: async (body, { trx }) => {
      if (typeof body.user_id === 'string') await assertRef(trx, 'users', body.user_id, 'user');
      return body;
    },
    preparePatch: async (body, _before, { trx }) => {
      if (typeof body.user_id === 'string') await assertRef(trx, 'users', body.user_id, 'user');
      return body;
    },
  });

  const schedules = crudRoutes(deps, {
    table: 'schedules',
    path: '/schedules',
    resource: 'schedule',
    tag: 'policies',
    permissions: {
      read: 'policy:read',
      create: 'policy:create',
      update: 'policy:update',
      delete: 'policy:delete',
    },
    siteMode: 'none',
    softDelete: false,
    createSchema: ScheduleCreate,
    updateSchema: ScheduleUpdate,
    prepareCreate: (body) => Promise.resolve({ ...body, rules: JSON.stringify(body.rules) }),
    preparePatch: (body) =>
      Promise.resolve(
        body.rules === undefined ? body : { ...body, rules: JSON.stringify(body.rules) },
      ),
  });

  return [
    ...sites,
    ...networkDevices,
    ...nas,
    rotateNasSecret,
    nasSetupGuide,
    ...users,
    ...userGroups,
    ...clientDevices,
    ...schedules,
  ];
}
