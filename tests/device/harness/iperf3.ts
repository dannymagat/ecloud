/**
 * iperf3 client wrapper: builds the argv, runs the binary (real iperf3 or the dry-run fake) and
 * parses its `-J` JSON. iperf3 prints JSON with an `error` member even when it fails (exit 1),
 * so the parser never relies on the exit code alone.
 */
import { spawn } from 'node:child_process';
import type { Direction, Iperf3Run, Sample } from './types.js';

export interface Iperf3Request {
  readonly server: string;
  readonly port: number;
  readonly direction: Direction;
  readonly duration_s: number;
  readonly omit_s: number;
}

/** `-R` = server sends = client DOWNLOAD (PHASE2_VALIDATION.md DT-04 "-R (download)"). */
export function iperf3Args(r: Iperf3Request): string[] {
  return [
    '-c',
    r.server,
    '-p',
    String(r.port),
    '-J',
    '-i',
    '1',
    '-t',
    String(r.duration_s),
    ...(r.omit_s > 0 ? ['-O', String(r.omit_s)] : []),
    ...(r.direction === 'down' ? ['-R'] : []),
  ];
}

interface RawInterval {
  sum?: {
    start?: number;
    end?: number;
    bytes?: number;
    bits_per_second?: number;
    omitted?: boolean;
  };
}

interface RawReport {
  intervals?: RawInterval[];
  end?: {
    sum_received?: { bits_per_second?: number };
    sum_sent?: { bits_per_second?: number };
  };
  error?: string;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parses iperf3 `-J` output; unparsable output becomes an `error`. */
export function parseIperf3Json(
  stdout: string,
): Pick<Iperf3Run, 'error' | 'samples' | 'receiver_bits_per_second' | 'sender_bits_per_second'> {
  let raw: RawReport;
  try {
    raw = JSON.parse(stdout) as RawReport;
  } catch {
    return {
      error: `iperf3 output is not JSON (${stdout.slice(0, 120).trim() || 'empty'})`,
      samples: [],
      receiver_bits_per_second: null,
      sender_bits_per_second: null,
    };
  }
  const samples: Sample[] = [];
  for (const i of raw.intervals ?? []) {
    const s = i.sum;
    if (s === undefined || s.omitted === true) continue;
    const start = num(s.start);
    const end = num(s.end);
    const bytes = num(s.bytes);
    const bps = num(s.bits_per_second);
    if (start === null || end === null || bytes === null || bps === null) continue;
    samples.push({ start_s: start, end_s: end, bytes, bits_per_second: bps });
  }
  return {
    error: typeof raw.error === 'string' && raw.error !== '' ? raw.error : null,
    samples,
    receiver_bits_per_second: num(raw.end?.sum_received?.bits_per_second),
    sender_bits_per_second: num(raw.end?.sum_sent?.bits_per_second),
  };
}

export interface CommandRunner {
  (argv: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }>;
}

/** Spawns `argv[0]` without a shell; stderr is discarded (iperf3 -J reports on stdout). */
export const spawnRunner: CommandRunner = (argv, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    if (cmd === undefined) {
      reject(new Error('empty iperf3 command'));
      return;
    }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });

export async function runIperf3(
  command: readonly string[],
  request: Iperf3Request,
  runner: CommandRunner = spawnRunner,
): Promise<Iperf3Run> {
  const argv = [...command, ...iperf3Args(request)];
  // generous: run time + omit + connect/teardown
  const timeoutMs = (request.duration_s + request.omit_s + 30) * 1000;
  try {
    const { code, stdout } = await runner(argv, timeoutMs);
    return { direction: request.direction, argv, exit_code: code, ...parseIperf3Json(stdout) };
  } catch (e) {
    return {
      direction: request.direction,
      argv,
      exit_code: null,
      error: `could not run iperf3: ${e instanceof Error ? e.message : String(e)}`,
      samples: [],
      receiver_bits_per_second: null,
      sender_bits_per_second: null,
    };
  }
}
