/**
 * Drives the dev-stack FreeRADIUS container (infra/compose/docker-compose.dev.yml) for the
 * aaa-contract suite: `docker compose exec -T freeradius radclient ...` fed with the attribute
 * files from infra/freeradius/test/. Nothing here starts, stops or rebuilds containers.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT_DIR = resolve(import.meta.dirname, '..', '..');
export const RADIUS_FIXTURE_DIR = resolve(ROOT_DIR, 'infra', 'freeradius', 'test');
export const COMPOSE_FILE_ENV = 'ECLOUD_TEST_COMPOSE_FILE';
export const RADIUS_GATE_ENV = 'ECLOUD_TEST_RADIUS';

export function composeFile(env: NodeJS.ProcessEnv = process.env): string {
  return env[COMPOSE_FILE_ENV]?.trim() || resolve(ROOT_DIR, 'infra/compose/docker-compose.dev.yml');
}

function composeArgs(args: string[]): string[] {
  return ['compose', '--project-directory', ROOT_DIR, '-f', composeFile(), ...args];
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `docker compose ... <args>` synchronously (short commands only). */
export function compose(args: string[], timeoutMs = 15_000): CommandResult {
  const result = spawnSync('docker', composeArgs(args), {
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd: ROOT_DIR,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export type RadiusGate = { ok: true } | { ok: false; reason: string };

/**
 * The suite runs only when `ECLOUD_TEST_RADIUS=1`, docker answers and the freeradius service
 * of the compose project is running. Anything else is a clean skip with a reason.
 */
export function radiusGate(env: NodeJS.ProcessEnv = process.env): RadiusGate {
  if (env[RADIUS_GATE_ENV] !== '1') {
    return { ok: false, reason: `${RADIUS_GATE_ENV}=1 not set` };
  }
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (docker.status !== 0) return { ok: false, reason: 'docker daemon not reachable' };
  const ps = compose(['ps', '--status', 'running', '--services']);
  if (ps.status !== 0 || !ps.stdout.split('\n').includes('freeradius')) {
    return { ok: false, reason: 'freeradius service not running (npm run dev:stack)' };
  }
  return { ok: true };
}

/** `printenv NAME` inside the freeradius container (trimmed, '' when unset). */
export function containerEnv(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`bad env name ${name}`);
  const result = compose(['exec', '-T', 'freeradius', 'printenv', name]);
  return result.status === 0 ? result.stdout.trim() : '';
}

/** Reads `infra/freeradius/test/<name>` and applies literal replacements. */
export function fixture(name: string, replacements: Record<string, string> = {}): string {
  let text = readFileSync(resolve(RADIUS_FIXTURE_DIR, name), 'utf8');
  for (const [from, to] of Object.entries(replacements)) text = text.split(from).join(to);
  return text;
}

/** Value of `Attribute = value` in an attribute file (quotes stripped). */
export function fixtureAttribute(text: string, attribute: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z0-9-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === attribute) return match[2]?.replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

export interface RadclientOptions {
  /** `auth` (1812) or `acct` (1813). */
  type: 'auth' | 'acct';
  /** Shell expression for the shared secret evaluated in the container (default the dev client secret). */
  secretExpr?: string;
  timeoutS?: number;
  retries?: number;
}

export interface RadclientReply {
  status: number | null;
  output: string;
  /** `Access-Accept`, `Access-Reject`, `Accounting-Response` or `undefined` (no reply). */
  code: string | undefined;
  /** Attributes of the received packet (`Name` -> values, quotes stripped). */
  attributes: Record<string, string[]>;
}

/** Parses `radclient -x` output: the block after "Received <Code> ..." holds the reply attributes. */
export function parseRadclient(output: string): Pick<RadclientReply, 'code' | 'attributes'> {
  const lines = output.split('\n');
  let code: string | undefined;
  const attributes: Record<string, string[]> = {};
  let inReply = false;
  for (const line of lines) {
    const received = /Received ([A-Za-z-]+) Id /.exec(line);
    if (received) {
      code = received[1];
      inReply = true;
      continue;
    }
    if (/^\s*Sent /.test(line) || /^\(\d+\) -: Expected/.test(line)) inReply = false;
    if (!inReply) continue;
    // Tagged attributes (RFC 2868 Tunnel-*) print as `Name:<tag> = value`.
    const attr = /^\s+([A-Za-z0-9-]+)(?::\d+)? = (.*)$/.exec(line);
    if (attr?.[1] !== undefined && attr[2] !== undefined) {
      const value = attr[2].replace(/^"(.*)"$/, '$1');
      (attributes[attr[1]] ??= []).push(value);
    }
  }
  return { code, attributes };
}

/**
 * Sends one attribute file with radclient INSIDE the freeradius container to its own address
 * (the dev client CIDR covers it; infra/freeradius/test/README.md).
 */
export function radclient(packet: string, options: RadclientOptions): Promise<RadclientReply> {
  const port = options.type === 'auth' ? 1812 : 1813;
  const secret = options.secretExpr ?? '"$RADIUS_DEV_CLIENT_SECRET"';
  const timeout = options.timeoutS ?? 3;
  const retries = options.retries ?? 1;
  const script = `radclient -x -r ${String(retries)} -t ${String(timeout)} "$(hostname -i)":${String(port)} ${options.type} ${secret}`;
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', composeArgs(['exec', '-T', 'freeradius', 'sh', '-c', script]), {
      cwd: ROOT_DIR,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const killer = setTimeout(() => child.kill('SIGKILL'), (timeout * (retries + 1) + 15) * 1000);
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(killer);
      resolvePromise({ status, output, ...parseRadclient(output) });
    });
    child.stdin.end(packet);
  });
}
