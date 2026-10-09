/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.stringMatching() asymmetric matchers are typed any */
import { ConfigError } from '@ecloud/shared';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_DEV_DEFAULTS } from '../config.js';
import { Envelope, NAS_SECRET_PURPOSE, sealSecretRef } from '../crypto.js';
import { resolveNasSecrets } from './load.js';
import {
  INVALID_ID_MARKER,
  RENDERED_HEADER,
  RadiusClientsRenderError,
  renderClientsConf,
  type NasClientEntry,
} from './render.js';
import {
  DEFAULT_RADIUS_CLIENTS_FILE,
  EXIT_SKIPPED,
  describeRenderError,
  loadRenderSettings,
  renderRadiusClients,
} from './run.js';
import { writeClientsFileAtomic } from './write.js';

const ID_A = '0b6f3c2e-1d2a-4c5e-9f00-112233445566';
const ID_B = '7c1d9e40-2a3b-4c5d-8e6f-778899aabbcc';
const SECRET = 'Ab3_-xyzAb3_-xyzAb3_-xyzAb3_-xyzAb3_-xyzAb3'; // check-no-secrets: allow (test value)

function entry(overrides: Partial<NasClientEntry> = {}): NasClientEntry {
  return {
    id: ID_A,
    nasIp: '192.168.203.198',
    secret: SECRET,
    requireMessageAuthenticator: true,
    ...overrides,
  };
}

const ID_C = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER_SECRET = 'Zz9-Zz9-Zz9-Zz9-Zz9-Zz9-Zz9'; // check-no-secrets: allow (test value)

/** Content of a render that must succeed. */
function conf(entries: NasClientEntry[]): string {
  return renderClientsConf(entries).content;
}

describe('renderClientsConf', () => {
  it('renders one exact-host client per NAS with the id as shortname', () => {
    const out = conf([entry()]);
    expect(out.startsWith(RENDERED_HEADER)).toBe(true);
    expect(out).toContain(
      [
        `client nas-${ID_A} {`,
        '\tipaddr = 192.168.203.198/32',
        `\tsecret = '${SECRET}'`,
        `\tshortname = ${ID_A}`,
        '\tnas_type = other',
        '\trequire_message_authenticator = yes',
        '\tlimit_proxy_state = auto',
        '}',
      ].join('\n'),
    );
    expect(renderClientsConf([entry()]).skipped).toEqual([]);
  });

  it('accepts an explicit host prefix and canonicalises IPv6 hosts', () => {
    expect(conf([entry({ nasIp: '10.1.2.3/32' })])).toContain('ipaddr = 10.1.2.3/32');
    expect(conf([entry({ nasIp: '2001:DB8:0:0::1' })])).toContain('ipaddr = 2001:db8::1/128');
  });

  it('falls back to limit_proxy_state = yes when Message-Authenticator is not required', () => {
    const out = conf([entry({ requireMessageAuthenticator: false })]);
    expect(out).toContain('require_message_authenticator = no');
    expect(out).toContain('limit_proxy_state = yes');
  });

  it('is deterministic (sorted by id) for an unchanged NAS table', () => {
    const a = entry();
    const b = entry({ id: ID_B, nasIp: '192.168.203.199' });
    expect(conf([b, a])).toBe(conf([a, b]));
    expect(conf([b, a]).indexOf(ID_A)).toBeLessThan(conf([b, a]).indexOf(ID_B));
  });

  it('refuses an empty client list', () => {
    expect(() => renderClientsConf([])).toThrow(/no active NAS clients/);
  });

  it.each([
    ['network prefix', '192.168.203.0/24'],
    ['host with a short mask', '192.168.203.198/24'],
    ['IPv6 network', '2001:db8::/64'],
    ['hostname', 'ap.example.net'],
    ['zone id', 'fe80::1%eth0'],
    ['injection', '192.168.203.198\n}\nclient evil {\n\tipaddr = 0.0.0.0/0'],
    ['empty', ''],
    ['IPv4-mapped IPv6 (dotted)', '::ffff:192.168.203.199'],
    ['IPv4-mapped IPv6 (hex)', '::ffff:c0a8:cbc7'],
    ['IPv4-compatible IPv6', '::192.168.203.199'],
    ['IPv6 unspecified', '::'],
    ['IPv6 loopback', '::1'],
    ['IPv4 unspecified', '0.0.0.0'],
    ['IPv4 loopback', '127.0.0.1'],
    ['IPv4 loopback (other)', '127.10.0.1'],
    ['IPv4 multicast', '224.0.0.1'],
    ['IPv4 reserved', '240.0.0.1'],
    ['IPv4 broadcast', '255.255.255.255'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv4 link-local', '169.254.10.10'],
  ])('skips nas_ip (%s) and keeps the valid NAS', (_label, nasIp) => {
    const out = renderClientsConf([entry(), entry({ id: ID_B, nasIp })]);
    expect(out.rendered.map((e) => e.id)).toEqual([ID_A]);
    expect(out.skipped).toEqual([{ id: ID_B, reason: expect.stringMatching(/^nas_ip must be/) }]);
    expect(out.content).not.toContain(ID_B);
  });

  it.each([
    ['single quote', `${SECRET}'`],
    ['double quote', `${SECRET}"`],
    ['newline + new block', `${SECRET}\n}\nclient evil {`],
    ['carriage return', `${SECRET}\r`],
    ['brace', `${SECRET}}`],
    ['config expansion', '${confdir}AAAAAAAAAAAAAAAAAAAA'],
    ['env expansion', '$ENV{INTERNAL_API_TOKEN}AAAAAAAA'],
    ['backslash', `${SECRET}\\`],
    ['comment', `${SECRET}#x`],
    ['space', 'abcdefgh ijklmnopq'],
    ['NUL', `${SECRET}\u0000`],
    ['non-ASCII', `${SECRET}é`],
    ['too short', 'short-secret'],
    ['too long', 'a'.repeat(129)],
  ])('skips a secret with %s and never echoes it', (_label, secret) => {
    const out = renderClientsConf([
      entry({ id: ID_B, nasIp: '10.9.9.9', secret: OTHER_SECRET }),
      entry({ secret }),
    ]);
    expect(out.skipped).toEqual([
      { id: ID_A, reason: expect.stringMatching(/^shared secret must be/) },
    ]);
    expect(JSON.stringify(out.skipped)).not.toContain(secret);
    expect(out.content).not.toContain(secret);
    expect(out.content).not.toContain(SECRET);
  });

  it('skips a non-UUID id without echoing it', () => {
    const out = renderClientsConf([entry({ id: 'nas {' }), entry({ id: ID_B, nasIp: '10.9.9.9' })]);
    expect(out.skipped).toEqual([{ id: INVALID_ID_MARKER, reason: 'id is not a lowercase UUID' }]);
    expect(
      renderClientsConf([entry({ id: ID_A.toUpperCase() }), entry({ id: ID_B, nasIp: '10.9.9.9' })])
        .skipped,
    ).toHaveLength(1);
  });

  it('skips every row of a shared address (incl. different IPv6 spellings), keeps the rest', () => {
    const out = renderClientsConf([
      entry({ nasIp: '2001:db8::5' }),
      entry({ id: ID_B, nasIp: '2001:DB8:0:0:0:0:0:5' }),
      entry({ id: ID_C, nasIp: '10.9.9.9' }),
    ]);
    expect(out.rendered.map((e) => e.id)).toEqual([ID_C]);
    expect(out.skipped.map((s) => s.id)).toEqual([ID_A, ID_B]);
    expect(out.skipped[0]?.reason).toBe('nas_ip is shared with another NAS');
  });

  it('skips a duplicate id', () => {
    const out = renderClientsConf([entry(), entry({ nasIp: '10.0.0.1' })]);
    expect(out.rendered).toHaveLength(1);
    expect(out.skipped).toEqual([{ id: ID_A, reason: 'duplicate id' }]);
  });

  it('fails the whole render when no valid client remains (nothing to write)', () => {
    expect(() =>
      renderClientsConf([entry({ nasIp: '127.0.0.1' })], [{ id: ID_B, reason: 'x' }]),
    ).toThrow(/no valid NAS client \(2 skipped\)/);
  });
});

describe('resolveNasSecrets', () => {
  const key = 'unit-test-data-encryption-key-0123456789';
  const envelope = new Envelope(key, NAS_SECRET_PURPOSE);
  const good = {
    id: ID_A,
    nasIp: '192.168.203.198',
    secretRef: sealSecretRef(envelope, SECRET),
    requireMessageAuthenticator: true,
  };

  it('opens enc: refs sealed by the API envelope', () => {
    const { entries, skipped } = resolveNasSecrets([good], key);
    expect(entries[0]?.secret).toBe(SECRET);
    expect(skipped).toEqual([]);
  });

  it.each([
    ['unknown scheme', 'env:NAS_SECRET', /scheme is not supported/],
    ['placeholder', 'enc:placeholder', /cannot be opened/],
    [
      'other key',
      sealSecretRef(new Envelope(`${key}-other`, NAS_SECRET_PURPOSE), SECRET),
      /cannot be opened/,
    ],
    [
      'wrong purpose',
      sealSecretRef(new Envelope(key, 'ecloud:other:v1'), SECRET),
      /cannot be opened/,
    ],
  ])(
    'skips one row with %s (others still render), without leaking the ref',
    (_label, secretRef, reason) => {
      const { entries, skipped } = resolveNasSecrets(
        [good, { id: ID_B, nasIp: '10.0.0.1', secretRef, requireMessageAuthenticator: true }],
        key,
      );
      expect(entries.map((e) => e.id)).toEqual([ID_A]);
      expect(skipped).toEqual([{ id: ID_B, reason: expect.stringMatching(reason) }]);
      expect(JSON.stringify(skipped)).not.toContain(secretRef);
    },
  );

  it('fails globally when the key opens none of the sealed secrets (wrong DATA_ENCRYPTION_KEY)', () => {
    expect(() => resolveNasSecrets([good, { ...good, id: ID_B }], `${key}-rotated`)).toThrow(
      /opens none of the 2 sealed NAS secrets/,
    );
  });
});

describe('writeClientsFileAtomic', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ecloud-radius-clients-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes 0640, reports unchanged on identical content and leaves no temp file', async () => {
    const path = join(dir, 'ecloud-nas.conf');
    const content = conf([entry()]);
    expect(await writeClientsFileAtomic(path, content)).toEqual({ changed: true });
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(await writeClientsFileAtomic(path, content)).toEqual({ changed: false });
    expect(await readdir(dir)).toEqual(['ecloud-nas.conf']);
  });

  it('refuses empty content and keeps the previous file', async () => {
    const path = join(dir, 'ecloud-nas.conf');
    await writeFile(path, 'previous\n');
    await expect(writeClientsFileAtomic(path, '  \n')).rejects.toThrow(/empty/);
    expect(await readFile(path, 'utf8')).toBe('previous\n');
  });

  it('keeps the previous file when the target directory is unwritable', async () => {
    const missingDir = join(dir, 'missing', 'ecloud-nas.conf');
    await expect(writeClientsFileAtomic(missingDir, 'x\n')).rejects.toThrow();
  });
});

describe('renderRadiusClients', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ecloud-radius-run-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const settings = (outFile: string) => ({
    databaseUrlPlatform: 'postgres://unused',
    dataEncryptionKey: 'x'.repeat(32),
    outFile,
  });

  it('renders and reports a secret-free summary', async () => {
    const outFile = join(dir, 'ecloud-nas.conf');
    const summary = await renderRadiusClients(settings(outFile), {
      loadEntries: () =>
        Promise.resolve({
          entries: [
            entry(),
            entry({ id: ID_B, nasIp: '10.9.9.9', requireMessageAuthenticator: false }),
          ],
          skipped: [],
        }),
    });
    expect(summary).toEqual({
      event: 'radius_clients_rendered',
      clients: 2,
      relaxedMessageAuthenticator: 1,
      changed: true,
      checkOnly: false,
      file: outFile,
      skipped: { count: 0, nas: [] },
    });
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('writes the valid NAS and reports skipped rows (CLI exit 3)', async () => {
    const outFile = join(dir, 'ecloud-nas.conf');
    await writeFile(outFile, 'previous\n');
    const summary = await renderRadiusClients(settings(outFile), {
      loadEntries: () =>
        Promise.resolve({
          entries: [entry(), entry({ id: ID_B, nasIp: '::ffff:10.9.9.9' })],
          skipped: [{ id: ID_C, reason: 'secret_ref cannot be opened with DATA_ENCRYPTION_KEY' }],
        }),
    });
    expect(summary.clients).toBe(1);
    expect(summary.changed).toBe(true);
    expect(summary.skipped.count).toBe(2);
    expect(summary.skipped.nas.map((s) => s.id)).toEqual([ID_B, ID_C].sort());
    expect(EXIT_SKIPPED).toBe(3);
    const written = await readFile(outFile, 'utf8');
    expect(written).toContain(ID_A);
    expect(written).not.toContain(ID_B);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('keeps the previous file when there are no NAS clients or the load fails', async () => {
    const outFile = join(dir, 'ecloud-nas.conf');
    await writeFile(outFile, 'previous\n');
    const write = vi.fn(writeClientsFileAtomic);
    await expect(
      renderRadiusClients(settings(outFile), {
        loadEntries: () => Promise.resolve({ entries: [], skipped: [] }),
        writeFile: write,
      }),
    ).rejects.toThrow(/no active NAS clients/);
    await expect(
      renderRadiusClients(settings(outFile), {
        loadEntries: () =>
          Promise.resolve({
            entries: [entry({ nasIp: '::1' })],
            skipped: [{ id: ID_B, reason: 'secret_ref scheme is not supported' }],
          }),
        writeFile: write,
      }),
    ).rejects.toThrow(/no valid NAS client/);
    await expect(
      renderRadiusClients(settings(outFile), {
        loadEntries: () =>
          Promise.reject(new RadiusClientsRenderError('DATA_ENCRYPTION_KEY opens none')),
        writeFile: write,
      }),
    ).rejects.toThrow(/opens none/);
    await expect(
      renderRadiusClients(settings(outFile), {
        loadEntries: () =>
          Promise.reject(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })),
        writeFile: write,
      }),
    ).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(outFile, 'utf8')).toBe('previous\n');
  });

  it('--check validates without writing', async () => {
    const outFile = join(dir, 'ecloud-nas.conf');
    const summary = await renderRadiusClients(
      settings(outFile),
      { loadEntries: () => Promise.resolve({ entries: [entry()], skipped: [] }) },
      { checkOnly: true },
    );
    expect(summary.checkOnly).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('loadRenderSettings / describeRenderError', () => {
  const base = {
    DATABASE_URL_PLATFORM: 'postgres://u:p@db/ecloud', // check-no-secrets: allow (test value)
    DATA_ENCRYPTION_KEY: 'k'.repeat(40),
  };

  it('defaults the target file', () => {
    expect(loadRenderSettings(base).outFile).toBe(DEFAULT_RADIUS_CLIENTS_FILE);
  });

  it('rejects the dev key and short keys in production', () => {
    expect(() =>
      loadRenderSettings({
        ...base,
        NODE_ENV: 'production',
        DATA_ENCRYPTION_KEY: API_DEV_DEFAULTS.DATA_ENCRYPTION_KEY,
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadRenderSettings({ ...base, NODE_ENV: 'production', DATA_ENCRYPTION_KEY: 'k'.repeat(20) }),
    ).toThrow(/at least 32/);
  });

  it('requires an absolute target whose name FreeRADIUS includes', () => {
    expect(() => loadRenderSettings(base, 'relative.conf')).toThrow(/absolute/);
    expect(() => loadRenderSettings(base, '/x/.hidden.conf')).toThrow(/file name/);
    expect(() => loadRenderSettings(base, '/x/backup.conf~')).toThrow(/file name/);
  });

  it('never surfaces raw error messages of unknown errors (they may carry a URL)', () => {
    const error = Object.assign(new Error('postgres://u:p@db failed'), { code: 'ECONNREFUSED' }); // check-no-secrets: allow
    expect(describeRenderError(error)).toBe('Error (ECONNREFUSED)');
    expect(describeRenderError(new RadiusClientsRenderError('nas x: bad'))).toBe('nas x: bad');
  });
});
