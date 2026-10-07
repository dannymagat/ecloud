/**
 * Golden tests: POLICY_ENGINE.md §4.3 worked example — 20 000 / 5 000 kbit/s, 1 GB daily quota
 * (300 MB used → 700 MB remaining), max_devices 2 (one other device active), idle 600 s,
 * Mon–Fri 09:00–18:00 Asia/Dubai, evaluated Tuesday 10:00 site time, interim 300 s, min_session 300 s.
 */
import { describe, expect, it } from 'vitest';
import {
  PolicyIntentSchema,
  resolveEffectivePolicy,
  translate,
  type EnforcementPlan,
  type ResolutionInput,
  type ResolutionResult,
  type TranslationContext,
} from '@ecloud/policy-engine';
import { getAdapter } from './registry.js';

const NOW = new Date('2026-10-06T06:00:00Z');
const SESSION = '0f3b9b4e-7b2d-4a6b-9d1e-2b7f8a1c5e10';

const staff = PolicyIntentSchema.parse({
  id: 'pol-staff',
  organization_id: 'org-1',
  name: 'Staff 20/5 daily 1GB',
  scope_type: 'group',
  status: 'active',
  version: 3,
  download_rate_kbps: 20000,
  upload_rate_kbps: 5000,
  quota_daily_bytes: '1000000000',
  idle_timeout_s: 600,
  max_devices: 2,
  schedule_id: 'sch-1',
  schedule: {
    id: 'sch-1',
    name: 'Office hours',
    timezone: 'Asia/Dubai',
    rules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
  },
});

function input(targetType: 'user_group' | 'site' = 'user_group'): ResolutionInput {
  return {
    now: NOW,
    timeZone: 'Asia/Dubai',
    organization_id: 'org-1',
    site_id: 'site-1',
    subject: { kind: 'user', user_id: 'user-1' },
    client_device_id: 'dev-2',
    mac: 'aa:bb:cc:dd:ee:02',
    group_ids: ['grp-staff'],
    candidates: [
      {
        assignment: {
          id: 'as-1',
          policy_id: 'pol-staff',
          target_type: targetType,
          user_group_id: targetType === 'user_group' ? 'grp-staff' : null,
          site_id: targetType === 'site' ? 'site-1' : null,
          effective_from: new Date('2026-01-01T00:00:00Z'),
          effective_until: null,
          priority: 100,
        },
        policy: staff,
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
  };
}

function ctx(r: ResolutionResult, extra: Partial<TranslationContext> = {}): TranslationContext {
  return {
    sessionId: SESSION,
    now: NOW,
    clip: r.clip,
    controls: r.controls,
    interimIntervalS: 300,
    nasAcctIntervalUnset: true,
    ...extra,
  };
}

const sorted = (plan: EnforcementPlan): [string, string | number][] =>
  [...plan.radiusReplyAttributes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => [a.name, a.value]);

describe('§4.3 worked example', () => {
  const r = resolveEffectivePolicy(input());

  it('resolution accepts with the documented clip and controls', () => {
    expect(r.decision).toBe('accept');
    expect(r.clip.window_end_s).toBe(28800);
    expect(r.clip.remaining_octets).toBe(700_000_000n);
    expect(r.clip.drain_time_s).toBe(300);
    expect(r.controls.map((c) => c.kind)).toEqual(['schedule_end', 'quota_watcher', 'concurrency']);
  });

  it('(a) openwifi-uspot-uam (TIP fork)', () => {
    const plan = getAdapter('openwifi-uspot-uam').translate(r.effective, ctx(r));
    expect(sorted(plan)).toEqual([
      ['Acct-Interim-Interval', 300],
      ['ChilliSpot-Max-Total-Octets', 700_000_000],
      ['Class', `ecloud:${SESSION}`],
      ['Idle-Timeout', 600],
      ['Session-Timeout', 28800],
      ['WISPr-Bandwidth-Max-Down', 20_000_000],
      ['WISPr-Bandwidth-Max-Up', 5_000_000],
    ]);
    expect(plan.unenforceable).toEqual([]);
    expect(plan.configPushChanges).toEqual([]);
    expect(plan.degradation).toBe('fallback_ecloud_side');
    expect(plan.decision).toBe('accept');
    expect(plan.sessionTimeout.boundBy).toBe('window_end'); // drain bound not applied: verified octet limit
    expect(plan.ecloudSideControls.map((c) => c.kind)).toEqual([
      'schedule_end',
      'quota_watcher',
      'concurrency',
      'session_timer',
    ]);
    expect(
      plan.radiusReplyAttributes.every(
        (a) => a.status === 'VERIFIED_SUPPORTED' && a.experimental === undefined,
      ),
    ).toBe(true);
  });

  it('(a′) ChilliSpot family alternative is emitted instead of (never together with) WISPr', () => {
    const plan = getAdapter('openwifi-uspot-uam').translate(
      r.effective,
      ctx(r, { preferredRateAttrFamily: 'chillispot' }),
    );
    expect(sorted(plan).filter(([n]) => n.includes('Bandwidth'))).toEqual([
      ['ChilliSpot-Bandwidth-Max-Down', 20000],
      ['ChilliSpot-Bandwidth-Max-Up', 5000],
    ]);
  });

  it('(a″) Acct-Interim-Interval is flagged when the NAS acct-interval may be set', () => {
    const plan = getAdapter('openwifi-uspot-uam').translate(
      r.effective,
      ctx(r, { nasAcctIntervalUnset: undefined }),
    );
    expect(plan.unenforceable).toEqual([
      expect.objectContaining({ field: 'interim_interval', reason: 'requires_device_test' }),
    ]);
    expect(plan.decision).toBe('accept');
  });

  it('(b) uspot-upstream-uam adds the Gigawords attribute', () => {
    const plan = getAdapter('uspot-upstream-uam').translate(r.effective, ctx(r));
    expect(sorted(plan)).toEqual([
      ['Acct-Interim-Interval', 300],
      ['ChilliSpot-Max-Total-Gigawords', 0],
      ['ChilliSpot-Max-Total-Octets', 700_000_000],
      ['Class', `ecloud:${SESSION}`],
      ['Idle-Timeout', 600],
      ['Session-Timeout', 28800],
      ['WISPr-Bandwidth-Max-Down', 20_000_000],
      ['WISPr-Bandwidth-Max-Up', 5_000_000],
    ]);
    expect(plan.unenforceable).toEqual([]);
  });

  it('(c) coovachilli-uam uses the CoovaChilli octet names', () => {
    const plan = getAdapter('coovachilli-uam').translate(r.effective, ctx(r));
    expect(sorted(plan)).toEqual([
      ['Acct-Interim-Interval', 300],
      ['Class', `ecloud:${SESSION}`],
      ['CoovaChilli-Max-Total-Gigawords', 0],
      ['CoovaChilli-Max-Total-Octets', 700_000_000],
      ['Idle-Timeout', 600],
      ['Session-Timeout', 28800],
      ['WISPr-Bandwidth-Max-Down', 20_000_000],
      ['WISPr-Bandwidth-Max-Up', 5_000_000],
    ]);
    expect(plan.unenforceable).toEqual([]);
    expect(
      plan.radiusReplyAttributes.find((a) => a.name === 'CoovaChilli-Max-Total-Octets')?.vendor,
    ).toBe('CoovaChilli');
  });

  it('(d) openwifi-hostapd-radius emits nothing by default; Session-Timeout 300 (drain) + Class only in lab mode', () => {
    const plan = getAdapter('openwifi-hostapd-radius').translate(r.effective, ctx(r));
    expect(plan.radiusReplyAttributes).toEqual([]);
    expect(plan.sessionTimeout).toEqual({
      value: 300,
      boundBy: 'quota_drain',
      candidates: { window_end: 28800, quota_reset: 50400, quota_drain: 300 },
    });
    expect(plan.unenforceable.map((u) => [u.field, u.reason])).toEqual([
      ['download_rate_kbps', 'requires_device_test'],
      ['upload_rate_kbps', 'requires_device_test'],
      ['quota_daily_bytes', 'unsupported'],
      ['session_bound', 'requires_device_test'],
      ['idle_timeout_s', 'requires_device_test'],
      ['interim_interval', 'requires_device_test'],
      ['class', 'requires_device_test'],
    ]);
    expect(plan.unenforceable.find((u) => u.field === 'quota_daily_bytes')?.detail).toContain(
      'drain time',
    );
    expect(plan.configPushChanges).toEqual([]); // group-scoped → no SSID rate-limit
    expect(plan.ecloudSideControls.map((c) => c.kind)).toEqual([
      'schedule_end',
      'quota_watcher',
      'concurrency',
      'session_timer',
    ]);
    expect(plan.ecloudSideControls.at(-1)?.params).toMatchObject({
      seconds: 300,
      mirrors_radius: false,
    });
    expect(plan.decision).toBe('accept');

    const lab = getAdapter('openwifi-hostapd-radius').translate(
      r.effective,
      ctx(r, { includeDeviceTestAttributes: true }),
    );
    expect(sorted(lab)).toEqual([
      ['Acct-Interim-Interval', 300],
      ['Class', `ecloud:${SESSION}`],
      ['Idle-Timeout', 600],
      ['Session-Timeout', 300],
    ]);
    expect(lab.radiusReplyAttributes.every((a) => a.experimental === true)).toBe(true);
    expect(getAdapter('openwifi-hostapd-radius').buildReplyAttributes(lab)).toEqual([]);
    expect(
      getAdapter('openwifi-hostapd-radius').buildReplyAttributes(lab, {
        includeExperimental: true,
      }),
    ).toHaveLength(4);
  });

  it('(d′) strict_reject on hostapd rejects naming the fields', () => {
    const plan = getAdapter('openwifi-hostapd-radius').translate(
      r.effective,
      ctx(r, { degradation: 'strict_reject' }),
    );
    expect(plan).toMatchObject({
      decision: 'reject',
      reasonCode:
        'unenforceable:download_rate_kbps,idle_timeout_s,quota_daily_bytes,upload_rate_kbps',
    });
  });

  it('(e) openwifi-config: group-scoped → everything granularity_mismatch / unsupported; site-scoped → rate-limit push', () => {
    const group = getAdapter('openwifi-config').translate(
      r.effective,
      ctx(r, { ssidRef: 'staff' }),
    );
    expect(group.radiusReplyAttributes).toEqual([]);
    expect(group.configPushChanges).toEqual([]);
    expect(group.unenforceable.map((u) => [u.field, u.reason])).toEqual([
      ['download_rate_kbps', 'granularity_mismatch'],
      ['upload_rate_kbps', 'granularity_mismatch'],
      ['quota_daily_bytes', 'unsupported'],
      ['idle_timeout_s', 'granularity_mismatch'],
      ['max_devices', 'unsupported'],
      ['schedule_id', 'unsupported'],
    ]);

    const site = resolveEffectivePolicy(input('site'));
    const plan = getAdapter('openwifi-config').translate(
      site.effective,
      ctx(site, { ssidRef: 'staff' }),
    );
    expect(plan.configPushChanges.map((c) => [c.path, c.value, c.status])).toEqual([
      ['interfaces[].ssids[staff].rate-limit.egress-rate', 20, 'VERIFIED_SUPPORTED'],
      ['interfaces[].ssids[staff].rate-limit.ingress-rate', 5, 'VERIFIED_SUPPORTED'],
      ['interfaces[].ssids[staff].max-inactivity', 600, 'VERIFIED_SUPPORTED'],
    ]);
    expect(plan.unenforceable.map((u) => [u.field, u.reason])).toEqual([
      ['quota_daily_bytes', 'unsupported'],
      ['max_devices', 'unsupported'],
      ['schedule_id', 'unsupported'],
    ]);
    const fragment = getAdapter('openwifi-config').renderConfig?.(plan);
    expect(fragment).toMatchObject({ scope: 'ssid', status: 'VERIFIED_SUPPORTED' });
    expect(fragment && 'changes' in fragment ? fragment.changes.length : 0).toBe(3);
  });

  it('(d″) hostapd with a site-scoped rate arms a config_push_fallback control (fallback_ecloud_side)', () => {
    const site = resolveEffectivePolicy(input('site'));
    const plan = getAdapter('openwifi-hostapd-radius').translate(site.effective, ctx(site));
    expect(
      plan.ecloudSideControls
        .filter((c) => c.kind === 'config_push_fallback')
        .map((c) => c.params?.field),
    ).toEqual(['download_rate_kbps', 'upload_rate_kbps']);
  });

  it('translate is deterministic across adapters and the plan carries the adapter version', () => {
    const a = translate(r.effective, getAdapter('coovachilli-uam').capabilities(), ctx(r));
    const b = getAdapter('coovachilli-uam').translate(r.effective, ctx(r));
    expect(JSON.stringify(a, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).toBe(
      JSON.stringify(b, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    expect(a.adapterVersion).toBe('0.1.0');
  });
});
