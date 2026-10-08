/**
 * Mirrors the typed compatibility registry of `@ecloud/adapters` into the platform tables of
 * migration 019 (MULTI_VENDOR_INTEGRATION_PLAN.md §7, §8.2): `vendors`, `hardware_models`,
 * `firmware_versions`, `compatibility_entries`. One source of truth, same pattern as the
 * permission catalogue: the registry is code, `ecloud-db seed` upserts it idempotently.
 *
 * Every vendor and row carries `registry_hash` = SHA-256 of its canonical JSON. After the upsert
 * the seed REBUILDS each typed entry from the database columns, hashes it and compares it with
 * the registry (inside the same transaction); any difference rolls the seed back. Stale
 * `compatibility_entries` (nothing references them) are deleted; vendors / models / firmware
 * that left the registry are reported, never deleted (tenant rows may reference them).
 */
import {
  REGISTRY_SNAPSHOT,
  registryEntryHash,
  registrySnapshotHash,
  type CompatibilityRow,
  type RegistrySnapshot,
  type VendorEntry,
} from '@ecloud/adapters';
import { newId } from '@ecloud/shared';
import { withMigrationLock, type MigrationExecutor } from './migrate.js';

export interface RegistrySeedResult {
  /** Snapshot hash of the registry that was mirrored. */
  registryHash: string;
  vendors: { total: number; inserted: number; updated: number; orphans: string[] };
  hardwareModels: { total: number; inserted: number; orphans: string[] };
  firmwareVersions: { total: number; inserted: number; orphans: string[] };
  entries: { total: number; inserted: number; updated: number; removed: string[] };
  check: RegistryMirrorCheck;
}

export interface RegistryMirrorCheck {
  /** True when every registry vendor and row is mirrored exactly and no stale row exists. */
  ok: boolean;
  registryHash: string;
  /** Snapshot hash recomputed from the database rows (equals `registryHash` when ok). */
  mirrorHash: string;
  mismatches: string[];
  /** Vendors / models / firmware present in the database but not in the registry (warning). */
  orphans: string[];
}

interface ModelKey {
  vendorKey: string;
  model: string;
}

interface FirmwareKey {
  vendorKey: string;
  model: string | null;
  version: string;
  controllerProduct: string | null;
  controllerVersion: string | null;
}

const UNKNOWN = 'UNKNOWN';

function modelOf(row: CompatibilityRow): ModelKey | null {
  return row.hardwareModel === UNKNOWN
    ? null
    : { vendorKey: row.vendorKey, model: row.hardwareModel };
}

function firmwareOf(row: CompatibilityRow): FirmwareKey | null {
  if (row.firmware === UNKNOWN) return null;
  return {
    vendorKey: row.vendorKey,
    model: row.hardwareModel === UNKNOWN ? null : row.hardwareModel,
    version: row.firmware,
    controllerProduct: row.controller?.product ?? null,
    controllerVersion: row.controller?.version ?? null,
  };
}

const modelId = (m: ModelKey): string => `${m.vendorKey}\u0000${m.model.toLowerCase()}`;
const firmwareId = (f: FirmwareKey): string =>
  [
    f.vendorKey,
    f.model?.toLowerCase() ?? '',
    f.version.toLowerCase(),
    f.controllerProduct ?? '',
    f.controllerVersion ?? '',
  ].join('\u0000');

/** Rebuilds the typed vendor entry from a `vendors` row. */
export function vendorFromRow(row: Record<string, unknown>): VendorEntry {
  const entry: Record<string, unknown> = {
    key: row.key,
    name: row.name,
    lifecycle: row.lifecycle,
    roadmapPhase: row.roadmap_phase,
    docLinks: row.doc_links,
  };
  if (row.notes !== null && row.notes !== undefined) entry.notes = row.notes;
  return entry as unknown as VendorEntry;
}

/** Rebuilds the typed compatibility row from a `compatibility_entries` row. */
export function compatibilityRowFromRow(row: Record<string, unknown>): CompatibilityRow {
  return {
    key: row.key,
    vendorKey: row.vendor_key,
    hardwareModel: row.hardware_model,
    firmware: row.firmware,
    controller: row.controller ?? null,
    lifecycle: row.lifecycle,
    deploymentModes: row.deployment_modes,
    enforcementPoint: row.enforcement_point,
    adapterKey: row.adapter_key ?? null,
    sourceVersionMatchesDevice: row.source_version_matches_device ?? null,
    identity: row.identity,
    profile: row.profile,
    capabilities: row.capabilities,
    configurationKind: row.configuration_kind,
    openItems: row.open_items,
  } as unknown as CompatibilityRow;
}

const SELECT_VENDORS_SQL = 'SELECT * FROM vendors ORDER BY key';
const SELECT_ENTRIES_SQL = `SELECT e.*, m.model AS linked_model, f.version AS linked_firmware
  FROM compatibility_entries e
  LEFT JOIN hardware_models m ON m.id = e.hardware_model_id
  LEFT JOIN firmware_versions f ON f.id = e.firmware_version_id
 ORDER BY e.key`;

/**
 * Compares the database mirror with `snapshot` by rebuilding every typed entry from its columns.
 * Read-only; runs on any connection that can SELECT the four tables.
 */
export async function verifyRegistryMirror(
  exec: MigrationExecutor,
  snapshot: RegistrySnapshot = REGISTRY_SNAPSHOT,
): Promise<RegistryMirrorCheck> {
  const mismatches: string[] = [];
  const orphans: string[] = [];
  const vendorRows = (await exec.query(SELECT_VENDORS_SQL)).rows;
  const entryRows = (await exec.query(SELECT_ENTRIES_SQL)).rows;

  const rebuiltVendors: VendorEntry[] = [];
  const dbVendors = new Map(vendorRows.map((r) => [r.key as string, r]));
  for (const vendor of snapshot.vendors) {
    const row = dbVendors.get(vendor.key);
    if (row === undefined) {
      mismatches.push(`vendor ${vendor.key}: missing in database`);
      continue;
    }
    const rebuilt = vendorFromRow(row);
    rebuiltVendors.push(rebuilt);
    const expected = registryEntryHash(vendor);
    if (registryEntryHash(rebuilt) !== expected) {
      mismatches.push(`vendor ${vendor.key}: content differs from the registry`);
    }
    if (row.registry_hash !== expected)
      mismatches.push(`vendor ${vendor.key}: stale registry_hash`);
  }
  const vendorKeys = new Set(snapshot.vendors.map((v) => v.key));
  for (const key of dbVendors.keys()) if (!vendorKeys.has(key)) orphans.push(`vendor ${key}`);

  const rebuiltRows: CompatibilityRow[] = [];
  const dbEntries = new Map(entryRows.map((r) => [r.key as string, r]));
  for (const entry of snapshot.rows) {
    const row = dbEntries.get(entry.key);
    if (row === undefined) {
      mismatches.push(`row ${entry.key}: missing in database`);
      continue;
    }
    const rebuilt = compatibilityRowFromRow(row);
    rebuiltRows.push(rebuilt);
    const expected = registryEntryHash(entry);
    if (registryEntryHash(rebuilt) !== expected) {
      mismatches.push(`row ${entry.key}: content differs from the registry`);
    }
    if (row.registry_hash !== expected) mismatches.push(`row ${entry.key}: stale registry_hash`);
    // the normalised references must name the same model / firmware as the row text
    const linkedModel = (row.linked_model as string | null) ?? UNKNOWN;
    if (linkedModel.toLowerCase() !== entry.hardwareModel.toLowerCase()) {
      mismatches.push(
        `row ${entry.key}: hardware_model_id does not reference ${entry.hardwareModel}`,
      );
    }
    const linkedFirmware = (row.linked_firmware as string | null) ?? UNKNOWN;
    if (linkedFirmware.toLowerCase() !== entry.firmware.toLowerCase()) {
      mismatches.push(`row ${entry.key}: firmware_version_id does not reference ${entry.firmware}`);
    }
  }
  const rowKeys = new Set(snapshot.rows.map((r) => r.key));
  for (const key of dbEntries.keys()) {
    if (!rowKeys.has(key)) mismatches.push(`row ${key}: in database but not in the registry`);
  }

  const wantedModels = new Set(
    snapshot.rows.map(modelOf).flatMap((m) => (m === null ? [] : [modelId(m)])),
  );
  for (const m of (await exec.query('SELECT vendor_key, model FROM hardware_models')).rows) {
    if (!wantedModels.has(modelId({ vendorKey: m.vendor_key as string, model: m.model as string })))
      orphans.push(`hardware_model ${String(m.vendor_key)}/${String(m.model)}`);
  }
  const wantedFirmware = new Set(
    snapshot.rows.map(firmwareOf).flatMap((f) => (f === null ? [] : [firmwareId(f)])),
  );
  const firmwareRows = (
    await exec.query(
      `SELECT f.vendor_key, m.model, f.version, f.controller_product, f.controller_version
         FROM firmware_versions f LEFT JOIN hardware_models m ON m.id = f.hardware_model_id`,
    )
  ).rows;
  for (const f of firmwareRows) {
    const key: FirmwareKey = {
      vendorKey: f.vendor_key as string,
      model: (f.model as string | null) ?? null,
      version: f.version as string,
      controllerProduct: (f.controller_product as string | null) ?? null,
      controllerVersion: (f.controller_version as string | null) ?? null,
    };
    if (!wantedFirmware.has(firmwareId(key)))
      orphans.push(`firmware_version ${key.vendorKey}/${key.version}`);
  }

  const registryHash = registrySnapshotHash(snapshot);
  const mirrorHash = registrySnapshotHash({ vendors: rebuiltVendors, rows: rebuiltRows });
  if (mismatches.length === 0 && mirrorHash !== registryHash) {
    mismatches.push('snapshot hash differs from the registry');
  }
  return { ok: mismatches.length === 0, registryHash, mirrorHash, mismatches, orphans };
}

const UPSERT_VENDOR_SQL = `INSERT INTO vendors (key, name, lifecycle, roadmap_phase, doc_links, notes, registry_hash)
VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  lifecycle = EXCLUDED.lifecycle,
  roadmap_phase = EXCLUDED.roadmap_phase,
  doc_links = EXCLUDED.doc_links,
  notes = EXCLUDED.notes,
  registry_hash = EXCLUDED.registry_hash
WHERE vendors.registry_hash IS DISTINCT FROM EXCLUDED.registry_hash
   OR (vendors.name, vendors.lifecycle, vendors.roadmap_phase, vendors.doc_links, vendors.notes)
      IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.lifecycle, EXCLUDED.roadmap_phase, EXCLUDED.doc_links, EXCLUDED.notes)
RETURNING key, (xmax = 0) AS inserted`;

const SELECT_MODEL_SQL =
  'SELECT id FROM hardware_models WHERE vendor_key = $1 AND lower(model) = lower($2)';
const INSERT_MODEL_SQL =
  'INSERT INTO hardware_models (id, vendor_key, model) VALUES ($1, $2, $3) RETURNING id';

const SELECT_FIRMWARE_SQL = `SELECT id FROM firmware_versions
 WHERE vendor_key = $1 AND hardware_model_id IS NOT DISTINCT FROM $2::uuid
   AND lower(version) = lower($3)
   AND controller_product IS NOT DISTINCT FROM $4 AND controller_version IS NOT DISTINCT FROM $5`;
const INSERT_FIRMWARE_SQL = `INSERT INTO firmware_versions
  (id, vendor_key, hardware_model_id, version, controller_product, controller_version)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;

const UPSERT_ENTRY_SQL = `INSERT INTO compatibility_entries (
  key, vendor_key, hardware_model_id, firmware_version_id, hardware_model, firmware, controller,
  lifecycle, deployment_modes, enforcement_point, adapter_key, source_version_matches_device,
  configuration_kind, identity, profile, capabilities, open_items, registry_hash)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::text[], $10, $11, $12, $13,
        $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18)
ON CONFLICT (key) DO UPDATE SET
  vendor_key = EXCLUDED.vendor_key,
  hardware_model_id = EXCLUDED.hardware_model_id,
  firmware_version_id = EXCLUDED.firmware_version_id,
  hardware_model = EXCLUDED.hardware_model,
  firmware = EXCLUDED.firmware,
  controller = EXCLUDED.controller,
  lifecycle = EXCLUDED.lifecycle,
  deployment_modes = EXCLUDED.deployment_modes,
  enforcement_point = EXCLUDED.enforcement_point,
  adapter_key = EXCLUDED.adapter_key,
  source_version_matches_device = EXCLUDED.source_version_matches_device,
  configuration_kind = EXCLUDED.configuration_kind,
  identity = EXCLUDED.identity,
  profile = EXCLUDED.profile,
  capabilities = EXCLUDED.capabilities,
  open_items = EXCLUDED.open_items,
  registry_hash = EXCLUDED.registry_hash
WHERE compatibility_entries.registry_hash IS DISTINCT FROM EXCLUDED.registry_hash
   OR compatibility_entries.hardware_model_id IS DISTINCT FROM EXCLUDED.hardware_model_id
   OR compatibility_entries.firmware_version_id IS DISTINCT FROM EXCLUDED.firmware_version_id
RETURNING key, (xmax = 0) AS inserted`;

const DELETE_STALE_ENTRIES_SQL =
  'DELETE FROM compatibility_entries WHERE key <> ALL($1::text[]) RETURNING key';

export interface SeedRegistryOptions {
  snapshot?: RegistrySnapshot;
}

/** Upserts the registry mirror in one locked transaction and verifies it before COMMIT. */
export async function seedRegistry(
  exec: MigrationExecutor,
  options: SeedRegistryOptions = {},
): Promise<RegistrySeedResult> {
  const snapshot = options.snapshot ?? REGISTRY_SNAPSHOT;
  return withMigrationLock(exec, async () => {
    await exec.query('BEGIN');
    try {
      let vendorsInserted = 0;
      let vendorsUpdated = 0;
      for (const vendor of snapshot.vendors) {
        const res = await exec.query<{ key: string; inserted: boolean }>(UPSERT_VENDOR_SQL, [
          vendor.key,
          vendor.name,
          vendor.lifecycle,
          vendor.roadmapPhase,
          JSON.stringify(vendor.docLinks),
          vendor.notes ?? null,
          registryEntryHash(vendor),
        ]);
        const row = res.rows[0];
        if (row?.inserted === true) vendorsInserted += 1;
        else if (row !== undefined) vendorsUpdated += 1;
      }

      const modelIds = new Map<string, string>();
      let modelsInserted = 0;
      for (const model of snapshot.rows.map(modelOf)) {
        if (model === null || modelIds.has(modelId(model))) continue;
        const found = (
          await exec.query<{ id: string }>(SELECT_MODEL_SQL, [model.vendorKey, model.model])
        ).rows[0];
        let id = found?.id;
        if (id === undefined) {
          const inserted = await exec.query<{ id: string }>(INSERT_MODEL_SQL, [
            newId(),
            model.vendorKey,
            model.model,
          ]);
          id = inserted.rows[0]?.id;
          modelsInserted += 1;
        }
        if (id === undefined) throw new Error(`hardware model ${model.model} has no id`);
        modelIds.set(modelId(model), id);
      }

      const firmwareIds = new Map<string, string>();
      let firmwareInserted = 0;
      for (const fw of snapshot.rows.map(firmwareOf)) {
        if (fw === null || firmwareIds.has(firmwareId(fw))) continue;
        const hwId =
          fw.model === null
            ? null
            : (modelIds.get(modelId({ vendorKey: fw.vendorKey, model: fw.model })) ?? null);
        const params = [fw.vendorKey, hwId, fw.version, fw.controllerProduct, fw.controllerVersion];
        const found = (await exec.query<{ id: string }>(SELECT_FIRMWARE_SQL, params)).rows[0];
        let id = found?.id;
        if (id === undefined) {
          const inserted = await exec.query<{ id: string }>(INSERT_FIRMWARE_SQL, [
            newId(),
            ...params,
          ]);
          id = inserted.rows[0]?.id;
          firmwareInserted += 1;
        }
        if (id === undefined) throw new Error(`firmware ${fw.version} has no id`);
        firmwareIds.set(firmwareId(fw), id);
      }

      let entriesInserted = 0;
      let entriesUpdated = 0;
      for (const row of snapshot.rows) {
        const model = modelOf(row);
        const fw = firmwareOf(row);
        const res = await exec.query<{ key: string; inserted: boolean }>(UPSERT_ENTRY_SQL, [
          row.key,
          row.vendorKey,
          model === null ? null : (modelIds.get(modelId(model)) ?? null),
          fw === null ? null : (firmwareIds.get(firmwareId(fw)) ?? null),
          row.hardwareModel,
          row.firmware,
          row.controller === null ? null : JSON.stringify(row.controller),
          row.lifecycle,
          [...row.deploymentModes],
          row.enforcementPoint,
          row.adapterKey,
          row.sourceVersionMatchesDevice,
          row.configurationKind,
          JSON.stringify(row.identity),
          JSON.stringify(row.profile),
          JSON.stringify(row.capabilities),
          JSON.stringify(row.openItems),
          registryEntryHash(row),
        ]);
        const result = res.rows[0];
        if (result?.inserted === true) entriesInserted += 1;
        else if (result !== undefined) entriesUpdated += 1;
      }
      const removed = (
        await exec.query<{ key: string }>(DELETE_STALE_ENTRIES_SQL, [
          snapshot.rows.map((r) => r.key),
        ])
      ).rows.map((r) => r.key);

      const check = await verifyRegistryMirror(exec, snapshot);
      if (!check.ok) {
        throw new Error(`registry mirror check failed: ${check.mismatches.join('; ')}`);
      }
      await exec.query('COMMIT');
      return {
        registryHash: check.registryHash,
        vendors: {
          total: snapshot.vendors.length,
          inserted: vendorsInserted,
          updated: vendorsUpdated,
          orphans: check.orphans.filter((o) => o.startsWith('vendor ')).map((o) => o.slice(7)),
        },
        hardwareModels: {
          total: modelIds.size,
          inserted: modelsInserted,
          orphans: check.orphans
            .filter((o) => o.startsWith('hardware_model '))
            .map((o) => o.slice(15)),
        },
        firmwareVersions: {
          total: firmwareIds.size,
          inserted: firmwareInserted,
          orphans: check.orphans
            .filter((o) => o.startsWith('firmware_version '))
            .map((o) => o.slice(17)),
        },
        entries: {
          total: snapshot.rows.length,
          inserted: entriesInserted,
          updated: entriesUpdated,
          removed,
        },
        check,
      };
    } catch (error) {
      await exec.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}
