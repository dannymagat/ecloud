/**
 * Pure normalisation of `radius.radacct_raw` rows (AAA_ARCHITECTURE.md §5.3). No I/O here so
 * every rule is unit-testable: Class parsing, status mapping, event time, MAC and
 * terminate-cause normalisation, period bucketing in the site timezone.
 */
import type { AccountingStatusType, RadiusAcctStatusType } from '@ecloud/db';
import { localDateKey, toLocal } from '@ecloud/policy-engine';
import { isUuid } from '@ecloud/shared';

/** Subset of `radius.radacct_raw` the drainer reads. */
export interface RawAccountingRow {
  radacctid: number;
  acctsessionid: string;
  acctuniqueid: string;
  username: string | null;
  nasipaddress: string;
  nasidentifier: string | null;
  nasportid: string | null;
  acctsessiontime: number | null;
  acctinputoctets: number | null;
  acctoutputoctets: number | null;
  acctinterval: number | null;
  calledstationid: string | null;
  callingstationid: string | null;
  acctterminatecause: string | null;
  framedipaddress: string | null;
  class: string | null;
  acctstatustype: RadiusAcctStatusType;
  eventtimestamp: Date | null;
  acctdelaytime: number | null;
  received_at: Date;
  /** Authenticated UDP source (migration 014); null on rows written before it. */
  packet_src_ip: string | null;
}

export interface NormalizedAccounting {
  radacctId: number;
  statusType: AccountingStatusType;
  acctSessionId: string;
  acctUniqueId: string;
  /** NAS-IP-Address as sent by the NAS: stored for display, never used for attribution. */
  nasIp: string;
  /** Authenticated packet source: the only key that resolves the NAS / tenant. */
  packetSrcIp: string | null;
  nasIdentifier: string | null;
  nasPortId: string | null;
  username: string | null;
  callingStationId: string | null;
  calledStationId: string | null;
  framedIp: string | null;
  mac: string | null;
  /** Session UUID carried in `Class` (`ai:<32 hex>`), or null. */
  classSessionId: string | null;
  /** Event-Timestamp, else received_at − Acct-Delay-Time. Stored for display. */
  eventTime: Date;
  receivedAt: Date;
  /** Time used for billing buckets: eventTime within ±5 min of receipt, else receipt time. */
  effectiveTime: Date;
  inputOctets: number;
  outputOctets: number;
  sessionTimeS: number;
  terminateCause: string | null;
  interimIntervalS: number | null;
}

export const EVENT_TIME_TOLERANCE_MS = 5 * 60 * 1000;

const STATUS_MAP: Readonly<Record<RadiusAcctStatusType, AccountingStatusType>> = {
  Start: 'start',
  'Interim-Update': 'interim',
  Stop: 'stop',
  'Accounting-On': 'accounting_on',
  'Accounting-Off': 'accounting_off',
};

export function mapStatusType(value: RadiusAcctStatusType): AccountingStatusType {
  const mapped = STATUS_MAP[value];
  if (mapped === undefined) throw new Error(`unknown Acct-Status-Type: ${String(value)}`);
  return mapped;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function hexToUuid(hex: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return uuid !== NIL_UUID && isUuid(uuid) ? uuid : null;
}

/**
 * Parses the ECLOUD `Class` convention (docs/contracts/aaa-authorize.md §3 rule 5): ASCII
 * `ai:` + 32 lowercase hex digits of the session UUID. FreeRADIUS writes the octets attribute
 * as `0x61693a<64 hex>`; the legacy 16-raw-byte form `0x61693a<32 hex>` and a plain `ai:<hex>`
 * string are accepted too. The nil UUID (lab placeholder) and anything else yield null.
 */
export function parseClassSessionId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  const plain = /^ai:([0-9a-fA-F]{32})$/.exec(trimmed);
  if (plain?.[1] !== undefined) return hexToUuid(plain[1].toLowerCase());
  const hex = /^0x61693a([0-9a-fA-F]+)$/i.exec(trimmed);
  if (hex?.[1] === undefined) return null;
  const body = hex[1].toLowerCase();
  if (body.length === 32) return hexToUuid(body);
  if (body.length === 64) {
    const ascii = Buffer.from(body, 'hex').toString('latin1');
    return /^[0-9a-f]{32}$/.test(ascii) ? hexToUuid(ascii) : null;
  }
  return null;
}

/** `AA-BB-CC-DD-EE-FF`, `aa:bb:…`, `aabb.ccdd.eeff`, `AABBCCDDEEFF` → `aa:bb:cc:dd:ee:ff`; else null. */
export function normalizeMacAddress(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const hex = value.trim().toLowerCase().replace(/[-:.]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return hex.match(/../g)?.join(':') ?? null;
}

/** `Session-Timeout` → `session_timeout`; empty → null. */
export function normalizeTerminateCause(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized === '' ? null : normalized;
}

function nonNegative(value: number | null): number {
  return value !== null && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function deriveTimes(
  eventTimestamp: Date | null,
  receivedAt: Date,
  delayS: number | null,
): { eventTime: Date; effectiveTime: Date } {
  const fallback = new Date(receivedAt.getTime() - nonNegative(delayS) * 1000);
  const eventTime = eventTimestamp ?? fallback;
  const skew = Math.abs(eventTime.getTime() - receivedAt.getTime());
  return { eventTime, effectiveTime: skew <= EVENT_TIME_TOLERANCE_MS ? eventTime : fallback };
}

export function normalizeAccounting(row: RawAccountingRow): NormalizedAccounting {
  const { eventTime, effectiveTime } = deriveTimes(
    row.eventtimestamp,
    row.received_at,
    row.acctdelaytime,
  );
  return {
    radacctId: row.radacctid,
    statusType: mapStatusType(row.acctstatustype),
    acctSessionId: row.acctsessionid,
    acctUniqueId: row.acctuniqueid,
    nasIp: row.nasipaddress,
    packetSrcIp: row.packet_src_ip,
    nasIdentifier: row.nasidentifier,
    nasPortId: row.nasportid,
    username: row.username,
    callingStationId: row.callingstationid,
    calledStationId: row.calledstationid,
    framedIp: row.framedipaddress,
    mac: normalizeMacAddress(row.callingstationid),
    classSessionId: parseClassSessionId(row.class),
    eventTime,
    receivedAt: row.received_at,
    effectiveTime,
    inputOctets: nonNegative(row.acctinputoctets),
    outputOctets: nonNegative(row.acctoutputoctets),
    sessionTimeS: nonNegative(row.acctsessiontime),
    terminateCause: normalizeTerminateCause(row.acctterminatecause),
    interimIntervalS: row.acctinterval !== null && row.acctinterval > 0 ? row.acctinterval : null,
  };
}

export interface SessionCounters {
  inputOctets: number;
  outputOctets: number;
  sessionTimeS: number;
}

/**
 * Delta between the counters stored on the session and a new record. Counters are monotonic
 * per session (DATABASE_DESIGN.md §5): a retransmitted or out-of-order packet yields 0, never
 * a negative number.
 */
export function counterDelta(stored: SessionCounters, incoming: SessionCounters): SessionCounters {
  return {
    inputOctets: Math.max(0, incoming.inputOctets - stored.inputOctets),
    outputOctets: Math.max(0, incoming.outputOctets - stored.outputOctets),
    sessionTimeS: Math.max(0, incoming.sessionTimeS - stored.sessionTimeS),
  };
}

export function maxCounters(a: SessionCounters, b: SessionCounters): SessionCounters {
  return {
    inputOctets: Math.max(a.inputOctets, b.inputOctets),
    outputOctets: Math.max(a.outputOctets, b.outputOctets),
    sessionTimeS: Math.max(a.sessionTimeS, b.sessionTimeS),
  };
}

export const TOTAL_PERIOD_START = '1970-01-01';

export interface PeriodStarts {
  daily: string;
  monthly: string;
  total: string;
}

/** `usage_counters.period_start` values for `at` in the site's IANA timezone (D6). */
export function periodStarts(at: Date, timeZone: string): PeriodStarts {
  const local = toLocal(at, timeZone);
  return {
    daily: localDateKey(at, timeZone),
    monthly: `${String(local.year)}-${String(local.month).padStart(2, '0')}-01`,
    total: TOTAL_PERIOD_START,
  };
}
