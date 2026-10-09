// Summarises scripts/load/run-load.sh output: k6 JSON summaries + `docker stats` samples.
// usage: node summarize.mjs <out-dir> "<scenario list>"   → JSON on stdout
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const [dir, list] = process.argv.slice(2);
const scenarios = (list ?? '').split(/\s+/).filter(Boolean);
const toMiB = (s) => {
  const m = /([\d.]+)\s*([KMG]i?B)/.exec(s ?? '');
  if (!m) return 0;
  const v = Number(m[1]);
  return m[2].startsWith('G') ? v * 1024 : m[2].startsWith('K') ? v / 1024 : v;
};
const stats = existsSync(join(dir, 'stats.csv'))
  ? readFileSync(join(dir, 'stats.csv'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(','))
  : [];
const round = (v, d = 1) => (v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(d)));
const pick = (m) =>
  m === undefined
    ? null
    : {
        p50: round(m.values.med),
        p95: round(m.values['p(95)']),
        p99: round(m.values['p(99)']),
        avg: round(m.values.avg),
        max: round(m.values.max),
      };

const out = [];
for (const name of scenarios.map((s) => s.replace(':', '-'))) {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) {
    out.push({ scenario: name, error: 'no k6 summary' });
    continue;
  }
  const k = JSON.parse(readFileSync(file, 'utf8')).metrics;
  const rows = stats.filter((r) => r[0] === name);
  const containers = {};
  for (const [, cname, cpu, mem] of rows) {
    const c = (containers[cname] ??= { cpu: [], mem: [] });
    c.cpu.push(Number(String(cpu).replace('%', '')));
    c.mem.push(toMiB(mem));
  }
  const res = Object.fromEntries(
    Object.entries(containers).map(([cname, v]) => [
      cname,
      {
        samples: v.cpu.length,
        cpu_avg_pct: round(v.cpu.reduce((a, b) => a + b, 0) / v.cpu.length),
        cpu_max_pct: round(Math.max(...v.cpu)),
        mem_max_mib: round(Math.max(...v.mem)),
      },
    ]),
  );
  const isPortal = name.startsWith('portal');
  out.push({
    scenario: name,
    requests: k.http_reqs?.values.count,
    req_rate: round(k.http_reqs?.values.rate, 2),
    iterations: k.iterations?.values.count,
    dropped_iterations: k.dropped_iterations?.values.count ?? 0,
    error_rate_pct: round((k.http_req_failed?.values.rate ?? 0) * 100, 2),
    checks_pass_pct: round((k.checks?.values.rate ?? 0) * 100, 2),
    latency_ms: isPortal
      ? {
          flow: pick(k.portal_flow_duration),
          entry: pick(k['http_req_duration{name:entry}']),
          form: pick(k['http_req_duration{name:form}']),
          login: pick(k['http_req_duration{name:login}']),
        }
      : pick(k['http_req_duration{name:authorize}']),
    accepted: k.aaa_accepted?.values.count,
    rejected: k.aaa_rejected?.values.count ?? 0,
    containers: res,
  });
}
let oom = '';
try {
  oom = readFileSync(join(dir, 'oom.txt'), 'utf8').trim();
} catch {
  oom = 'n/a';
}
const metrics = existsSync(join(dir, 'api-metrics.txt'))
  ? readFileSync(join(dir, 'api-metrics.txt'), 'utf8')
  : '';
const decisions = metrics
  .split('\n')
  .filter((l) => l.startsWith('ecloud_aaa_authorize_decisions_total{'));
process.stdout.write(
  `${JSON.stringify({ scenarios: out, oom_killed_restarts: oom, api_metrics_decisions: decisions }, null, 2)}\n`,
);
