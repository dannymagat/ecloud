/**
 * radclient wrapper for RFC 5176 Disconnect / CoA (AAA_ARCHITECTURE.md §6). The shared secret
 * is written to a 0600 file inside a fresh 0700 temp directory, passed with `-S <file>` (never
 * on the command line) and deleted afterwards. The process is injected (`RadclientRunner`) so
 * the dispatcher is unit-tested with a fake.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RadiusAttribute } from '@ecloud/adapters';

export type RadclientCommand = 'disconnect' | 'coa';

export interface RadclientExecution {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the process was killed by our own timeout. */
  killed: boolean;
}

export type RadclientRunner = (
  path: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
) => Promise<RadclientExecution>;

export const spawnRadclient: RadclientRunner = (path, args, stdin, timeoutMs) =>
  new Promise((resolve) => {
    const child = execFile(
      path,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        resolve({
          exitCode: err === null ? 0 : typeof err.code === 'number' ? err.code : null,
          stdout,
          stderr: err !== null && stderr === '' ? err.message : stderr,
          killed: err?.killed === true,
        });
      },
    );
    child.stdin?.end(stdin);
  });

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const HEX_RE = /^0x[0-9a-fA-F]+$/;

function formatValue(value: string | number): string {
  if (typeof value === 'number') return String(value);
  return HEX_RE.test(value) ? value : quote(value);
}

/** radclient attribute file: `Name = value` per line; strings quoted, numbers and 0x… octets bare. */
export function formatAttributes(attributes: readonly RadiusAttribute[]): string {
  return attributes.map((a) => `${a.name} = ${formatValue(a.value)}`).join('\n') + '\n';
}

export type RadclientOutcome =
  | { result: 'ack' }
  | { result: 'nak'; errorCause: string | null }
  | { result: 'timeout' }
  | { result: 'error'; message: string };

const REPLY_RE = /Received (?:Disconnect|CoA)-(ACK|NAK)\b/;
const ERROR_CAUSE_RE = /Error-Cause\s*=\s*([^\s]+)/;

/**
 * Interprets radclient output. Success is ONLY a literal `Received Disconnect-ACK` /
 * `Received CoA-ACK` line with exit code 0 (D-006: never record success without a real ACK).
 */
export function parseRadclientOutput(execution: RadclientExecution): RadclientOutcome {
  const text = `${execution.stdout}\n${execution.stderr}`;
  const reply = REPLY_RE.exec(text);
  if (reply?.[1] === 'ACK' && execution.exitCode === 0) return { result: 'ack' };
  if (reply?.[1] === 'NAK') {
    return { result: 'nak', errorCause: ERROR_CAUSE_RE.exec(text)?.[1] ?? null };
  }
  if (execution.killed || /No reply from server/i.test(text)) return { result: 'timeout' };
  const firstLine = (execution.stderr.trim() || execution.stdout.trim()).split('\n')[0] ?? '';
  return {
    result: 'error',
    message: firstLine === '' ? `radclient exited with ${String(execution.exitCode)}` : firstLine,
  };
}

export interface SendOptions {
  radclientPath: string;
  host: string;
  port: number;
  command: RadclientCommand;
  secret: string;
  attributes: readonly RadiusAttribute[];
  timeoutS: number;
  retries: number;
  runner?: RadclientRunner;
}

export function radclientArgs(
  secretFile: string,
  opts: Pick<SendOptions, 'host' | 'port' | 'command' | 'timeoutS' | 'retries'>,
): string[] {
  const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  return [
    '-x',
    '-r',
    String(Math.max(1, opts.retries)),
    '-t',
    String(opts.timeoutS),
    '-S',
    secretFile,
    `${host}:${String(opts.port)}`,
    opts.command,
  ];
}

export async function sendDynamicAuthorization(opts: SendOptions): Promise<RadclientOutcome> {
  const runner = opts.runner ?? spawnRadclient;
  const dir = await mkdtemp(join(tmpdir(), 'ecloud-coa-'));
  const secretFile = join(dir, 'secret');
  try {
    await writeFile(secretFile, `${opts.secret}\n`, { mode: 0o600, flag: 'wx' });
    const args = radclientArgs(secretFile, opts);
    const budgetMs = (Math.max(1, opts.retries) * opts.timeoutS + 5) * 1000;
    const execution = await runner(
      opts.radclientPath,
      args,
      formatAttributes(opts.attributes),
      budgetMs,
    );
    return parseRadclientOutput(execution);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
