/**
 * Seeds a scratch load-test tenant (P10-B) into an ALREADY MIGRATED scratch database and writes
 * the k6 fixture JSON. Called by scripts/load/run-load.sh; never pointed at a shared database.
 *
 *   LOAD_PLATFORM_URL=postgres://ecloud_platform:...@127.0.0.1:5432/ecloud_loadtest_x \
 *   LOAD_OUT=/tmp/fixture.json npx tsx scripts/load/seed.ts
 *
 * Tenant: one organization, one site, one NAS (`192.0.2.50`, uspot UAM adapter), an active
 * 10/2 Mbit site policy, LOAD_USERS subscribers (Argon2id at the production cost
 * ARGON2_MEMORY_KIB=19456, t=2, p=1), LOAD_VOUCHERS single-use vouchers and LOAD_PORTAL_FLOWS
 * pre-signed UAM redirect queries for the portal scenario.
 */
import { loadApiConfig, sealUamSecret } from '@ecloud/api';
import { createDb, hashPassword } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import { SIM_UAM_SECRET, buildUamRedirect } from '@ecloud/testing';
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const env = process.env;
const platformUrl = env['LOAD_PLATFORM_URL'] ?? '';
const out = env['LOAD_OUT'] ?? '';
if (!/\/ecloud_loadtest_[a-z0-9_]+$/.test(platformUrl)) {
  throw new Error('LOAD_PLATFORM_URL must point at a scratch ecloud_loadtest_* database');
}
if (out === '') throw new Error('LOAD_OUT is required');
const USERS = Number(env['LOAD_USERS'] ?? 500);
const VOUCHERS = Number(env['LOAD_VOUCHERS'] ?? 6000);
const FLOWS = Number(env['LOAD_PORTAL_FLOWS'] ?? 1500);
const PORTAL_ORIGIN = env['LOAD_PORTAL_ORIGIN'] ?? 'http://portal.loadtest';
const NAS_IP = '192.0.2.50';
const NAS_IDENTIFIER = 'load-nas-01';
const PASSWORD = 'load-sub-password-1'; // test fixture, scratch DB only

const config = loadApiConfig({ NODE_ENV: 'development', ARGON2_MEMORY_KIB: '19456' });
const db = createDb(platformUrl, { max: 4, applicationName: 'ecloud-load-seed' });
const hex = (n: number) => randomBytes(n).toString('hex');

try {
  const orgId = newId();
  const siteId = newId();
  await db
    .insertInto('organizations')
    .values({ id: orgId, slug: `load-${hex(4)}`, name: 'Load Org' })
    .execute();
  await db
    .insertInto('sites')
    .values({ id: siteId, organization_id: orgId, slug: 'hall', name: 'Hall', timezone: 'UTC' })
    .execute();
  await db
    .insertInto('nas_clients')
    .values({
      organization_id: orgId,
      site_id: siteId,
      name: 'load-uspot',
      nas_identifier: NAS_IDENTIFIER,
      nas_ip: NAS_IP,
      adapter_type_key: 'openwifi-uspot-uam',
      adapter_key: 'openwifi-uspot-uam',
      secret_ref: 'enc:placeholder',
    })
    .execute();
  await db
    .insertInto('captive_portals')
    .values({
      organization_id: orgId,
      site_id: siteId,
      name: 'Load Wi-Fi',
      public_slug: `load-${hex(4)}`,
      portal_type: 'uspot',
      network_ref: 'guest',
      auth_methods: ['password', 'voucher', 'click_through'],
      uam_secret_ref: sealUamSecret(config.dataEncryptionKey, SIM_UAM_SECRET),
    })
    .execute();
  const policy = await db
    .insertInto('policies')
    .values({
      organization_id: orgId,
      site_id: siteId,
      name: 'Load 10/2 Mbit',
      scope_type: 'site',
      status: 'active',
      download_rate_kbps: 10_000,
      upload_rate_kbps: 2_000,
      session_timeout_s: 3_600,
      idle_timeout_s: 600,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('policy_assignments')
    .values({ organization_id: orgId, policy_id: policy.id, target_type: 'site', site_id: siteId })
    .execute();

  // One real Argon2id hash per user at the production cost (each verify costs the same as prod).
  const users: string[] = [];
  const rows = [];
  for (let i = 0; i < USERS; i += 1) {
    const username = `load-user-${String(i).padStart(5, '0')}`;
    users.push(username);
    rows.push({
      organization_id: orgId,
      username,
      password_hash: await hashPassword(PASSWORD, { memoryKib: config.base.argon2.memoryKib }),
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insertInto('users')
      .values(rows.slice(i, i + 500))
      .execute();
  }

  const batch = await db
    .insertInto('voucher_batches')
    .values({ organization_id: orgId, name: 'load', count: VOUCHERS, site_id: siteId, max_uses: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  const vouchers: string[] = [];
  const vrows = [];
  for (let i = 0; i < VOUCHERS; i += 1) {
    const code = `LV${randomBytes(5).toString('hex').toUpperCase().replace(/[01]/g, '7')}`;
    vouchers.push(code);
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    vrows.push({
      organization_id: orgId,
      batch_id: batch.id,
      code_hash: createHmac('sha256', config.voucherPepper)
        .update(normalized, 'utf8')
        .digest('hex'),
    });
  }
  for (let i = 0; i < vrows.length; i += 1000) {
    await db
      .insertInto('vouchers')
      .values(vrows.slice(i, i + 1000))
      .execute();
  }

  const flows: string[] = [];
  for (let i = 0; i < FLOWS; i += 1) {
    const mac = Array.from(randomBytes(6), (b) =>
      b.toString(16).padStart(2, '0').toUpperCase(),
    ).join('-');
    flows.push(
      buildUamRedirect(
        {
          uamServer: `${PORTAL_ORIGIN}/uam/uspot/`,
          uamSecret: SIM_UAM_SECRET,
          res: 'notyet',
          uamip: '10.1.0.1',
          uamport: '3990',
          challenge: hex(16),
          mac,
          ip: `10.1.${String(Math.floor(i / 250))}.${String((i % 250) + 2)}`,
          called: 'AA-00-00-00-00-01',
          nasid: NAS_IDENTIFIER,
          ssid: 'Guest',
          sessionid: hex(8),
          userurl: 'https://example.com/',
        },
        'uspot-tip',
      ).query,
    );
  }

  writeFileSync(
    out,
    JSON.stringify({
      nasIp: NAS_IP,
      nasIdentifier: NAS_IDENTIFIER,
      password: PASSWORD,
      users,
      vouchers,
      flows,
    }),
    { mode: 0o600 },
  );
  process.stderr.write(
    `seeded org ${orgId}: ${String(USERS)} users, ${String(VOUCHERS)} vouchers, ${String(FLOWS)} portal flows\n`,
  );
} finally {
  await db.destroy();
}
