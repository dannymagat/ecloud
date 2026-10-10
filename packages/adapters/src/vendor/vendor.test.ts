/**
 * Vendor-neutral contract over the five first-party adapters (MULTI_VENDOR_INTEGRATION_PLAN.md
 * §6, §8.1 AC1–AC3). UAM fixtures use only the parameter lists of CAPTIVE_PORTAL_ARCHITECTURE.md
 * §3.2 (uspot) and §4 (CoovaChilli); the UAM secret is an obvious test value.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PolicyIntentSchema,
  resolveEffectivePolicy,
  type ResolutionInput,
  type TranslationContext,
} from '@ecloud/policy-engine';
import { getAdapter } from '../registry.js';
import { getVendorAdapter, listVendorAdapters } from './first-party.js';
import type {
  BrokerCredential,
  HotspotContext,
  NasLookup,
  ParsedRedirect,
  RegisteredNas,
} from './types.js';
import {
  computeUamSignature,
  encodeUamPapPassword,
  safeUserUrl,
  splitUamQuery,
  verifyUamSignature,
} from './uam.js';

const TEST_UAM_SECRET = 'test-uam-secret';
const USPOT_SERVER = 'https://portal.ezecloud.ezelink.ai/uam/uspot/';
const CHILLI_SERVER = 'https://portal.ezecloud.ezelink.ai/uam/chilli/';
const NOW = new Date('2026-10-06T06:00:00Z');

/** uspot T order (CP §3.2): userurl raw (not url-encoded), md last. */
const USPOT_T_QUERY =
  'res=notyet&uamip=10.1.0.1&uamport=3990&challenge=0123456789abcdef0123456789abcdef&mac=AA-BB-CC-DD-EE-02&ip=10.1.0.23&called=00-11-22-33-44-55&nasid=nas-uspot-1&ssid=Guest&sessionid=5f3c2a1b0d9e8f70&userurl=http://example.com/a?b=c&d=%e9';

function signed(server: string, query: string, secret = TEST_UAM_SECRET): string {
  return `${query}&md=${computeUamSignature(`${server}?${query}`, secret)}`;
}

const NAS_USPOT: RegisteredNas = {
  id: 'nas-uspot-1',
  organizationId: 'org-a',
  siteId: 'site-a',
  identifier: 'nas-uspot-1',
  adapterKey: 'openwifi-uspot-uam',
  controllerId: null,
  deploymentMode: 'native',
  uamServerUrl: USPOT_SERVER,
  uamSecret: TEST_UAM_SECRET,
};

function lookup(nas: RegisteredNas | null, extra: Partial<NasLookup> = {}): NasLookup {
  return {
    findNas: () => Promise.resolve(nas),
    expectedOrganizationId: null,
    isReplay: () => Promise.resolve(false),
    now: () => NOW,
    ...extra,
  };
}

const uspot = getVendorAdapter('openwifi-uspot-uam');
const chilli = getVendorAdapter('coovachilli-uam');

function parse(query: string, adapter = uspot): ParsedRedirect {
  const p = adapter.parseRedirect({ url: `${USPOT_SERVER}?${query}`, method: 'GET' });
  if ('unsupported' in p) throw new Error(p.reason);
  return p;
}

async function context(query = signed(USPOT_SERVER, USPOT_T_QUERY)): Promise<HotspotContext> {
  const v = await uspot.validateContext(parse(query), lookup(NAS_USPOT));
  if (!v.ok) throw new Error(v.detail);
  return v.context;
}

const credential: BrokerCredential = {
  username: 'pc-0123456789abcdef',
  password: 'Zx9pQ2rT7vW4yB6n',
  expiresAt: new Date(NOW.getTime() + 90_000),
  boundNasId: 'nas-uspot-1',
  boundClientMac: 'aa:bb:cc:dd:ee:02',
};

describe('first-party VendorAdapter wrappers (AC1, AC2)', () => {
  it('wrap the unchanged engine objects and expose the nine operations', () => {
    const all = listVendorAdapters();
    expect(all.map((v) => v.key)).toEqual([
      'openwifi-hostapd-radius',
      'openwifi-uspot-uam',
      'uspot-upstream-uam',
      'coovachilli-uam',
      'openwifi-config',
      'generic-radius-8021x',
      'mikrotik-hotspot',
      'external-portal-postback',
    ]);
    for (const v of all) {
      expect(v.engine).toBe(getAdapter(v.key));
      for (const op of [
        'discoverCapabilities',
        'parseRedirect',
        'validateContext',
        'buildAuthorization',
        'authorizeSession',
        'revokeSession',
        'normalizeAccounting',
        'buildSetupGuide',
        'healthCheck',
      ] as const)
        expect(typeof v[op], `${v.key}.${op}`).toBe('function');
    }
    expect(uspot.strategies).toEqual(['browser-form']);
    expect(getVendorAdapter('openwifi-config').strategies).toEqual([]);
    expect(() => getVendorAdapter('cambium-hotspot')).toThrow('unknown vendor adapter');
  });

  it('adapters without a portal return explicit Unsupported (plan §6.3)', async () => {
    for (const key of ['openwifi-hostapd-radius', 'openwifi-config']) {
      const v = getVendorAdapter(key);
      expect(v.parseRedirect({ url: `/x?${USPOT_T_QUERY}`, method: 'GET' })).toMatchObject({
        unsupported: true,
      });
      expect(
        v.authorizeSession(await context(), credential, { uamSecret: TEST_UAM_SECRET }),
      ).toMatchObject({
        unsupported: true,
      });
    }
  });

  it('buildAuthorization carries engine.translate / buildReplyAttributes results by reference', async () => {
    const policy = PolicyIntentSchema.parse({
      id: 'pol-1',
      organization_id: 'org-a',
      name: 'Guest 10/2',
      scope_type: 'site',
      status: 'active',
      version: 1,
      download_rate_kbps: 10000,
      upload_rate_kbps: 2000,
      session_timeout_s: 3600,
    });
    const input: ResolutionInput = {
      now: NOW,
      timeZone: 'UTC',
      organization_id: 'org-a',
      site_id: 'site-a',
      subject: { kind: 'user', user_id: 'user-1' },
      client_device_id: null,
      mac: 'aa:bb:cc:dd:ee:02',
      group_ids: [],
      candidates: [
        {
          assignment: {
            id: 'as-1',
            policy_id: 'pol-1',
            target_type: 'site',
            user_group_id: null,
            site_id: 'site-a',
            effective_from: new Date('2026-01-01T00:00:00Z'),
            effective_until: null,
            priority: 100,
          },
          policy,
        },
      ],
      usage: {},
      active_sessions: [],
      tenant: { min_session_s: 300 },
    };
    const r = resolveEffectivePolicy(input);
    const tctx: TranslationContext = {
      sessionId: '0f3b9b4e-7b2d-4a6b-9d1e-2b7f8a1c5e10',
      now: NOW,
      clip: r.clip,
      controls: r.controls,
      interimIntervalS: 300,
      nasAcctIntervalUnset: true,
    };
    const engine = getAdapter('openwifi-uspot-uam');
    const translateSpy = vi.spyOn(engine, 'translate');
    const replySpy = vi.spyOn(engine, 'buildReplyAttributes');
    try {
      const plan = uspot.buildAuthorization(await context(), credential, r.effective, tctx, {
        uamSecret: TEST_UAM_SECRET,
      });
      if ('unsupported' in plan) throw new Error(plan.reason);
      expect(plan.enforcement).toBe(translateSpy.mock.results[0]?.value);
      expect(plan.replyAttributes).toBe(replySpy.mock.results[0]?.value);
      // Same output as calling the engine directly.
      expect(plan.enforcement).toEqual(engine.translate(r.effective, tctx));
      expect(plan.handoff.state).toBe('pending');
    } finally {
      translateSpy.mockRestore();
      replySpy.mockRestore();
    }
  });

  it('revokeSession delegates to engine.buildDisconnect (status stays REQUIRES_DEVICE_TEST, D-006)', () => {
    const session = {
      sessionId: 's',
      callingStationId: 'AA-BB-CC-DD-EE-02',
      nasIdentifier: 'nas-uspot-1',
    };
    const req = uspot.revokeSession(session);
    expect(req).toEqual(getAdapter('openwifi-uspot-uam').buildDisconnect(session));
    expect(req).toMatchObject({ kind: 'disconnect', status: 'REQUIRES_DEVICE_TEST' });
    expect(chilli.revokeSession({ sessionId: 's' })).toMatchObject({ unsupported: true });
  });

  it('discoverCapabilities resolves the registry row and applies V11 / V12', () => {
    const gw = chilli.discoverCapabilities({ firmware: 'coova-chilli 1.2.9' });
    expect(gw.rowKey).toBe('coova-chilli-1.2.9-ezegate');
    expect(gw.cells.filter((c) => c.status === 'VERIFIED_SUPPORTED')).toEqual([]);
    const tip = uspot.discoverCapabilities({
      modelKey: 'EZE-AP1832',
      firmware: 'EZEAP 6 r32912-6639b15f62',
    });
    expect(tip.rowKey).toBe('ezelink-eze-ap1832-r32912-tip-uspot');
    expect(tip.cells.find((c) => c.capability === 'download_rate_kbps')).toMatchObject({
      status: 'VERIFIED_SUPPORTED',
      evidenceLevel: 'VERIFIED_FROM_SOURCE',
      deviceEnforced: false,
    });
    const generic = uspot.discoverCapabilities({});
    expect(generic.rowKey).toBeNull();
    expect(generic.cells.every((c) => !c.deviceEnforced)).toBe(true);
  });
});

describe('UAM redirect parsing and validation (AC3)', () => {
  it('parses md as the last parameter and keeps rawQuery byte-identical', () => {
    const q = signed(USPOT_SERVER, USPOT_T_QUERY);
    const p = parse(q);
    expect(p.rawQuery).toBe(q);
    expect(p.signature.kind).toBe('uam-md5');
    expect(p.signature.value).toMatch(/^[0-9A-F]{32}$/);
    expect(p.result).toBe('notyet');
    // uspot T raw userurl keeps its own `?`/`&`; `md` is not swallowed into it.
    expect(p.params.userurl).toBe('http://example.com/a?b=c&d=%e9');
    expect(p.params.nasid).toBe('nas-uspot-1');
    expect(parse('res=reject&mac=x').result).toBe('failed');
    expect(uspot.parseRedirect({ url: `/x?${q}`, method: 'POST' })).toMatchObject({
      unsupported: true,
    });
  });

  it('verifies md case-insensitively and rejects tampering', () => {
    const q = signed(USPOT_SERVER, USPOT_T_QUERY);
    expect(verifyUamSignature(parse(q), USPOT_SERVER, TEST_UAM_SECRET)).toBe(true);
    expect(
      verifyUamSignature(
        parse(q.replace(/md=([0-9A-F]+)$/, (_m, h: string) => `md=${h.toLowerCase()}`)),
        USPOT_SERVER,
        TEST_UAM_SECRET,
      ),
    ).toBe(true);
    expect(
      verifyUamSignature(
        parse(q.replace('mac=AA-BB-CC-DD-EE-02', 'mac=AA-BB-CC-DD-EE-03')),
        USPOT_SERVER,
        TEST_UAM_SECRET,
      ),
    ).toBe(false);
    expect(verifyUamSignature(parse(q), USPOT_SERVER, 'other-test-secret')).toBe(false);
    expect(verifyUamSignature(parse(USPOT_T_QUERY), USPOT_SERVER, TEST_UAM_SECRET)).toBe(false);
    // md = MD5(url + secret), uppercase hex (CP §7.3).
    const url = `${CHILLI_SERVER}?res=notyet`;
    expect(computeUamSignature(url, TEST_UAM_SECRET)).toBe(
      createHash('md5')
        .update(url + TEST_UAM_SECRET)
        .digest('hex')
        .toUpperCase(),
    );
  });

  it('builds a HotspotContext from a valid redirect (tenant from the NAS, opaque query preserved)', async () => {
    const q = signed(USPOT_SERVER, USPOT_T_QUERY);
    const ctx = await context(q);
    expect(ctx).toMatchObject({
      organizationId: 'org-a',
      siteId: 'site-a',
      vendorKey: 'ezelink',
      controllerId: null,
      nas: { id: 'nas-uspot-1', identifier: 'nas-uspot-1', adapterKey: 'openwifi-uspot-uam' },
      apMac: '00:11:22:33:44:55',
      clientMac: 'aa:bb:cc:dd:ee:02',
      ssid: 'Guest',
      clientIp: '10.1.0.23',
      nasSessionId: '5f3c2a1b0d9e8f70',
      policyRef: null,
      deploymentMode: 'native',
      receivedAt: NOW,
    });
    expect(ctx.vendorOpaque.raw).toBe(q);
    expect(JSON.stringify(ctx)).not.toContain(TEST_UAM_SECRET);
  });

  it('rejects bad signature, unknown NAS, tenant mismatch, public uamip, replay and malformed input', async () => {
    const good = signed(USPOT_SERVER, USPOT_T_QUERY);
    const v = (q: string, l: NasLookup = lookup(NAS_USPOT)) => uspot.validateContext(parse(q), l);
    expect(await v(USPOT_T_QUERY)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(await v(good.replace('nasid=nas-uspot-1', 'nasid=nas-uspot-2'))).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await v(good, lookup(null))).toMatchObject({ ok: false, reason: 'unknown_nas' });
    expect(await v(good, lookup({ ...NAS_USPOT, adapterKey: 'coovachilli-uam' }))).toMatchObject({
      ok: false,
      reason: 'unknown_nas',
    });
    expect(await v(good, lookup(NAS_USPOT, { expectedOrganizationId: 'org-b' }))).toMatchObject({
      ok: false,
      reason: 'tenant_mismatch',
    });
    expect(await v(good, lookup({ ...NAS_USPOT, uamSecret: null }))).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
    const publicIp = signed(
      USPOT_SERVER,
      USPOT_T_QUERY.replace('uamip=10.1.0.1', 'uamip=203.0.113.7'),
    );
    expect(await v(publicIp)).toMatchObject({ ok: false, reason: 'private_address_required' });
    expect(
      await v(good, lookup(NAS_USPOT, { isReplay: () => Promise.resolve(true) })),
    ).toMatchObject({ ok: false, reason: 'replayed' });
    expect(await v(good, lookup(NAS_USPOT, { expectedOrganizationId: 'org-a' }))).toMatchObject({
      ok: true,
    });
  });

  it('fails closed when the caller omits the replay check or the expected organization', async () => {
    const good = signed(USPOT_SERVER, USPOT_T_QUERY);
    const noReplay = { findNas: () => Promise.resolve(NAS_USPOT), expectedOrganizationId: null };
    expect(
      await uspot.validateContext(parse(good), noReplay as unknown as NasLookup),
    ).toMatchObject({ ok: false, reason: 'replayed' });
    const noOrg = {
      findNas: () => Promise.resolve(NAS_USPOT),
      isReplay: () => Promise.resolve(false),
    };
    expect(await uspot.validateContext(parse(good), noOrg as unknown as NasLookup)).toMatchObject({
      ok: false,
      reason: 'tenant_mismatch',
    });
  });

  it('md is derived from the raw query, never from a caller-supplied signature field', () => {
    const good = signed(USPOT_SERVER, USPOT_T_QUERY);
    const forged: ParsedRedirect = {
      ...parse(USPOT_T_QUERY),
      signature: { kind: 'uam-md5', value: parse(good).signature.value },
    };
    expect(verifyUamSignature(forged, USPOT_SERVER, TEST_UAM_SECRET)).toBe(false);
  });

  it('rejects malformed redirects', async () => {
    const v = (q: string) => uspot.validateContext(parse(q), lookup(NAS_USPOT));
    const noMac = signed(USPOT_SERVER, USPOT_T_QUERY.replace('&mac=AA-BB-CC-DD-EE-02', ''));
    expect(await v(noMac)).toMatchObject({ ok: false, reason: 'malformed' });
    const dup = signed(USPOT_SERVER, `nasid=evil&${USPOT_T_QUERY}`);
    expect(await v(dup)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('treats userurl as hostile (SECURITY §5.3)', () => {
    expect(safeUserUrl('https://example.com/x', '10.1.0.1')).toBe('https://example.com/x');
    for (const bad of [
      'javascript:alert(1)',
      'https://user:pw@example.com/',
      'http://10.1.0.1/',
      'http://192.168.1.1/',
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:10.0.0.1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost./',
      'http://app.localhost/',
      `https://example.com/${'a'.repeat(2100)}`,
      'not a url',
    ])
      expect(safeUserUrl(bad, '10.1.0.1'), bad).toBeNull();
  });

  it('splitUamQuery decodes display copies only', () => {
    const q = splitUamQuery('res=notyet&ssid=Caf%C3%A9+Guest&userurl=http%3A%2F%2Fexample.com%2F');
    expect(q.params.ssid).toBe('Café Guest');
    expect(q.params.userurl).toBe('http://example.com/');
    expect(q.md).toBeNull();
  });
});

describe('authorization hand-off (browser-form)', () => {
  it('GET-302 to http://uamip:uamport/logon with PAP-encoded single-use credential; no secret leaks', async () => {
    const h = uspot.authorizeSession(await context(), credential, { uamSecret: TEST_UAM_SECRET });
    if ('unsupported' in h) throw new Error(h.reason);
    expect(h.strategy).toBe('browser-form');
    expect(h.browser?.method).toBe('GET-302');
    expect(
      h.browser?.url.startsWith(
        'http://10.1.0.1:3990/logon?username=pc-0123456789abcdef&password=',
      ),
    ).toBe(true);
    expect(h.browser?.fields.password).toBe(
      encodeUamPapPassword(
        credential.password,
        '0123456789abcdef0123456789abcdef',
        TEST_UAM_SECRET,
      ),
    );
    expect(h.browser?.fields.userurl).toBe('http://example.com/a?b=c&d=%e9');
    expect(JSON.stringify(h)).not.toContain(TEST_UAM_SECRET);
    expect(JSON.stringify(h)).not.toContain(credential.password);
  });

  it('PAP encoding is reversible with the same key (XOR) and refuses > 16 bytes', () => {
    const enc = Buffer.from(encodeUamPapPassword('abc', '00ff', TEST_UAM_SECRET), 'hex');
    const key = createHash('md5')
      .update(Buffer.concat([Buffer.from('00ff', 'hex'), Buffer.from(TEST_UAM_SECRET)]))
      .digest();
    const dec = Buffer.from(enc.map((b, i) => b ^ (key[i] ?? 0)));
    expect(dec.subarray(0, 3).toString()).toBe('abc');
    expect([...dec.subarray(3)].every((b) => b === 0)).toBe(true);
    expect(() => encodeUamPapPassword('x'.repeat(17), '00ff', TEST_UAM_SECRET)).toThrow(
      '1–16 bytes',
    );
  });

  it('refuses unbound/expired credentials and a missing UAM secret (never fakes success)', async () => {
    const ctx = await context();
    expect(uspot.authorizeSession(ctx, credential, { uamSecret: null })).toMatchObject({
      unsupported: true,
    });
    expect(
      uspot.authorizeSession(
        ctx,
        { ...credential, boundClientMac: 'aa:bb:cc:dd:ee:03' },
        { uamSecret: TEST_UAM_SECRET },
      ),
    ).toMatchObject({ unsupported: true });
    expect(
      uspot.authorizeSession(
        ctx,
        { ...credential, expiresAt: NOW },
        { uamSecret: TEST_UAM_SECRET },
      ),
    ).toMatchObject({ unsupported: true });
    expect(chilli.authorizeSession(ctx, credential, { uamSecret: TEST_UAM_SECRET })).toMatchObject({
      unsupported: true,
    });
  });
});

describe('setup guide, health', () => {
  it('setup guides contain placeholders only for secrets', () => {
    for (const v of listVendorAdapters()) {
      for (const s of v.buildSetupGuide({ siteId: 'site-a', nasId: 'nas-1' })) {
        if (/secret/i.test(s.setting)) expect(s.value, `${v.key}/${s.id}`).toMatch(/^<[A-Z_]+>/);
        expect(s.evidenceRefs.length).toBeGreaterThan(0);
      }
    }
    const steps = uspot.buildSetupGuide({ siteId: 'site-a', nasId: 'nas-1' });
    expect(steps.find((s) => s.id === 'uam-server')?.value).toBe(USPOT_SERVER);
    expect(steps.find((s) => s.id === 'nasid')?.value).toBe('nas-1');
  });

  it('healthCheck reports ECLOUD-side signals only', () => {
    const h = uspot.healthCheck({
      now: NOW,
      lastAccessRequestAt: new Date(NOW.getTime() - 60_000),
      lastAccountingAt: new Date(NOW.getTime() - 3_600_000),
      interimIntervalS: 300,
      lastWireguardHandshakeAt: new Date(NOW.getTime() - 30_000),
    });
    expect(h.signals.map((s) => [s.name, s.state])).toEqual([
      ['radius-access-request', 'ok'],
      ['radius-accounting', 'stale'],
      ['wireguard-handshake', 'ok'],
    ]);
    const cfg = getVendorAdapter('openwifi-config').healthCheck({
      now: NOW,
      lastAccessRequestAt: null,
      lastAccountingAt: null,
      interimIntervalS: null,
    });
    expect(cfg.signals).toEqual([
      { name: 'wireguard-handshake', state: 'unknown', lastSeenAt: null },
    ]);
  });
});

describe('generic-radius-8021x vendor adapter (Cycle A)', () => {
  const generic = getVendorAdapter('generic-radius-8021x');

  it('is vendor-neutral, has no portal and wraps the engine record', () => {
    expect(generic.vendorKey).toBe('generic-radius');
    expect(generic.engine).toBe(getAdapter('generic-radius-8021x'));
    expect(generic.strategies).toEqual([]);
    expect(generic.parseRedirect({ url: 'https://x/?a=b', method: 'GET' })).toMatchObject({
      unsupported: true,
    });
    expect(generic.authorizeSession(context as never, credential)).toMatchObject({
      unsupported: true,
    });
  });

  it('setup guide covers RADIUS auth/acct, EAP-TTLS/PAP, MAC auth and DAS with placeholders', () => {
    const steps = generic.buildSetupGuide({ siteId: 'site-a', nasId: 'nas-1' });
    expect(steps.map((s) => s.id)).toEqual([
      'radius-auth',
      'radius-acct',
      'nas-source',
      'nas-identifier',
      'message-authenticator',
      'interim',
      'eap-method',
      'eap-ca',
      'mac-auth',
      'das',
    ]);
    expect(steps.find((s) => s.id === 'eap-method')?.value).toBe('EAP-TTLS / PAP');
    for (const s of steps) expect(s.value).not.toMatch(/ecloud_dev|secret=/i);
  });

  it('capability report presents nothing as device-enforced (V12)', () => {
    const engineOnly = generic.discoverCapabilities({});
    expect(engineOnly.rowKey).toBeNull();
    const report = generic.discoverCapabilities({ modelKey: 'UNKNOWN', firmware: 'UNKNOWN' });
    expect(report.rowKey).toBe('generic-radius-8021x');
    expect(report.lifecycle).toBe('implemented');
    for (const r of [engineOnly, report]) {
      expect(r.cells.some((c) => c.deviceEnforced)).toBe(false);
      expect(r.cells.some((c) => c.status === 'VERIFIED_SUPPORTED')).toBe(false);
    }
  });

  it('Disconnect is built for the NAS DAS and needs Calling-Station-Id', () => {
    const ok = generic.revokeSession({
      sessionId: 's',
      callingStationId: 'AA-BB-CC-DD-EE-02',
      userName: 'alice',
    });
    expect(ok).toMatchObject({
      kind: 'disconnect',
      target: 'rfc5176-das',
      status: 'REQUIRES_DEVICE_TEST',
    });
    expect(generic.revokeSession({ sessionId: 's', userName: 'alice' })).toMatchObject({
      unsupported: true,
    });
  });
});

describe('NasLookup carries the AP MAC (Cycle A contract gap)', () => {
  it('UAM validation passes the canonical AP MAC from `called` to findNas', async () => {
    const findNas = vi.fn(() => Promise.resolve(NAS_USPOT));
    const v = await uspot.validateContext(
      parse(signed(USPOT_SERVER, USPOT_T_QUERY)),
      lookup(NAS_USPOT, { findNas }),
    );
    expect(v.ok).toBe(true);
    expect(findNas).toHaveBeenCalledWith({
      nasid: 'nas-uspot-1',
      called: '00-11-22-33-44-55',
      apMac: '00:11:22:33:44:55',
    });
  });
});
