// k6 load script (P10-B): POST /internal/aaa/authorize with the rlm_rest JSON encoding of a
// realistic Access-Request (docs/contracts/aaa-authorize.md §2). Open-model constant arrival
// rate; every request is a NEW session (unique Acct-Session-Id + MAC, so no retransmit cache
// hits). MODE=password (Argon2id verify per request) or MODE=voucher (HMAC lookup, single use).
// Run via scripts/load/run-load.sh (k6 in a container on the dev compose network).
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const fixture = JSON.parse(open(__ENV.FIXTURE || '/load/fixture.json'));
const RATE = Number(__ENV.RATE || 10);
const DURATION = __ENV.DURATION || '60s';
const MODE = __ENV.MODE || 'password';
const TARGET = __ENV.TARGET || 'http://ecloud-p10b-api:3001';
const NAME = __ENV.NAME || `authorize-${MODE}-${RATE}`;
// Vouchers are single-use: run-load.sh passes a running offset so scenarios never reuse one.
const OFFSET = Number(__ENV.OFFSET || 0);
const accepted = new Counter('aaa_accepted');
const rejected = new Counter('aaa_rejected');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    authorize: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(10, RATE * 2),
      maxVUs: Math.max(50, RATE * 10),
    },
  },
  thresholds: { 'http_req_duration{name:authorize}': ['p(95)<100'] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const s = (v) => ({ type: 'string', value: [v] });
const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0').toUpperCase();

export default function () {
  const i = exec.scenario.iterationInTest;
  const mac = ['02', '4C', hex2(i >> 16), hex2(i >> 8), hex2(i), hex2(exec.vu.idInTest)].join('-');
  const user =
    MODE === 'voucher'
      ? fixture.vouchers[(OFFSET + i) % fixture.vouchers.length]
      : fixture.users[i % fixture.users.length];
  const body = {
    'User-Name': s(user),
    'NAS-IP-Address': { type: 'ipaddr', value: [fixture.nasIp] },
    'NAS-Identifier': s(fixture.nasIdentifier),
    'NAS-Port-Type': { type: 'integer', value: ['Wireless-802.11'] },
    'Service-Type': { type: 'integer', value: ['Login-User'] },
    'Calling-Station-Id': s(mac),
    'Called-Station-Id': s('00-11-22-33-44-55'),
    'Called-Station-SSID': s('Guest'),
    'Acct-Session-Id': s(`ld${String(Date.now())}${String(i)}`),
    'Framed-IP-Address': {
      type: 'ipaddr',
      value: [`10.2.${String((i >> 8) & 255)}.${String(i & 255)}`],
    },
    'WISPr-Logoff-URL': s('http://10.1.0.1:3990/logoff'),
    'ECLOUD-Packet-Src-IP-Address': s(fixture.nasIp),
    'ECLOUD-Packet-Src-Port': { type: 'integer', value: [40000 + (i % 20000)] },
    'ECLOUD-Packet-Dst-Port': { type: 'integer', value: [1812] },
    'ECLOUD-Client-Shortname': s('load-nas'),
  };
  if (MODE === 'voucher') body['User-Password'] = s(user);
  else body['User-Password'] = s(fixture.password);
  const res = http.post(`${TARGET}/internal/aaa/authorize`, JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'x-internal-token': __ENV.TOKEN },
    tags: { name: 'authorize' },
  });
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'Accept with Class': (r) =>
      r.status === 200 && r.body.includes('control:Auth-Type') && r.body.includes('reply:Class'),
  });
  if (res.status === 200) accepted.add(1);
  else if (res.status === 401) rejected.add(1);
  return ok;
}

export function handleSummary(data) {
  return { [`/out/${NAME}.json`]: JSON.stringify(data, null, 2) };
}
