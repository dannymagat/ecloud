/**
 * P10-B failure drills against the LOCAL dev stack (scripted, repeatable).
 *
 *   npm run build && npx tsx scripts/drills/failure-drills.ts [--only postgres,redis,...]
 *
 * Drills: postgres stop/start, redis stop/start, freeradius restart, api restart, worker restart.
 * For each it asserts the documented behaviour (AAA fail-closed: HTTP 503 / RADIUS Access-Reject,
 * portal error page, readiness 503, worker drains without loss or duplication after recovery,
 * sessions reaped / authorizations expired) and measures the recovery time.
 *
 * Isolation: a scratch database `ecloud_failure_drill_<ts>` (created, migrated and seeded here,
 * DROPPED at the end), Redis logical db 12, and api/portal/worker run as host processes from
 * `dist/` on the dev ports (3000-3003; the dev freeradius container already sends rlm_rest to
 * host.docker.internal:3001). Stopping the shared postgres/redis/freeradius containers is brief;
 * every one is started again and confirmed healthy before the script exits (also on failure).
 * Prints a JSON report on stdout; progress on stderr. Exit 1 when any assertion failed.
 */
import { createDb, hashPassword, type Db } from '@ecloud/db';
import { loadApiConfig, sealUamSecret } from '@ecloud/api';
import { newId } from '@ecloud/shared';
import { SIM_UAM_SECRET, buildUamRedirect } from '@ecloud/testing';
import { sql } from 'kysely';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { radclient } from '../../tests/aaa-contract/radius-harness.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PG = 'ecloud-dev-postgres';
const REDIS = 'ecloud-dev-redis';
const FR = 'ecloud-dev-freeradius';
const PG_PORT = process.env['POSTGRES_PORT'] ?? '5432';
const DEV_PW = process.env['ECLOUD_PLATFORM_PASSWORD'] ?? 'ecloud_dev_password'; // DEV ONLY default
const APP_PW = process.env['ECLOUD_APP_PASSWORD'] ?? 'ecloud_dev_password'; // DEV ONLY default
const STAMP = new Date()
  .toISOString()
  .replace(/[-:TZ.]/g, '')
  .slice(0, 14);
const SCRATCH = `ecloud_failure_drill_${STAMP}`;
const REDIS_URL = `redis://127.0.0.1:${process.env['REDIS_PORT'] ?? '6379'}/12`;
const PLATFORM_URL = `postgres://ecloud_platform:${DEV_PW}@127.0.0.1:${PG_PORT}/${SCRATCH}`;
const APP_URL = `postgres://ecloud_app:${APP_PW}@127.0.0.1:${PG_PORT}/${SCRATCH}`;
const PORTAL_ORIGIN = 'http://localhost:3002';
const SUB_PASSWORD = 'drill-sub-password-1'; // scratch-DB fixture only; check-no-secrets: allow
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? new Set((process.argv[i + 1] ?? '').split(',')) : null;
})();

const LOGDIR = mkdtempSync(join(tmpdir(), 'ecloud-failure-drills-'));
const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} [drill] ${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------- helpers
function run(cmd: string, args: string[], input?: string, timeoutMs = 60_000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, timeout: timeoutMs, cwd: ROOT });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function psqlAdmin(db: string, statement: string): string {
  const r = run('docker', [
    'exec',
    '-i',
    PG,
    'psql',
    '-X',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'ecloud',
    '-d',
    db,
    '-c',
    statement,
  ]);
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim();
}

function health(container: string): string {
  return run('docker', ['inspect', '-f', '{{.State.Health.Status}}', container]).stdout.trim();
}

async function waitHealthy(container: string, timeoutMs = 120_000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (health(container) === 'healthy') return Date.now() - t0;
    await sleep(500);
  }
  throw new Error(`${container} not healthy after ${String(timeoutMs)} ms`);
}

async function httpStatus(url: string, init: RequestInit = {}, timeoutMs = 8_000) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return {
      status: res.status,
      ms: Math.round(performance.now() - t0),
      text,
      headers: res.headers,
    };
  } catch (error) {
    return {
      status: 0,
      ms: Math.round(performance.now() - t0),
      text: (error as Error).message,
      headers: new Headers(),
    };
  }
}

async function waitFor<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  everyMs = 250,
): Promise<{ ok: boolean; ms: number; last: T }> {
  const t0 = Date.now();
  let last = await fn();
  while (!ok(last)) {
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, last };
    await sleep(everyMs);
    last = await fn();
  }
  return { ok: true, ms: Date.now() - t0, last };
}

// ------------------------------------------------------------------------------- processes
interface Proc {
  name: string;
  script: string;
  env: NodeJS.ProcessEnv;
  probe: string;
  child?: ChildProcess;
}

const internalToken =
  run('docker', ['exec', FR, 'printenv', 'INTERNAL_API_TOKEN']).stdout.trim() ||
  'ecloud_dev_internal_token_change_me';

const baseEnv: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'],
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  DATABASE_URL: APP_URL,
  DATABASE_URL_PLATFORM: PLATFORM_URL,
  REDIS_URL,
  INTERNAL_API_TOKEN: internalToken,
  PUBLIC_PORTAL_ORIGIN: PORTAL_ORIGIN,
  API_PORT: '3000',
  INTERNAL_PORT: '3001',
  PORTAL_PORT: '3002',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_PATH: join(LOGDIR, 'storage'),
};

const procs: Record<'api' | 'portal' | 'worker', Proc> = {
  api: {
    name: 'api',
    script: 'apps/api/dist/main.js',
    env: baseEnv,
    probe: 'http://127.0.0.1:3000/healthz',
  },
  portal: {
    name: 'portal',
    script: 'apps/portal/dist/main.js',
    env: {
      ...baseEnv,
      PORTAL_INTERNAL_API_URL: 'http://127.0.0.1:3001',
      PORTAL_METRICS_PORT: '3005',
    },
    probe: 'http://127.0.0.1:3002/healthz',
  },
  worker: {
    name: 'worker',
    script: 'apps/worker/dist/main.js',
    env: {
      ...baseEnv,
      WORKER_HEALTH_PORT: '3003',
      WORKER_AUTHORIZATION_TTL_S: '30',
      ECLOUD_COA_ENABLED: 'false',
      RETENTION_APPLY: 'false',
    },
    probe: 'http://127.0.0.1:3003/metrics',
  },
};

async function startProc(p: Proc): Promise<number> {
  const t0 = Date.now();
  const out = createWriteStream(join(LOGDIR, `${p.name}.log`), { flags: 'a' });
  const child = spawn(process.execPath, [p.script], {
    cwd: ROOT,
    env: p.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  p.child = child;
  const up = await waitFor(
    () => httpStatus(p.probe, {}, 1_000),
    (r) => r.status > 0,
    30_000,
    200,
  );
  if (!up.ok) throw new Error(`${p.name} did not start (log: ${join(LOGDIR, `${p.name}.log`)})`);
  return Date.now() - t0;
}

async function stopProc(p: Proc, signal: NodeJS.Signals = 'SIGTERM'): Promise<number> {
  const child = p.child;
  if (child === undefined || child.exitCode !== null) return 0;
  const t0 = Date.now();
  await new Promise<void>((resolveStop) => {
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolveStop();
    });
    child.kill(signal);
  });
  p.child = undefined;
  return Date.now() - t0;
}

// -------------------------------------------------------------------------------- fixture
const f = {
  orgId: newId(),
  siteId: newId(),
  nasIp: '',
  nasId: '',
  nasIdentifier: `drill-nas-${randomBytes(3).toString('hex')}`,
  username: `drill-${randomBytes(3).toString('hex')}`,
};
let db!: Db;

async function seed(): Promise<void> {
  const ip = run('docker', ['exec', FR, 'hostname', '-i']).stdout.trim().split(/\s+/)[0] ?? '';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip))
    throw new Error('cannot read the freeradius container address');
  f.nasIp = ip;
  db = createDb(PLATFORM_URL, {
    max: 4,
    applicationName: 'ecloud-failure-drill',
    onIdleError: () => undefined,
  });
  const config = loadApiConfig({ ...baseEnv });
  await db
    .insertInto('organizations')
    .values({ id: f.orgId, slug: `drill-${STAMP}`, name: 'Drill Org' })
    .execute();
  await db
    .insertInto('sites')
    .values({
      id: f.siteId,
      organization_id: f.orgId,
      slug: 'lobby',
      name: 'Lobby',
      timezone: 'UTC',
    })
    .execute();
  const nas = await db
    .insertInto('nas_clients')
    .values({
      organization_id: f.orgId,
      site_id: f.siteId,
      name: 'drill-uspot',
      nas_identifier: f.nasIdentifier,
      nas_ip: f.nasIp,
      adapter_type_key: 'openwifi-uspot-uam',
      adapter_key: 'openwifi-uspot-uam',
      secret_ref: 'enc:placeholder',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  f.nasId = nas.id;
  await db
    .insertInto('captive_portals')
    .values({
      organization_id: f.orgId,
      site_id: f.siteId,
      name: 'Drill Wi-Fi',
      public_slug: `drill-${STAMP}`,
      portal_type: 'uspot',
      network_ref: 'guest',
      auth_methods: ['password', 'voucher', 'click_through'],
      uam_secret_ref: sealUamSecret(config.dataEncryptionKey, SIM_UAM_SECRET),
    })
    .execute();
  await db
    .insertInto('users')
    .values({
      organization_id: f.orgId,
      username: f.username,
      password_hash: await hashPassword(SUB_PASSWORD, { memoryKib: config.base.argon2.memoryKib }),
    })
    .execute();
  const policy = await db
    .insertInto('policies')
    .values({
      organization_id: f.orgId,
      site_id: f.siteId,
      name: 'Drill 10/2 Mbit',
      scope_type: 'site',
      status: 'active',
      download_rate_kbps: 10_000,
      upload_rate_kbps: 2_000,
      session_timeout_s: 3_600,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('policy_assignments')
    .values({
      organization_id: f.orgId,
      policy_id: policy.id,
      target_type: 'site',
      site_id: f.siteId,
    })
    .execute();
}

// ---------------------------------------------------------------------------------- probes
const mac = () =>
  Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('-');

function radiusBody(acctSessionId = randomBytes(8).toString('hex')) {
  const a = (v: string) => ({ type: 'string', value: [v] });
  return {
    'User-Name': a(f.username),
    'User-Password': a(SUB_PASSWORD),
    'ECLOUD-Packet-Src-IP-Address': a(f.nasIp),
    'Calling-Station-Id': a(mac()),
    'Acct-Session-Id': a(acctSessionId),
    'NAS-Identifier': a(f.nasIdentifier),
  };
}

async function authorizeHttp() {
  return httpStatus('http://127.0.0.1:3001/internal/aaa/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': internalToken },
    body: JSON.stringify(radiusBody()),
  });
}

async function radiusAuth(): Promise<{ code: string; ms: number }> {
  const t0 = performance.now();
  const packet = [
    `User-Name = "${f.username}"`,
    `User-Password = "${SUB_PASSWORD}"`,
    `Acct-Session-Id = "${randomBytes(8).toString('hex')}"`,
    `Calling-Station-Id = "${mac()}"`,
    'Called-Station-Id = "AA-00-00-00-00-01:Guest"',
    `NAS-Identifier = "${f.nasIdentifier}"`,
    `NAS-IP-Address = ${f.nasIp}`,
    'NAS-Port-Type = Wireless-802.11',
    'Message-Authenticator = 0x00',
    '',
  ].join('\n');
  try {
    const reply = await radclient(packet, { type: 'auth', timeoutS: 3, retries: 1 });
    return { code: reply.code ?? 'no-reply', ms: Math.round(performance.now() - t0) };
  } catch {
    return { code: 'no-reply', ms: Math.round(performance.now() - t0) };
  }
}

async function portalEntry() {
  const d = {
    mac: mac(),
    sessionid: randomBytes(8).toString('hex'),
    challenge: randomBytes(16).toString('hex'),
  };
  const r = buildUamRedirect(
    {
      uamServer: `${PORTAL_ORIGIN}/uam/uspot/`,
      uamSecret: SIM_UAM_SECRET,
      res: 'notyet',
      uamip: '10.1.0.1',
      uamport: '3990',
      challenge: d.challenge,
      mac: d.mac,
      ip: '10.1.0.50',
      called: 'AA-00-00-00-00-01',
      nasid: f.nasIdentifier,
      ssid: 'Guest',
      sessionid: d.sessionid,
      userurl: 'https://example.com/',
    },
    'uspot-tip',
  );
  return httpStatus(`http://127.0.0.1:3002/uam/uspot/?${r.query}`);
}

/** Full portal password login: entry → form → POST → expect 302 hand-off to the NAS. */
async function portalLogin(): Promise<{ status: number; location: string }> {
  const entry = await portalEntry();
  if (entry.status !== 303) return { status: entry.status, location: '' };
  const flow = entry.headers.get('location') ?? '';
  const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const form = await httpStatus(`http://127.0.0.1:3002${flow}/login`, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(form.text)?.[1] ?? '';
  const post = await httpStatus(`http://127.0.0.1:3002${flow}/login`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, username: f.username, password: SUB_PASSWORD }).toString(),
  });
  return { status: post.status, location: post.headers.get('location') ?? '' };
}

const readyz = () => httpStatus('http://127.0.0.1:3000/readyz');
const workerHealth = () => httpStatus('http://127.0.0.1:3003/healthz');

// ------------------------------------------------------------------------------ accounting
let rawSeq = 0;
async function insertRaw(
  n: number,
  opts: { ageS?: number; session?: string } = {},
): Promise<string[]> {
  const ids: string[] = [];
  const rows = Array.from({ length: n }, () => {
    rawSeq += 1;
    const session = opts.session ?? `drill-acct-${STAMP}-${String(rawSeq)}`;
    ids.push(session);
    const at = new Date(Date.now() - (opts.ageS ?? 0) * 1000);
    return {
      acctsessionid: session,
      acctuniqueid: `uniq-${session}`,
      username: f.username,
      nasipaddress: f.nasIp,
      nasidentifier: f.nasIdentifier,
      acctstatustype: 'Start',
      acctstarttime: at,
      acctsessiontime: 0,
      acctinputoctets: 0,
      acctoutputoctets: 0,
      callingstationid: mac(),
      calledstationid: 'AA-00-00-00-00-01:Guest',
      framedipaddress: '10.1.0.50',
      acctdelaytime: 0,
      eventtimestamp: at,
      received_at: at,
      packet_src_ip: f.nasIp,
    };
  });
  await db
    .insertInto('radius.radacct_raw')
    .values(rows as never)
    .execute();
  return ids;
}

async function drillAccounting(): Promise<{ raw: number; records: number; distinctRaw: number }> {
  const r = await sql<{ raw: string; records: string; distinct_raw: string }>`
    SELECT (SELECT count(*) FROM radius.radacct_raw WHERE acctsessionid LIKE ${`drill-acct-${STAMP}-%`}) AS raw,
           count(*) AS records,
           count(DISTINCT raw->>'radacctid') AS distinct_raw
      FROM accounting_records WHERE acct_session_id LIKE ${`drill-acct-${STAMP}-%`}`.execute(db);
  const row = r.rows[0];
  return {
    raw: Number(row?.raw),
    records: Number(row?.records),
    distinctRaw: Number(row?.distinct_raw),
  };
}

async function waitDrained(timeoutMs: number) {
  return waitFor(
    () => drillAccounting().catch(() => ({ raw: -1, records: -2, distinctRaw: -3 })),
    (a) => a.raw > 0 && a.records === a.raw,
    timeoutMs,
    500,
  );
}

// ---------------------------------------------------------------------------------- drills
interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean;
}
interface DrillResult {
  drill: string;
  checks: Check[];
  timings: Record<string, number>;
}
const results: DrillResult[] = [];
function check(r: DrillResult, name: string, expected: string, observed: string, pass: boolean) {
  r.checks.push({ name, expected, observed, pass });
  log(`${pass ? 'PASS' : 'FAIL'} ${r.drill}: ${name} (expected ${expected}, observed ${observed})`);
}

async function outageChecks(
  r: DrillResult,
  opts: { aaaHttp: boolean; portal: boolean; readyz: boolean; worker: boolean },
) {
  if (opts.aaaHttp) {
    const a = await authorizeHttp();
    check(
      r,
      'authorize HTTP fails closed',
      '503 (no Auth-Type)',
      `${String(a.status)} in ${String(a.ms)} ms`,
      a.status === 503 && !a.text.includes('Auth-Type'),
    );
    r.timings['authorize_503_ms'] = a.ms;
  }
  const rad = await radiusAuth();
  check(
    r,
    'RADIUS through FreeRADIUS',
    'Access-Reject (never Accept)',
    `${rad.code} in ${String(rad.ms)} ms`,
    rad.code === 'Access-Reject',
  );
  if (opts.portal) {
    const p = await portalEntry();
    check(
      r,
      'portal UAM entry',
      '503 error page',
      `${String(p.status)}${p.text.includes('<html') ? ' html' : ''}`,
      p.status === 503 && p.text.includes('<html'),
    );
  }
  if (opts.readyz) {
    const ry = await readyz();
    check(r, 'api /readyz', '503', String(ry.status), ry.status === 503);
  }
  if (opts.worker) {
    const w = await workerHealth();
    check(r, 'worker /healthz', '503 degraded', String(w.status), w.status === 503);
  }
}

async function recoveryChecks(r: DrillResult, t0: number) {
  const auth = await waitFor(authorizeHttp, (a) => a.status === 200, 60_000);
  r.timings['authorize_recovered_ms'] = Date.now() - t0;
  check(
    r,
    'authorize recovers',
    '200',
    `${String(auth.last.status)} after ${String(Date.now() - t0)} ms`,
    auth.ok,
  );
  const rad = await waitFor(radiusAuth, (x) => x.code === 'Access-Accept', 60_000, 1_000);
  check(r, 'RADIUS recovers', 'Access-Accept', rad.last.code, rad.ok);
  const portal = await waitFor(portalEntry, (p) => p.status === 303, 30_000);
  check(r, 'portal recovers', '303 to flow', String(portal.last.status), portal.ok);
  const w = await waitFor(workerHealth, (x) => x.status === 200, 60_000, 500);
  check(r, 'worker /healthz recovers', '200', String(w.last.status), w.ok);
}

async function drillPostgres(): Promise<void> {
  const r: DrillResult = { drill: 'postgres stop/start', checks: [], timings: {} };
  results.push(r);
  const s0 = Date.now();
  run('docker', ['stop', PG], undefined, 60_000);
  r.timings['stop_ms'] = Date.now() - s0;
  await outageChecks(r, { aaaHttp: true, portal: true, readyz: true, worker: true });
  const t0 = Date.now();
  run('docker', ['start', PG]);
  r.timings['container_healthy_ms'] = await waitHealthy(PG);
  await recoveryChecks(r, t0);
  r.timings['downtime_total_ms'] = Date.now() - s0;
}

async function drillRedis(): Promise<void> {
  const r: DrillResult = { drill: 'redis stop/start', checks: [], timings: {} };
  results.push(r);
  const before = await drillAccounting();
  const s0 = Date.now();
  run('docker', ['stop', REDIS], undefined, 60_000);
  r.timings['stop_ms'] = Date.now() - s0;
  await outageChecks(r, { aaaHttp: true, portal: true, readyz: true, worker: true });
  const t0 = Date.now();
  run('docker', ['start', REDIS]);
  r.timings['container_healthy_ms'] = await waitHealthy(REDIS);
  await recoveryChecks(r, t0);
  r.timings['downtime_total_ms'] = Date.now() - s0;
  // Redis has no persistence in dev/pilot: schedulers and the drain cursor are gone. The worker
  // must re-register its schedulers and the drain must rescan without duplicating records.
  const metrics = await waitFor(
    () => httpStatus('http://127.0.0.1:3003/metrics'),
    (m) =>
      Number(/^ecloud_worker_scheduler_registrations_total (\d+)/m.exec(m.text)?.[1] ?? 0) >= 2,
    30_000,
    500,
  );
  const regs =
    /^ecloud_worker_scheduler_registrations_total (\d+)/m.exec(metrics.last.text)?.[1] ?? '?';
  check(
    r,
    'worker re-registers schedulers after Redis data loss',
    '>= 2 registrations',
    regs,
    metrics.ok,
  );
  await insertRaw(20);
  const drained = await waitDrained(60_000);
  check(
    r,
    'drain resumes after cursor loss without duplicates',
    'records == raw rows, distinct radacctid == records',
    `raw ${String(drained.last.raw)} (before ${String(before.raw)}), records ${String(drained.last.records)}, distinct ${String(drained.last.distinctRaw)}`,
    drained.ok && drained.last.distinctRaw === drained.last.records,
  );
  r.timings['drain_after_recovery_ms'] = drained.ms;
}

async function drillFreeradius(): Promise<void> {
  const r: DrillResult = { drill: 'freeradius restart', checks: [], timings: {} };
  results.push(r);
  const s0 = Date.now();
  const restart = spawn('docker', ['restart', FR], { stdio: 'ignore' });
  await sleep(300);
  const during = await radiusAuth();
  check(
    r,
    'RADIUS during restart',
    'no Access-Accept (no reply / reject: NAS fails closed)',
    during.code,
    during.code !== 'Access-Accept',
  );
  await new Promise((res) => restart.once('exit', res));
  r.timings['restart_cmd_ms'] = Date.now() - s0;
  r.timings['container_healthy_ms'] = await waitHealthy(FR);
  const rad = await waitFor(radiusAuth, (x) => x.code === 'Access-Accept', 60_000, 1_000);
  r.timings['radius_recovered_ms'] = Date.now() - s0;
  check(r, 'RADIUS recovers', 'Access-Accept', rad.last.code, rad.ok);
  const a = await authorizeHttp();
  check(r, 'api unaffected', '200', String(a.status), a.status === 200);
}

async function drillApi(): Promise<void> {
  const r: DrillResult = { drill: 'api restart', checks: [], timings: {} };
  results.push(r);
  // In-flight requests at SIGTERM finish (graceful drain).
  const inflight = Array.from({ length: 5 }, () => authorizeHttp());
  await sleep(20);
  const s0 = Date.now();
  r.timings['graceful_stop_ms'] = await stopProc(procs.api, 'SIGTERM');
  const settled = await Promise.all(inflight);
  const codes = settled.map((x) => x.status);
  check(
    r,
    'in-flight authorize requests at SIGTERM',
    'all 200 (drained) or refused before accept (0); never 5xx',
    codes.join(','),
    codes.every((c) => c === 200 || c === 0),
  );
  await outageChecks(r, { aaaHttp: false, portal: true, readyz: false, worker: false });
  const t0 = Date.now();
  r.timings['start_ms'] = await startProc(procs.api);
  await recoveryChecks(r, t0);
  r.timings['downtime_total_ms'] = Date.now() - s0;
}

async function drillWorker(): Promise<void> {
  const r: DrillResult = { drill: 'worker restart', checks: [], timings: {} };
  results.push(r);
  // Stale session (last sign of life 2 h ago) that the reaper must close after the restart.
  const [staleSession] = await insertRaw(1, { ageS: 7_200 });
  const batchA = await insertRaw(150);
  const a = await waitDrained(60_000);
  check(
    r,
    'batch A drained before crash',
    'records == raw',
    `${String(a.last.records)}/${String(a.last.raw)}`,
    a.ok,
  );
  // An authorization without accounting, to be expired (WORKER_AUTHORIZATION_TTL_S=30).
  const auth = await authorizeHttp();
  const sessionHex = /"ai:([0-9a-f]{32})"/.exec(auth.text)?.[1] ?? '';
  const authorizedId = sessionHex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  await insertRaw(150); // batch B: inserted, then the worker is killed hard before draining it
  const s0 = Date.now();
  await stopProc(procs.worker, 'SIGKILL');
  r.timings['kill_ms'] = Date.now() - s0;
  await insertRaw(150); // batch C: arrives while the worker is down
  const down = await drillAccounting();
  check(
    r,
    'rows pending while worker is down',
    'records < raw',
    `${String(down.records)}/${String(down.raw)}`,
    down.records < down.raw,
  );
  const authDown = await authorizeHttp();
  check(
    r,
    'AAA independent of the worker',
    '200',
    String(authDown.status),
    authDown.status === 200,
  );
  const t0 = Date.now();
  r.timings['start_ms'] = await startProc(procs.worker);
  const drained = await waitDrained(90_000);
  r.timings['drain_after_restart_ms'] = Date.now() - t0;
  check(
    r,
    'no loss / no duplication after hard kill',
    'records == raw rows (450+), distinct radacctid == records',
    `raw ${String(drained.last.raw)}, records ${String(drained.last.records)}, distinct ${String(drained.last.distinctRaw)}`,
    drained.ok && drained.last.distinctRaw === drained.last.records,
  );
  const reaped = await waitFor(
    async () =>
      (
        await sql<{
          status: string;
          terminate_cause: string | null;
        }>`SELECT status, terminate_cause FROM sessions WHERE acct_session_id = ${staleSession ?? ''}`.execute(
          db,
        )
      ).rows[0],
    (s) => s?.status === 'stopped',
    90_000,
    1_000,
  );
  check(
    r,
    'stale session reaped',
    'stopped / lost_interim',
    `${String(reaped.last?.status)} / ${String(reaped.last?.terminate_cause)}`,
    reaped.ok && reaped.last?.terminate_cause === 'lost_interim',
  );
  r.timings['reaped_after_restart_ms'] = Date.now() - t0;
  if (authorizedId !== '') {
    const expired = await waitFor(
      async () =>
        (
          await sql<{
            status: string;
          }>`SELECT status FROM sessions WHERE id = ${authorizedId}::uuid`.execute(db)
        ).rows[0]?.status,
      (s) => s === 'expired',
      120_000,
      2_000,
    );
    check(
      r,
      'authorization without accounting expires',
      'expired (TTL 30 s)',
      String(expired.last),
      expired.ok,
    );
  }
  void batchA;
}

// ------------------------------------------------------------------------------------ main
async function ensureStackHealthy(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of [PG, REDIS, FR]) {
    if (health(c) !== 'healthy') {
      run('docker', ['start', c]);
      try {
        await waitHealthy(c);
      } catch {
        /* reported below */
      }
    }
    out[c] = health(c);
  }
  return out;
}

async function main(): Promise<number> {
  for (const port of [3000, 3001, 3002, 3003, 3005]) {
    const busy = await httpStatus(`http://127.0.0.1:${String(port)}/`, {}, 500);
    if (busy.status !== 0)
      throw new Error(`port ${String(port)} is in use; stop the local dev processes first`);
  }
  const pre = await ensureStackHealthy();
  if (Object.values(pre).some((s) => s !== 'healthy'))
    throw new Error(`dev stack not healthy: ${JSON.stringify(pre)}`);
  log(`scratch database ${SCRATCH}, redis db 12, logs in ${LOGDIR}`);
  psqlAdmin('postgres', `CREATE DATABASE "${SCRATCH}" OWNER ecloud_platform`);
  const mig = run(
    process.execPath,
    ['packages/db/dist/cli.js', 'migrate', '--url', PLATFORM_URL],
    undefined,
    180_000,
  );
  if (mig.status !== 0) throw new Error(`migrate failed: ${mig.stderr || mig.stdout}`);
  const seedCatalogue = run(
    process.execPath,
    ['packages/db/dist/cli.js', 'seed', '--url', PLATFORM_URL],
    undefined,
    180_000,
  );
  if (seedCatalogue.status !== 0)
    throw new Error(`seed failed: ${seedCatalogue.stderr || seedCatalogue.stdout}`);
  run('docker', ['exec', REDIS, 'redis-cli', '-n', '12', 'FLUSHDB']);
  await seed();
  const startup: Record<string, number> = {};
  for (const p of [procs.api, procs.portal, procs.worker]) startup[p.name] = await startProc(p);

  const baseline: DrillResult = { drill: 'baseline', checks: [], timings: startup };
  results.push(baseline);
  const a = await authorizeHttp();
  check(
    baseline,
    'authorize HTTP',
    '200 Accept',
    `${String(a.status)} in ${String(a.ms)} ms`,
    a.status === 200 && a.text.includes('Auth-Type'),
  );
  const rad = await radiusAuth();
  check(
    baseline,
    'RADIUS through FreeRADIUS',
    'Access-Accept',
    rad.code,
    rad.code === 'Access-Accept',
  );
  const login = await portalLogin();
  check(
    baseline,
    'portal password login',
    '302 hand-off to http://10.1.0.1:3990/logon',
    `${String(login.status)} ${login.location.split('?')[0] ?? ''}`,
    login.status === 302 && login.location.startsWith('http://10.1.0.1:3990/logon'),
  );
  const ry = await readyz();
  check(baseline, 'api /readyz', '200', String(ry.status), ry.status === 200);

  const drills: Array<[string, () => Promise<void>]> = [
    ['postgres', drillPostgres],
    ['redis', drillRedis],
    ['freeradius', drillFreeradius],
    ['api', drillApi],
    ['worker', drillWorker],
  ];
  for (const [name, fn] of drills) {
    if (only !== null && !only.has(name)) continue;
    log(`=== drill: ${name}`);
    try {
      await fn();
    } catch (error) {
      results.push({
        drill: name,
        checks: [
          {
            name: 'drill ran',
            expected: 'no exception',
            observed: (error as Error).message,
            pass: false,
          },
        ],
        timings: {},
      });
    }
    const healthy = await ensureStackHealthy();
    log(`stack after ${name}: ${JSON.stringify(healthy)}`);
  }
  return results.every((r) => r.checks.every((c) => c.pass)) ? 0 : 1;
}

// Last-resort safety net: whatever happens, the shared containers are started again, the app
// processes are killed and the scratch database is dropped.
process.on('uncaughtException', (error) => {
  log(`UNCAUGHT: ${error.message} - emergency cleanup`);
  for (const p of Object.values(procs)) p.child?.kill('SIGKILL');
  for (const c of [PG, REDIS, FR]) run('docker', ['start', c]);
  for (let i = 0; i < 60 && health(PG) !== 'healthy'; i += 1) run('sleep', ['1']);
  run('docker', [
    'exec',
    PG,
    'psql',
    '-X',
    '-U',
    'ecloud',
    '-d',
    'postgres',
    '-c',
    `DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`,
  ]);
  run('docker', ['exec', REDIS, 'redis-cli', '-n', '12', 'FLUSHDB']);
  process.exit(1);
});

let code = 1;
try {
  code = await main();
} catch (error) {
  log(`ABORTED: ${(error as Error).message}`);
  results.push({
    drill: 'setup',
    checks: [{ name: 'setup', expected: 'ok', observed: (error as Error).message, pass: false }],
    timings: {},
  });
} finally {
  for (const p of Object.values(procs)) await stopProc(p).catch(() => 0);
  await db?.destroy().catch(() => undefined);
  const stack = await ensureStackHealthy();
  try {
    psqlAdmin('postgres', `DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
    log(`dropped ${SCRATCH}`);
  } catch (error) {
    log(`WARNING: could not drop ${SCRATCH}: ${(error as Error).message}`);
  }
  run('docker', ['exec', REDIS, 'redis-cli', '-n', '12', 'FLUSHDB']);
  process.stdout.write(
    `${JSON.stringify({ scratch: SCRATCH, stack_after: stack, results }, null, 2)}\n`,
  );
  if (process.env['DRILL_KEEP_LOGS'] !== '1') rmSync(LOGDIR, { recursive: true, force: true });
}
process.exit(code);
