/**
 * Cycle B (D-044): MikroTik RouterOS Hotspot vendor adapter + Teltonika profile. Pure unit tests:
 * redirect parsing, CHAP computation (vendor doc vectors cross-checked with an independent MD5),
 * login-target validation, hand-off fields, attribute rendering through the engine adapter.
 */
import { createHash } from 'node:crypto';
import type { EffectivePolicy, TranslationContext } from '@ecloud/policy-engine';
import { INTENT_COLUMNS } from '@ecloud/policy-engine';
import { describe, expect, it } from 'vitest';
import { getAdapter } from '../registry.js';
import { getCompatibilityRow } from '../registry/compatibility.js';
import {
  computeMikrotikChapPassword,
  decodeMikrotikOctal,
  MIKROTIK_REDIRECT_PARAMS,
  parseMikrotikLoginTarget,
  renderMikrotikLoginHtml,
  splitMikrotikQuery,
} from './mikrotik.js';
import { getVendorAdapter, getVendorProfile, PORTAL_ORIGIN } from './first-party.js';
import type { BrokerCredential, NasLookup, RegisteredNas } from './types.js';

/** Vendor doc examples (Hotspot customisation, variable list). */
const DOC_CHAP_ID = '\\371';
const DOC_CHAP_CHALLENGE =
  '\\357\\015\\330\\013\\021\\234\\145\\245\\303\\253\\142\\246\\133\\175\\375\\316';
const DOC_CHALLENGE_HEX = 'ef0dd80b119c65a5c3ab62a65b7dfdce';

const NAS: RegisteredNas = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  siteId: '33333333-3333-4333-8333-333333333333',
  identifier: 'mt-lobby',
  adapterKey: 'mikrotik-hotspot',
  controllerId: null,
  deploymentMode: 'gateway',
  uamServerUrl: null,
  uamSecret: null,
  hotspotAddress: '10.5.50.1',
  hotspotPort: null,
};

function query(over: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {
    mac: '01:23:45:67:89:AB',
    ip: '10.5.50.2',
    identity: 'mt-lobby',
    'link-login-only': 'http://10.5.50.1/login',
    'link-orig': 'https://www.example.com/',
    'chap-id': DOC_CHAP_ID,
    'chap-challenge': DOC_CHAP_CHALLENGE,
    error: '',
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete base[k];
    else base[k] = v;
  }
  return new URLSearchParams(base).toString();
}

function lookup(over: Partial<NasLookup> = {}, nas: RegisteredNas | null = NAS): NasLookup {
  return {
    findNas: () => Promise.resolve(nas),
    expectedOrganizationId: null,
    isReplay: () => Promise.resolve(false),
    now: () => new Date('2026-10-10T08:00:00Z'),
    ...over,
  };
}

const mt = getVendorAdapter('mikrotik-hotspot');

async function context(q = query()) {
  const parsed = mt.parseRedirect({ url: `/hotspot/mikrotik/?${q}`, method: 'GET' });
  if ('unsupported' in parsed) throw new Error(parsed.reason);
  return mt.validateContext(parsed, lookup());
}

function credential(over: Partial<BrokerCredential> = {}): BrokerCredential {
  return {
    username: 'pc-0123456789abcdef',
    password: 'demo',
    expiresAt: new Date('2026-10-10T08:01:30Z'),
    boundNasId: NAS.id,
    boundClientMac: '01:23:45:67:89:ab',
    ...over,
  };
}

describe('MikroTik CHAP (vendor doc: MD5(chap-id + password + chap-challenge))', () => {
  it('decodes the documented octal-escaped chap-id / chap-challenge', () => {
    expect(decodeMikrotikOctal(DOC_CHAP_ID)?.toString('hex')).toBe('f9');
    expect(decodeMikrotikOctal(DOC_CHAP_CHALLENGE)?.toString('hex')).toBe(DOC_CHALLENGE_HEX);
  });

  it.each([
    ['', 'empty'],
    ['\\400', 'out of byte range'],
    ['\\37', 'short'],
    ['abc', 'plain'],
    ['\\371x', 'trailing'],
  ])('refuses %j (%s)', (value) => {
    expect(decodeMikrotikOctal(value)).toBeNull();
  });

  it('matches fixed RFC 1994-style vectors (id ‖ secret ‖ challenge, lowercase hex)', () => {
    const challenge = Buffer.from(DOC_CHALLENGE_HEX, 'hex');
    expect(computeMikrotikChapPassword(Buffer.from([0xf9]), 'demo', challenge)).toBe(
      'ed92c3cb60d7bfcc640fed522852d78e',
    );
    expect(
      computeMikrotikChapPassword(Buffer.from([1]), 'password', Buffer.from([...Array(16).keys()])),
    ).toBe('51b4c75f261478f67e37e429440e294d');
    // Independent recomputation for an arbitrary input.
    const id = Buffer.from([0x2a]);
    const ch = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    expect(computeMikrotikChapPassword(id, 'Zz9-xY', ch)).toBe(
      createHash('md5')
        .update(Buffer.concat([id, Buffer.from('Zz9-xY'), ch]))
        .digest('hex'),
    );
  });

  it('requires a one-byte id and a non-empty challenge', () => {
    expect(() => computeMikrotikChapPassword(Buffer.from([1, 2]), 'p', Buffer.from([1]))).toThrow();
    expect(() => computeMikrotikChapPassword(Buffer.from([1]), 'p', Buffer.alloc(0))).toThrow();
  });
});

describe('MikroTik login target ($(link-login-only), browser target only)', () => {
  it.each([
    ['http://10.5.50.1/login', 'http://10.5.50.1:80/login', 'http://10.5.50.1:80', false],
    [
      'https://192.168.88.1/login',
      'https://192.168.88.1:443/login',
      'https://192.168.88.1:443',
      true,
    ],
    [
      'http://100.64.0.1:8080/lv/login',
      'http://100.64.0.1:8080/lv/login',
      'http://100.64.0.1:8080',
      false,
    ],
  ])('accepts %s', (raw, url, origin, https) => {
    expect(parseMikrotikLoginTarget(raw)).toEqual({ url, origin, https });
  });

  it.each([
    'http://8.8.8.8/login',
    'http://hotspot.example.net/login',
    'http://10.5.50.1/logout',
    'http://10.5.50.1/login?dst=x',
    'http://user:pw@10.5.50.1/login',
    'ftp://10.5.50.1/login',
    'http://10.5.50.1/a/b/login',
    'javascript:alert(1)',
    'http:\\\\10.5.50.1\\login',
  ])('refuses %s', (raw) => {
    expect(parseMikrotikLoginTarget(raw)).toBeNull();
  });
});

describe('mikrotik-hotspot redirect parsing and validation', () => {
  it('uses only the documented RouterOS variable names, ignores others, reports duplicates', () => {
    expect([...MIKROTIK_REDIRECT_PARAMS]).toEqual([
      'mac',
      'ip',
      'identity',
      'link-login-only',
      'link-orig',
      'chap-id',
      'chap-challenge',
      'error',
    ]);
    const split = splitMikrotikQuery(`${query()}&nasid=x&mac=02:00:00:00:00:01`);
    expect(split.params.nasid).toBeUndefined();
    expect(split.duplicates).toEqual(['mac']);
  });

  it('parses a GET redirect, unsigned, keeping the raw query', () => {
    const q = query();
    const parsed = mt.parseRedirect({ url: `/hotspot/mikrotik/?${q}#frag`, method: 'GET' });
    expect(parsed).toMatchObject({
      vendorKey: 'mikrotik',
      rawQuery: q,
      signature: { kind: 'none', value: null },
    });
    expect(mt.parseRedirect({ url: '/?', method: 'POST' })).toMatchObject({ unsupported: true });
  });

  it('resolves the NAS by router identity (= NAS-Identifier) and builds the context', async () => {
    const seen: unknown[] = [];
    const parsed = mt.parseRedirect({ url: `/?${query()}`, method: 'GET' });
    if ('unsupported' in parsed) throw new Error('parse');
    const v = await mt.validateContext(
      parsed,
      lookup({
        findNas: (q) => {
          seen.push(q);
          return Promise.resolve(NAS);
        },
      }),
    );
    expect(seen).toEqual([{ nasid: 'mt-lobby', called: null, apMac: null }]);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.context).toMatchObject({
      vendorKey: 'mikrotik',
      clientMac: '01:23:45:67:89:ab',
      clientIp: '10.5.50.2',
      apMac: null,
      nasSessionId: null,
    });
    expect(v.context.vendorOpaque.fields['link-login-only']).toBe('http://10.5.50.1:80/login');
    expect(v.context.vendorOpaque.fields['chap-challenge-hex']).toBe(DOC_CHALLENGE_HEX);
  });

  it('replay key = the CHAP challenge (vendor-nonce)', async () => {
    const keys: unknown[] = [];
    const parsed = mt.parseRedirect({ url: `/?${query()}`, method: 'GET' });
    if ('unsupported' in parsed) throw new Error('parse');
    const v = await mt.validateContext(
      parsed,
      lookup({
        isReplay: (k) => {
          keys.push(k);
          return Promise.resolve(true);
        },
      }),
    );
    expect(v).toMatchObject({ ok: false, reason: 'replayed' });
    expect(keys).toEqual([
      {
        nasId: NAS.id,
        sessionId: null,
        challenge: DOC_CHALLENGE_HEX,
        clientMac: '01:23:45:67:89:ab',
        nonceKind: 'vendor-nonce',
      },
    ]);
  });

  it.each([
    [{ mac: null }, 'malformed'],
    [{ identity: null }, 'malformed'],
    [{ mac: 'not-a-mac' }, 'malformed'],
    [{ 'chap-id': null }, 'malformed'],
    [{ 'chap-challenge': '\\001\\002' }, 'malformed'],
    [{ 'link-login-only': 'http://203.0.113.9/login' }, 'private_address_required'],
  ] as const)('refuses %j as %s', async (over, reason) => {
    expect(await context(query(over))).toMatchObject({ ok: false, reason });
  });

  it('fails closed on unknown NAS, other adapter, tenant mismatch', async () => {
    const parsed = mt.parseRedirect({ url: `/?${query()}`, method: 'GET' });
    if ('unsupported' in parsed) throw new Error('parse');
    expect(await mt.validateContext(parsed, lookup({}, null))).toMatchObject({
      reason: 'unknown_nas',
    });
    expect(
      await mt.validateContext(parsed, lookup({}, { ...NAS, adapterKey: 'coovachilli-uam' })),
    ).toMatchObject({ reason: 'unknown_nas' });
    expect(
      await mt.validateContext(
        parsed,
        lookup({ expectedOrganizationId: '44444444-4444-4444-8444-444444444444' }),
      ),
    ).toMatchObject({ reason: 'tenant_mismatch' });
  });
});

describe('review F1: link-login-only is bound to the registered hotspot address', () => {
  it.each([
    ['foreign private host', 'http://10.5.50.66/login'],
    ['foreign https host (PAP target)', 'https://192.168.1.10/login'],
    ['right host, other port when a port is registered', 'http://10.5.50.1:8080/login'],
  ])('refuses a %s', async (_label, target) => {
    const parsed = mt.parseRedirect({
      url: `/?${query({ 'link-login-only': target })}`,
      method: 'GET',
    });
    if ('unsupported' in parsed) throw new Error('parse');
    const v = await mt.validateContext(parsed, lookup({}, { ...NAS, hotspotPort: 80 }));
    expect(v).toMatchObject({ ok: false, reason: 'private_address_required' });
  });

  it('PAP to a foreign https host is refused even without CHAP', async () => {
    const parsed = mt.parseRedirect({
      url: `/?${query({ 'chap-id': null, 'chap-challenge': null, 'link-login-only': 'https://10.9.9.9/login' })}`,
      method: 'GET',
    });
    if ('unsupported' in parsed) throw new Error('parse');
    expect(await mt.validateContext(parsed, lookup())).toMatchObject({
      ok: false,
      reason: 'private_address_required',
    });
  });

  it('fails closed when the NAS has no registered hotspot address', async () => {
    const parsed = mt.parseRedirect({ url: `/?${query()}`, method: 'GET' });
    if ('unsupported' in parsed) throw new Error('parse');
    for (const hotspotAddress of [null, undefined, '8.8.8.8', 'garbage']) {
      expect(
        await mt.validateContext(parsed, lookup({}, { ...NAS, hotspotAddress })),
      ).toMatchObject({ ok: false, reason: 'unknown_nas' });
    }
  });

  it('happy path with a registered port; the hand-off re-checks the server-side binding', async () => {
    const parsed = mt.parseRedirect({ url: `/?${query()}`, method: 'GET' });
    if ('unsupported' in parsed) throw new Error('parse');
    const v = await mt.validateContext(parsed, lookup({}, { ...NAS, hotspotPort: 80 }));
    if (!v.ok) throw new Error(v.detail);
    expect(v.context.vendorOpaque.fields['ecloud:hotspot-address']).toBe('10.5.50.1:80');
    expect(mt.authorizeSession(v.context, credential())).toMatchObject({
      browser: { url: 'http://10.5.50.1:80/login' },
    });
    // A context whose target was swapped after validation is refused at the hand-off.
    const tampered = {
      ...v.context,
      vendorOpaque: {
        ...v.context.vendorOpaque,
        fields: { ...v.context.vendorOpaque.fields, 'link-login-only': 'http://10.5.50.66/login' },
      },
    };
    expect(mt.authorizeSession(tampered, credential())).toMatchObject({ unsupported: true });
    // The binding field can never come from the query (documented names only).
    expect(splitMikrotikQuery('ecloud%3Ahotspot-address=10.9.9.9').params).toEqual({});
  });
});

describe('mikrotik-hotspot hand-off (POST to link-login-only)', () => {
  it('CHAP: password = MD5(chap-id ‖ credential ‖ chap-challenge), documented field names', async () => {
    const v = await context();
    if (!v.ok) throw new Error(v.detail);
    const h = mt.authorizeSession(v.context, credential());
    expect(h).toEqual({
      strategy: 'browser-form',
      browser: {
        method: 'POST-form',
        url: 'http://10.5.50.1:80/login',
        fields: {
          username: 'pc-0123456789abcdef',
          password: 'ed92c3cb60d7bfcc640fed522852d78e', // CHAP test vector of 'demo'. check-no-secrets: allow
          dst: 'https://www.example.com/',
          popup: 'false',
        },
      },
      state: 'pending',
    });
  });

  it('PAP only to an https target; refused over http (no cleartext on the LAN)', async () => {
    const http = await context(query({ 'chap-id': null, 'chap-challenge': null }));
    if (!http.ok) throw new Error(http.detail);
    expect(mt.authorizeSession(http.context, credential())).toMatchObject({ unsupported: true });
    const https = await context(
      query({
        'chap-id': null,
        'chap-challenge': null,
        'link-login-only': 'https://10.5.50.1/login',
      }),
    );
    if (!https.ok) throw new Error(https.detail);
    const h = mt.authorizeSession(https.context, credential());
    expect(h).toMatchObject({
      browser: { url: 'https://10.5.50.1:443/login', fields: { password: 'demo' } },
    });
  });

  it('drops a private / hostile dst and refuses foreign or expired credentials', async () => {
    const v = await context(query({ 'link-orig': 'http://10.5.50.1/' }));
    if (!v.ok) throw new Error(v.detail);
    const h = mt.authorizeSession(v.context, credential());
    if ('unsupported' in h) throw new Error(h.reason);
    expect(h.browser?.fields.dst).toBeUndefined();
    expect(
      mt.authorizeSession(v.context, credential({ boundClientMac: '02:00:00:00:00:01' })),
    ).toMatchObject({ unsupported: true });
    expect(
      mt.authorizeSession(v.context, credential({ expiresAt: new Date('2026-10-10T07:00:00Z') })),
    ).toMatchObject({ unsupported: true });
  });
});

describe('mikrotik-hotspot engine adapter (attribute rendering)', () => {
  const engine = getAdapter('mikrotik-hotspot');
  const blank = Object.fromEntries(
    INTENT_COLUMNS.map((k) => [k, null]),
  ) as unknown as EffectivePolicy['fields'];
  const effective: EffectivePolicy = {
    fields: {
      ...blank,
      download_rate_kbps: 10_000,
      upload_rate_kbps: 2_500,
      session_timeout_s: 3_600,
      idle_timeout_s: 600,
      quota_total_bytes: 6_000_000_000n,
    },
    schedule: null,
    provenance: {},
    winner: null,
    concurrency_mode: null,
    critical_fields: [],
  };
  const ctx = (lab: boolean): TranslationContext => ({
    now: new Date('2026-10-10T08:00:00Z'),
    clip: {
      policy_session_timeout_s: 3_600,
      window_end_s: null,
      validity_end_s: null,
      voucher_end_s: null,
      quota_reset_s: null,
      remaining_octets: 6_000_000_000n,
      remaining_period: 'total',
      drain_time_s: null,
      min_session_s: 300,
    },
    interimIntervalS: 300,
    includeDeviceTestAttributes: lab,
  });

  it('default: nothing device-side is emitted (all REQUIRES_DEVICE_TEST), every field flagged', () => {
    const plan = engine.translate(effective, ctx(false));
    expect(engine.buildReplyAttributes(plan)).toEqual([]);
    const flagged = new Set(plan.unenforceable.map((u) => u.field));
    for (const f of [
      'download_rate_kbps',
      'upload_rate_kbps',
      'session_timeout_s',
      'idle_timeout_s',
      'quota_total_bytes',
    ])
      expect(flagged.has(f as never)).toBe(true);
  });

  it('lab opt-in: Mikrotik-Rate-Limit "rx/tx", Total-Limit + Gigawords, timers, interim — all experimental', () => {
    const plan = engine.translate(effective, ctx(true));
    const attrs = engine.buildReplyAttributes(plan, { includeExperimental: true });
    expect(attrs).toEqual(
      expect.arrayContaining([
        { name: 'Mikrotik-Rate-Limit', value: '2500k/10M', vendor: 'Mikrotik' },
        { name: 'Mikrotik-Total-Limit', value: 6_000_000_000 % 4_294_967_296, vendor: 'Mikrotik' },
        { name: 'Mikrotik-Total-Limit-Gigawords', value: 1, vendor: 'Mikrotik' },
        { name: 'Session-Timeout', value: 3_600 },
        { name: 'Idle-Timeout', value: 600 },
        { name: 'Acct-Interim-Interval', value: 300 },
      ]),
    );
    expect(plan.radiusReplyAttributes.every((a) => a.experimental === true)).toBe(true);
    // Still not device-enforced, and buildReplyAttributes without the opt-in drops them all.
    expect(plan.fieldTable.some((r) => r.deviceEnforced)).toBe(false);
    expect(engine.buildReplyAttributes(plan)).toEqual([]);
  });

  it('declares the MikroTik DAS default port 1700 and the documented CoA-changeable set', () => {
    const caps = engine.capabilities();
    expect(caps.disconnect).toMatchObject({
      target: 'rfc5176-das',
      defaultPort: 1700,
      status: 'REQUIRES_DEVICE_TEST',
    });
    expect(caps.coaChange.changeable).toEqual([
      'Mikrotik-Rate-Limit',
      'Session-Timeout',
      'Idle-Timeout',
    ]);
    const all = [
      ...Object.values(caps.fields).map((f) => f.status),
      ...Object.values(caps.attributes).map((a) => a.status),
      caps.disconnect.status,
      caps.coaChange.status,
    ];
    expect(all).not.toContain('VERIFIED_SUPPORTED');
  });
});

describe('generated artefacts and setup guides', () => {
  it('login.html redirects with $(name-esc) for exactly the documented variables, no script', () => {
    const html = renderMikrotikLoginHtml(`${PORTAL_ORIGIN}/hotspot/mikrotik/`);
    for (const n of MIKROTIK_REDIRECT_PARAMS) expect(html).toContain(`${n}=$(${n}-esc)`);
    expect(html).toContain(
      'https://portal.ezecloud.ezelink.ai/hotspot/mikrotik/?mac=$(mac-esc)&amp;',
    );
    expect(html).not.toMatch(/<script/i);
    expect(() => renderMikrotikLoginHtml('http://portal.example/hotspot/mikrotik/')).toThrow();
  });

  it('MikroTik guide: use-radius, /radius entry, /radius incoming 1700, walled garden, login.html; placeholders only', () => {
    const steps = mt.buildSetupGuide({ siteId: 's', nasId: 'n' });
    const text = steps.map((s) => `${s.setting} ${s.value}`).join('\n');
    expect(text).toContain('use-radius=');
    expect(text).toContain('/radius add service=hotspot');
    expect(text).toContain('/radius incoming set accept=yes port=');
    expect(text).toContain('1700');
    expect(text).toContain('/ip hotspot walled-garden add dst-host=');
    expect(text).toContain('portal.ezecloud.ezelink.ai');
    expect(text).toContain('login.html');
    expect(text).toContain('<RADIUS_SECRET>');
    expect(text).toContain('hotspot_address');
    for (const s of steps) expect(s.evidenceRefs.length).toBeGreaterThan(0);
  });

  it('Teltonika profile rides on coovachilli-uam with its own guide and the V11-overridden row', () => {
    const t = getVendorProfile('teltonika');
    expect(t?.key).toBe('coovachilli-uam');
    expect(t?.vendorKey).toBe('teltonika');
    expect(t?.engine).toBe(getAdapter('coovachilli-uam'));
    const guide = t?.buildSetupGuide({ siteId: 's', nasId: 'nas-1' }) ?? [];
    const text = guide.map((s) => `${s.title} ${s.value}`).join('\n');
    expect(text).toContain('/uam/chilli/');
    expect(text).toContain('3990');
    expect(text).toContain('<UAM_SECRET>');
    expect(text).toContain('REQUIRES_CLARIFICATION');
    const report = t?.discoverCapabilities({});
    expect(report).toMatchObject({
      rowKey: 'teltonika-rutos-hotspot',
      vendorKey: 'teltonika',
      sourceVersionMatchesDevice: false,
    });
    expect(report?.cells.some((c) => c.status === 'VERIFIED_SUPPORTED')).toBe(false);
    expect(getVendorProfile('mikrotik')?.key).toBe('mikrotik-hotspot');
    expect(getVendorProfile('nobody')).toBeNull();
  });

  it('registry rows (validated in registry.test.ts) claim nothing VERIFIED', () => {
    for (const key of ['mikrotik-routeros-hotspot', 'teltonika-rutos-hotspot']) {
      const row = getCompatibilityRow(key);
      expect(row?.lifecycle).toBe('implemented');
      const cells = Object.values(row?.capabilities ?? {}).flat();
      expect(cells.filter((c) => c.status === 'VERIFIED_SUPPORTED')).toEqual([]);
    }
    expect(getCompatibilityRow('mikrotik-routeros-hotspot')?.deploymentModes).toEqual([
      'gateway',
      'native',
    ]);
  });
});
