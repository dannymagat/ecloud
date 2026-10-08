// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { safeFilename } from '../api/client';
import { adminMe, orgScope, ORG_A } from '../test/fixtures';
import {
  canExport,
  freshnessLevel,
  freshnessText,
  operationGate,
  quotaPercent,
  queuedMessage,
  validateRange,
  type OperationAvailability,
} from './accounting';
import { visibleOrgNav } from './nav';

const REFUSED: OperationAvailability = {
  operation: 'disconnect',
  permission: 'session:disconnect',
  permitted: true,
  available: false,
  mode: null,
  device_enforced: false,
  code: 'dispatcher_disabled',
  reason: 'Disconnect requests are not sent: the CoA/Disconnect dispatcher is disabled (D-006).',
  evidence: {
    status: 'REQUIRES_DEVICE_TEST',
    evidence_level: null,
    device_enforced: false,
    declaration: null,
  },
  dispatcher_enabled: false,
};

const VALIDATED: OperationAvailability = {
  ...REFUSED,
  available: true,
  mode: 'validated',
  device_enforced: true,
  code: null,
  reason: 'Disconnect is lab-validated for this adapter.',
  evidence: {
    status: 'VERIFIED_SUPPORTED',
    evidence_level: 'LAB_VALIDATED',
    device_enforced: true,
    declaration: null,
  },
  dispatcher_enabled: true,
};

const gate = (availability: OperationAvailability | undefined, extra = {}) =>
  operationGate({
    operation: 'disconnect',
    hasPermission: true,
    endpointAvailable: true,
    availability,
    ...extra,
  });

describe('operationGate (D-006, V12)', () => {
  it('shows the registry reason verbatim when the API refuses', () => {
    expect(gate(REFUSED)).toEqual({ enabled: false, reason: REFUSED.reason });
  });

  it('checks the permission first, then the endpoint', () => {
    expect(gate(VALIDATED, { hasPermission: false }).reason).toMatch(/session:disconnect/);
    expect(gate({ ...VALIDATED, permitted: false }).enabled).toBe(false);
    expect(
      operationGate({
        operation: 'reauthorize',
        hasPermission: false,
        endpointAvailable: true,
        availability: VALIDATED,
      }).reason,
    ).toMatch(/session:coa/);
    expect(gate(VALIDATED, { endpointAvailable: false }).reason).toMatch(
      /not available in this API version/,
    );
  });

  it('never enables in lab mode (available but not lab-validated)', () => {
    const lab = { ...VALIDATED, mode: 'lab' as const, device_enforced: false };
    const g = gate({ ...lab, evidence: REFUSED.evidence });
    expect(g.enabled).toBe(false);
    expect(g.reason).toMatch(/only for lab-validated adapters/);
  });

  it('never enables on a contradictory payload (device_enforced with source evidence)', () => {
    const g = gate({
      ...VALIDATED,
      evidence: {
        status: 'VERIFIED_SUPPORTED',
        evidence_level: 'VERIFIED_FROM_SOURCE',
        device_enforced: true,
        declaration: null,
      },
    });
    expect(g.enabled).toBe(false);
    expect(g.reason).toMatch(/not lab-validated/);
    expect(gate({ ...VALIDATED, device_enforced: false }).enabled).toBe(false);
  });

  it('is disabled without evidence (list rows) and enabled only when lab-validated', () => {
    expect(gate(undefined).enabled).toBe(false);
    expect(gate(VALIDATED)).toEqual({ enabled: true, reason: VALIDATED.reason });
  });
});

describe('queued wording', () => {
  it('never claims the device applied the request', () => {
    const text = queuedMessage('disconnect', { session_action: { id: 'a1' } });
    expect(text).toMatch(/queued \(action a1\)/);
    expect(text).toMatch(/not a confirmation from the device/);
    expect(text).not.toMatch(/disconnected|applied|enforced/i);
    expect(queuedMessage('reauthorize', { deduplicated: true })).toMatch(/already pending/);
  });
});

describe('freshness', () => {
  it('grades the accounting age against the expected lag', () => {
    expect(freshnessLevel({ freshness_s: null })).toBe('none');
    expect(freshnessText({ freshness_s: null })).toBe('No accounting received yet');
    expect(freshnessLevel({ freshness_s: 120, expected_lag_s: 305 })).toBe('fresh');
    expect(freshnessText({ freshness_s: 120, expected_lag_s: 305 })).toBe(
      'Last accounting 2 min ago',
    );
    expect(freshnessLevel({ freshness_s: 600, expected_lag_s: 305 })).toBe('lagging');
    expect(freshnessLevel({ freshness_s: 4000, expected_lag_s: 305 })).toBe('stale');
    expect(freshnessText({ freshness_s: 4000 })).toMatch(/may have stopped reporting/);
  });
});

describe('exports (Q75, D-027)', () => {
  it('needs the export permission and is hidden while impersonating', () => {
    const target = { organizationId: ORG_A, anySite: true };
    const readOnly = adminMe([orgScope(ORG_A, ['accounting:read', 'report:read'])]);
    const admin = adminMe([orgScope(ORG_A, ['accounting:read', 'accounting:export'])]);
    const impersonating = adminMe([orgScope(ORG_A, ['accounting:export', 'report:export'])], {
      impersonation: { organization_id: ORG_A, reason: 'support', expires_at: '2099-01-01' },
    });
    expect(canExport(readOnly, 'accounting:export', target)).toBe(false);
    expect(canExport(admin, 'accounting:export', target)).toBe(true);
    expect(canExport(admin, 'report:export', target)).toBe(false);
    expect(canExport(impersonating, 'accounting:export', target)).toBe(false);
    expect(canExport(impersonating, 'report:export', target)).toBe(false);
  });
});

describe('record window and quota helpers', () => {
  it('requires ordered bounds of at most 31 days', () => {
    expect(validateRange(null, '2026-10-02T00:00:00Z')).toMatch(/required/);
    expect(validateRange('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z')).toMatch(/after/);
    expect(validateRange('2026-09-01T00:00:00Z', '2026-10-03T00:00:00Z')).toMatch(/31 days/);
    expect(validateRange('2026-09-02T00:00:00Z', '2026-10-03T00:00:00Z')).toBeNull();
  });

  it('computes the used share of a quota (capped, null without a limit)', () => {
    expect(quotaPercent({ limit_bytes: 1000, used_bytes: 250 })).toBe(25);
    expect(quotaPercent({ limit_bytes: 1000, used_bytes: 5000 })).toBe(100);
    expect(quotaPercent({ limit_bytes: 0, used_bytes: 5 })).toBeNull();
  });

  it('reveals Usage and Accounting records with accounting:read only', () => {
    const paths = (perms: string[]) =>
      visibleOrgNav(adminMe([orgScope(ORG_A, perms)]), ORG_A).map((i) => i.path);
    expect(paths(['accounting:read'])).toEqual(expect.arrayContaining(['usage', 'accounting']));
    expect(paths(['session:read'])).not.toContain('usage');
    expect(paths(['session:read'])).not.toContain('accounting');
  });
});

describe('safeFilename (P8-B review fix)', () => {
  it('decodes a valid name and keeps it', () => {
    expect(safeFilename('accounting%202026-10-08.csv')).toBe('accounting 2026-10-08.csv');
  });
  it('returns null for malformed percent escapes instead of throwing', () => {
    expect(safeFilename('%E0%A4%A')).toBeNull();
  });
  it('strips path separators and control characters and caps length', () => {
    expect(safeFilename('..%2F..%2Fetc%2Fpasswd')).toBe('.._.._etc_passwd');
    expect(safeFilename('a%0Ab.csv')).toBe('a_b.csv');
    expect(safeFilename('x'.repeat(300))?.length).toBe(200);
  });
  it('returns null for empty input', () => {
    expect(safeFilename(undefined)).toBeNull();
    expect(safeFilename('')).toBeNull();
  });
});
