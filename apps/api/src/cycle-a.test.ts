/**
 * Cycle A (D-044) unit tests without a database: NAS identity decision rules, MAC-auth / EAP
 * request classification, vendor-API credential and access-point input validation.
 */
import { describe, expect, it } from 'vitest';
import { EAP_ADAPTER_KEYS, isEapInner, macAuthKind } from './internal/aaa.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@ecloud/policy-engine';
import { requestFingerprint } from './http/idempotency.js';
import { calledStationMac, decideNasIdentity, type ResolvedNasRow } from './internal/nas-lookup.js';
import { isReplayed, legacyReplayKey, markReplayed, replayKey } from './internal/portal-store.js';
import { MemoryKv } from './kv.js';
import type { RadiusRequestBody } from './internal/radius.js';
import { AccessPointCreate } from './routes/access-points.js';
import {
  VENDOR_API_KIND_VENDOR,
  VENDOR_API_KINDS,
  VendorApiCredentialBody,
  serializeVendorApiCredential,
} from './routes/controllers.js';

const NAS_A: ResolvedNasRow = {
  id: 'nas-a',
  organization_id: 'org-a',
  site_id: 'site-a',
  nas_identifier: 'nas-a',
  adapter_key: 'generic-radius-8021x',
  deployment_mode: 'native',
  controller_id: null,
};
const NAS_B: ResolvedNasRow = { ...NAS_A, id: 'nas-b', organization_id: 'org-b' };

function ap(nas: ResolvedNasRow, over: Record<string, unknown> = {}) {
  return {
    ...nas,
    ap_status: 'active',
    nas_status: 'active',
    nas_deleted_at: null,
    site_status: 'active',
    site_deleted_at: null,
    org_status: 'active',
    ap_verified_at: new Date('2026-10-10T00:00:00Z'),
    ...over,
  };
}

describe('decideNasIdentity (fail closed)', () => {
  const MAC = 'aa:bb:cc:dd:ee:01';
  it('nothing to go on', () => {
    expect(decideNasIdentity({ nasid: null, apMac: null, byNasid: null, byApMac: null })).toEqual({
      ok: false,
      reason: 'no_identity',
    });
  });
  it('nasid: exactly one, else refuse', () => {
    expect(
      decideNasIdentity({ nasid: 'x', apMac: null, byNasid: [NAS_A], byApMac: null }),
    ).toMatchObject({ ok: true, via: 'nasid', nas: { id: 'nas-a' } });
    expect(
      decideNasIdentity({ nasid: 'x', apMac: null, byNasid: [NAS_A, NAS_B], byApMac: null }),
    ).toEqual({ ok: false, reason: 'ambiguous_nasid' });
    expect(decideNasIdentity({ nasid: 'x', apMac: null, byNasid: [], byApMac: null })).toEqual({
      ok: false,
      reason: 'unknown_nas',
    });
  });
  it('AP MAC only: a verified, active AP resolves; anything else fails closed', () => {
    expect(
      decideNasIdentity({ nasid: null, apMac: MAC, byNasid: null, byApMac: [ap(NAS_A)] }),
    ).toMatchObject({
      ok: true,
      via: 'ap_mac',
      nas: { id: 'nas-a' },
      apMacClaimedElsewhere: false,
    });
    for (const over of [
      { ap_status: 'disabled' },
      { nas_status: 'disabled' },
      { nas_deleted_at: new Date() },
      { site_status: 'suspended' },
      { site_deleted_at: new Date() },
      { org_status: 'suspended' },
    ]) {
      expect(
        decideNasIdentity({ nasid: null, apMac: MAC, byNasid: null, byApMac: [ap(NAS_A, over)] }),
      ).toEqual({ ok: false, reason: 'ap_inactive' });
    }
    // review M1b: an unverified (merely registered) AP never identifies a NAS on its own
    expect(
      decideNasIdentity({
        nasid: null,
        apMac: MAC,
        byNasid: null,
        byApMac: [ap(NAS_A, { ap_verified_at: null })],
      }),
    ).toEqual({ ok: false, reason: 'ap_unverified' });
    expect(decideNasIdentity({ nasid: null, apMac: MAC, byNasid: null, byApMac: [] })).toEqual({
      ok: false,
      reason: 'unknown_ap',
    });
    expect(
      decideNasIdentity({
        nasid: null,
        apMac: MAC,
        byNasid: null,
        byApMac: [ap(NAS_A), ap(NAS_B)],
      }),
    ).toEqual({ ok: false, reason: 'conflict' });
  });
  it('nasid decides; the AP row is a hint (review M1a: no squatting DoS)', () => {
    expect(
      decideNasIdentity({ nasid: 'x', apMac: MAC, byNasid: [NAS_A], byApMac: [ap(NAS_A)] }),
    ).toMatchObject({ ok: true, via: 'both', apMacClaimedElsewhere: false });
    // a MAC registered (even verified) by ANOTHER tenant's NAS does not block, it is flagged
    expect(
      decideNasIdentity({ nasid: 'x', apMac: MAC, byNasid: [NAS_A], byApMac: [ap(NAS_B)] }),
    ).toMatchObject({ ok: true, via: 'nasid', nas: { id: 'nas-a' }, apMacClaimedElsewhere: true });
    // a disabled / unverified AP row of the same NAS does not block either
    expect(
      decideNasIdentity({
        nasid: 'x',
        apMac: MAC,
        byNasid: [NAS_A],
        byApMac: [ap(NAS_A, { ap_status: 'disabled', ap_verified_at: null })],
      }),
    ).toMatchObject({ ok: true, nas: { id: 'nas-a' } });
    expect(
      decideNasIdentity({ nasid: 'x', apMac: MAC, byNasid: [NAS_A], byApMac: [] }),
    ).toMatchObject({ ok: true, via: 'nasid', apMacClaimedElsewhere: false });
    // a wrong nasid is never rescued by the AP MAC
    expect(
      decideNasIdentity({ nasid: 'x', apMac: MAC, byNasid: [], byApMac: [ap(NAS_A)] }),
    ).toEqual({ ok: false, reason: 'unknown_nas' });
  });
});

describe('calledStationMac (RADIUS-observed AP verification)', () => {
  it.each([
    ['AA-BB-CC-DD-EE-01', 'aa:bb:cc:dd:ee:01'],
    ['AA-BB-CC-DD-EE-01:Guest WiFi', 'aa:bb:cc:dd:ee:01'],
    ['aabbccddee01:ssid', 'aa:bb:cc:dd:ee:01'],
  ])('%s -> %s', (v, mac) => expect(calledStationMac(v)).toBe(mac));
  it.each([undefined, 'hotspot1', '01-00-5E-00-00-01', 'xx-aabbccddee01'])('%s -> null', (v) =>
    expect(calledStationMac(v)).toBeNull(),
  );
});

describe('idempotency fingerprint (review L1)', () => {
  const body = { api_kind: 'mist', secret: 'test-low-entropy-1' };
  it('is a keyed HMAC, not a plain hash of the (secret-bearing) body', () => {
    const fp = requestFingerprint('test-data-key-material-0123456789', body);
    expect(fp.startsWith('hmac:')).toBe(true);
    const plain = createHash('sha256').update(canonicalJson(body)).digest('hex');
    expect(fp).not.toContain(plain);
    // stable for the same body and key, different under another key / body
    expect(requestFingerprint('test-data-key-material-0123456789', { ...body })).toBe(fp);
    expect(requestFingerprint('test-other-key-material-987654321', body)).not.toBe(fp);
    expect(
      requestFingerprint('test-data-key-material-0123456789', { ...body, secret: 'x' }),
    ).not.toBe(fp);
    expect(requestFingerprint('test-data-key-material-0123456789', Buffer.from('abc'))).not.toBe(
      requestFingerprint('test-data-key-material-0123456789', 'abc'),
    );
  });
});

function body(attrs: Record<string, string>): RadiusRequestBody {
  return Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [k, { type: 'string', value: [v] }]),
  );
}

describe('macAuthKind / isEapInner (AAA §2.3, §2.4)', () => {
  const STATION = 'AA-BB-CC-DD-EE-01';
  it('Call-Check is MAC auth on every adapter (unchanged behaviour)', () => {
    expect(
      macAuthKind(body({ 'User-Name': 'x', 'Service-Type': 'Call-Check' }), 'coovachilli-uam'),
    ).toBe('call-check');
  });
  it('generic adapter: User-Name = station MAC, password absent or same MAC', () => {
    for (const userName of [
      'aabbccddee01',
      'aa:bb:cc:dd:ee:01',
      'AA-BB-CC-DD-EE-01',
      'aabb.ccdd.ee01',
    ]) {
      expect(
        macAuthKind(
          body({ 'User-Name': userName, 'Calling-Station-Id': STATION }),
          'generic-radius-8021x',
        ),
        userName,
      ).toBe('username');
      expect(
        macAuthKind(
          body({
            'User-Name': userName,
            'User-Password': 'AABBCCDDEE01',
            'Calling-Station-Id': STATION,
          }),
          'generic-radius-8021x',
        ),
      ).toBe('username');
    }
  });
  it('generic adapter: not MAC auth when it does not look exactly like MAB', () => {
    const cases: Record<string, string>[] = [
      { 'User-Name': 'aabbccddee02', 'Calling-Station-Id': STATION }, // other station
      { 'User-Name': 'aabbccddee01', 'User-Password': 'secret-pw', 'Calling-Station-Id': STATION },
      { 'User-Name': 'aabbccddee01x', 'Calling-Station-Id': STATION },
      { 'User-Name': 'aabbccddee01' }, // no station
      { 'User-Name': 'aabbccddee01', 'Calling-Station-Id': STATION, 'CHAP-Password': '0x00' },
    ];
    for (const c of cases)
      expect(macAuthKind(body(c), 'generic-radius-8021x'), JSON.stringify(c)).toBeNull();
  });
  it('MAC-as-username applies only to the generic adapter', () => {
    const b = body({ 'User-Name': 'aabbccddee01', 'Calling-Station-Id': STATION });
    for (const key of ['openwifi-hostapd-radius', 'openwifi-uspot-uam', 'coovachilli-uam', null])
      expect(macAuthKind(b, key)).toBeNull();
  });
  it('an EAP inner identity is never MAC auth (not even with Call-Check)', () => {
    const inner = body({
      'User-Name': 'aabbccddee01',
      'Calling-Station-Id': STATION,
      'Service-Type': 'Call-Check',
      'ECLOUD-EAP-Inner': 'ttls',
    });
    expect(isEapInner(inner)).toBe(true);
    expect(macAuthKind(inner, 'generic-radius-8021x')).toBeNull();
    expect(isEapInner(body({ 'User-Name': 'x' }))).toBe(false);
    expect([...EAP_ADAPTER_KEYS].sort()).toEqual([
      'generic-radius-8021x',
      'openwifi-hostapd-radius',
    ]);
  });
});

describe('replay keys (contract gap: nonce without challenge; review L4)', () => {
  const base = { nasId: 'n', sessionId: null, challenge: 'AbC', clientMac: 'aa:bb:cc:dd:ee:01' };
  it('UAM default kind; case-insensitive UAM challenge; other kinds separate and exact', () => {
    expect(replayKey(base)).toBe(replayKey({ ...base, nonceKind: 'uam-challenge' }));
    expect(replayKey(base)).toBe(replayKey({ ...base, challenge: 'abc' }));
    const token = replayKey({ ...base, nonceKind: 'ecloud-login-token' });
    expect(token).not.toBe(replayKey(base));
    expect(token).not.toBe(replayKey({ ...base, nonceKind: 'vendor-nonce' }));
    expect(token).not.toBe(
      replayKey({ ...base, challenge: 'abc', nonceKind: 'ecloud-login-token' }),
    );
  });
  it('is unambiguous: a `|` in the session id cannot shift fields', () => {
    const a = replayKey({ ...base, sessionId: 's|abc', challenge: 'def' });
    const b = replayKey({ ...base, sessionId: 's', challenge: 'abc|def' });
    expect(a).not.toBe(b);
    expect(a.startsWith('pf:replay:v2:')).toBe(true);
  });
  it('legacy UAM markers (pre-upgrade, TTL-bounded) are still honoured on read', async () => {
    const kv = new MemoryKv();
    const legacy = legacyReplayKey(base);
    expect(legacy).not.toBeNull();
    expect(legacyReplayKey({ ...base, nonceKind: 'ecloud-login-token' })).toBeNull();
    expect(await isReplayed(kv, base)).toBe(false);
    await kv.set(legacy as string, '1', 60);
    expect(await isReplayed(kv, base)).toBe(true);
    const fresh = { ...base, challenge: 'ff' };
    await markReplayed(kv, replayKey(fresh));
    expect(await isReplayed(kv, fresh)).toBe(true);
  });
});

describe('vendor API credential input', () => {
  const ok = { api_kind: 'unifi-network', base_url: 'https://10.0.0.5/', secret: 'x' };
  it('accepts the documented kinds, each mapped to a registry vendor', () => {
    expect(VENDOR_API_KINDS).toHaveLength(6);
    for (const k of VENDOR_API_KINDS) expect(VENDOR_API_KIND_VENDOR[k]).toMatch(/^[a-z-]+$/);
    expect(VendorApiCredentialBody.safeParse(ok).success).toBe(true);
  });
  it('refuses unknown kinds, extra fields, empty secrets and a missing Omada operator', () => {
    for (const bad of [
      { ...ok, api_kind: 'cisco-dnac' },
      { ...ok, secret: '' },
      { ...ok, secret_ref: 'enc:v1.x' },
      { ...ok, api_kind: 'omada-controller' },
      { ...ok, external_site_id: 'a b' },
      { ...ok, external_org_id: 'x'.repeat(129) },
    ]) {
      expect(VendorApiCredentialBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(
      VendorApiCredentialBody.safeParse({ ...ok, api_kind: 'omada-controller', username: 'op' })
        .success,
    ).toBe(true);
  });
  it('serialisation never carries the sealed secret', () => {
    const out = serializeVendorApiCredential({
      controller_id: 'c',
      api_kind: 'mist',
      base_url: 'https://api.mist.example.com/',
      username: null,
      external_org_id: null,
      external_site_id: null,
      rotated_at: new Date(0),
      updated_at: new Date(0),
      // extra column a careless caller might pass along
      ...({ secret_ref: 'enc:v1.sealed' } as object),
    });
    expect(JSON.stringify(out)).not.toContain('enc:v1');
    expect(out.has_secret).toBe(true);
  });
});

describe('access point input', () => {
  const nas = '01a12526-0d03-7e71-96aa-2e7d04522c36';
  it('canonicalises the MAC and refuses group / zero addresses', () => {
    const parsed = AccessPointCreate.safeParse({ nas_client_id: nas, mac: 'AA-BB-CC-DD-EE-01' });
    expect(parsed.success && parsed.data.mac).toBe('aa:bb:cc:dd:ee:01');
    for (const mac of [
      'ff:ff:ff:ff:ff:ff',
      '01:00:5e:00:00:01',
      '000000000000',
      'aa:bb-cc:dd:ee:01',
    ])
      expect(AccessPointCreate.safeParse({ nas_client_id: nas, mac }).success, mac).toBe(false);
  });
});
