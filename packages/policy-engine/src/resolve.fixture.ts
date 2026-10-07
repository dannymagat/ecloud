/** Shared resolution fixtures for policy-engine tests (the §1.2 policy and §4.3 context). */
import { PolicyIntentSchema, type PolicyIntent, type PolicyIntentInput } from './intent.js';
import type { PolicyAssignment, ResolutionInput } from './resolve.js';

export const NOW = new Date('2026-10-06T06:00:00Z'); // Tuesday 10:00 Asia/Dubai
export const OFFICE = {
  id: 'sch-1',
  name: 'Office hours',
  timezone: 'Asia/Dubai',
  rules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
};

export function policy(id: string, overrides: Partial<PolicyIntentInput> = {}): PolicyIntent {
  return PolicyIntentSchema.parse({
    id,
    organization_id: 'org-1',
    name: id,
    scope_type: 'group',
    status: 'active',
    version: 1,
    ...overrides,
  });
}

export function assignment(
  id: string,
  policy_id: string,
  target: Partial<PolicyAssignment> & Pick<PolicyAssignment, 'target_type'>,
): PolicyAssignment {
  return {
    id,
    policy_id,
    effective_from: new Date('2026-01-01T00:00:00Z'),
    effective_until: null,
    priority: 100,
    ...target,
  };
}

/** The §1.2 / §4.3 group policy assigned to the user's group. */
export const staffPolicy = policy('pol-staff', {
  name: 'Staff 20/5 daily 1GB',
  version: 3,
  download_rate_kbps: 20000,
  upload_rate_kbps: 5000,
  quota_daily_bytes: '1000000000',
  idle_timeout_s: 600,
  max_devices: 2,
  schedule_id: 'sch-1',
  schedule: OFFICE,
});

export function workedExampleInput(overrides: Partial<ResolutionInput> = {}): ResolutionInput {
  return {
    now: NOW,
    timeZone: 'Asia/Dubai',
    organization_id: 'org-1',
    site_id: 'site-1',
    subject: { kind: 'user', user_id: 'user-1' },
    client_device_id: 'dev-2',
    mac: 'AA:BB:CC:DD:EE:02',
    group_ids: ['grp-staff'],
    candidates: [
      {
        assignment: assignment('as-staff', 'pol-staff', {
          target_type: 'user_group',
          user_group_id: 'grp-staff',
        }),
        policy: staffPolicy,
      },
    ],
    usage: { daily: { bytes_in: 200_000_000n, bytes_out: 100_000_000n } },
    active_sessions: [
      {
        id: 'sess-1',
        mac: 'aa:bb:cc:dd:ee:01',
        user_id: 'user-1',
        started_at: new Date('2026-10-06T05:30:00Z'),
        last_update_at: NOW,
      },
    ],
    tenant: { min_session_s: 300 },
    ...overrides,
  };
}
