/**
 * P10-B load-test regression: voucher authorize locks ONLY its voucher row. Before the fix the
 * `SELECT … FROM vouchers JOIN voucher_batches … FOR UPDATE` also locked the shared batch row, so
 * every voucher login of a batch waited for the previous one (p95 > 1 s at 10 voucher logins/s).
 * Here a foreign transaction holds a row lock on the batch (what every in-flight voucher login
 * held before the fix, or an admin editing the batch); authorizing a voucher of that batch must
 * not wait for it.
 */
import { newId } from '@ecloud/shared';
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import { voucherHash } from './routes/vouchers.js';
import {
  TEST_INTERNAL_TOKEN,
  closeDeps,
  createTenant,
  integrationDeps,
} from './test-support/deps.js';

await describeIntegration('@ecloud/api voucher authorize concurrency (P10-B)', () => {
  let deps: AppDeps;
  let internal: ReturnType<typeof createApp>['internalApp'];
  const nasIp = `10.${String(Math.floor(Math.random() * 250) + 2)}.77.${String(Math.floor(Math.random() * 250) + 2)}`;
  const codeA = `CA${randomBytes(4).toString('hex').toUpperCase().replace(/[01]/g, '7')}`;
  const codeB = `CB${randomBytes(4).toString('hex').toUpperCase().replace(/[01]/g, '7')}`;
  let batchId = '';

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
    internal = createApp(deps).internalApp;
    const p = deps.dbPlatform;
    const { orgId, siteId } = await createTenant(p);
    await p
      .insertInto('nas_clients')
      .values({
        organization_id: orgId,
        site_id: siteId,
        name: 'nas-voucher-lock',
        nas_identifier: `vl-${randomBytes(3).toString('hex')}`,
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
        name: 'Voucher lock 5/1 Mbit',
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
    const batch = await p
      .insertInto('voucher_batches')
      .values({ organization_id: orgId, name: 'lock', count: 2, site_id: siteId, max_uses: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rows = await p
      .insertInto('vouchers')
      .values(
        [codeA, codeB].map((code) => ({
          id: newId(),
          organization_id: orgId,
          batch_id: batch.id,
          code_hash: voucherHash(deps.config.voucherPepper, code),
        })),
      )
      .returning('id')
      .execute();
    expect(rows).toHaveLength(2);
    batchId = batch.id;
  }, 60_000);

  afterAll(async () => {
    await sql`UPDATE nas_clients SET deleted_at = now() WHERE nas_ip = ${nasIp}::inet AND deleted_at IS NULL`
      .execute(deps.dbPlatform)
      .catch(() => undefined);
    await closeDeps(deps);
  });

  const authorize = (code: string) =>
    request(internal)
      .post('/internal/aaa/authorize')
      .set('X-Internal-Token', TEST_INTERNAL_TOKEN)
      .send({
        'User-Name': { type: 'string', value: [code] },
        'User-Password': { type: 'string', value: [code] },
        'ECLOUD-Packet-Src-IP-Address': { type: 'string', value: [nasIp] },
        'Calling-Station-Id': {
          type: 'string',
          value: [`02-00-00-${randomBytes(3).toString('hex').match(/../g)?.join('-') ?? ''}`],
        },
        'Acct-Session-Id': { type: 'string', value: [randomBytes(8).toString('hex')] },
      });

  it('a held lock on the voucher batch row does not block a voucher login of that batch', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = deps.dbPlatform.transaction().execute(async (trx) => {
      await sql`SELECT id FROM voucher_batches WHERE id = ${batchId}::uuid FOR UPDATE`.execute(trx);
      locked();
      await held;
    });
    await isLocked;
    // Without the fix the login waits for this lock; release it after 5 s so the test fails fast.
    const safety = setTimeout(() => release(), 5_000);
    try {
      const t0 = Date.now();
      const res = await authorize(codeB);
      const ms = Date.now() - t0;
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(ms).toBeLessThan(3_000);
    } finally {
      clearTimeout(safety);
      release();
      await holder;
    }
  }, 30_000);
});
