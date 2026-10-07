/**
 * Contract test: real FreeRADIUS 3.2.10 (dev-stack container, ECLOUD raddb) <-> stub of the
 * internal AAA API implementing docs/contracts/aaa-authorize.md. Requires
 * `ECLOUD_TEST_RADIUS=1`, docker and a running `freeradius` service; skips cleanly otherwise.
 *
 * The stub listens where the container already points (`ECLOUD_INTERNAL_URL`, dev default
 * host.docker.internal:3001), so the running dev container is used unchanged. Accounting rows
 * are read from radius.radacct_raw of the container's `RADIUS_SQL_DB` via the platform role.
 */
import { randomBytes } from 'node:crypto';
import {
  AAA_AUTHORIZE_PATH,
  AAA_POST_AUTH_PATH,
  AAA_UNAVAILABLE_MESSAGE,
  attributeValue,
  buildAcceptPolicy,
  getTestDatabaseUrl,
  startAaaStub,
  withDatabaseName,
  type AaaStub,
  type AaaStubRequest,
} from '@ecloud/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  containerEnv,
  fixture,
  fixtureAttribute,
  radclient,
  radiusGate,
} from './radius-harness.js';

const gate = radiusGate();
if (
  !gate.ok &&
  process.env['ECLOUD_TEST_RADIUS'] === '1' &&
  process.env['ECLOUD_TEST_REQUIRE_INTEGRATION'] === '1'
) {
  // CI radius-contract job: a missing container must fail, not skip
  throw new Error(`aaa-contract required but unavailable: ${gate.reason}`);
}
const suite = gate.ok ? describe : describe.skip;
const title = gate.ok
  ? 'aaa-contract: FreeRADIUS rlm_rest <-> /internal/aaa (stub)'
  : `aaa-contract: FreeRADIUS rlm_rest <-> /internal/aaa [skipped: ${gate.reason}]`;

/** Explicit URL of the database FreeRADIUS writes accounting to (platform role). */
const RADIUS_DATABASE_URL_ENV = 'ECLOUD_TEST_RADIUS_DATABASE_URL';

function uniqueSessionId(): string {
  return `ct${randomBytes(6).toString('hex')}`;
}

function classFor(): { ascii: string; hex: string } {
  const ascii = `ai:${randomBytes(16).toString('hex')}`;
  return { ascii, hex: `0x${Buffer.from(ascii, 'ascii').toString('hex')}` };
}

function forSession(path: string, sessionId: string) {
  return (r: AaaStubRequest) =>
    r.path === path && attributeValue(r.body, 'Acct-Session-Id') === sessionId;
}

function accessRequest(sessionId: string): { packet: string; password: string } {
  const packet = fixture('access-request-uspot-uam-pap.txt', {
    '<uam-sessionid-placeholder>': sessionId,
  });
  const password = fixtureAttribute(packet, 'User-Password');
  if (password === undefined) throw new Error('fixture has no User-Password');
  return { packet, password };
}

suite(title, () => {
  let stub: AaaStub;
  let radiusDb: pg.Client | undefined;
  let radiusDbReason = '';

  beforeAll(async () => {
    const internalUrl = new URL(
      containerEnv('ECLOUD_INTERNAL_URL') || 'http://host.docker.internal:3001',
    );
    const token = containerEnv('INTERNAL_API_TOKEN');
    expect(token, 'INTERNAL_API_TOKEN in the freeradius container').not.toBe('');
    const host =
      process.env['ECLOUD_TEST_AAA_STUB_HOST'] ??
      (process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1');
    try {
      stub = await startAaaStub({ host, port: Number(internalUrl.port || 80), token });
    } catch (error) {
      throw new Error(
        `cannot bind the AAA stub on ${host}:${internalUrl.port} (${String(error)}); stop the api internal listener while running the contract suite`,
      );
    }

    const explicit = process.env[RADIUS_DATABASE_URL_ENV]?.trim();
    const base = getTestDatabaseUrl();
    const radiusDbName = containerEnv('RADIUS_SQL_DB') || 'ecloud';
    const url = explicit || (base !== undefined ? withDatabaseName(base, radiusDbName) : undefined);
    if (url === undefined) {
      radiusDbReason = `${RADIUS_DATABASE_URL_ENV} / ECLOUD_TEST_DATABASE_URL not set`;
    } else {
      radiusDb = new pg.Client({
        connectionString: url,
        application_name: 'ecloud-test-aaa-contract',
      });
      await radiusDb.connect();
    }
  });

  afterAll(async () => {
    await stub?.close();
    await radiusDb?.end();
  });

  it('T-A1 200 PAP policy -> Access-Accept with the reply attributes; request/post-auth bodies match the contract', async () => {
    const sessionId = uniqueSessionId();
    const { packet, password } = accessRequest(sessionId);
    const cls = classFor();
    stub.setMode({
      kind: 'accept',
      policy: buildAcceptPolicy({
        cleartextPassword: password,
        reply: {
          'Session-Timeout': 3600,
          'Idle-Timeout': 600,
          'Acct-Interim-Interval': 300,
          'WISPr-Bandwidth-Max-Down': 20_000_000,
          'WISPr-Bandwidth-Max-Up': 5_000_000,
          'ChilliSpot-Max-Total-Octets': 2_147_483_648,
          Class: cls.ascii,
          // do_xlat:false must keep this literal (contract §3 rule 1)
          'Reply-Message': 'Welcome %{User-Name}',
        },
      }),
    });

    const reply = await radclient(packet, { type: 'auth' });
    expect(reply.code, reply.output).toBe('Access-Accept');
    expect(reply.attributes['Session-Timeout']).toEqual(['3600']);
    expect(reply.attributes['Idle-Timeout']).toEqual(['600']);
    expect(reply.attributes['Acct-Interim-Interval']).toEqual(['300']);
    expect(reply.attributes['WISPr-Bandwidth-Max-Down']).toEqual(['20000000']);
    expect(reply.attributes['WISPr-Bandwidth-Max-Up']).toEqual(['5000000']);
    expect(reply.attributes['ChilliSpot-Max-Total-Octets']).toEqual(['2147483648']);
    expect(reply.attributes['Class']).toEqual([cls.hex]);
    expect(reply.attributes['Reply-Message']).toEqual(['Welcome %{User-Name}']);

    const authorize = await stub.waitForRequest(forSession(AAA_AUTHORIZE_PATH, sessionId));
    expect(authorize.headers['x-freeradius-section']).toBe('authorize');
    expect(authorize.headers['content-type']).toMatch(/application\/json/);
    expect(authorize.body?.['User-Name']).toEqual({ type: 'string', value: ['pc-PLACEHOLDER'] });
    expect(attributeValue(authorize.body, 'User-Password')).toBe(password);
    expect(attributeValue(authorize.body, 'Calling-Station-Id')).toBe('AA-BB-CC-DD-EE-FF');
    expect(attributeValue(authorize.body, 'Called-Station-Id')).toBe('00-11-22-33-44-55');
    expect(attributeValue(authorize.body, 'Called-Station-SSID')).toBe('lab-uam');
    expect(typeof attributeValue(authorize.body, 'ECLOUD-Packet-Src-IP-Address')).toBe('string');
    expect(attributeValue(authorize.body, 'ECLOUD-Packet-Dst-Port')).toBe(1812);
    expect(attributeValue(authorize.body, 'ECLOUD-Client-Shortname')).toBeDefined();
    expect(authorize.body?.['Message-Authenticator']).toBeDefined();

    const postAuth = await stub.waitForRequest(forSession(AAA_POST_AUTH_PATH, sessionId));
    expect(postAuth.headers['x-freeradius-section']).toBe('post-auth');
    expect(attributeValue(postAuth.body, 'ECLOUD-Auth-Result')).toBe('accept');
    expect(attributeValue(postAuth.body, 'ECLOUD-Decision')).toBe('accept');
    expect(attributeValue(postAuth.body, 'ECLOUD-Reply-Class')).toBe(cls.hex);
    expect(postAuth.body?.['User-Password'], 'credentials stripped from post-auth').toBeUndefined();
  });

  it('200 policy but wrong PAP credential -> Access-Reject without the welcome text', async () => {
    const sessionId = uniqueSessionId();
    const { packet } = accessRequest(sessionId);
    stub.setMode({
      kind: 'accept',
      policy: buildAcceptPolicy({
        cleartextPassword: 'not-the-fixture-password',
        reply: { 'Reply-Message': 'Welcome' },
      }),
    });
    const reply = await radclient(packet, { type: 'auth' });
    expect(reply.code, reply.output).toBe('Access-Reject');
    expect(reply.attributes['Reply-Message'] ?? []).not.toContain('Welcome');
    const postAuth = await stub.waitForRequest(forSession(AAA_POST_AUTH_PATH, sessionId));
    expect(attributeValue(postAuth.body, 'ECLOUD-Auth-Result')).toBe('reject');
    expect(String(attributeValue(postAuth.body, 'Module-Failure-Message'))).toMatch(/pap/i);
  });

  it('401 (+Reply-Message) -> Access-Reject carrying the message; post-auth result reject', async () => {
    const sessionId = uniqueSessionId();
    const { packet } = accessRequest(sessionId);
    stub.setMode({ kind: 'reject', replyMessage: 'quota exhausted' });
    const reply = await radclient(packet, { type: 'auth' });
    expect(reply.code, reply.output).toBe('Access-Reject');
    expect(reply.attributes['Reply-Message']).toEqual(['quota exhausted']);
    const postAuth = await stub.waitForRequest(forSession(AAA_POST_AUTH_PATH, sessionId));
    expect(attributeValue(postAuth.body, 'ECLOUD-Auth-Result')).toBe('reject');
    expect(attributeValue(postAuth.body, 'ECLOUD-Decision')).toBe('reject');
  });

  it('500 -> Access-Reject "AAA backend unavailable" (no fail-open) and no post-auth call', async () => {
    const sessionId = uniqueSessionId();
    const { packet } = accessRequest(sessionId);
    stub.setMode({ kind: 'unavailable', status: 500 });
    const reply = await radclient(packet, { type: 'auth' });
    expect(reply.code, reply.output).toBe('Access-Reject');
    expect(reply.attributes['Reply-Message']).toEqual([AAA_UNAVAILABLE_MESSAGE]);
    await stub.waitForRequest(forSession(AAA_AUTHORIZE_PATH, sessionId));
    await new Promise((r) => setTimeout(r, 500));
    expect(stub.requests.filter(forSession(AAA_POST_AUTH_PATH, sessionId))).toEqual([]);
  });

  it('authorize slower than the 1.5 s budget -> Access-Reject "AAA backend unavailable"', async () => {
    const sessionId = uniqueSessionId();
    const { packet, password } = accessRequest(sessionId);
    stub.setMode({
      kind: 'slow',
      delayMs: 2_500,
      policy: buildAcceptPolicy({ cleartextPassword: password }),
    });
    const reply = await radclient(packet, { type: 'auth', timeoutS: 5 });
    expect(reply.code, reply.output).toBe('Access-Reject');
    expect(reply.attributes['Reply-Message']).toEqual([AAA_UNAVAILABLE_MESSAGE]);
  });

  it('S-04 wrong shared secret -> no reply (silently dropped) and the API is never called', async () => {
    const sessionId = uniqueSessionId();
    const { packet, password } = accessRequest(sessionId);
    stub.setMode({ kind: 'accept', policy: buildAcceptPolicy({ cleartextPassword: password }) });
    const reply = await radclient(packet, {
      type: 'auth',
      secretExpr: "'wrong-shared-secret-for-test'",
      timeoutS: 2,
      retries: 1,
    });
    expect(reply.code, reply.output).toBeUndefined();
    expect(reply.output).toMatch(/No reply from server/i);
    expect(stub.requests.filter(forSession(AAA_AUTHORIZE_PATH, sessionId))).toEqual([]);
  });

  async function sendAccounting(file: string, replacements: Record<string, string>, timeoutS = 3) {
    return radclient(fixture(file, replacements), { type: 'acct', timeoutS });
  }

  function accountingReplacements(): { sessionId: string; replacements: Record<string, string> } {
    const sessionId = uniqueSessionId();
    return {
      sessionId,
      replacements: {
        '<uam-sessionid-placeholder>': sessionId,
        'ai:00000000000000000000000000000000': classFor().ascii,
      },
    };
  }

  it('T-A6 accounting Start/Interim/Stop incl. retransmits -> one radacct_raw row per distinct packet, Gigawords folded', async (ctx) => {
    if (radiusDb === undefined) ctx.skip(radiusDbReason);
    const db = radiusDb as pg.Client;
    const { sessionId, replacements } = accountingReplacements();
    for (const file of ['acct-start.txt', 'acct-interim-update.txt', 'acct-stop.txt']) {
      const reply = await sendAccounting(file, replacements);
      expect(reply.code, `${file}: ${reply.output}`).toBe('Accounting-Response');
      // NAS retransmit of the identical packet: must not create a second row (the reply to
      // the retransmit is asserted separately below)
      await sendAccounting(file, replacements, 1);
    }
    const rows = await db.query<{
      acctstatustype: string;
      acctuniqueid: string;
      acctoutputoctets: string | null;
    }>(
      `SELECT acctstatustype, acctuniqueid, acctoutputoctets::text AS acctoutputoctets
         FROM radius.radacct_raw WHERE acctsessionid = $1 ORDER BY radacctid`,
      [sessionId],
    );
    expect(rows.rows.map((r) => r.acctstatustype)).toEqual(['Start', 'Interim-Update', 'Stop']);
    expect(new Set(rows.rows.map((r) => r.acctuniqueid)).size).toBe(1);
    expect(rows.rows[1]?.acctoutputoctets).toBe(String(2 ** 32 + 123_456_789));
    expect(rows.rows[2]?.acctoutputoctets).toBe(String(2 ** 32 + 987_654_321));
  });

  // A retransmit is collapsed by ON CONFLICT DO NOTHING (rlm_sql noop); sites-enabled/ecloud
  // maps that noop to ok so the NAS still gets its Accounting-Response (RFC 2866 §2).
  it('T-A6: a retransmitted accounting packet is acknowledged', async () => {
    const { replacements } = accountingReplacements();
    const first = await sendAccounting('acct-start.txt', replacements);
    expect(first.code, first.output).toBe('Accounting-Response');
    const retransmit = await sendAccounting('acct-start.txt', replacements, 2);
    expect(retransmit.code, retransmit.output).toBe('Accounting-Response');
  });
});
