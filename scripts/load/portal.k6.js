// k6 load script (P10-B): captive-portal password login flow per iteration —
// GET /uam/uspot/?<signed UAM query> (303) → GET /f/{token}/login (200, CSRF) →
// POST /f/{token}/login (302 hand-off to the NAS /logon). Each iteration uses a distinct
// pre-signed redirect (new device/flow). Portal → api internal listener → Argon2id verify.
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const fixture = JSON.parse(open(__ENV.FIXTURE || '/load/fixture.json'));
const RATE = Number(__ENV.RATE || 5);
const DURATION = __ENV.DURATION || '60s';
const TARGET = __ENV.TARGET || 'http://ecloud-p10b-portal:3002';
const NAME = __ENV.NAME || `portal-login-${RATE}`;
const flowDuration = new Trend('portal_flow_duration', true);

export const options = {
  scenarios: {
    login: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(10, RATE * 4),
      maxVUs: Math.max(50, RATE * 20),
    },
  },
  // Per-step sub-metrics (thresholds only make k6 report them; they are not pass/fail gates).
  thresholds: {
    'http_req_duration{name:entry}': ['p(95)<60000'],
    'http_req_duration{name:form}': ['p(95)<60000'],
    'http_req_duration{name:login}': ['p(95)<60000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const i = exec.scenario.iterationInTest;
  const query = fixture.flows[i % fixture.flows.length];
  const t0 = Date.now();
  const entry = http.get(`${TARGET}/uam/uspot/?${query}`, {
    redirects: 0,
    tags: { name: 'entry' },
  });
  if (!check(entry, { 'entry 303': (r) => r.status === 303 })) return;
  const flow = entry.headers['Location'];
  const form = http.get(`${TARGET}${flow}/login`, { tags: { name: 'form' } });
  if (!check(form, { 'form 200': (r) => r.status === 200 })) return;
  const m = /name="csrf" value="([^"]+)"/.exec(form.body);
  const post = http.post(
    `${TARGET}${flow}/login`,
    {
      csrf: m ? m[1] : '',
      username: fixture.users[i % fixture.users.length],
      password: fixture.password,
    },
    { redirects: 0, tags: { name: 'login' } },
  );
  const ok = check(post, {
    'login 302 to NAS logon': (r) =>
      r.status === 302 && String(r.headers['Location']).startsWith('http://10.1.0.1:3990/logon'),
  });
  if (ok) flowDuration.add(Date.now() - t0);
}

export function handleSummary(data) {
  return { [`/out/${NAME}.json`]: JSON.stringify(data, null, 2) };
}
