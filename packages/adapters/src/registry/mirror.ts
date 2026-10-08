/**
 * Database-mirror helpers for the compatibility registry (MULTI_VENDOR_INTEGRATION_PLAN.md §8.2,
 * L3). The typed registry in this package is the single source of truth; `ecloud-db seed`
 * copies it into `vendors` / `hardware_models` / `firmware_versions` / `compatibility_entries`
 * and proves the copy with these hashes (`registry_hash` = SHA-256 of the canonical JSON).
 *
 * Also the registry-derived views the API needs (no capability fact is computed outside the
 * registry): per-adapter cell evidence for the adapter catalogue and the deployment modes a NAS
 * of a given engine adapter may declare.
 */
import { createHash } from 'node:crypto';
import type { EvidenceLevel } from '@ecloud/shared';
import { COMPATIBILITY_ROWS } from './compatibility.js';
import { presentCells } from './derive.js';
import type { CompatibilityRow, DeploymentMode, VendorEntry } from './types.js';
import { VENDORS } from './vendors.js';

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped (as `JSON.stringify`
 * does), arrays kept in order. Values that round-trip through PostgreSQL `jsonb` hash equal.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = canonicalize(inner);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `registry_hash` of one vendor entry or compatibility row. */
export function registryEntryHash(entry: VendorEntry | CompatibilityRow): string {
  return sha256Hex(canonicalJson(entry));
}

export interface RegistrySnapshot {
  readonly vendors: readonly VendorEntry[];
  readonly rows: readonly CompatibilityRow[];
}

/** The data `ecloud-db seed` mirrors. */
export const REGISTRY_SNAPSHOT: RegistrySnapshot = Object.freeze({
  vendors: VENDORS,
  rows: COMPATIBILITY_ROWS,
});

/**
 * Hash of a whole snapshot, independent of entry order: SHA-256 over the sorted
 * `key=entryHash` lines of vendors and rows.
 */
export function registrySnapshotHash(snapshot: RegistrySnapshot = REGISTRY_SNAPSHOT): string {
  const lines = [
    ...snapshot.vendors.map((v) => `vendor:${v.key}=${registryEntryHash(v)}`),
    ...snapshot.rows.map((r) => `row:${r.key}=${registryEntryHash(r)}`),
  ].sort();
  return sha256Hex(lines.join('\n'));
}

/** Deployment modes the registry rows of `adapterKey` declare (empty when no row names it). */
export function deploymentModesForAdapter(
  adapterKey: string,
  rows: readonly CompatibilityRow[] = COMPATIBILITY_ROWS,
): DeploymentMode[] {
  const modes = new Set<DeploymentMode>();
  for (const row of rows) {
    if (row.adapterKey === adapterKey) for (const m of row.deploymentModes) modes.add(m);
  }
  return [...modes].sort();
}

export interface AdapterCellEvidence {
  /** Evidence level of the registry cells (they derive from the engine declaration). */
  readonly evidenceLevel: EvidenceLevel | null;
  /** Union of the device-test references of every registry row of the adapter. */
  readonly dtRefs: readonly string[];
  /**
   * V12, conservative: true only when EVERY registry row of the adapter presents the cell as
   * device-enforced (one lab-validated device does not make the engine adapter device-enforced
   * on the others).
   */
  readonly deviceEnforced: boolean;
  /** Registry rows that contributed (row keys). */
  readonly rowKeys: readonly string[];
}

/**
 * Evidence of `capability` (a policy field, `macAuth`, `disconnect`, `coaChange`) for the
 * engine adapter `adapterKey`, read from the registry rows that use it. `undefined` when no
 * registry row covers the adapter/capability pair.
 */
export function adapterCellEvidence(
  adapterKey: string,
  capability: string,
  rows: readonly CompatibilityRow[] = COMPATIBILITY_ROWS,
): AdapterCellEvidence | undefined {
  const cells = rows
    .filter((r) => r.adapterKey === adapterKey)
    .flatMap((r) =>
      presentCells(r.capabilities)
        .filter((c) => c.capability === capability)
        .map((c) => ({ row: r.key, cell: c })),
    );
  if (cells.length === 0) return undefined;
  const levels = new Set(cells.map((c) => c.cell.evidenceLevel));
  if (levels.size !== 1) {
    throw new Error(
      `registry rows of ${adapterKey} disagree on the evidence level of ${capability}: ${[...levels].join(', ')}`,
    );
  }
  return {
    evidenceLevel: cells[0]?.cell.evidenceLevel ?? null,
    dtRefs: [...new Set(cells.flatMap((c) => c.cell.dtRefs))].sort(),
    deviceEnforced: cells.every((c) => c.cell.deviceEnforced),
    rowKeys: cells.map((c) => c.row),
  };
}
