/**
 * Compatibility registry read API (MULTI_VENDOR_INTEGRATION_PLAN.md §7, §8.2):
 *   GET /api/v1/compatibility, GET /api/v1/compatibility/{key}, GET /api/v1/vendors
 *
 * Served from the database mirror that `ecloud-db seed` writes from @ecloud/adapters (hash
 * checked), so it shows exactly the registry. Cells are presented with the registry's own rules
 * (`presentCells`: V11 override, V12 `device_enforced` only for LAB/PRODUCTION evidence with a
 * DT reference). Permission `compatibility:read` from ANY binding: the registry is the same
 * platform-curated data for every tenant (explicit choice in plan §8.2).
 */
import { presentCells, type PresentedCell, type RegistryFact } from '@ecloud/adapters';
import { compatibilityRowFromRow } from '@ecloud/db';
import { NotFoundError, type EvidenceRef } from '@ecloud/shared';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { problemResponses } from '../http/common.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';

const TAG = ['compatibility'];
const KEY_RE = /^[a-z0-9][a-z0-9.-]{1,127}$/;

const LIFECYCLE = z.enum([
  'planned',
  'researched',
  'implemented',
  'lab-validated',
  'production-validated',
]);

function ref(r: EvidenceRef): Record<string, string> {
  return {
    kind: r.kind,
    ref: r.ref,
    ...(r.url !== undefined ? { url: r.url } : {}),
    ...(r.appliesTo !== undefined ? { applies_to: r.appliesTo } : {}),
  };
}

function fact(f: RegistryFact): Record<string, unknown> {
  return {
    value: f.value,
    evidence_level: f.evidenceLevel,
    evidence_refs: f.evidenceRefs.map(ref),
    ...(f.label !== undefined ? { label: f.label } : {}),
  };
}

function cell(c: PresentedCell): Record<string, unknown> {
  return {
    group: c.group,
    capability: c.capability,
    status: c.status,
    engine_status: c.engineStatus,
    evidence_level: c.evidenceLevel,
    evidence_refs: c.evidenceRefs.map(ref),
    dt_refs: c.dtRefs,
    device_enforced: c.deviceEnforced,
    ...(c.note !== undefined ? { note: c.note } : {}),
  };
}

type EntryRow = Record<string, unknown>;

function serializeEntry(row: EntryRow, docLinks: unknown): Record<string, unknown> {
  const typed = compatibilityRowFromRow(row);
  return {
    key: typed.key,
    vendor_key: typed.vendorKey,
    hardware_model: typed.hardwareModel,
    hardware_model_id: row.hardware_model_id ?? null,
    firmware: typed.firmware,
    firmware_version_id: row.firmware_version_id ?? null,
    controller: typed.controller,
    lifecycle: typed.lifecycle,
    deployment_modes: typed.deploymentModes,
    enforcement_point: typed.enforcementPoint,
    adapter_key: typed.adapterKey,
    source_version_matches_device: typed.sourceVersionMatchesDevice,
    configuration_kind: typed.configurationKind,
    identity: typed.identity.map(fact),
    profile: Object.fromEntries(
      Object.entries(typed.profile as unknown as Record<string, RegistryFact>).map(([k, f]) => [
        k,
        fact(f),
      ]),
    ),
    capabilities: presentCells(typed.capabilities).map(cell),
    open_items: typed.openItems,
    doc_links: Array.isArray(docLinks) ? (docLinks as EvidenceRef[]).map(ref) : [],
    registry_hash: row.registry_hash,
  };
}

const EntrySchema = z
  .looseObject({
    key: z.string(),
    vendor_key: z.string(),
    lifecycle: LIFECYCLE,
    capabilities: z.array(
      z.looseObject({
        group: z.string(),
        capability: z.string(),
        status: z.string(),
        evidence_level: z.string().nullable(),
        dt_refs: z.array(z.string()),
        device_enforced: z.boolean(),
      }),
    ),
    doc_links: z.array(z.looseObject({ kind: z.string(), ref: z.string() })),
    registry_hash: z.string(),
  })
  .meta({
    id: 'CompatibilityEntry',
    description:
      'Registry row (plan §7.1). device_enforced is true only for LAB_VALIDATED / PRODUCTION_VALIDATED evidence with a device-test reference (V12).',
  });

const VendorSchema = z
  .looseObject({
    key: z.string(),
    name: z.string(),
    lifecycle: LIFECYCLE,
    roadmap_phase: z.string(),
    doc_links: z.array(z.looseObject({ kind: z.string(), ref: z.string() })),
    compatibility_keys: z.array(z.string()),
    registry_hash: z.string(),
  })
  .meta({ id: 'Vendor', description: 'Vendor entry of the compatibility registry (plan §7.1)' });

export function registryRoutes(deps: AppDeps): AnyRouteSpec[] {
  async function docLinksByVendor(): Promise<Map<string, unknown>> {
    const vendors = await deps.db.selectFrom('vendors').select(['key', 'doc_links']).execute();
    return new Map(vendors.map((v) => [v.key, v.doc_links]));
  }

  const list = defineRoute({
    method: 'get',
    path: '/api/v1/compatibility',
    summary: 'Compatibility registry rows with status, evidence level, lifecycle and doc links',
    tags: TAG,
    auth: 'principal',
    permission: 'compatibility:read',
    scope: 'any-binding',
    query: z.object({
      vendor_key: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,63}$/)
        .optional(),
      lifecycle: LIFECYCLE.optional(),
      adapter_key: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{1,63}$/)
        .optional(),
    }),
    responses: {
      200: {
        description: 'Registry rows (database mirror of @ecloud/adapters)',
        schema: z.object({ data: z.array(EntrySchema) }),
      },
      ...problemResponses,
    },
    handler: async ({ query }) => {
      let q = deps.db.selectFrom('compatibility_entries').selectAll().orderBy('key');
      if (query.vendor_key) q = q.where('vendor_key', '=', query.vendor_key);
      if (query.lifecycle) q = q.where('lifecycle', '=', query.lifecycle);
      if (query.adapter_key) q = q.where('adapter_key', '=', query.adapter_key);
      const [rows, links] = await Promise.all([q.execute(), docLinksByVendor()]);
      return {
        status: 200,
        body: {
          data: rows.map((r) => serializeEntry(r as EntryRow, links.get(r.vendor_key))),
        },
      };
    },
  });

  const get = defineRoute({
    method: 'get',
    path: '/api/v1/compatibility/:key',
    summary: 'One compatibility registry row',
    tags: TAG,
    auth: 'principal',
    permission: 'compatibility:read',
    scope: 'any-binding',
    params: z.object({ key: z.string().regex(KEY_RE, 'registry row key') }),
    responses: { 200: { description: 'Registry row', schema: EntrySchema }, ...problemResponses },
    handler: async ({ params }) => {
      const row = await deps.db
        .selectFrom('compatibility_entries')
        .selectAll()
        .where('key', '=', params.key)
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError('compatibility_entry', params.key);
      const links = await docLinksByVendor();
      return { status: 200, body: serializeEntry(row, links.get(row.vendor_key)) };
    },
  });

  const vendors = defineRoute({
    method: 'get',
    path: '/api/v1/vendors',
    summary: 'Vendors of the compatibility registry with lifecycle and roadmap phase',
    tags: TAG,
    auth: 'principal',
    permission: 'compatibility:read',
    scope: 'any-binding',
    responses: {
      200: { description: 'Vendors', schema: z.object({ data: z.array(VendorSchema) }) },
      ...problemResponses,
    },
    handler: async () => {
      const [rows, entries] = await Promise.all([
        deps.db.selectFrom('vendors').selectAll().orderBy('key').execute(),
        deps.db
          .selectFrom('compatibility_entries')
          .select(['key', 'vendor_key'])
          .orderBy('key')
          .execute(),
      ]);
      return {
        status: 200,
        body: {
          data: rows.map((v) => ({
            key: v.key,
            name: v.name,
            lifecycle: v.lifecycle,
            roadmap_phase: v.roadmap_phase,
            doc_links: Array.isArray(v.doc_links) ? (v.doc_links as EvidenceRef[]).map(ref) : [],
            notes: v.notes,
            compatibility_keys: entries.filter((e) => e.vendor_key === v.key).map((e) => e.key),
            registry_hash: v.registry_hash,
          })),
        },
      };
    },
  });

  return [list, get, vendors];
}
