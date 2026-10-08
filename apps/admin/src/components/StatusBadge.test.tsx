import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EnforceabilityMatrix, toAdapterColumns } from '../features/policies/EnforceabilityMatrix';
import {
  ADAPTER_FIELD_STATUSES,
  EVIDENCE_LEVELS,
  SOURCE_VERIFIED_DESCRIPTION,
  presentStatus,
} from '../lib/adapterStatus';
import { disconnectGate } from '../lib/disconnect';
import { StatusBadge } from './StatusBadge';

describe('four-state enforceability badges (D-028) × evidence level (plan §4.4)', () => {
  it.each(ADAPTER_FIELD_STATUSES)(
    '%s renders its own state and is not device-enforced without lab evidence',
    (status) => {
      const { container } = render(<StatusBadge status={status} evidence="POLICY_ENGINE.md §3" />);
      const el = container.querySelector('[data-status]');
      expect(el?.getAttribute('data-status')).toBe(status);
      expect(el?.getAttribute('data-device-enforced')).toBe('false');
    },
  );

  it.each(['VERIFIED', 'verified_supported', 'SUPPORTED', '', null, undefined, 42])(
    'never renders %s as verified',
    (status) => {
      const { container } = render(<StatusBadge status={status} />);
      const el = container.querySelector('[data-status]');
      expect(el?.getAttribute('data-device-enforced')).toBe('false');
      expect(el?.getAttribute('data-status')).not.toBe('VERIFIED_SUPPORTED');
      expect(container).not.toHaveTextContent(/^✓/);
      expect(presentStatus(status).deviceEnforced).toBe(false);
    },
  );

  it('source-verified cells read "Verified (source)" / "Expected (source-verified, not device-tested)"', () => {
    const p = presentStatus('VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE');
    expect([p.label, p.previewLabel, p.variant, p.deviceEnforced]).toEqual([
      'Verified (source)',
      'Expected (source-verified, not device-tested)',
      'outline',
      false,
    ]);
    expect(p.description).toBe(SOURCE_VERIFIED_DESCRIPTION);
    // Missing evidence level (today's API payload): says so, never implies source evidence.
    expect(presentStatus('VERIFIED_SUPPORTED').label).toBe(
      'Verified (evidence level not reported)',
    );
    expect(presentStatus('VERIFIED_SUPPORTED', 'bogus').previewLabel).toBe(
      'Expected (evidence level not reported, not device-tested)',
    );
    expect(presentStatus('VERIFIED_SUPPORTED').deviceEnforced).toBe(false);
    const { container } = render(
      <StatusBadge
        status="VERIFIED_SUPPORTED"
        evidenceLevel="VERIFIED_FROM_SOURCE"
        mode="preview"
      />,
    );
    expect(container).toHaveTextContent('Expected (source-verified, not device-tested)');
    expect(
      container.querySelector('[data-device-enforced]')?.getAttribute('data-device-enforced'),
    ).toBe('false');
  });

  it('"Lab validated" (device-enforced) only with LAB_VALIDATED evidence AND a DT reference', () => {
    const lab = presentStatus('VERIFIED_SUPPORTED', 'LAB_VALIDATED', { dtRefs: ['DT-04'] });
    expect([lab.label, lab.variant, lab.deviceEnforced]).toEqual(['Lab validated', 'solid', true]);
    expect(lab.description).toContain('DT-04');
    const noRef = presentStatus('VERIFIED_SUPPORTED', 'LAB_VALIDATED');
    expect([noRef.label, noRef.deviceEnforced]).toEqual(['Verified (source)', false]);
    for (const level of ['DOCUMENTED', 'SIMULATOR_TESTED'])
      expect(presentStatus('VERIFIED_SUPPORTED', level, { dtRefs: ['DT-04'] })).toMatchObject({
        label: 'Needs device test',
        deviceEnforced: false,
      });
  });

  it('no non-LAB_VALIDATED cell renders as device-enforced (V12)', () => {
    for (const status of [...ADAPTER_FIELD_STATUSES, 'UNKNOWN', undefined])
      for (const level of [...EVIDENCE_LEVELS, undefined, 'lab_validated'])
        for (const dtRefs of [undefined, [], ['DT-04']]) {
          const p = presentStatus(status, level, { dtRefs });
          const allowed =
            status === 'VERIFIED_SUPPORTED' &&
            (level === 'LAB_VALIDATED' || level === 'PRODUCTION_VALIDATED') &&
            (dtRefs?.length ?? 0) > 0;
          expect(p.deviceEnforced, `${String(status)}/${String(level)}/${String(dtRefs)}`).toBe(
            allowed,
          );
          const { container, unmount } = render(
            <StatusBadge status={status} evidenceLevel={level} dtRefs={dtRefs} />,
          );
          expect(
            container.querySelector('[data-device-enforced]')?.getAttribute('data-device-enforced'),
          ).toBe(allowed ? 'true' : 'false');
          unmount();
        }
  });

  it('matrix shows device-enforced only for lab-validated cells; source-verified cells as expected', () => {
    const adapters = toAdapterColumns([
      {
        adapter: 'coovachilli-uam',
        field_table: [
          {
            field: 'download_rate_kbps',
            status: 'REQUIRES_DEVICE_TEST',
            evidence: 'NETWORK_INTEGRATION.md §2',
            set: true,
          },
          {
            field: 'quota_daily_bytes',
            status: 'ECLOUD_SIDE_ONLY',
            evidence: 'POLICY_ENGINE.md §3',
            set: true,
          },
        ],
      },
      {
        key: 'openwifi-hostapd-radius',
        fields: [
          { field: 'download_rate_kbps', status: 'VERIFIED_SUPPORTED', evidence: 'test record' },
          { field: 'quota_daily_bytes', status: 'UNSUPPORTED', evidence: 'POLICY_ENGINE.md §3' },
        ],
      },
      {
        key: 'openwifi-uspot-uam',
        fields: [
          {
            field: 'download_rate_kbps',
            status: 'VERIFIED_SUPPORTED',
            evidence_level: 'LAB_VALIDATED',
            dt_refs: ['DT-04'],
            evidence: 'lab record',
          },
          {
            field: 'quota_daily_bytes',
            status: 'VERIFIED_SUPPORTED',
            evidence_level: 'VERIFIED_FROM_SOURCE',
            evidence: 'V-054',
          },
        ],
      },
    ]);
    render(
      <EnforceabilityMatrix
        adapters={adapters}
        fields={['download_rate_kbps', 'quota_daily_bytes', 'vlan_id']}
        mode="preview"
      />,
    );
    const table = screen.getByRole('table');
    const enforced = table.querySelectorAll('[data-device-enforced="true"]');
    expect(enforced).toHaveLength(1);
    expect(enforced[0]?.getAttribute('data-evidence-level')).toBe('LAB_VALIDATED');
    expect(
      within(table).getAllByText('Expected (source-verified, not device-tested)'),
    ).toHaveLength(1);
    expect(
      within(table).getAllByText('Expected (evidence level not reported, not device-tested)'),
    ).toHaveLength(1);
    const rows = within(table).getAllByRole('row');
    // vlan_id is undeclared by every adapter → shown as not verified.
    const vlan = rows.find((r) => r.textContent?.includes('VLAN'));
    expect(vlan?.querySelectorAll('[data-device-enforced="true"]')).toHaveLength(0);
    expect(vlan?.querySelectorAll('[data-status="REQUIRES_DEVICE_TEST"]')).toHaveLength(3);
  });

  it('no admin source claims device testing for unvalidated entries (R-10 regression guard)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
      (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f),
    );
    const forbidden = [
      /verified by a recorded device test/i,
      /Only Verified entries have passed/i,
      /Only <strong>Verified<\/strong> fields are enforced/i,
      /Enforced by the device; verified/i,
    ];
    for (const f of files) {
      const text = readFileSync(join(root, f), 'utf8');
      for (const re of forbidden) expect(re.test(text), `${f} matches ${String(re)}`).toBe(false);
    }
  });
});

describe('session Disconnect gating', () => {
  const base = { adapterKey: 'openwifi-uspot-uam', hasPermission: true, endpointAvailable: true };
  const LAB = { status: 'VERIFIED_SUPPORTED', evidenceLevel: 'LAB_VALIDATED', dtRefs: ['DT-07'] };
  it('is disabled unless the adapter disconnect is VERIFIED_SUPPORTED with lab evidence (V5, V12)', () => {
    for (const status of [
      'REQUIRES_DEVICE_TEST',
      'UNSUPPORTED',
      'ECLOUD_SIDE_ONLY',
      undefined,
      'VERIFIED',
    ]) {
      const gate = disconnectGate({ ...base, status });
      expect(gate.enabled).toBe(false);
      expect(gate.reason.length).toBeGreaterThan(10);
    }
    // Source-verified only (or lab evidence without a DT reference) is not enough.
    expect(disconnectGate({ ...base, status: 'VERIFIED_SUPPORTED' }).enabled).toBe(false);
    expect(
      disconnectGate({ ...base, status: 'VERIFIED_SUPPORTED', evidenceLevel: 'LAB_VALIDATED' })
        .enabled,
    ).toBe(false);
    expect(disconnectGate({ ...base, ...LAB }).enabled).toBe(true);
  });
  it('also requires the permission and an API endpoint', () => {
    expect(disconnectGate({ ...base, ...LAB, hasPermission: false }).enabled).toBe(false);
    expect(disconnectGate({ ...base, ...LAB, endpointAvailable: false }).enabled).toBe(false);
  });
});
