/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
import { ConfigError } from '@ecloud/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ADAPTER_KEYS } from '@ecloud/policy-engine';
import { NAS_ADAPTER_KEYS, isNasAdapterKey, nasAdapter } from './nas-adapter.js';
import { auditSnapshot } from './audit.js';
import { MfaCodec, newRecoveryCodes } from './auth/mfa.js';
import { API_KEY_RE } from './auth/principal.js';
import { loadApiConfig } from './config.js';
import type { RequestContext } from './context.js';
import {
  Envelope,
  VOUCHER_ALPHABET,
  normalizeVoucherCode,
  openSecretRef,
  randomVoucherCode,
  sealSecretRef,
} from './crypto.js';
import { problemHandler } from './http/errors.js';
import { defineRoute, mountRoute } from './http/route.js';
import {
  PolicyBuilder,
  attr,
  classForSession,
  dictionaryName,
  macFrom,
  sessionIdFromReplyClass,
} from './internal/radius.js';
import { retransmitKey } from './internal/aaa.js';
import { MemoryKv } from './kv.js';
import { unitDeps } from './test-support/deps.js';
import { generate } from 'otplib';

describe('crypto', () => {
  it('envelope round-trips and detects tampering', () => {
    const env = new Envelope('k'.repeat(32), 'purpose-a');
    const sealed = env.encrypt('s3cret');
    expect(sealed).not.toContain('s3cret');
    expect(env.decrypt(sealed)).toBe('s3cret');
    const parts = sealed.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => env.decrypt(parts.join('.'))).toThrow();
    // a different purpose derives a different key
    expect(() => new Envelope('k'.repeat(32), 'purpose-b').decrypt(sealed)).toThrow();
  });

  it('secret_ref uses the enc: scheme', () => {
    const env = new Envelope('k'.repeat(32), 'nas');
    const ref = sealSecretRef(env, 'radius-secret');
    expect(ref.startsWith('enc:v1.')).toBe(true);
    expect(openSecretRef(env, ref)).toBe('radius-secret');
  });

  it('voucher codes use the 32-symbol alphabet without 0/O/1/I', () => {
    const code = randomVoucherCode(200);
    expect([...code].every((c) => VOUCHER_ALPHABET.includes(c))).toBe(true);
    expect(code).not.toMatch(/[01OI]/);
    expect(normalizeVoucherCode('ab-cd ef')).toBe('ABCDEF');
  });
});

describe('MFA', () => {
  it('verifies a current TOTP code and rejects others', async () => {
    const codec = new MfaCodec('m'.repeat(32));
    const secret = codec.newSecret();
    const sealed = codec.seal(secret);
    expect(codec.open(sealed)).toBe(secret);
    const code = await generate({ secret });
    expect(await codec.check(secret, code)).toBe(true);
    expect(await codec.check(secret, code === '000000' ? '111111' : '000000')).toBe(false);
    expect(await codec.check(secret, 'abc')).toBe(false);
    expect(codec.uri(secret, 'a@example.test')).toMatch(/^otpauth:\/\/totp\//);
  });

  it('recovery codes are returned in clear once and stored hashed', () => {
    const { codes, hashes } = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });
});

describe('RADIUS encoding (docs/contracts/aaa-authorize.md)', () => {
  it('Class is ai: + 32 lowercase hex and parses back from the 0x form', () => {
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';
    const cls = classForSession(id);
    expect(cls).toBe('ai:0199aaaabbbb7ccc8dddeeeeffff0000');
    expect(cls).toHaveLength(35);
    const hex = `0x${Buffer.from(cls, 'latin1').toString('hex')}`;
    expect(hex.startsWith('0x61693a')).toBe(true);
    expect(sessionIdFromReplyClass(hex)).toBe(id);
    expect(sessionIdFromReplyClass('0x00')).toBeNull();
  });

  it('every attribute uses the object form with do_xlat:false', () => {
    const policy = new PolicyBuilder()
      .set('control', 'Auth-Type', 'Accept')
      .add('reply', 'Reply-Message', 'Welcome %{User-Name}')
      .add('reply', 'Tunnel-Type', 13)
      .add('reply', 'Tunnel-Type', 13)
      .build();
    expect(policy['control:Auth-Type']).toEqual({ value: ['Accept'], op: ':=', do_xlat: false });
    expect(policy['reply:Reply-Message']?.do_xlat).toBe(false);
    expect(policy['reply:Tunnel-Type']).toEqual({ value: [13, 13], op: '+=', do_xlat: false });
  });

  it('reads first values, normalises MACs and maps CoovaChilli names', () => {
    const body = {
      'User-Name': { type: 'string', value: ['bob'] },
      'ECLOUD-Packet-Src-Port': { type: 'integer', value: [44916] },
    };
    expect(attr(body, 'User-Name')).toBe('bob');
    expect(attr(body, 'ECLOUD-Packet-Src-Port')).toBe('44916');
    expect(attr(body, 'Missing')).toBeUndefined();
    expect(macFrom('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(macFrom('nope')).toBeNull();
    expect(dictionaryName('CoovaChilli-Max-Total-Octets')).toBe('ChilliSpot-Max-Total-Octets');
    expect(dictionaryName('WISPr-Bandwidth-Max-Down')).toBe('WISPr-Bandwidth-Max-Down');
  });

  it('retransmit key depends on the password but never contains it', () => {
    const base = {
      'User-Name': { value: ['u'] },
      'Acct-Session-Id': { value: ['s1'] },
      'ECLOUD-Packet-Src-IP-Address': { value: ['192.0.2.1'] },
    };
    const a = retransmitKey({ ...base, 'User-Password': { value: ['pw-1'] } });
    const b = retransmitKey({ ...base, 'User-Password': { value: ['pw-2'] } });
    expect(a).not.toBe(b);
    expect(a).not.toContain('pw-1');
  });
});

describe('NAS adapter (D-035)', () => {
  it('resolves only the four NAS-facing engine keys, never aliases', () => {
    for (const key of NAS_ADAPTER_KEYS) {
      expect(ADAPTER_KEYS).toContain(key);
      expect(nasAdapter(key)?.key).toBe(key);
    }
    expect(isNasAdapterKey('openwifi-config')).toBe(false);
    expect(nasAdapter('openwifi-config')).toBeNull();
    expect(nasAdapter('coovachilli')).toBeNull();
    expect(nasAdapter('openwifi_ucentral')).toBeNull();
    expect(nasAdapter(null)).toBeNull();
  });
});

describe('API keys', () => {
  it('match eck_<id>_<secret> with a schema-compatible prefix', () => {
    const key = `eck_${'A1b2C3d4E5f6'}_${'x'.repeat(43)}`;
    const m = API_KEY_RE.exec(key);
    expect(m?.[1]).toBe('eck_A1b2C3d4E5f6');
    expect(m?.[1]).toMatch(/^eck_[A-Za-z0-9]{4,32}$/);
    expect(API_KEY_RE.test('eck_short_x')).toBe(false);
  });
});

describe('audit snapshots', () => {
  it('drop secret-bearing keys', () => {
    expect(
      auditSnapshot({
        id: 'x',
        password_hash: 'h',
        secret_ref: 'enc:',
        nested: { key_hash: 'k', ok: 1 },
      }),
    ).toEqual({ id: 'x', nested: { ok: 1 } });
  });
});

describe('config extension', () => {
  it('rejects dev key material in production', () => {
    expect(() =>
      loadApiConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://a:b@db/x',
        DATABASE_URL_PLATFORM: 'postgres://a:b@db/y',
        REDIS_URL: 'redis://r:6379',
        INTERNAL_API_TOKEN: 'p'.repeat(40),
      }),
    ).toThrow(ConfigError);
  });

  it('defaults cookies to non-secure outside production', () => {
    const config = loadApiConfig({ NODE_ENV: 'test' });
    expect(config.session.secureCookie).toBe(false);
    expect(config.session.idleSeconds).toBe(1800);
  });

  it('AAA_SESSION_TIMEOUT_CAP_S: default 1800, 0 disables, 1–299 rejected (P7-A review fix 8)', () => {
    expect(loadApiConfig({ NODE_ENV: 'test' }).aaaSessionTimeoutCapS).toBe(1800);
    expect(
      loadApiConfig({ NODE_ENV: 'test', AAA_SESSION_TIMEOUT_CAP_S: '0' }).aaaSessionTimeoutCapS,
    ).toBe(0);
    expect(
      loadApiConfig({ NODE_ENV: 'test', AAA_SESSION_TIMEOUT_CAP_S: '300' }).aaaSessionTimeoutCapS,
    ).toBe(300);
    for (const bad of ['1', '60', '299', '-1', '86401']) {
      expect(
        () => loadApiConfig({ NODE_ENV: 'test', AAA_SESSION_TIMEOUT_CAP_S: bad }),
        bad,
      ).toThrow(ConfigError);
    }
    expect(loadApiConfig({ NODE_ENV: 'test' }).enforcementMaxSessions).toBe(2000);
  });
});

describe('memory kv', () => {
  it('expires keys and supports NX', async () => {
    let now = 0;
    const kv = new MemoryKv(() => now);
    expect(await kv.set('a', '1', 10, true)).toBe(true);
    expect(await kv.set('a', '2', 10, true)).toBe(false);
    expect(await kv.incr('c', 5)).toBe(1);
    expect(await kv.incr('c', 5)).toBe(2);
    now = 11_000;
    expect(await kv.get('a')).toBeNull();
    expect(await kv.incr('c', 5)).toBe(1);
  });
});

describe('Idempotency-Key', () => {
  function app() {
    const deps = unitDeps();
    let calls = 0;
    const router = express.Router();
    mountRoute(
      router,
      deps,
      defineRoute({
        method: 'post',
        path: '/things',
        summary: 't',
        tags: ['t'],
        auth: 'public',
        body: z.object({ n: z.number() }),
        idempotency: 'required',
        secretFields: ['secret'],
        audit: false,
        responses: { 201: { description: 'ok' } },
        handler: ({ body }) => {
          calls += 1;
          return Promise.resolve({ status: 201, body: { n: body.n, call: calls, secret: 'once' } });
        },
      }),
    );
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      const ctx: RequestContext = {
        requestId: 'r',
        ip: '127.0.0.1',
        userAgent: null,
        principal: null,
        authMethod: null,
        decisions: new Map(),
        audited: false,
      };
      req.ctx = ctx;
      next();
    });
    a.use(router);
    a.use(problemHandler(deps.logger));
    return a;
  }

  it('requires the header, replays the first response without secrets, rejects a changed body', async () => {
    const server = app();
    const missing = await request(server).post('/things').send({ n: 1 });
    expect(missing.status).toBe(428);
    const key = '01900000-0000-7000-8000-000000000001';
    const first = await request(server).post('/things').set('Idempotency-Key', key).send({ n: 1 });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ n: 1, call: 1, secret: 'once' });
    const replay = await request(server).post('/things').set('Idempotency-Key', key).send({ n: 1 });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ n: 1, call: 1 });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.headers['idempotent-redacted']).toBe('secret');
    const changed = await request(server)
      .post('/things')
      .set('Idempotency-Key', key)
      .send({ n: 2 });
    expect(changed.status).toBe(422);
    expect(changed.body.type).toBe('urn:ecloud:problem:idempotency-conflict');
  });
});
