import { COMPATIBILITY_ROWS, VENDORS, registryEntryHash } from '@ecloud/adapters';
import { describe, expect, it } from 'vitest';
import type { MigrationExecutor } from './migrate.js';
import { compatibilityRowFromRow, vendorFromRow, verifyRegistryMirror } from './registry-seed.js';

/** What PostgreSQL returns for the mirror rows (jsonb parsed, snake_case columns). */
function dbRows() {
  const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const vendors = VENDORS.map((v) => ({
    key: v.key,
    name: v.name,
    lifecycle: v.lifecycle,
    roadmap_phase: v.roadmapPhase,
    doc_links: json(v.docLinks),
    notes: v.notes ?? null,
    registry_hash: registryEntryHash(v),
  }));
  const entries = COMPATIBILITY_ROWS.map((r) => ({
    key: r.key,
    vendor_key: r.vendorKey,
    hardware_model: r.hardwareModel,
    firmware: r.firmware,
    controller: r.controller === null ? null : json(r.controller),
    lifecycle: r.lifecycle,
    deployment_modes: [...r.deploymentModes],
    enforcement_point: r.enforcementPoint,
    adapter_key: r.adapterKey,
    source_version_matches_device: r.sourceVersionMatchesDevice,
    configuration_kind: r.configurationKind,
    identity: json(r.identity),
    profile: json(r.profile),
    capabilities: json(r.capabilities),
    open_items: json(r.openItems),
    registry_hash: registryEntryHash(r),
    linked_model: r.hardwareModel === 'UNKNOWN' ? null : r.hardwareModel,
    linked_firmware: r.firmware === 'UNKNOWN' ? null : r.firmware,
  }));
  return { vendors, entries };
}

function fakeExec(rows: ReturnType<typeof dbRows>): MigrationExecutor {
  return {
    query<R extends Record<string, unknown>>(text: string) {
      let out: Record<string, unknown>[] = [];
      if (text.startsWith('SELECT * FROM vendors')) out = rows.vendors;
      else if (text.startsWith('SELECT e.*')) out = rows.entries;
      return Promise.resolve({ rows: out as R[] });
    },
  };
}

describe('registry mirror rebuild', () => {
  it('rebuilds every typed entry from its database row with an identical hash', () => {
    const { vendors, entries } = dbRows();
    vendors.forEach((row, i) => {
      expect(registryEntryHash(vendorFromRow(row))).toBe(registryEntryHash(VENDORS[i]!));
    });
    entries.forEach((row, i) => {
      expect(registryEntryHash(compatibilityRowFromRow(row))).toBe(
        registryEntryHash(COMPATIBILITY_ROWS[i]!),
      );
    });
  });

  it('verifyRegistryMirror accepts an exact mirror and reports drift', async () => {
    const rows = dbRows();
    expect((await verifyRegistryMirror(fakeExec(rows))).mismatches).toEqual([]);

    const drift = dbRows();
    const tip = drift.entries.find((e) => e.key === 'ezelink-eze-ap1832-r32912-tip-uspot');
    if (tip === undefined) throw new Error('TIP row missing');
    tip.lifecycle = 'lab-validated';
    drift.vendors.pop();
    drift.entries.push({ ...tip, key: 'stale-row' });
    const check = await verifyRegistryMirror(fakeExec(drift));
    expect(check.ok).toBe(false);
    expect(check.mismatches).toEqual(
      expect.arrayContaining([
        'row ezelink-eze-ap1832-r32912-tip-uspot: content differs from the registry',
        `vendor ${VENDORS.at(-1)?.key ?? ''}: missing in database`,
        'row stale-row: in database but not in the registry',
      ]),
    );
  });
});
