/**
 * Exit-code contract of infra/vps-local/scripts/radius-reload-watch.sh.
 *
 * The watcher runs from cron every 60 s, so its reading of reload-radius.sh's exit code
 * decides whether a reload is retried. reload-radius.sh exit 3 means "clients.conf was
 * written and FreeRADIUS WAS restarted, some invalid NAS rows were skipped": treating it
 * as a failure keeps the Redis signal and restarts FreeRADIUS every minute for as long as
 * one bad NAS row exists, each restart a brief authentication outage.
 *
 * The watcher is driven here with a stub `redis-cli` on PATH and a stub reload-radius.sh
 * beside a copy of the watcher (it resolves that script from its own directory). No Redis,
 * no Docker, no host access.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const WATCHER_SRC = resolve(
  import.meta.dirname,
  '../../infra/vps-local/scripts/radius-reload-watch.sh',
);
const PENDING_KEY = 'radius:clients:reload_pending';
const ATTEMPT_KEY = 'radius:clients:reload_attempts';

/** Password only ever reaches redis-cli through REDISCLI_AUTH, never argv. */
const REDIS_PASSWORD = 'stub-redis-password';

interface Harness {
  dir: string;
  run: (env?: Record<string, string>) => { status: number | null; stdout: string; stderr: string };
  state: (key: string) => string | null;
  setState: (key: string, value: string) => void;
  argvLog: () => string;
  reloadRan: () => boolean;
}

const made: string[] = [];

/**
 * @param reloadExit exit code the stub reload-radius.sh returns.
 */
function harness(reloadExit: number): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ecloud-reload-watch-'));
  made.push(dir);
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  const pathDir = join(dir, 'path');
  for (const d of [binDir, stateDir, pathDir]) mkdirSync(d, { recursive: true });

  const watcher = join(binDir, 'radius-reload-watch.sh');
  copyFileSync(WATCHER_SRC, watcher);
  chmodSync(watcher, 0o755);

  // Stub reload-radius.sh: records that it ran, then returns the code under test.
  const reloadMarker = join(stateDir, 'reload-ran');
  const reload = join(binDir, 'reload-radius.sh');
  writeFileSync(
    reload,
    `#!/usr/bin/env bash\ntouch ${JSON.stringify(reloadMarker)}\nexit ${reloadExit}\n`,
  );
  chmodSync(reload, 0o755);

  // Stub redis-cli: a file-backed GET/DEL/INCR/EXPIRE, logging argv and REDISCLI_AUTH so the
  // test can prove the password never appears on the command line.
  const argvLog = join(stateDir, 'argv.log');
  const stub = join(pathDir, 'redis-cli');
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      `printf 'ARGV %s | AUTH_ENV %s\\n' "$*" "\${REDISCLI_AUTH:-<unset>}" >> ${JSON.stringify(argvLog)}`,
      `STATE=${JSON.stringify(stateDir)}`,
      'args=()',
      'while [[ $# -gt 0 ]]; do',
      '  case "$1" in',
      '    -h|-p|-n|-a) shift 2 ;;',
      '    --no-auth-warning) shift ;;',
      '    *) args+=("$1"); shift ;;',
      '  esac',
      'done',
      'cmd="${args[0]:-}"; key="${args[1]:-}"',
      'file="$STATE/${key//:/_}"',
      'case "$cmd" in',
      '  GET) [[ -f "$file" ]] && cat "$file" || true ;;',
      '  DEL) rm -f "$file" ;;',
      '  INCR) n=0; [[ -f "$file" ]] && n="$(cat "$file")"; n=$((n + 1)); printf "%s" "$n" > "$file"; echo "$n" ;;',
      '  EXPIRE) : ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(stub, 0o755);

  const fileFor = (key: string) => join(stateDir, key.replaceAll(':', '_'));

  return {
    dir,
    run: (env = {}) => {
      const r = spawnSync('bash', [watcher], {
        encoding: 'utf8',
        env: {
          PATH: `${pathDir}:${process.env.PATH ?? ''}`,
          REDIS_URL: `redis://:${REDIS_PASSWORD}@127.0.0.1:6379/0`,
          ...env,
        },
      });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    state: (key) => {
      try {
        return readFileSync(fileFor(key), 'utf8');
      } catch {
        return null;
      }
    },
    setState: (key, value) => writeFileSync(fileFor(key), value),
    argvLog: () => {
      try {
        return readFileSync(argvLog, 'utf8');
      } catch {
        return '';
      }
    },
    reloadRan: () => {
      try {
        readFileSync(reloadMarker);
        return true;
      } catch {
        return false;
      }
    },
  };
}

afterEach(() => {
  made.length = 0;
});

describe('radius-reload-watch.sh', () => {
  it('does nothing when no reload is pending', () => {
    const h = harness(0);
    const r = h.run();
    expect(r.status).toBe(0);
    expect(h.reloadRan()).toBe(false);
  });

  it('consumes the signal when the reload succeeds', () => {
    const h = harness(0);
    h.setState(PENDING_KEY, '2026-10-12T00:00:00Z');
    const r = h.run();
    expect(r.status).toBe(0);
    expect(h.reloadRan()).toBe(true);
    expect(h.state(PENDING_KEY)).toBeNull();
  });

  it('consumes the signal on exit 3 (reloaded, some NAS rows skipped)', () => {
    // The regression this test exists for: retrying exit 3 restarts FreeRADIUS every
    // minute for as long as one invalid NAS row exists.
    const h = harness(3);
    h.setState(PENDING_KEY, '2026-10-12T00:00:00Z');
    const r = h.run();
    expect(r.status).toBe(0);
    expect(h.state(PENDING_KEY)).toBeNull();
    expect(h.state(ATTEMPT_KEY)).toBeNull();
    expect(r.stdout).toMatch(/skipped NAS rows/);
  });

  it('keeps the signal and counts the attempt when the reload fails', () => {
    const h = harness(1);
    h.setState(PENDING_KEY, '2026-10-12T00:00:00Z');
    const r = h.run();
    expect(r.status).toBe(1);
    expect(h.state(PENDING_KEY)).not.toBeNull();
    expect(h.state(ATTEMPT_KEY)).toBe('1');
  });

  it('stops retrying once the attempt cap is reached', () => {
    const h = harness(1);
    h.setState(PENDING_KEY, '2026-10-12T00:00:00Z');
    h.setState(ATTEMPT_KEY, '5');
    const r = h.run({ ECLOUD_RELOAD_MAX_ATTEMPTS: '5' });
    // Exit 0 so cron stops mailing; the pending key is kept so the reload stays visible.
    expect(r.status).toBe(0);
    expect(h.reloadRan()).toBe(false);
    expect(h.state(PENDING_KEY)).not.toBeNull();
    expect(r.stdout).toMatch(/not retrying/);
  });

  it('passes the Redis password through REDISCLI_AUTH, never argv', () => {
    const h = harness(0);
    h.setState(PENDING_KEY, '2026-10-12T00:00:00Z');
    h.run();
    const log = h.argvLog();
    expect(log).not.toContain(`ARGV`.concat(' ').concat('-a'));
    expect(log).not.toContain(REDIS_PASSWORD.concat(' |'));
    expect(log).toMatch(new RegExp(`AUTH_ENV ${REDIS_PASSWORD}`));
  });
});
