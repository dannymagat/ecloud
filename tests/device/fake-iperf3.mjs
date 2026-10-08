#!/usr/bin/env node
/* global process */
/**
 * Fake iperf3 for the device harness DRY RUN (Phase 7 P7-B AC1). It never opens a socket: it
 * prints an iperf3-shaped `-J` report computed from a scenario, so the harness and its analysis
 * can be tested without a lab device. Output from this script is NEVER evidence.
 *
 *   node tests/device/fake-iperf3.mjs --scenario '<json>' -c <host> -p <port> -J -i 1 -t <s> [-O <s>] [-R]
 *
 * Scenario (all optional): {
 *   "down_kbps": 2000, "up_kbps": 1000,      shaped rate per direction (default 50000)
 *   "cutoff_after_s": 118,                   traffic stops at this second of the run
 *   "cutoff_after_bytes": 52428800,          traffic stops once this many bytes were sent
 *   "overshoot_bytes": 0,                    extra bytes before a byte cut-off (NAS poll lag)
 *   "cut_error": true,                       report "control socket has closed" after a cut
 *   "unreachable": false                     connection refused (exit 1)
 * }
 */
const argv = process.argv.slice(2);

function opt(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const scenario = JSON.parse(opt('--scenario') ?? '{}');
const host = opt('-c') ?? '127.0.0.1';
const duration = Number(opt('-t') ?? '10');
const omit = Number(opt('-O') ?? '0');
const reverse = argv.includes('-R');

if (scenario.unreachable === true) {
  process.stdout.write(
    `${JSON.stringify({ start: {}, intervals: [], end: {}, error: `unable to connect to server - server may have stopped running or use a different port, firewall issue, etc.: Connection refused (${host})` }, null, 2)}\n`,
  );
  process.exit(1);
}

const kbps = (reverse ? scenario.down_kbps : scenario.up_kbps) ?? 50_000;
const bytesPerSecond = (kbps * 1000) / 8;
const cutAt = typeof scenario.cutoff_after_s === 'number' ? scenario.cutoff_after_s : null;
const cutBytes =
  typeof scenario.cutoff_after_bytes === 'number'
    ? scenario.cutoff_after_bytes + (scenario.overshoot_bytes ?? 0)
    : null;

const intervals = [];
let total = 0;
let cut = false;
for (let i = 0; i < omit + duration; i++) {
  const omitted = i < omit;
  const t = omitted ? i : i - omit;
  // deterministic ±1 % ripple, no randomness
  let bytes = Math.round(bytesPerSecond * (1 + (i % 2 === 0 ? 0.01 : -0.01)));
  if (!omitted && cutAt !== null && t >= cutAt) bytes = 0;
  if (!omitted && cutBytes !== null) {
    if (total >= cutBytes) bytes = 0;
    else if (total + bytes > cutBytes) bytes = cutBytes - total;
  }
  if (!omitted) {
    total += bytes;
    if (bytes === 0) cut = true;
  }
  intervals.push({
    sum: {
      start: t,
      end: t + 1,
      seconds: 1,
      bytes,
      bits_per_second: bytes * 8,
      omitted,
    },
  });
}

const counted = intervals.filter((i) => !i.sum.omitted);
const avg = counted.length === 0 ? 0 : (total * 8) / counted.length;
const report = {
  start: { test_start: { protocol: 'TCP', duration, omit, reverse: reverse ? 1 : 0 } },
  intervals,
  end: {
    sum_sent: { bytes: total, bits_per_second: avg },
    sum_received: { bytes: total, bits_per_second: avg },
  },
};
if (cut && scenario.cut_error === true) report.error = 'control socket has closed unexpectedly';
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.error ? 1 : 0);
