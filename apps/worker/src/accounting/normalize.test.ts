import { describe, expect, it } from 'vitest';
import {
  EVENT_TIME_TOLERANCE_MS,
  counterDelta,
  deriveTimes,
  mapStatusType,
  maxCounters,
  normalizeAccounting,
  normalizeMacAddress,
  normalizeTerminateCause,
  parseClassSessionId,
  periodStarts,
  type RawAccountingRow,
} from './normalize.js';

const SESSION_UUID = '0199b0a4-5c3e-7d2a-9f10-1234567890ab';
const HEX32 = SESSION_UUID.replace(/-/g, '');
const asciiHex = (s: string) => Buffer.from(s, 'latin1').toString('hex');

function raw(overrides: Partial<RawAccountingRow> = {}): RawAccountingRow {
  return {
    radacctid: 1,
    acctsessionid: 'sess-1',
    acctuniqueid: 'uniq-1',
    username: 'pc-alice',
    nasipaddress: '192.0.2.10',
    nasidentifier: 'nas-1',
    nasportid: null,
    acctsessiontime: null,
    acctinputoctets: null,
    acctoutputoctets: null,
    acctinterval: null,
    calledstationid: '00-11-22-33-44-55:lab-uam',
    callingstationid: 'AA-BB-CC-DD-EE-FF',
    acctterminatecause: null,
    framedipaddress: '192.0.2.100',
    class: `0x61693a${asciiHex(HEX32)}`,
    acctstatustype: 'Start',
    eventtimestamp: new Date('2026-01-01T00:00:00Z'),
    acctdelaytime: 0,
    received_at: new Date('2026-01-01T00:00:01Z'),
    ...overrides,
  };
}

describe('parseClassSessionId', () => {
  it('decodes the FreeRADIUS hex rendering of ASCII "ai:<32 hex>"', () => {
    expect(parseClassSessionId(`0x61693a${asciiHex(HEX32)}`)).toBe(SESSION_UUID);
  });
  it('accepts the plain string form and upper-case hex', () => {
    expect(parseClassSessionId(`ai:${HEX32}`)).toBe(SESSION_UUID);
    expect(parseClassSessionId(`0X61693A${asciiHex(HEX32).toUpperCase()}`)).toBe(SESSION_UUID);
  });
  it('accepts the legacy 16-raw-byte form', () => {
    expect(parseClassSessionId(`0x61693a${HEX32}`)).toBe(SESSION_UUID);
  });
  it('rejects the nil placeholder, foreign classes and malformed values', () => {
    expect(parseClassSessionId('ai:00000000000000000000000000000000')).toBeNull();
    expect(parseClassSessionId(`0x61693a${asciiHex('0'.repeat(32))}`)).toBeNull();
    expect(parseClassSessionId('0x0102030405')).toBeNull();
    expect(parseClassSessionId(`0x61693a${asciiHex('zz'.repeat(16))}`)).toBeNull();
    expect(parseClassSessionId('ai:1234')).toBeNull();
    expect(parseClassSessionId(null)).toBeNull();
    expect(parseClassSessionId(undefined)).toBeNull();
    // not a valid RFC 9562 version nibble
    expect(parseClassSessionId(`ai:${'1'.repeat(12)}0${'1'.repeat(19)}`)).toBeNull();
  });
});

describe('field normalisation', () => {
  it('maps every Acct-Status-Type', () => {
    expect(mapStatusType('Start')).toBe('start');
    expect(mapStatusType('Interim-Update')).toBe('interim');
    expect(mapStatusType('Stop')).toBe('stop');
    expect(mapStatusType('Accounting-On')).toBe('accounting_on');
    expect(mapStatusType('Accounting-Off')).toBe('accounting_off');
    expect(() => mapStatusType('Bogus' as never)).toThrow(/unknown/);
  });
  it('normalises MAC addresses from Calling-Station-Id formats', () => {
    expect(normalizeMacAddress('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMacAddress('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMacAddress('AABBCCDDEEFF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMacAddress('not-a-mac')).toBeNull();
    expect(normalizeMacAddress(null)).toBeNull();
  });
  it('normalises terminate causes', () => {
    expect(normalizeTerminateCause('Session-Timeout')).toBe('session_timeout');
    expect(normalizeTerminateCause(' Admin-Reset ')).toBe('admin_reset');
    expect(normalizeTerminateCause('')).toBeNull();
    expect(normalizeTerminateCause(null)).toBeNull();
  });
});

describe('deriveTimes', () => {
  const received = new Date('2026-01-01T00:10:00Z');
  it('uses Event-Timestamp when within tolerance', () => {
    const event = new Date(received.getTime() - 60_000);
    expect(deriveTimes(event, received, 0)).toEqual({ eventTime: event, effectiveTime: event });
  });
  it('falls back to received_at − Acct-Delay-Time for skewed NAS clocks', () => {
    const event = new Date(received.getTime() - EVENT_TIME_TOLERANCE_MS - 1);
    const out = deriveTimes(event, received, 30);
    expect(out.eventTime).toEqual(event);
    expect(out.effectiveTime).toEqual(new Date(received.getTime() - 30_000));
  });
  it('derives the event time from the delay when no timestamp is present', () => {
    const out = deriveTimes(null, received, 12);
    expect(out.eventTime).toEqual(new Date(received.getTime() - 12_000));
    expect(out.effectiveTime).toEqual(out.eventTime);
  });
});

describe('normalizeAccounting', () => {
  it('normalises a Stop shaped like infra/freeradius/test/acct-stop.txt (Gigawords folded)', () => {
    const rec = normalizeAccounting(
      raw({
        radacctid: 7,
        acctstatustype: 'Stop',
        acctsessiontime: 3600,
        acctinputoctets: 2_097_152,
        acctoutputoctets: 2 ** 32 + 987_654_321,
        acctterminatecause: 'Session-Timeout',
        acctinterval: 300,
      }),
    );
    expect(rec).toMatchObject({
      radacctId: 7,
      statusType: 'stop',
      classSessionId: SESSION_UUID,
      mac: 'aa:bb:cc:dd:ee:ff',
      inputOctets: 2_097_152,
      outputOctets: 2 ** 32 + 987_654_321,
      sessionTimeS: 3600,
      terminateCause: 'session_timeout',
      interimIntervalS: 300,
    });
  });
  it('treats missing or negative counters as 0', () => {
    const rec = normalizeAccounting(raw({ acctinputoctets: -5, acctoutputoctets: null }));
    expect(rec.inputOctets).toBe(0);
    expect(rec.outputOctets).toBe(0);
    expect(rec.interimIntervalS).toBeNull();
  });
});

describe('counter deltas (retransmits and reordering)', () => {
  const stored = { inputOctets: 1000, outputOctets: 5000, sessionTimeS: 600 };
  it('a new interim yields the positive difference', () => {
    expect(
      counterDelta(stored, { inputOctets: 1500, outputOctets: 9000, sessionTimeS: 900 }),
    ).toEqual({
      inputOctets: 500,
      outputOctets: 4000,
      sessionTimeS: 300,
    });
  });
  it('a retransmitted interim yields zero', () => {
    expect(counterDelta(stored, { ...stored })).toEqual({
      inputOctets: 0,
      outputOctets: 0,
      sessionTimeS: 0,
    });
  });
  it('an out-of-order (older) interim never decreases counters', () => {
    const older = { inputOctets: 800, outputOctets: 4000, sessionTimeS: 300 };
    expect(counterDelta(stored, older)).toEqual({
      inputOctets: 0,
      outputOctets: 0,
      sessionTimeS: 0,
    });
    expect(maxCounters(stored, older)).toEqual(stored);
  });
});

describe('periodStarts (site timezone buckets)', () => {
  it('buckets by the local calendar date, not UTC', () => {
    // 2026-01-31 22:30 UTC = 2026-02-01 02:30 in Asia/Dubai (UTC+4)
    const at = new Date('2026-01-31T22:30:00Z');
    expect(periodStarts(at, 'Asia/Dubai')).toEqual({
      daily: '2026-02-01',
      monthly: '2026-02-01',
      total: '1970-01-01',
    });
    expect(periodStarts(at, 'UTC')).toEqual({
      daily: '2026-01-31',
      monthly: '2026-01-01',
      total: '1970-01-01',
    });
  });
  it('handles the DST spring-forward day in America/New_York', () => {
    // 2026-03-08: clocks jump 02:00 → 03:00 EST→EDT (UTC−5 → UTC−4)
    expect(periodStarts(new Date('2026-03-08T04:59:59Z'), 'America/New_York').daily).toBe(
      '2026-03-07',
    );
    expect(periodStarts(new Date('2026-03-08T05:00:00Z'), 'America/New_York').daily).toBe(
      '2026-03-08',
    );
    // 23:59 EDT on the 8th is 03:59 UTC on the 9th
    expect(periodStarts(new Date('2026-03-09T03:59:00Z'), 'America/New_York').daily).toBe(
      '2026-03-08',
    );
    expect(periodStarts(new Date('2026-03-09T04:00:00Z'), 'America/New_York').daily).toBe(
      '2026-03-09',
    );
  });
  it('handles the DST fall-back day in Europe/Berlin', () => {
    // 2026-10-25: 03:00 CEST → 02:00 CET; midnight of the 26th is 23:00 UTC on the 25th
    expect(periodStarts(new Date('2026-10-25T22:59:59Z'), 'Europe/Berlin').daily).toBe(
      '2026-10-25',
    );
    expect(periodStarts(new Date('2026-10-25T23:00:00Z'), 'Europe/Berlin').daily).toBe(
      '2026-10-26',
    );
    expect(periodStarts(new Date('2026-10-31T23:00:00Z'), 'Europe/Berlin').monthly).toBe(
      '2026-11-01',
    );
  });
});
