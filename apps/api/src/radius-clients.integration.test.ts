/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
/**
 * F-P10-07 end to end: nas_clients (sealed secret, platform role) -> renderer -> rendered file
 * -> FreeRADIUS 3.2.10 container using the REPO's clients.conf + entrypoint in rendered mode.
 *
 * Database / API part: always with the integration database (NAS address rules in the API and
 * the migration 027 CHECK, per-row skips). FreeRADIUS part: only with ECLOUD_TEST_RADIUS=1, a
 * reachable docker daemon and the FreeRADIUS image present (ECLOUD_TEST_FREERADIUS_IMAGE,
 * default the dev-stack image `ecloud-dev-freeradius:3.2.10`). The container runs on a
 * throw-away docker network with a fixed address, which is the NAS address: radclient inside the
 * container sends from it. rlm_sql has `start = 0`, rlm_rest points at a closed port so every
 * authorize is rejected: a reply proves the client entry and its secret were accepted; a wrong
 * secret gets no reply at all. The dev stack is never touched.
 */
import { newId } from '@ecloud/shared';
import { describeIntegration, migrateTestDatabase } from '@ecloud/testing';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDeps } from './context.js';
import { Envelope, NAS_SECRET_PURPOSE, randomToken, sealSecretRef } from './crypto.js';
import { MemoryKv } from './kv.js';
import { loadNasClientRows, resolveNasSecrets } from './radius-clients/load.js';
import { renderClientsConf, type RenderOutput } from './radius-clients/render.js';
import { writeClientsFileAtomic } from './radius-clients/write.js';
import {
  TEST_ORIGIN,
  closeDeps,
  createAdmin,
  createTenant,
  integrationDeps,
} from './test-support/deps.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const IMAGE = process.env.ECLOUD_TEST_FREERADIUS_IMAGE?.trim() || 'ecloud-dev-freeradius:3.2.10';
const NAS_NAME = 'radius-clients-it';
const BROWSER = { Origin: TEST_ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };

function docker(args: string[], input?: string, timeout = 30_000) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, timeout });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function radiusGate(): string | null {
  if (process.env.ECLOUD_TEST_RADIUS !== '1') return 'ECLOUD_TEST_RADIUS=1 not set';
  if (docker(['info', '--format', '{{.ServerVersion}}'], undefined, 10_000).status !== 0) {
    return 'docker daemon not reachable';
  }
  if (docker(['image', 'inspect', IMAGE], undefined, 10_000).status !== 0) {
    return `image ${IMAGE} not present (npm run dev:stack builds it)`;
  }
  return null;
}

/** Placeholder-only environment: nothing here is a credential. */
const CONTAINER_ENV = [
  'RADIUS_CLIENTS_RENDERED=1',
  'RADIUS_LISTEN_IP=*',
  'RADIUS_STATUS_SECRET=ecloud_test_status_placeholder',
  'RADIUS_SQL_HOST=localhost',
  'RADIUS_SQL_DB=ecloud',
  'RADIUS_SQL_USER=ecloud_radius',
  'RADIUS_SQL_PASSWORD=ecloud_test_placeholder',
  'ECLOUD_INTERNAL_URL=http://127.0.0.1:1',
  'INTERNAL_API_TOKEN=ecloud_test_internal_placeholder',
];

interface RunOptions {
  name: string;
  clientsDir: string | null;
  detach: boolean;
  network?: { name: string; ip: string };
  command?: string[];
}

function runArgs(o: RunOptions): string[] {
  return [
    'run',
    ...(o.detach ? ['-d'] : ['--rm']),
    '--name',
    o.name,
    ...(o.network ? ['--network', o.network.name, '--ip', o.network.ip] : ['--network', 'none']),
    ...CONTAINER_ENV.flatMap((e) => ['-e', e]),
    '-v',
    `${join(ROOT, 'infra/freeradius/raddb/clients.conf')}:/etc/freeradius/clients.conf:ro`,
    '-v',
    `${join(ROOT, 'infra/freeradius/docker-entrypoint.sh')}:/usr/local/bin/ecloud-entrypoint.sh:ro`,
    ...(o.clientsDir === null ? [] : ['-v', `${o.clientsDir}:/etc/freeradius/clients.d:ro`]),
    IMAGE,
    ...(o.command ?? []),
  ];
}

const gate = radiusGate();

await describeIntegration('@ecloud/api FreeRADIUS clients renderer (F-P10-07)', () => {
  let deps: AppDeps;
  let orgA = '';
  let orgB = '';
  let siteA = '';
  let nasA = '';
  let nasB = '';
  let nasBad = '';
  let secretA = '';
  let dir = '';
  // NAS A = the container's fixed address on a throw-away /24 (random to avoid collisions).
  const subnetOctet = randomInt(2, 250);
  const network = {
    name: `ecloud-it-radius-net-${randomBytes(3).toString('hex')}`,
    subnet: `10.231.${String(subnetOctet)}.0/24`,
    ip: `10.231.${String(subnetOctet)}.10`,
  };
  const container = `ecloud-it-radius-clients-${randomBytes(3).toString('hex')}`;
  let envelope: Envelope;

  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
    envelope = new Envelope(deps.config.dataEncryptionKey, NAS_SECRET_PURPOSE);
    const p = deps.dbPlatform;
    // A crashed earlier run may have left its NAS rows active (nas_ip is unique).
    await p
      .updateTable('nas_clients')
      .set({ deleted_at: new Date() })
      .where('name', 'like', `${NAS_NAME}%`)
      .where('deleted_at', 'is', null)
      .execute();
    const a = await createTenant(p);
    const b = await createTenant(p);
    orgA = a.orgId;
    orgB = b.orgId;
    siteA = a.siteId;
    secretA = randomToken(32);
    nasA = newId();
    nasB = newId();
    nasBad = newId();
    const rand = () => String(randomInt(2, 250));
    await p
      .insertInto('nas_clients')
      .values([
        {
          id: nasA,
          organization_id: orgA,
          site_id: a.siteId,
          name: NAS_NAME,
          nas_ip: network.ip,
          adapter_type_key: 'uspot-upstream-uam',
          adapter_key: 'uspot-upstream-uam',
          secret_ref: sealSecretRef(envelope, secretA),
        },
        {
          id: nasB,
          organization_id: orgB,
          site_id: b.siteId,
          name: `${NAS_NAME}-b`,
          nas_ip: `10.${rand()}.207.${rand()}`,
          adapter_type_key: 'uspot-upstream-uam',
          adapter_key: 'uspot-upstream-uam',
          secret_ref: sealSecretRef(envelope, randomToken(32)),
          require_message_authenticator: false,
        },
        {
          // Individually broken row: sealed with another key (e.g. imported from elsewhere).
          id: nasBad,
          organization_id: orgB,
          site_id: b.siteId,
          name: `${NAS_NAME}-bad`,
          nas_ip: `10.${rand()}.208.${rand()}`,
          adapter_type_key: 'uspot-upstream-uam',
          adapter_key: 'uspot-upstream-uam',
          secret_ref: sealSecretRef(
            new Envelope(`${deps.config.dataEncryptionKey}-other`, NAS_SECRET_PURPOSE),
            randomToken(32),
          ),
        },
      ])
      .execute();
    // Docker Desktop shares /tmp; os.tmpdir() on macOS may not be shared.
    dir = await mkdtemp('/tmp/ecloud-it-radius-clients-');
  });

  afterAll(async () => {
    docker(['rm', '-f', container]);
    docker(['network', 'rm', network.name]);
    if (dir !== '') await rm(dir, { recursive: true, force: true });
    if (deps !== undefined) {
      await deps.dbPlatform
        .updateTable('nas_clients')
        .set({ deleted_at: new Date() })
        .where('organization_id', 'in', [orgA, orgB])
        .execute()
        .catch(() => undefined);
      await closeDeps(deps);
    }
  });

  async function render(): Promise<RenderOutput & { changed: boolean }> {
    const rows = await loadNasClientRows(deps.dbPlatform, { organizationIds: [orgA, orgB] });
    const resolved = resolveNasSecrets(rows, deps.config.dataEncryptionKey);
    const out = renderClientsConf(resolved.entries, resolved.skipped);
    const { changed } = await writeClientsFileAtomic(join(dir, 'ecloud-nas.conf'), out.content);
    return { ...out, changed };
  }

  it('renders every valid NAS of both tenants, skips the broken row by id, 0640, ids only', async () => {
    const { changed, content: text, skipped } = await render();
    expect(changed).toBe(true);
    expect(text).toContain(`client nas-${nasA} {`);
    expect(text).toContain(`ipaddr = ${network.ip}/32`);
    expect(text).toContain(`secret = '${secretA}'`);
    expect(text).toContain(`shortname = ${nasA}`);
    expect(text).toContain(`client nas-${nasB} {`);
    expect(text).toContain('require_message_authenticator = no');
    expect(text).not.toContain(nasBad);
    expect(skipped).toEqual([
      { id: nasBad, reason: 'secret_ref cannot be opened with DATA_ENCRYPTION_KEY' },
    ]);
    expect(text).not.toContain(NAS_NAME); // no tenant free text
    expect((await stat(join(dir, 'ecloud-nas.conf'))).mode & 0o777).toBe(0o640);
    expect((await render()).changed).toBe(false);
  });

  it('drops disabled NAS rows', async () => {
    await deps.dbPlatform
      .updateTable('nas_clients')
      .set({ status: 'disabled' })
      .where('id', '=', nasB)
      .execute();
    expect((await render()).content).not.toContain(nasB);
    await deps.dbPlatform
      .updateTable('nas_clients')
      .set({ status: 'active' })
      .where('id', '=', nasB)
      .execute();
    expect((await render()).content).toContain(nasB);
  });

  it('migration 027 refuses mapped / special addresses for active rows, allows disabling', async () => {
    const p = deps.dbPlatform;
    for (const ip of [
      '::ffff:10.231.0.10',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      '224.0.0.5',
    ]) {
      await expect(
        p
          .insertInto('nas_clients')
          .values({
            organization_id: orgA,
            site_id: siteA,
            name: `${NAS_NAME}-ck`,
            nas_ip: ip,
            adapter_type_key: 'uspot-upstream-uam',
            adapter_key: 'uspot-upstream-uam',
            secret_ref: 'enc:placeholder',
          })
          .execute(),
        ip,
      ).rejects.toThrow(/ck_nas_clients_nas_ip_unicast_host/);
    }
    const disabledId = newId();
    await p
      .insertInto('nas_clients')
      .values({
        id: disabledId,
        organization_id: orgA,
        site_id: siteA,
        name: `${NAS_NAME}-ck-disabled`,
        nas_ip: `127.${String(randomInt(1, 250))}.0.1`,
        adapter_type_key: 'uspot-upstream-uam',
        adapter_key: 'uspot-upstream-uam',
        secret_ref: 'enc:placeholder',
        status: 'disabled',
      })
      .execute();
    await expect(
      p.updateTable('nas_clients').set({ status: 'active' }).where('id', '=', disabledId).execute(),
    ).rejects.toThrow(/ck_nas_clients_nas_ip_unicast_host/);
  });

  it('API: NAS create / update reject mapped and special addresses with 400', async () => {
    const apps = createApp({ ...deps, kv: new MemoryKv() });
    const admin = await createAdmin(deps.dbPlatform, [
      { template: 'org_admin', scope: 'organization', orgId: orgA },
    ]);
    const agent = request.agent(apps.publicApp);
    const login = await agent
      .post('/api/v1/auth/login')
      .set(BROWSER)
      .send({ email: admin.email, password: admin.password });
    expect(login.status).toBe(200);
    const body = (nas_ip: string) => ({
      site_id: siteA,
      name: `${NAS_NAME}-api`,
      nas_ip,
      adapter_key: 'uspot-upstream-uam',
    });
    for (const ip of [
      '::ffff:192.168.203.198',
      '::ffff:c0a8:cbc6',
      '::',
      '::1',
      '0.0.0.0',
      '127.0.0.1',
      '169.254.1.1',
      '224.0.0.1',
      'ff02::1',
      'fe80::1',
    ]) {
      const res = await agent.post(`/api/v1/orgs/${orgA}/nas`).set(BROWSER).send(body(ip));
      expect(res.status, ip).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/unicast/);
    }
    const ok = await agent
      .post(`/api/v1/orgs/${orgA}/nas`)
      .set(BROWSER)
      .send(body(`10.${String(randomInt(2, 250))}.209.${String(randomInt(2, 250))}`));
    expect(ok.status).toBe(201);
    const patched = await agent
      .patch(`/api/v1/orgs/${orgA}/nas/${String(ok.body.id)}`)
      .set(BROWSER)
      .send({ nas_ip: '::ffff:10.0.0.1' });
    expect(patched.status).toBe(400);
  });

  describe.skipIf(gate !== null)(`FreeRADIUS container${gate ? ` [skipped: ${gate}]` : ''}`, () => {
    function access(secret: string): string {
      const attrs =
        'User-Name = "it-user"\nUser-Password = "it-pass"\nMessage-Authenticator = 0x00\n';
      return docker(
        [
          'exec',
          '-i',
          container,
          'radclient',
          '-r',
          '1',
          '-t',
          '2',
          '-x',
          `${network.ip}:1812`,
          'auth',
          secret,
        ],
        attrs,
      ).out;
    }

    /** Waits for the `nth` "Ready to process requests" line (1 = first start). */
    async function waitReady(nth: number): Promise<void> {
      for (let i = 0; i < 40; i += 1) {
        const logs = docker(['logs', container]).out;
        if (logs.split('Ready to process requests').length - 1 >= nth) return;
        if (docker(['inspect', '-f', '{{.State.Running}}', container]).out.trim() !== 'true') {
          throw new Error('freeradius container exited during start-up');
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('freeradius did not become ready');
    }

    it('refuses to start in rendered mode without the rendered volume (fail closed)', async () => {
      // The image's own clients.d/ (dev client) stays visible when the volume is not mounted.
      const visibleDev = docker(
        runArgs({
          name: `${container}-nodir`,
          clientsDir: join(ROOT, 'infra/freeradius/raddb/clients.d'),
          detach: false,
        }),
      );
      expect(visibleDev.status).not.toBe(0);
      expect(visibleDev.out).toMatch(/dev\.conf is visible/);
      const emptyDir = await mkdtemp('/tmp/ecloud-it-radius-empty-');
      try {
        const empty = docker(
          runArgs({ name: `${container}-empty`, clientsDir: emptyDir, detach: false }),
        );
        expect(empty.status).not.toBe(0);
        expect(empty.out).toMatch(/missing, empty or unreadable/);
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    }, 60_000);

    it('`freeradius -XC` accepts the rendered file (config check)', async () => {
      // Docker Desktop bind mounts keep the host uid; let freerad read the test copy.
      await chmod(join(dir, 'ecloud-nas.conf'), 0o644);
      const check = docker(
        runArgs({
          name: `${container}-xc`,
          clientsDir: dir,
          detach: false,
          command: ['freeradius', '-XC', '-l', 'stdout'],
        }),
        undefined,
        60_000,
      );
      expect(check.out).toContain(
        'including configuration file /etc/freeradius/clients.d/ecloud-nas.conf',
      );
      expect(check.out).toContain(`client nas-${nasA} {`);
      expect(check.out).toContain(`client nas-${nasB} {`);
      expect(check.out).toMatch(/Configuration appears to be OK/);
      expect(check.status).toBe(0);
    }, 60_000);

    it('accepts the rendered NAS with its ECLOUD secret and drops a wrong secret', async () => {
      const net = docker(['network', 'create', '--subnet', network.subnet, network.name]);
      expect(net.status, net.out).toBe(0);
      await chmod(join(dir, 'ecloud-nas.conf'), 0o644);
      const started = docker(runArgs({ name: container, clientsDir: dir, detach: true, network }));
      expect(started.status, started.out).toBe(0);
      await waitReady(1);
      expect(access(secretA)).toMatch(/Received Access-Reject/); // rlm_rest backend closed -> reject
      expect(access(randomToken(32))).not.toMatch(/Received Access-/);
      expect(docker(['logs', container]).out).not.toContain(secretA);
    }, 60_000);

    it('picks up a rotated secret after re-render + restart (SIGHUP is not enough)', async () => {
      const rotated = randomToken(32);
      await deps.dbPlatform
        .updateTable('nas_clients')
        .set({ secret_ref: sealSecretRef(envelope, rotated) })
        .where('id', '=', nasA)
        .execute();
      expect((await render()).changed).toBe(true);
      await chmod(join(dir, 'ecloud-nas.conf'), 0o644);
      docker(['kill', '-s', 'HUP', container]);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(access(rotated)).not.toMatch(/Received Access-/);
      expect(access(secretA)).toMatch(/Received Access-Reject/);
      expect(docker(['restart', container]).status).toBe(0);
      await waitReady(2);
      expect(access(rotated)).toMatch(/Received Access-Reject/);
      expect(access(secretA)).not.toMatch(/Received Access-/);
    }, 60_000);
  });
});
