import { describe, expect, it } from 'vitest';
import { captive32, captive64, perSsid, untested } from './adapters.fixture.js';
import { INTENT_COLUMNS, RADIUS_UINT32_MAX } from './intent.js';
import {
  resolveEffectivePolicy,
  type Clip,
  type EffectivePolicy,
  type Provenance,
  type ResolutionResult,
} from './resolve.js';
import { assignment, policy, staffPolicy, workedExampleInput } from './resolve.fixture.js';
import { translate, type EnforcementPlan, type TranslationContext } from './translate.js';

const NOW = new Date('2026-10-06T06:00:00Z');

function ctxOf(r: ResolutionResult, extra: Partial<TranslationContext> = {}): TranslationContext {
  return {
    sessionId: 'sess-new',
    now: NOW,
    clip: r.clip,
    controls: r.controls,
    interimIntervalS: 300,
    nasAcctIntervalUnset: true,
    ...extra,
  };
}

function attrs(plan: EnforcementPlan): [string, string | number][] {
  return [...plan.radiusReplyAttributes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => [a.name, a.value]);
}

const prov = (
  layer_name: Provenance['layer_name'],
  target_type: Provenance['target_type'] = layer_name === 'organization_default'
    ? 'organization_default'
    : (layer_name as Provenance['target_type']),
): Provenance => ({
  policy_id: 'p',
  policy_version: 1,
  assignment_id: 'a',
  layer: 5,
  layer_name,
  target_type,
});

function effectiveOf(
  fields: Partial<EffectivePolicy['fields']>,
  layer: Provenance['layer_name'] = 'user_group',
  extra: Partial<EffectivePolicy> = {},
): EffectivePolicy {
  const blank = Object.fromEntries(
    INTENT_COLUMNS.map((k) => [k, null]),
  ) as unknown as EffectivePolicy['fields'];
  const provenance: EffectivePolicy['provenance'] = {};
  for (const k of Object.keys(fields)) (provenance as Record<string, Provenance>)[k] = prov(layer);
  return {
    fields: { ...blank, ...fields },
    schedule: null,
    provenance,
    winner: null,
    concurrency_mode: null,
    critical_fields: [],
    ...extra,
  };
}

const emptyClip: Clip = {
  policy_session_timeout_s: null,
  window_end_s: null,
  validity_end_s: null,
  voucher_end_s: null,
  quota_reset_s: null,
  remaining_octets: null,
  remaining_period: null,
  drain_time_s: null,
  min_session_s: 300,
};

describe('translate — attribute gating (D-028)', () => {
  const r = resolveEffectivePolicy(workedExampleInput());

  it('emits only VERIFIED_SUPPORTED attributes by default', () => {
    const plan = translate(r.effective, captive32, ctxOf(r));
    expect(attrs(plan)).toEqual([
      ['Acct-Interim-Interval', 300],
      ['ChilliSpot-Max-Total-Octets', 700_000_000],
      ['Class', 'ecloud:sess-new'],
      ['Idle-Timeout', 600],
      ['Session-Timeout', 28800],
      ['WISPr-Bandwidth-Max-Down', 20_000_000],
      ['WISPr-Bandwidth-Max-Up', 5_000_000],
    ]);
    expect(
      plan.radiusReplyAttributes.every((a) => a.status === 'VERIFIED_SUPPORTED' && !a.experimental),
    ).toBe(true);
    expect(
      plan.radiusReplyAttributes.find((a) => a.name === 'WISPr-Bandwidth-Max-Down')?.vendor,
    ).toBe('WISPr');
    expect(plan.unenforceable).toEqual([]);
    expect(plan.decision).toBe('accept');
    expect(plan.sessionTimeout).toEqual({
      value: 28800,
      boundBy: 'window_end',
      candidates: { window_end: 28800, quota_reset: 50400 },
    });
  });

  it('refuses REQUIRES_DEVICE_TEST attributes unless includeDeviceTestAttributes, then marks them experimental', () => {
    const plan = translate(r.effective, untested, ctxOf(r));
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
    const lab = translate(r.effective, untested, ctxOf(r, { includeDeviceTestAttributes: true }));
    expect(attrs(lab)).toEqual([
      ['Acct-Interim-Interval', 300],
      ['Class', 'ecloud:sess-new'],
      ['Idle-Timeout', 600],
      ['Session-Timeout', 300],
    ]);
    expect(
      lab.radiusReplyAttributes.every(
        (a) => a.experimental === true && a.status === 'REQUIRES_DEVICE_TEST',
      ),
    ).toBe(true);
    // lab mode still flags them
    expect(
      lab.unenforceable.some(
        (u) => u.field === 'session_bound' && u.reason === 'requires_device_test',
      ),
    ).toBe(true);
  });

  it('never emits an attribute the adapter does not declare', () => {
    const noClass = {
      ...captive32,
      attributes: Object.fromEntries(
        Object.entries(captive32.attributes).filter(([k]) => k !== 'Class'),
      ),
    };
    const plan = translate(r.effective, noClass, ctxOf(r));
    expect(plan.radiusReplyAttributes.some((a) => a.name === 'Class')).toBe(false);
    expect(plan.unenforceable).toContainEqual({
      field: 'class',
      status: 'UNSUPPORTED',
      reason: 'attribute_not_declared',
      detail: 'Class is not declared by openwifi-uspot-uam',
    });
  });

  it('an UNSUPPORTED attribute declaration blocks emission', () => {
    const blocked = {
      ...captive32,
      attributes: {
        ...captive32.attributes,
        'Idle-Timeout': {
          name: 'Idle-Timeout',
          status: 'UNSUPPORTED' as const,
          evidence: 'fixture',
        },
      },
    };
    const plan = translate(r.effective, blocked, ctxOf(r));
    expect(plan.radiusReplyAttributes.some((a) => a.name === 'Idle-Timeout')).toBe(false);
    expect(plan.unenforceable).toContainEqual({
      field: 'idle_timeout_s',
      status: 'UNSUPPORTED',
      reason: 'unsupported',
      detail: 'Idle-Timeout: fixture',
    });
  });

  it('skips Class without a session id and Acct-Interim-Interval without a tenant interval', () => {
    const plan = translate(r.effective, captive32, { clip: r.clip, now: NOW });
    expect(plan.radiusReplyAttributes.map((a) => a.name)).not.toContain('Class');
    expect(plan.radiusReplyAttributes.map((a) => a.name)).not.toContain('Acct-Interim-Interval');
  });
});

describe('translate — unit conversions and rounding (§4.1)', () => {
  it('WISPr bit/s = kbps × 1000, clamped to 2^32-1 with overflow_clamped; ChilliSpot family stays kbit/s', () => {
    const eff = effectiveOf({ download_rate_kbps: 4_294_967, upload_rate_kbps: 4_294_968 });
    const plan = translate(eff, captive32, { clip: emptyClip, now: NOW });
    expect(attrs(plan)).toEqual([
      ['WISPr-Bandwidth-Max-Down', 4_294_967_000],
      ['WISPr-Bandwidth-Max-Up', RADIUS_UINT32_MAX],
    ]);
    expect(plan.unenforceable).toEqual([
      {
        field: 'upload_rate_kbps',
        status: 'VERIFIED_SUPPORTED',
        reason: 'overflow_clamped',
        detail: `WISPr-Bandwidth-Max-Up clamped to ${RADIUS_UINT32_MAX} bit/s`,
      },
    ]);
    expect(plan.decision).toBe('accept'); // clamping never rejects, even strict
    const chilli = translate(eff, captive32, {
      clip: emptyClip,
      now: NOW,
      preferredRateAttrFamily: 'chillispot',
      degradation: 'strict_reject',
    });
    expect(attrs(chilli)).toEqual([
      ['ChilliSpot-Bandwidth-Max-Down', 4_294_967],
      ['ChilliSpot-Bandwidth-Max-Up', 4_294_968],
    ]);
    expect(chilli.unenforceable).toEqual([]);
    expect(chilli.radiusReplyAttributes[0]?.vendor).toBe('ChilliSpot');
  });

  it('falls back to the first family when the preferred one is not available', () => {
    const wisprOnly = { ...captive32, rateFamilies: captive32.rateFamilies.slice(0, 1) };
    const plan = translate(effectiveOf({ download_rate_kbps: 1000 }), wisprOnly, {
      clip: emptyClip,
      now: NOW,
      preferredRateAttrFamily: 'chillispot',
    });
    expect(attrs(plan)).toEqual([['WISPr-Bandwidth-Max-Down', 1_000_000]]);
  });

  it('32-bit octet limit clamps with overflow_clamped; 64-bit splits Octets + Gigawords', () => {
    const remaining = 5_000_000_000n; // > 2^32
    const clip = { ...emptyClip, remaining_octets: remaining, remaining_period: 'total' as const };
    const eff = effectiveOf({ quota_total_bytes: 10_000_000_000n });
    const p32 = translate(eff, captive32, { clip, now: NOW });
    expect(attrs(p32)).toEqual([['ChilliSpot-Max-Total-Octets', RADIUS_UINT32_MAX]]);
    expect(p32.unenforceable[0]).toMatchObject({
      field: 'quota_total_bytes',
      reason: 'overflow_clamped',
    });
    expect(p32.fieldTable.find((f) => f.field === 'quota_total_bytes')?.deviceEnforced).toBe(true);
    const p64 = translate(eff, captive64, { clip, now: NOW });
    expect(attrs(p64)).toEqual([
      ['ChilliSpot-Max-Total-Gigawords', 1],
      ['ChilliSpot-Max-Total-Octets', 5_000_000_000 - 4_294_967_296],
    ]);
    expect(p64.unenforceable).toEqual([]);
    const small = translate(eff, captive64, {
      clip: { ...clip, remaining_octets: 700_000_000n },
      now: NOW,
    });
    expect(attrs(small)).toEqual([
      ['ChilliSpot-Max-Total-Gigawords', 0],
      ['ChilliSpot-Max-Total-Octets', 700_000_000],
    ]);
  });

  it('with several quota periods set, all share the emitted octet attribute in the field table', () => {
    const clip = { ...emptyClip, remaining_octets: 1_000n, remaining_period: 'daily' as const };
    const plan = translate(
      effectiveOf({ quota_daily_bytes: 10n, quota_monthly_bytes: 100n }),
      captive32,
      { clip, now: NOW },
    );
    expect(plan.fieldTable.find((f) => f.field === 'quota_monthly_bytes')?.attributes).toEqual([
      'ChilliSpot-Max-Total-Octets',
    ]);
  });

  it('quota set but no remaining computed (e.g. preview without counters) emits nothing and does not crash', () => {
    const plan = translate(effectiveOf({ quota_daily_bytes: 10n }), captive32, {
      clip: emptyClip,
      now: NOW,
    });
    expect(plan.radiusReplyAttributes).toEqual([]);
  });

  it('Session-Timeout = min(policy, window, validity, voucher, quota reset, drain) with the min 60 s floor on hard ends', () => {
    const clip: Clip = {
      ...emptyClip,
      policy_session_timeout_s: 7200,
      window_end_s: 10,
      validity_end_s: 5000,
      voucher_end_s: 4000,
    };
    const plan = translate(effectiveOf({ session_timeout_s: 7200 }), captive32, { clip, now: NOW });
    expect(plan.sessionTimeout).toEqual({
      value: 60,
      boundBy: 'window_end',
      candidates: { policy: 7200, window_end: 60, validity_end: 5000, voucher_end: 4000 },
    });
    expect(attrs(plan)).toEqual([['Session-Timeout', 60]]);
    expect(plan.ecloudSideControls.find((c) => c.kind === 'session_timer')).toMatchObject({
      at: new Date(NOW.getTime() + 60_000),
      params: { seconds: 60, bound_by: 'window_end', mirrors_radius: true },
    });
  });

  it('drain time applies only without a verified octet attribute and only in fallback_ecloud_side mode', () => {
    const clip: Clip = {
      ...emptyClip,
      remaining_octets: 700_000_000n,
      remaining_period: 'daily',
      drain_time_s: 300,
      window_end_s: 28800,
    };
    const eff = effectiveOf({
      quota_daily_bytes: 1_000_000_000n,
      download_rate_kbps: 20000,
      upload_rate_kbps: 5000,
    });
    expect(translate(eff, captive32, { clip, now: NOW }).sessionTimeout.boundBy).toBe('window_end');
    expect(translate(eff, untested, { clip, now: NOW }).sessionTimeout).toMatchObject({
      value: 300,
      boundBy: 'quota_drain',
    });
    expect(
      translate(eff, untested, { clip, now: NOW, degradation: 'allow_and_flag' }).sessionTimeout,
    ).toMatchObject({ value: 28800, boundBy: 'window_end' });
    expect(
      translate(eff, untested, {
        clip: { ...clip, drain_time_s: 100, min_session_s: 300 },
        now: NOW,
      }).sessionTimeout.value,
    ).toBe(300);
  });

  it('Idle-Timeout has a 60 s floor; Acct-Interim-Interval too', () => {
    const plan = translate(effectiveOf({ idle_timeout_s: 60 }), captive32, {
      clip: emptyClip,
      now: NOW,
      interimIntervalS: 10,
    });
    expect(attrs(plan)).toEqual([
      ['Acct-Interim-Interval', 60],
      ['Idle-Timeout', 60],
    ]);
  });

  it('Acct-Interim-Interval on uspot is flagged requires_device_test unless the NAS acct-interval is known unset', () => {
    const noteAdapter = {
      ...captive32,
      attributes: {
        ...captive32.attributes,
        'Acct-Interim-Interval': {
          ...captive32.attributes['Acct-Interim-Interval'],
          note: 'NAS acct-interval overrides',
        },
      },
    } as typeof captive32;
    const flagged = translate(effectiveOf({}), noteAdapter, {
      clip: emptyClip,
      now: NOW,
      interimIntervalS: 300,
    });
    expect(flagged.unenforceable).toEqual([
      {
        field: 'interim_interval',
        status: 'VERIFIED_SUPPORTED',
        reason: 'requires_device_test',
        detail: expect.stringContaining('acct-interval') as string,
      },
    ]);
    expect(flagged.decision).toBe('accept');
    const strict = translate(effectiveOf({}), noteAdapter, {
      clip: emptyClip,
      now: NOW,
      interimIntervalS: 300,
      degradation: 'strict_reject',
    });
    expect(strict.decision).toBe('accept'); // interim is not a policy field
    expect(
      translate(effectiveOf({}), noteAdapter, {
        clip: emptyClip,
        now: NOW,
        interimIntervalS: 300,
        nasAcctIntervalUnset: true,
      }).unenforceable,
    ).toEqual([]);
  });
});

describe('translate — VLAN, burst, ECLOUD-side fields', () => {
  it('VLAN triplet is RFC 3580 (Tunnel-Type 13, Medium 6, Group-Id string), lab mode only, one flag', () => {
    const eff = effectiveOf({ vlan_id: 42 });
    const plan = translate(eff, captive32, { clip: emptyClip, now: NOW });
    expect(plan.radiusReplyAttributes).toEqual([]);
    expect(plan.unenforceable).toHaveLength(1);
    expect(plan.unenforceable[0]).toMatchObject({
      field: 'vlan_id',
      reason: 'requires_device_test',
      status: 'REQUIRES_DEVICE_TEST',
    });
    const lab = translate(eff, captive32, {
      clip: emptyClip,
      now: NOW,
      includeDeviceTestAttributes: true,
    });
    expect(attrs(lab)).toEqual([
      ['Tunnel-Medium-Type', 6],
      ['Tunnel-Private-Group-Id', '42'],
      ['Tunnel-Type', 13],
    ]);
    const none = translate(eff, { ...captive32, vlanAttrs: [] }, { clip: emptyClip, now: NOW });
    expect(none.unenforceable[0]).toMatchObject({ field: 'vlan_id', reason: 'unsupported' });
  });

  it('burst is always unenforceable', () => {
    const plan = translate(
      effectiveOf({
        burst_download_kbps: 30000,
        burst_upload_kbps: 6000,
        burst_duration_s: 10,
        download_rate_kbps: 20000,
      }),
      captive32,
      { clip: emptyClip, now: NOW },
    );
    expect(plan.unenforceable.map((u) => u.field)).toEqual([
      'burst_download_kbps',
      'burst_upload_kbps',
      'burst_duration_s',
    ]);
    expect(
      plan.unenforceable.every((u) => u.reason === 'unsupported' && u.status === 'UNSUPPORTED'),
    ).toBe(true);
  });

  it('ECLOUD_SIDE_ONLY fields are not unenforceable; the field table shows mechanism ecloud_side', () => {
    const r = resolveEffectivePolicy(
      workedExampleInput({
        subject: {
          kind: 'voucher',
          user_id: 'user-1',
          voucher: { batch_id: 'vb-1', expires_at: new Date('2026-10-06T08:00:00Z') },
        },
      }),
    );
    const plan = translate(r.effective, captive32, ctxOf(r));
    const row = (f: string) => plan.fieldTable.find((x) => x.field === f);
    expect(row('max_devices')).toMatchObject({
      set: true,
      mechanism: 'ecloud_side',
      deviceEnforced: false,
      status: 'ECLOUD_SIDE_ONLY',
    });
    expect(row('schedule_id')).toMatchObject({ set: true, mechanism: 'ecloud_side' });
    expect(row('voucher_validity')).toMatchObject({ set: true, mechanism: 'ecloud_side' });
    expect(row('valid_until')).toMatchObject({ set: false, mechanism: 'not_set' });
    expect(row('download_rate_kbps')).toMatchObject({
      set: true,
      mechanism: 'radius',
      deviceEnforced: true,
      attributes: ['WISPr-Bandwidth-Max-Down'],
    });
    expect(plan.fieldTable).toHaveLength(17);
    expect(plan.sessionTimeout.boundBy).toBe('voucher_end');
  });
});

describe('translate — per-SSID adapter (openwifi-config shape)', () => {
  it('site-scoped rates become ceil(kbps/1000) Mbit/s config pushes; group-scoped are granularity_mismatch', () => {
    const site = effectiveOf(
      { download_rate_kbps: 20500, upload_rate_kbps: 5000, idle_timeout_s: 600 },
      'site',
    );
    const plan = translate(site, perSsid, { clip: emptyClip, now: NOW, ssidRef: 'guest' });
    expect(plan.configPushChanges.map((c) => [c.path, c.value])).toEqual([
      ['interfaces[].ssids[guest].rate-limit.egress-rate', 21],
      ['interfaces[].ssids[guest].rate-limit.ingress-rate', 5],
      ['interfaces[].ssids[guest].max-inactivity', 600],
    ]);
    expect(plan.radiusReplyAttributes).toEqual([]);
    expect(plan.unenforceable).toEqual([]);
    expect(plan.fieldTable.find((f) => f.field === 'download_rate_kbps')).toMatchObject({
      mechanism: 'config_push',
      deviceEnforced: true,
    });
    const group = translate(
      effectiveOf({
        download_rate_kbps: 20000,
        upload_rate_kbps: 5000,
        idle_timeout_s: 600,
        max_devices: 2,
      }),
      perSsid,
      { clip: emptyClip, now: NOW },
    );
    expect(group.configPushChanges).toEqual([]);
    expect(group.unenforceable.map((u) => [u.field, u.reason])).toEqual([
      ['download_rate_kbps', 'granularity_mismatch'],
      ['upload_rate_kbps', 'granularity_mismatch'],
      ['idle_timeout_s', 'granularity_mismatch'],
      ['max_devices', 'unsupported'],
    ]);
  });

  it('sub-Mbit rates cannot be expressed; organization default counts as site-wide', () => {
    const plan = translate(
      effectiveOf({ download_rate_kbps: 512 }, 'organization_default'),
      perSsid,
      { clip: emptyClip, now: NOW },
    );
    expect(plan.configPushChanges).toEqual([]);
    expect(plan.unenforceable[0]).toMatchObject({
      field: 'download_rate_kbps',
      reason: 'unsupported',
      detail: expect.stringContaining('sub-Mbit') as string,
    });
    const ok = translate(
      effectiveOf({ download_rate_kbps: 1000 }, 'organization_default'),
      perSsid,
      { clip: emptyClip, now: NOW },
    );
    expect(ok.configPushChanges[0]?.value).toBe(1);
  });

  it('captive.session-timeout is pushed only for captive SSIDs and site scope', () => {
    const site = effectiveOf({ session_timeout_s: 3600 }, 'site');
    expect(translate(site, perSsid, { clip: emptyClip, now: NOW }).unenforceable[0]).toMatchObject({
      field: 'session_timeout_s',
      reason: 'unsupported',
    });
    expect(
      translate(site, perSsid, { clip: emptyClip, now: NOW, ssidIsCaptive: true })
        .configPushChanges,
    ).toEqual([
      {
        path: 'interfaces[].ssids[<ssid>].captive.session-timeout',
        value: 3600,
        scope: 'ssid',
        status: 'VERIFIED_SUPPORTED',
        evidence: 'fixture (test only)',
        field: 'session_timeout_s',
      },
    ]);
    expect(
      translate(effectiveOf({ session_timeout_s: 3600 }), perSsid, {
        clip: emptyClip,
        now: NOW,
        ssidIsCaptive: true,
      }).unenforceable[0],
    ).toMatchObject({ reason: 'granularity_mismatch' });
    const rdt = {
      ...perSsid,
      fields: {
        ...perSsid.fields,
        session_timeout_s: {
          ...perSsid.fields.session_timeout_s,
          status: 'REQUIRES_DEVICE_TEST' as const,
        },
        idle_timeout_s: {
          ...perSsid.fields.idle_timeout_s,
          status: 'REQUIRES_DEVICE_TEST' as const,
        },
        download_rate_kbps: {
          ...perSsid.fields.download_rate_kbps,
          status: 'REQUIRES_DEVICE_TEST' as const,
        },
      },
    };
    const flagged = translate(
      effectiveOf(
        { session_timeout_s: 3600, idle_timeout_s: 600, download_rate_kbps: 2000 },
        'site',
      ),
      rdt,
      { clip: emptyClip, now: NOW, ssidIsCaptive: true },
    );
    expect(flagged.unenforceable.map((u) => u.reason)).toEqual([
      'requires_device_test',
      'requires_device_test',
      'requires_device_test',
    ]);
  });
});

describe('translate — degradation modes (§4.2)', () => {
  const r = resolveEffectivePolicy(workedExampleInput());

  it('fallback_ecloud_side (default) keeps the ECLOUD controls and arms a config_push_fallback for site-scoped rates on untested adapters', () => {
    const siteRate = effectiveOf({ download_rate_kbps: 20000 }, 'site');
    const plan = translate(siteRate, untested, { clip: emptyClip, now: NOW });
    expect(plan.degradation).toBe('fallback_ecloud_side');
    expect(
      plan.ecloudSideControls.find((c) => c.kind === 'config_push_fallback')?.params,
    ).toMatchObject({ adapter: 'openwifi-config', field: 'download_rate_kbps', kbps: 20000 });
    const flagOnly = translate(siteRate, untested, {
      clip: emptyClip,
      now: NOW,
      degradation: 'allow_and_flag',
    });
    expect(flagOnly.ecloudSideControls.some((c) => c.kind === 'config_push_fallback')).toBe(false);
    expect(flagOnly.decision).toBe('accept');
  });

  it('strict_reject rejects when any policy field is unenforceable, listing the fields', () => {
    const plan = translate(r.effective, untested, ctxOf(r, { degradation: 'strict_reject' }));
    expect(plan.decision).toBe('reject');
    expect(plan.reasonCode).toBe(
      'unenforceable:download_rate_kbps,idle_timeout_s,quota_daily_bytes,upload_rate_kbps',
    );
    expect(
      translate(r.effective, captive32, ctxOf(r, { degradation: 'strict_reject' })).decision,
    ).toBe('accept');
  });

  it('critical_fields force a reject regardless of mode', () => {
    const eff = effectiveOf({ vlan_id: 10, download_rate_kbps: 1000 }, 'user_group', {
      critical_fields: ['vlan_id'],
    });
    const plan = translate(eff, captive32, { clip: emptyClip, now: NOW });
    expect(plan).toMatchObject({ decision: 'reject', reasonCode: 'unenforceable:vlan_id' });
  });

  it('session_timer control is only armed when a Session-Timeout exists', () => {
    const plan = translate(effectiveOf({ download_rate_kbps: 1000 }), captive32, {
      clip: emptyClip,
      now: NOW,
    });
    expect(plan.ecloudSideControls.some((c) => c.kind === 'session_timer')).toBe(false);
  });
});

describe('translate — resolution → translation integration', () => {
  it('copies resolution controls and adds the session timer', () => {
    const r = resolveEffectivePolicy(workedExampleInput());
    const plan = translate(r.effective, captive32, ctxOf(r));
    expect(plan.ecloudSideControls.map((c) => c.kind)).toEqual([
      'schedule_end',
      'quota_watcher',
      'concurrency',
      'session_timer',
    ]);
  });

  it('a policy with explicit session_timeout_s below the window end binds Session-Timeout to the policy', () => {
    const p = { ...staffPolicy, session_timeout_s: 1800 };
    const r = resolveEffectivePolicy(
      workedExampleInput({
        candidates: [
          {
            assignment: assignment('as-staff', 'pol-staff', {
              target_type: 'user_group',
              user_group_id: 'grp-staff',
            }),
            policy: p,
          },
        ],
      }),
    );
    const plan = translate(r.effective, captive32, ctxOf(r));
    expect(plan.sessionTimeout).toMatchObject({ value: 1800, boundBy: 'policy' });
    expect(plan.radiusReplyAttributes.find((a) => a.name === 'Session-Timeout')?.field).toBe(
      'session_timeout_s',
    );
  });

  it('unused policy() helper shapes still translate (smoke)', () => {
    const p = policy('x', { download_rate_kbps: 100 });
    expect(p.download_rate_kbps).toBe(100);
  });
});
