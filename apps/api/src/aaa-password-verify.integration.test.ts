/**
 * B-3 regression (docs/PERFORMANCE.md, P10-B): RADIUS password authorize ran the Argon2id verify
 * (~45 ms CPU) inside the tenant transaction, so every login held a pg connection while hashing
 * and the pool saturated at ~17 logins/s (503 after the 5 s pool wait). Now a short tenant
 * transaction reads the credential, the verify runs with no connection held, and the decision
 * transaction re-reads the user and requires the credential unchanged (TOCTOU).
 *
 * The tenant pool here has ONE connection: a verify running inside a transaction would make the
 * probe query in the injected verifier wait for that same connection (and time out).
 */
import { createDb, createPool, hashPassword, verifyPassword } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import { describeIntegration, getTestAppDatabaseUrl, migrateTestDatabase } from '@ecloud/testing';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import { decisionKey } from './internal/aaa.js';
import type { RadiusRequestBody } from './internal/radius.js';
import { AAA_VERIFY_MAX_WAIT_MS, passwordVerifyGate } from './internal/verify-gate.js';
import { voucherHash } from './routes/vouchers.js';
import {
  TEST_INTERNAL_TOKEN,
  closeDeps,
  createTenant,
  integrationDeps,
  unique,
} from './test-support/deps.js';

const PASSWORD = 'b3-subscriber-password';

await describeIntegration('@ecloud/api AAA password verify outside the transaction (B-3)', () => {
  let deps: AppDeps;
  let pool: ReturnType<typeof createPool>;
  let internal: ReturnType<typeof createApp>['internalApp'];
  let orgId = '';
  let siteId = '';
  let hash = '';
  const nasIp = `10.${String(Math.floor(Math.random() * 250) + 2)}.83.${String(Math.floor(Math.random() * 250) + 2)}`;

  /** Calls of the injected verifier and the side effect it runs while "hashing". */
  let verifyCalls = 0;
  let duringVerify: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
    const appUrl = getTestAppDatabaseUrl();
    if (appUrl === undefined) throw new Error('ECLOUD_TEST_DATABASE_URL is required');
    await deps.db.destroy();
    pool = createPool(appUrl, { max: 1, connectionTimeoutMillis: 2_000 });
    deps.db = createDb(pool);
    deps.verifyPassword = async (h, p) => {
      verifyCalls += 1;
      if (duringVerify !== null) await duringVerify();
      return verifyPassword(h, p);
    };
    internal = createApp(deps).internalApp;
    hash = await hashPassword(PASSWORD, { memoryKib: 8192 });

    const p = deps.dbPlatform;
    ({ orgId, siteId } = await createTenant(p));
    await p
      .insertInto('nas_clients')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'nas-b3',
        nas_identifier: `b3-${randomBytes(3).toString('hex')}`,
        nas_ip: nasIp,
        adapter_type_key: 'openwifi-hostapd-radius',
        adapter_key: 'openwifi-hostapd-radius',
        secret_ref: 'enc:placeholder',
      })
      .execute();
    const policy = await p
      .insertInto('policies')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'B3 5/1 Mbit',
        scope_type: 'site',
        status: 'active',
        download_rate_kbps: 5_000,
        upload_rate_kbps: 1_000,
        session_timeout_s: 3_600,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await p
      .insertInto('policy_assignments')
      .values({
        organization_id: orgId,
        policy_id: policy.id,
        target_type: 'site',
        site_id: siteId,
      })
      .execute();
  }, 60_000);

  beforeEach(() => {
    verifyCalls = 0;
    duringVerify = null;
  });

  afterAll(async () => {
    await sql`UPDATE nas_clients SET deleted_at = now() WHERE nas_ip = ${nasIp}::inet AND deleted_at IS NULL`
      .execute(deps.dbPlatform)
      .catch(() => undefined);
    await closeDeps(deps);
  });

  async function newUser(): Promise<{ id: string; username: string }> {
    const id = newId();
    const username = unique('b3');
    await deps.dbPlatform
      .insertInto('users')
      .values({ id, organization_id: orgId, username, password_hash: hash, status: 'active' })
      .execute();
    return { id, username };
  }

  function accessRequest(username: string, password: string): RadiusRequestBody {
    const s = (v: string) => ({ type: 'string', value: [v] });
    return {
      'User-Name': s(username),
      'User-Password': s(password),
      'ECLOUD-Packet-Src-IP-Address': s(nasIp),
      'Calling-Station-Id': s(
        `02-00-00-${randomBytes(3).toString('hex').match(/../g)?.join('-') ?? ''}`,
      ),
      'Acct-Session-Id': s(randomBytes(8).toString('hex')),
    };
  }

  const authorize = (body: RadiusRequestBody, app = internal) =>
    request(app)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send(body);

  async function reasonOf(body: RadiusRequestBody): Promise<string | null> {
    const facts = await deps.kv.get(decisionKey(body));
    return facts === null
      ? null
      : ((JSON.parse(facts) as { reason: string | null }).reason ?? null);
  }

  async function sessionsOf(userId: string): Promise<number> {
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}::uuid
    `.execute(deps.dbPlatform);
    return r.rows[0]?.n ?? 0;
  }

  it('no pg connection is held while Argon2id runs (pool of 1: a concurrent query succeeds)', async () => {
    const user = await newUser();
    let checkedOut = -1;
    let probe = 'not run';
    duringVerify = async () => {
      checkedOut = pool.totalCount - pool.idleCount;
      probe = await sql`SELECT 1`
        .execute(deps.db)
        .then(() => 'ok')
        .catch((error: unknown) => String(error));
    };
    const body = accessRequest(user.username, PASSWORD);
    const res = await authorize(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(verifyCalls).toBe(1);
    expect(checkedOut).toBe(0);
    expect(probe).toBe('ok');
    expect(await sessionsOf(user.id)).toBe(1);
  }, 30_000);

  it('TOCTOU: password changed between verify and decision → reject (credential_changed), no session', async () => {
    const user = await newUser();
    duringVerify = async () => {
      const other = await hashPassword('new-password-after-reset', { memoryKib: 8192 });
      await deps.dbPlatform
        .updateTable('users')
        .set({ password_hash: other })
        .where('id', '=', user.id)
        .execute();
    };
    const body = accessRequest(user.username, PASSWORD);
    const res = await authorize(body);
    expect(res.status).toBe(401);
    expect(await reasonOf(body)).toBe('credential_changed');
    expect(await sessionsOf(user.id)).toBe(0);
  }, 30_000);

  it('TOCTOU: same password re-set (new salt) between verify and decision → still rejected', async () => {
    const user = await newUser();
    duringVerify = async () => {
      const again = await hashPassword(PASSWORD, { memoryKib: 8192 });
      await deps.dbPlatform
        .updateTable('users')
        .set({ password_hash: again })
        .where('id', '=', user.id)
        .execute();
    };
    const body = accessRequest(user.username, PASSWORD);
    expect((await authorize(body)).status).toBe(401);
    expect(await reasonOf(body)).toBe('credential_changed');
  }, 30_000);

  it('TOCTOU: user disabled between verify and decision → reject (user_disabled), no session', async () => {
    const user = await newUser();
    duringVerify = async () => {
      await deps.dbPlatform
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', user.id)
        .execute();
    };
    const body = accessRequest(user.username, PASSWORD);
    expect((await authorize(body)).status).toBe(401);
    expect(await reasonOf(body)).toBe('user_disabled');
    expect(await sessionsOf(user.id)).toBe(0);
  }, 30_000);

  it('TOCTOU: user deleted between verify and decision → reject, no session', async () => {
    const user = await newUser();
    duringVerify = async () => {
      await deps.dbPlatform
        .updateTable('users')
        .set({ deleted_at: new Date() })
        .where('id', '=', user.id)
        .execute();
    };
    const body = accessRequest(user.username, PASSWORD);
    expect((await authorize(body)).status).toBe(401);
    // No live user any more: the request falls to the voucher lookup, as before B-3.
    expect(await reasonOf(body)).toBe('bad_credentials');
    expect(await sessionsOf(user.id)).toBe(0);
  }, 30_000);

  it('TOCTOU: password method removed between verify and decision → reject', async () => {
    const user = await newUser();
    duringVerify = async () => {
      await deps.dbPlatform
        .updateTable('users')
        .set({ auth_methods: ['mac'] })
        .where('id', '=', user.id)
        .execute();
    };
    const body = accessRequest(user.username, PASSWORD);
    expect((await authorize(body)).status).toBe(401);
    expect(await reasonOf(body)).toBe('credential_changed');
  }, 30_000);

  it('timing behaviour as before: wrong password = 1 verify; unknown user / no password method = 0', async () => {
    const user = await newUser();
    const wrong = accessRequest(user.username, 'not-the-password');
    expect((await authorize(wrong)).status).toBe(401);
    expect(await reasonOf(wrong)).toBe('bad_credentials');
    expect(verifyCalls).toBe(1);

    verifyCalls = 0;
    const unknown = accessRequest(unique('nobody'), 'whatever');
    expect((await authorize(unknown)).status).toBe(401);
    expect(await reasonOf(unknown)).toBe('bad_credentials');
    expect(verifyCalls).toBe(0);

    verifyCalls = 0;
    const macOnly = await newUser();
    await deps.dbPlatform
      .updateTable('users')
      .set({ auth_methods: ['mac'] })
      .where('id', '=', macOnly.id)
      .execute();
    const noMethod = accessRequest(macOnly.username, PASSWORD);
    expect((await authorize(noMethod)).status).toBe(401);
    expect(await reasonOf(noMethod)).toBe('bad_credentials');
    expect(verifyCalls).toBe(0);
  }, 30_000);

  it('inactive site: rejected tenant_inactive without any verify', async () => {
    const user = await newUser();
    await deps.dbPlatform
      .updateTable('sites')
      .set({ status: 'suspended' })
      .where('id', '=', siteId)
      .execute();
    try {
      const body = accessRequest(user.username, PASSWORD);
      expect((await authorize(body)).status).toBe(401);
      expect(await reasonOf(body)).toBe('tenant_inactive');
      expect(verifyCalls).toBe(0);
    } finally {
      await deps.dbPlatform
        .updateTable('sites')
        .set({ status: 'active' })
        .where('id', '=', siteId)
        .execute();
    }
  }, 30_000);

  it('site reactivated between pre-read and decision: no verify ran → fail closed', async () => {
    // Pre-read sees the suspended site (no verify); the site is reactivated before the decision
    // transaction, which must not accept a password nobody verified.
    const user = await newUser();
    await deps.dbPlatform
      .updateTable('sites')
      .set({ status: 'suspended' })
      .where('id', '=', siteId)
      .execute();
    let reactivated = false;
    // Reactivate as soon as the pre-read transaction has committed (first tenant transaction).
    const db = new Proxy(deps.db, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
        return () => {
          const builder = target.transaction();
          return {
            execute: async (fn: Parameters<typeof builder.execute>[0]) => {
              const result: unknown = await builder.execute(fn);
              if (!reactivated) {
                reactivated = true;
                await deps.dbPlatform
                  .updateTable('sites')
                  .set({ status: 'active' })
                  .where('id', '=', siteId)
                  .execute();
              }
              return result;
            },
          };
        };
      },
    });
    const racing = createApp({ ...deps, db }).internalApp;
    try {
      const body = accessRequest(user.username, PASSWORD);
      expect((await authorize(body, racing)).status).toBe(401);
      expect(reactivated).toBe(true);
      expect(await reasonOf(body)).toBe('credential_changed');
      expect(verifyCalls).toBe(0);
      expect(await sessionsOf(user.id)).toBe(0);
    } finally {
      await deps.dbPlatform
        .updateTable('sites')
        .set({ status: 'active' })
        .where('id', '=', siteId)
        .execute();
    }
  }, 30_000);

  it('overload: no verify slot within the AAA deadline (1 s, < FreeRADIUS 1.5 s) → fail-closed 503, other paths unaffected', async () => {
    const user = await newUser();
    // A voucher of the same tenant: the cheap path must keep working while the gate is full.
    const code = `VB${randomBytes(4).toString('hex').toUpperCase().replace(/[01]/g, '7')}`;
    const batch = await deps.dbPlatform
      .insertInto('voucher_batches')
      .values({ organization_id: orgId, name: 'b3-gate', count: 1, site_id: siteId, max_uses: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await deps.dbPlatform
      .insertInto('vouchers')
      .values({
        id: newId(),
        organization_id: orgId,
        batch_id: batch.id,
        code_hash: voucherHash(deps.config.voucherPepper, code),
      })
      .execute();

    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const holders = Array.from({ length: passwordVerifyGate.concurrency }, () =>
      passwordVerifyGate.run(() => held),
    );
    try {
      expect(passwordVerifyGate.stats.active).toBe(passwordVerifyGate.concurrency);
      const voucher = await authorize(accessRequest(code, code));
      expect(voucher.status, JSON.stringify(voucher.body)).toBe(200);

      const t0 = Date.now();
      const res = await authorize(accessRequest(user.username, PASSWORD));
      const ms = Date.now() - t0;
      expect(res.status).toBe(503);
      // Answered before FreeRADIUS's ~1.5 s rlm_rest timeout (review B-3 #1).
      expect(ms).toBeGreaterThanOrEqual(AAA_VERIFY_MAX_WAIT_MS - 100);
      expect(ms).toBeLessThan(1_500);
      expect(verifyCalls).toBe(0);
      expect(await sessionsOf(user.id)).toBe(0);
    } finally {
      release();
      await Promise.all(holders);
    }
    // Capacity back: the same login now succeeds.
    expect((await authorize(accessRequest(user.username, PASSWORD))).status).toBe(200);
  }, 30_000);
});
