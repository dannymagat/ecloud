import { describe, expect, it } from 'vitest';
import type { EnforcementPlan } from '@ecloud/policy-engine';
import { attributeTable, decl, fieldTable } from './base.js';
import { getAdapter, isAdapterKey, listAdapters, listCapabilities } from './registry.js';
import type { SessionRef } from './types.js';

const session: SessionRef = {
  sessionId: 'sess-1',
  userName: 'alice',
  acctSessionId: '0123456789abcdef',
  callingStationId: 'AA-BB-CC-DD-EE-01',
  nasIdentifier: 'ap-serial-1',
  nasIpAddress: '100.100.1.2',
  framedIpAddress: '10.0.0.5',
};

function plan(
  adapter: EnforcementPlan['adapter'],
  attrs: EnforcementPlan['radiusReplyAttributes'],
): EnforcementPlan {
  return {
    adapter,
    adapterVersion: '0.1.0',
    decision: 'accept',
    reasonCode: null,
    radiusReplyAttributes: attrs,
    ecloudSideControls: [],
    configPushChanges: [],
    unenforceable: [],
    fieldTable: [],
    degradation: 'fallback_ecloud_side',
    sessionTimeout: { value: null, boundBy: null, candidates: {} },
  };
}

describe('registry', () => {
  it('lists the five adapters in §3.1 order (+ generic-radius-8021x) and resolves by key', () => {
    expect(listAdapters().map((a) => a.key)).toEqual([
      'openwifi-hostapd-radius',
      'ezeap-uam',
      'uspot-upstream-uam',
      'ezecloud-uam',
      'openwifi-config',
      'generic-radius-8021x',
      'mikrotik-hotspot',
      'external-portal-postback',
      'meraki-splash',
    ]);
    expect(listCapabilities().map((c) => c.version)).toEqual([
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
    ]);
    expect(getAdapter('ezecloud-uam').version).toBe('0.1.0');
    expect(getAdapter('ezecloud-uam').capabilities().key).toBe('ezecloud-uam');
    expect(isAdapterKey('generic_radius')).toBe(false);
    expect(() => getAdapter('generic_radius')).toThrow('unknown adapter type: generic_radius');
  });
});

describe('describeDisconnect / buildDisconnect', () => {
  it('CoovaChilli needs User-Name (mandatory) and optionally Acct-Session-Id, status REQUIRES_DEVICE_TEST', () => {
    const d = getAdapter('ezecloud-uam').describeDisconnect();
    expect(d).toMatchObject({
      target: 'coaport',
      status: 'REQUIRES_DEVICE_TEST',
      mandatory: ['User-Name'],
      identifyBy: ['User-Name', 'Acct-Session-Id'],
      acctStopEmitted: true,
    });
    expect(d.evidence).toContain('CAPTIVE_PORTAL_ARCHITECTURE.md §4');
    const req = getAdapter('ezecloud-uam').buildDisconnect(session);
    expect(req).toMatchObject({
      kind: 'disconnect',
      target: 'coaport',
      status: 'REQUIRES_DEVICE_TEST',
    });
    expect('attributes' in req ? req.attributes : []).toEqual([
      { name: 'User-Name', value: 'alice' },
      { name: 'Acct-Session-Id', value: '0123456789abcdef' },
    ]);
    expect(getAdapter('ezecloud-uam').buildDisconnect({ ...session, userName: null })).toEqual({
      unsupported: true,
      reason: 'missing mandatory identification attribute(s): User-Name',
    });
  });

  it('hostapd DAS (802.1X and TIP uspot) identifies by Calling-Station-Id (+ NAS-Identifier)', () => {
    const h = getAdapter('openwifi-hostapd-radius').describeDisconnect();
    expect(h).toMatchObject({
      target: 'hostapd-das',
      status: 'REQUIRES_DEVICE_TEST',
      mandatory: ['Calling-Station-Id'],
      acctStopEmitted: 'unknown',
    });
    expect(h.identifyBy).toEqual([
      'Calling-Station-Id',
      'NAS-Identifier',
      'User-Name',
      'Acct-Session-Id',
    ]);
    const u = getAdapter('ezeap-uam').describeDisconnect();
    expect(u).toMatchObject({
      target: 'hostapd-das',
      status: 'REQUIRES_DEVICE_TEST',
      mandatory: ['Calling-Station-Id'],
      identifyBy: ['Calling-Station-Id'],   // 2026-10-19 device test: User-Name never matches on an open captive BSS
      acctStopEmitted: false,
    });
    expect(u.note).toContain('no Acct-Stop');
    const req = getAdapter('ezeap-uam').buildDisconnect(session);
    // uspot's session kick rides on hostapd's CoA handler (ubus `coa`), never on Disconnect.
    expect('packet' in req ? req.packet : undefined).toBe('coa');
    // Calling-Station-Id only: User-Name is filtered against the 802.1X identity, which an open captive
    // BSS has none of (device test 2026-10-19, Session-Context-Not-Found); the 2026-10-16 Missing-Attribute
    // was the absent T-C-Filtering VSA, not the identity.
    expect('attributes' in req ? req.attributes : []).toEqual([
      { name: 'Calling-Station-Id', value: 'AA-BB-CC-DD-EE-01' },
      // WFA HS2.0 T-C-Filtering (vendor 40808 / 9): hostapd's CoA parser refuses the request without it.
      { name: 'Attr-26.40808.9', value: '0x00000000' },
    ]);
    expect(getAdapter('ezeap-uam').buildDisconnect({ sessionId: 'x' })).toMatchObject({
      unsupported: true,
    });
  });

  it('upstream uspot accepts any identification attribute; openwifi-config has no Disconnect', () => {
    const up = getAdapter('uspot-upstream-uam');
    expect(up.describeDisconnect()).toMatchObject({
      target: 'uspot-das',
      mandatory: [],
      acctStopEmitted: true,
    });
    const req = up.buildDisconnect({ sessionId: 'x', acctSessionId: 'abc' });
    expect('attributes' in req ? req.attributes : []).toEqual([
      { name: 'Acct-Session-Id', value: 'abc' },
    ]);
    expect(up.buildDisconnect({ sessionId: 'x' })).toEqual({
      unsupported: true,
      reason: 'no identification attribute available for this session',
    });
    const cfg = getAdapter('openwifi-config');
    expect(cfg.describeDisconnect()).toMatchObject({ target: 'none', status: 'UNSUPPORTED' });
    expect(cfg.buildDisconnect(session)).toMatchObject({ unsupported: true });
  });
});

describe('buildCoa', () => {
  const coovaPlan = plan('ezecloud-uam', [
    {
      name: 'WISPr-Bandwidth-Max-Down',
      value: 2_000_000,
      vendor: 'WISPr',
      status: 'VERIFIED_SUPPORTED',
      field: 'download_rate_kbps',
      evidence: 'x',
    },
    {
      name: 'Session-Timeout',
      value: 600,
      status: 'VERIFIED_SUPPORTED',
      field: 'session_timeout_s',
      evidence: 'x',
    },
    {
      name: 'Class',
      value: 'ecloud:sess-1',
      status: 'VERIFIED_SUPPORTED',
      field: 'class',
      evidence: 'x',
    },
    {
      name: 'CoovaChilli-VLAN-Id',
      value: 10,
      vendor: 'CoovaChilli',
      status: 'REQUIRES_DEVICE_TEST',
      field: 'vlan_id',
      evidence: 'x',
      experimental: true,
    },
  ]);

  it('CoovaChilli: identity + changeable attributes, experimental ones excluded', () => {
    const coa = getAdapter('ezecloud-uam').buildCoa(session, coovaPlan);
    // D-006: CoA stays REQUIRES_DEVICE_TEST until DT-15 passes on a real gateway
    expect(coa).toMatchObject({ kind: 'coa', status: 'REQUIRES_DEVICE_TEST' });
    expect('attributes' in coa ? coa.attributes : []).toEqual([
      { name: 'User-Name', value: 'alice' },
      { name: 'Acct-Session-Id', value: '0123456789abcdef' },
      { name: 'WISPr-Bandwidth-Max-Down', value: 2_000_000, vendor: 'WISPr' },
      { name: 'Session-Timeout', value: 600 },
    ]);
    expect(getAdapter('ezecloud-uam').buildCoa({ sessionId: 'x' }, coovaPlan)).toMatchObject({
      unsupported: true,
    });
    expect(getAdapter('ezecloud-uam').buildCoa(session, plan('ezecloud-uam', []))).toEqual({
      unsupported: true,
      reason: 'plan carries no attribute the NAS can change via CoA',
    });
  });

  it('TIP uspot: unsupported; upstream uspot: timeouts/interim only (REQUIRES_DEVICE_TEST)', () => {
    expect(getAdapter('ezeap-uam').buildCoa(session, plan('ezeap-uam', []))).toMatchObject({
      unsupported: true,
    });
    const upPlan = plan('uspot-upstream-uam', [
      {
        name: 'WISPr-Bandwidth-Max-Down',
        value: 2_000_000,
        vendor: 'WISPr',
        status: 'VERIFIED_SUPPORTED',
        field: 'download_rate_kbps',
        evidence: 'x',
      },
      {
        name: 'Idle-Timeout',
        value: 300,
        status: 'VERIFIED_SUPPORTED',
        field: 'idle_timeout_s',
        evidence: 'x',
      },
    ]);
    const coa = getAdapter('uspot-upstream-uam').buildCoa(session, upPlan);
    expect(coa).toMatchObject({ kind: 'coa', status: 'REQUIRES_DEVICE_TEST' });
    expect('attributes' in coa ? coa.attributes.map((a) => a.name) : []).toEqual([
      'User-Name',
      'NAS-IP-Address',
      'NAS-Identifier',
      'Framed-IP-Address',
      'Calling-Station-Id',
      'Acct-Session-Id',
      'Idle-Timeout',
    ]);
  });

  it('plans for another adapter are refused', () => {
    expect(() => getAdapter('ezecloud-uam').buildCoa(session, plan('ezeap-uam', []))).toThrow(
      'plan for ezeap-uam given to ezecloud-uam',
    );
    expect(() => getAdapter('ezecloud-uam').buildReplyAttributes(plan('ezeap-uam', []))).toThrow();
  });
});

describe('buildReplyAttributes / renderConfig', () => {
  it('returns dictionary-named attributes with vendor, dropping experimental and undeclared ones', () => {
    const p = plan('ezeap-uam', [
      {
        name: 'WISPr-Bandwidth-Max-Up',
        value: 5_000_000,
        vendor: 'WISPr',
        status: 'VERIFIED_SUPPORTED',
        field: 'upload_rate_kbps',
        evidence: 'x',
      },
      {
        name: 'Session-Timeout',
        value: 60,
        status: 'VERIFIED_SUPPORTED',
        field: 'session_bound',
        evidence: 'x',
      },
      {
        name: 'Tunnel-Type',
        value: 13,
        status: 'REQUIRES_DEVICE_TEST',
        field: 'vlan_id',
        evidence: 'x',
        experimental: true,
      },
      {
        name: 'Filter-Id',
        value: 'x',
        status: 'VERIFIED_SUPPORTED',
        field: 'class',
        evidence: 'x',
      },
    ]);
    expect(getAdapter('ezeap-uam').buildReplyAttributes(p)).toEqual([
      { name: 'WISPr-Bandwidth-Max-Up', value: 5_000_000, vendor: 'WISPr' },
      { name: 'Session-Timeout', value: 60 },
    ]);
    expect(
      getAdapter('ezeap-uam').buildReplyAttributes(p, { includeExperimental: true }),
    ).toHaveLength(2); // Tunnel-Type not declared by uspot
  });

  it('renderConfig only exists on openwifi-config and refuses foreign/empty plans', () => {
    expect('renderConfig' in getAdapter('ezecloud-uam')).toBe(false);
    const cfg = getAdapter('openwifi-config');
    expect(cfg.renderConfig?.(plan('openwifi-config', []))).toEqual({
      unsupported: true,
      reason: 'no site-scoped field translates to an SSID config change',
    });
    expect(cfg.renderConfig?.(plan('ezecloud-uam', []))).toEqual({
      unsupported: true,
      reason: 'plan for ezecloud-uam',
    });
  });

  it('declaration helpers reject duplicates and gaps', () => {
    expect(() =>
      fieldTable([
        decl('vlan_id', 'UNSUPPORTED', 'DOCUMENTED', 'x'),
        decl('vlan_id', 'UNSUPPORTED', 'DOCUMENTED', 'x'),
      ]),
    ).toThrow('duplicate declaration for vlan_id');
    expect(() => fieldTable([decl('vlan_id', 'UNSUPPORTED', 'DOCUMENTED', 'x')])).toThrow(
      'missing declaration for download_rate_kbps',
    );
    expect(() =>
      attributeTable([
        { name: 'Class', status: 'UNSUPPORTED', evidence: 'x', evidenceLevel: 'DOCUMENTED' },
        { name: 'Class', status: 'UNSUPPORTED', evidence: 'x', evidenceLevel: 'DOCUMENTED' },
      ]),
    ).toThrow('duplicate attribute declaration for Class');
  });
});
