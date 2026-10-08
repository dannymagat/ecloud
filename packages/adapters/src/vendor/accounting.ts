/**
 * Pure accounting normalisation (AAA_ARCHITECTURE.md §5.3), the single implementation used by
 * `VendorAdapter.normalizeAccounting` (plan §6.1) and by the worker's accounting drainer:
 * `apps/worker/src/accounting/normalize.ts` re-exports these functions (relocated in L3,
 * MULTI_VENDOR_INTEGRATION_PLAN.md §8.2; the worker keeps only the site-timezone period
 * bucketing). The two status unions are inlined (= the `@ecloud/db` types, pinned by a type test
 * in the worker) so this package does not depend on `@ecloud/db`.
 */
import { isUuid } from '@ecloud/shared';

/** = `@ecloud/db` RadiusAcctStatusType. */
export type RadiusAcctStatusType =
  'Start' | 'Interim-Update' | 'Stop' | 'Accounting-On' | 'Accounting-Off';

/** = `@ecloud/db` AccountingStatusType. */
export type AccountingStatusType =
  'start' | 'interim' | 'stop' | 'accounting_on' | 'accounting_off';

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

// ---------------------------------------------------------------------------------------------
// Per-vendor accounting quirks hook (MULTI_VENDOR_INTEGRATION_PLAN.md §6.1 `normalizeAccounting`
// "+ per-vendor quirks hook", §8.3 SIM-14). REPORT ONLY: it never changes `normalizeAccounting`,
// `counterDelta` or `maxCounters` output, and the worker does not call it (worker behaviour and
// tests unchanged). How a real device wraps its counters is REQUIRES_DEVICE_TEST.
// ---------------------------------------------------------------------------------------------

const TWO_POW_32 = 4_294_967_296;

export type AccountingAnomalyKind = 'counter_wrap_32bit';

export interface AccountingAnomaly {
  readonly kind: AccountingAnomalyKind;
  readonly counter: 'inputOctets' | 'outputOctets';
  /** Stored (previous maximum) value of the counter. */
  readonly previous: number;
  /** Value carried by the newer record. */
  readonly observed: number;
  /**
   * Bytes the monotonic counter rule does not count for this record, assuming exactly one wrap:
   * `2^32 − previous + observed`. An estimate — more than one wrap between records is undetectable.
   */
  readonly estimatedLostBytes: number;
  readonly detail: string;
}

/** Optional per-vendor hook on `VendorAdapter` (additive; absent = no known quirks). */
export interface AccountingQuirks {
  /**
   * Compares the counters stored for a session (`prev`, e.g. after `maxCounters`) with a newer
   * normalised record (`next`) and reports anomalies. Pure; never alters either argument.
   */
  detectAnomalies(prev: SessionCounters, next: SessionCounters): AccountingAnomaly[];
}

/**
 * Quirks of a NAS whose octet counters are 32-bit with no Acct-*-Gigawords (uspot TIP,
 * PHASE2_VALIDATION V-054). A counter that decreases while the session time advances is a wrap,
 * not a reordered packet: an out-of-order (older) Interim also carries a smaller session time,
 * and a retransmit carries equal counters, so neither is flagged.
 */
export function counterWrap32Quirks(): AccountingQuirks {
  return {
    detectAnomalies(prev, next) {
      if (next.sessionTimeS <= prev.sessionTimeS) return [];
      const out: AccountingAnomaly[] = [];
      for (const counter of ['inputOctets', 'outputOctets'] as const) {
        const previous = prev[counter];
        const observed = next[counter];
        if (observed >= previous || previous >= TWO_POW_32) continue;
        out.push({
          kind: 'counter_wrap_32bit',
          counter,
          previous,
          observed,
          estimatedLostBytes: TWO_POW_32 - previous + observed,
          detail: `${counter} decreased ${String(previous)} → ${String(observed)} while session time advanced ${String(prev.sessionTimeS)} → ${String(next.sessionTimeS)} s; 32-bit counter without Gigawords assumed to have wrapped once`,
        });
      }
      return out;
    },
  };
}
