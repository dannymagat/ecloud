/**
 * Cycle E (D-044): FreeRADIUS Meraki listener rendering with the platform flag ON / OFF, and the
 * renderer run writing (or not) the Meraki file next to the NAS clients file.
 */
import { parseMerakiCloudRadiusSettings } from '@ecloud/shared';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERAKI_RENDERED_HEADER, renderMerakiListeners, type MerakiNasEntry } from './meraki.js';
import { loadRenderSettings, renderRadiusClients } from './run.js';

const ID_M = '3e0c4b1a-7d2f-4a6b-9c8d-0e1f2a3b4c5d';
const ID_N = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ID_GENERIC = '0b6f3c2e-1d2a-4c5e-9f00-112233445566';
const SECRET_M = 'Mm1_-merakiMm1_-merakiMm1_-merakiMm1_-merak'; // check-no-secrets: allow (test value)
const SECRET_N = 'Nn2_-merakiNn2_-merakiNn2_-merakiNn2_-merak'; // check-no-secrets: allow (test value)
const SECRET_G = 'Gg3_-genericGg3_-genericGg3_-genericGg3_-ge'; // check-no-secrets: allow (test value)
// Ordinary public unicast test networks (NOT Meraki ranges: Meraki publishes no fixed list).
const CIDR_1 = '64.1.2.0/24';
const CIDR_2 = '64.9.0.0/16';

const ON = parseMerakiCloudRadiusSettings({
  MERAKI_CLOUD_RADIUS_ENABLED: 'true',
  MERAKI_RADIUS_SOURCE_CIDRS: `${CIDR_1},${CIDR_2}`,
  MERAKI_RADIUS_PORT_RANGE: '21000-21009',
});
const OFF = parseMerakiCloudRadiusSettings({
  MERAKI_RADIUS_SOURCE_CIDRS: `${CIDR_1},${CIDR_2}`,
  MERAKI_RADIUS_PORT_RANGE: '21000-21009',
});

function m(overrides: Partial<MerakiNasEntry> = {}): MerakiNasEntry {
  return {
    id: ID_M,
    secret: SECRET_M,
    requireMessageAuthenticator: true,
    authPort: 21000,
    acctPort: 21001,
    ...overrides,
  };
}

describe('renderMerakiListeners', () => {
  it('flag ON: one private client list (per-NAS secret + shortname) and an auth/acct listener pair per NAS', () => {
    const out = renderMerakiListeners(
      [m(), m({ id: ID_N, secret: SECRET_N, authPort: 21002, acctPort: 21003 })],
      ON,
    );
    expect(out.state).toBe('enabled');
    expect(out.rendered.map((e) => e.id)).toEqual([ID_M, ID_N]);
    expect(out.content.startsWith(MERAKI_RENDERED_HEADER)).toBe(true);
    const hexM = ID_M.replace(/-/g, '');
    expect(out.content).toContain(
      [
        `clients meraki_${hexM} {`,
        `\tclient meraki-${ID_M}-1 {`,
        `\t\tipaddr = ${CIDR_1}`,
        `\t\tsecret = '${SECRET_M}'`,
        `\t\tshortname = ${ID_M}`,
        '\t\tnas_type = other',
        '\t\trequire_message_authenticator = yes',
        '\t\tlimit_proxy_state = auto',
        '\t}',
      ].join('\n'),
    );
    expect(out.content).toContain(`\t\tipaddr = ${CIDR_2}`);
    expect(out.content).toContain(
      [
        'listen {',
        '\ttype = auth',
        '\tipaddr = $ENV{RADIUS_LISTEN_IP}',
        '\tport = 21000',
        `\tclients = meraki_${hexM}`,
        '\tvirtual_server = ecloud',
        '}',
      ].join('\n'),
    );
    expect(out.content).toContain(
      '\ttype = acct\n\tipaddr = $ENV{RADIUS_LISTEN_IP}\n\tport = 21001',
    );
    // each NAS's secret lives ONLY in its own client list
    const blockN = out.content.slice(out.content.indexOf(`# NAS ${ID_N}`));
    expect(blockN).toContain(SECRET_N);
    expect(blockN).not.toContain(SECRET_M);
  });

  it('flag OFF: comment only, no listener, no client, no secret', () => {
    const out = renderMerakiListeners([m()], OFF);
    expect(out.state).toBe('disabled');
    expect(out.rendered).toEqual([]);
    expect(out.content).not.toMatch(/^\s*(listen|clients?)\b/m);
    expect(out.content).not.toContain(SECRET_M);
    expect(out.content).toContain('state: disabled');
  });

  it('flag ON but no source ranges / no port range: still nothing rendered (fail closed)', () => {
    for (const env of [
      { MERAKI_CLOUD_RADIUS_ENABLED: 'true', MERAKI_RADIUS_PORT_RANGE: '21000-21009' },
      { MERAKI_CLOUD_RADIUS_ENABLED: 'true', MERAKI_RADIUS_SOURCE_CIDRS: CIDR_1 },
    ]) {
      const out = renderMerakiListeners([m()], parseMerakiCloudRadiusSettings(env));
      expect(out.rendered).toEqual([]);
      expect(out.content).not.toMatch(/^\s*listen\b/m);
      expect(out.content).not.toContain(SECRET_M);
    }
  });

  it('skips rows with bad ids, secrets, ports or shared ports (reported by id + rule only)', () => {
    const out = renderMerakiListeners(
      [
        m({ id: 'not-a-uuid' }),
        m({ id: ID_N, secret: "bad'secret}" }),
        m({ id: '11111111-2222-4333-8444-555555555555', authPort: null, acctPort: null }),
        m({ id: '22222222-2222-4333-8444-555555555555', authPort: 30000, acctPort: 30001 }),
        m({ id: '33333333-2222-4333-8444-555555555555', authPort: 21001, acctPort: 21002 }),
        m(),
        m({ id: '44444444-2222-4333-8444-555555555555' }),
      ],
      ON,
    );
    expect(out.rendered.map((e) => e.id)).toEqual(['3e0c4b1a-7d2f-4a6b-9c8d-0e1f2a3b4c5d']);
    expect(out.skipped.map((s) => s.id).sort()).toEqual(
      [
        '(invalid-id)',
        ID_N,
        '11111111-2222-4333-8444-555555555555',
        '22222222-2222-4333-8444-555555555555',
        '33333333-2222-4333-8444-555555555555',
        '44444444-2222-4333-8444-555555555555',
      ].sort(),
    );
    expect(JSON.stringify(out.skipped)).not.toContain('bad');
  });

  it('Message-Authenticator is forced unless MERAKI_ALLOW_RELAXED_MSGAUTH (review F7)', () => {
    const forced = renderMerakiListeners([m({ requireMessageAuthenticator: false })], ON);
    expect(forced.content).toContain(
      '\t\trequire_message_authenticator = yes\n\t\tlimit_proxy_state = auto',
    );
    expect(forced.content).not.toContain('require_message_authenticator = no');
  });

  it('a relaxed NAS gets require_message_authenticator = no and limit_proxy_state = yes when allowed', () => {
    const out = renderMerakiListeners([m({ requireMessageAuthenticator: false })], {
      ...ON,
      allowRelaxedMessageAuthenticator: true,
    });
    expect(out.content).toContain(
      '\t\trequire_message_authenticator = no\n\t\tlimit_proxy_state = yes',
    );
  });
});

describe('renderRadiusClients with the Meraki file (Cycle E)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ecloud-radius-meraki-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const generic = {
    id: ID_GENERIC,
    nasIp: '192.168.203.198',
    secret: SECRET_G,
    requireMessageAuthenticator: true,
  };

  it('flag OFF: the NAS file is rendered, the Meraki file is a comment and no Meraki secret is loaded', async () => {
    const base = {
      DATABASE_URL_PLATFORM: 'postgres://unused',
      DATA_ENCRYPTION_KEY: 'x'.repeat(32),
      RADIUS_CLIENTS_FILE: join(dir, 'ecloud-nas.conf'),
      MERAKI_RADIUS_FILE: join(dir, 'ecloud-meraki.conf'),
    };
    const settings = loadRenderSettings(base);
    expect(settings.meraki?.enabled).toBe(false);
    const loadMeraki = vi.fn(() => Promise.resolve({ entries: [m()], skipped: [] }));
    const summary = await renderRadiusClients(settings, {
      loadEntries: () => Promise.resolve({ entries: [generic], skipped: [] }),
      loadMerakiEntries: loadMeraki,
    });
    expect(loadMeraki).not.toHaveBeenCalled();
    expect(summary.meraki).toMatchObject({ state: 'disabled', listeners: 0, changed: true });
    const merakiFile = await readFile(join(dir, 'ecloud-meraki.conf'), 'utf8');
    expect(merakiFile).not.toMatch(/^\s*listen\b/m);
    expect(await readFile(join(dir, 'ecloud-nas.conf'), 'utf8')).toContain(ID_GENERIC);
  });

  it('flag ON: listeners rendered into the Meraki file, never into the NAS file', async () => {
    const settings = loadRenderSettings({
      DATABASE_URL_PLATFORM: 'postgres://unused',
      DATA_ENCRYPTION_KEY: 'x'.repeat(32),
      RADIUS_CLIENTS_FILE: join(dir, 'ecloud-nas.conf'),
      MERAKI_RADIUS_FILE: join(dir, 'ecloud-meraki.conf'),
      MERAKI_CLOUD_RADIUS_ENABLED: 'true',
      MERAKI_RADIUS_SOURCE_CIDRS: CIDR_1,
      MERAKI_RADIUS_PORT_RANGE: '21000-21009',
    });
    const summary = await renderRadiusClients(settings, {
      loadEntries: () => Promise.resolve({ entries: [generic], skipped: [] }),
      loadMerakiEntries: () => Promise.resolve({ entries: [m()], skipped: [] }),
    });
    expect(summary.meraki).toMatchObject({ state: 'enabled', listeners: 1 });
    expect(JSON.stringify(summary)).not.toContain(SECRET_M);
    const merakiFile = await readFile(join(dir, 'ecloud-meraki.conf'), 'utf8');
    expect(merakiFile).toContain('\tport = 21000');
    const nasFile = await readFile(join(dir, 'ecloud-nas.conf'), 'utf8');
    expect(nasFile).not.toContain(ID_M);
    expect(nasFile).not.toContain(SECRET_M);
  });

  it('refuses a Meraki file equal to the NAS file or with an ignored name', () => {
    const base = {
      DATABASE_URL_PLATFORM: 'postgres://unused',
      DATA_ENCRYPTION_KEY: 'x'.repeat(32),
      RADIUS_CLIENTS_FILE: '/x/ecloud-nas.conf',
    };
    expect(() => loadRenderSettings({ ...base, MERAKI_RADIUS_FILE: '/x/ecloud-nas.conf' })).toThrow(
      /must differ/,
    );
    expect(() => loadRenderSettings({ ...base, MERAKI_RADIUS_FILE: '/x/.hidden.conf' })).toThrow(
      /MERAKI_RADIUS_FILE/,
    );
    expect(() => loadRenderSettings({ ...base, MERAKI_RADIUS_SOURCE_CIDRS: '10.0.0.0/8' })).toThrow(
      /MERAKI_RADIUS_SOURCE_CIDRS/,
    );
  });

  it('review F5: the Meraki file is written even when the NAS clients render fails', async () => {
    const nasFile = join(dir, 'ecloud-nas.conf');
    const merakiPath = join(dir, 'ecloud-meraki.conf');
    // a previous run left live listeners; the flag is now OFF and there is no other NAS
    await writeFile(merakiPath, 'listen { port = 21000 }\n');
    const settings = loadRenderSettings({
      DATABASE_URL_PLATFORM: 'postgres://unused',
      DATA_ENCRYPTION_KEY: 'x'.repeat(32),
      RADIUS_CLIENTS_FILE: nasFile,
      MERAKI_RADIUS_FILE: merakiPath,
    });
    await expect(
      renderRadiusClients(settings, {
        loadEntries: () => Promise.resolve({ entries: [], skipped: [] }),
      }),
    ).rejects.toThrow(/no active NAS clients/);
    const cleared = await readFile(merakiPath, 'utf8');
    expect(cleared).not.toMatch(/^\s*listen\b/m);
    expect(cleared).toContain('state: disabled');

    // Meraki-only deployment with the flag ON: listeners written, then the main error surfaces
    const on = loadRenderSettings({
      DATABASE_URL_PLATFORM: 'postgres://unused',
      DATA_ENCRYPTION_KEY: 'x'.repeat(32),
      RADIUS_CLIENTS_FILE: nasFile,
      MERAKI_RADIUS_FILE: merakiPath,
      MERAKI_CLOUD_RADIUS_ENABLED: 'true',
      MERAKI_RADIUS_SOURCE_CIDRS: CIDR_1,
      MERAKI_RADIUS_PORT_RANGE: '21000-21009',
    });
    await expect(
      renderRadiusClients(on, {
        loadEntries: () => Promise.resolve({ entries: [], skipped: [] }),
        loadMerakiEntries: () => Promise.resolve({ entries: [m()], skipped: [] }),
      }),
    ).rejects.toThrow(/no active NAS clients/);
    expect(await readFile(merakiPath, 'utf8')).toContain('\tport = 21000');
  });
});
