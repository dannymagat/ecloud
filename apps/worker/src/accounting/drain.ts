/**
 * `accounting.drain` (AAA_ARCHITECTURE.md §5.3, DATABASE_DESIGN.md §5): reads new
 * `radius.radacct_raw` rows past a cursor, normalises them into `accounting_records`, upserts
 * `sessions`, advances `usage_counters` by delta and writes outbox events.
 *
 * Idempotency: every accounting_records row carries `raw.radacctid`; a raw row already
 * normalised (crash between commit and cursor save) is skipped. The cursor lives in Redis
 * because `radacct_raw` has no drained marker column (proposed in the Phase 3 report).
 */
import { withPlatform, type Db, type DbTransaction, type SessionStatus } from '@ecloud/db';
import { newId, type Logger } from '@ecloud/shared';
import { sql } from 'kysely';
import { emitEvent } from '../events.js';
import type { WorkerState } from '../infra/state.js';
import {
  counterDelta,
  maxCounters,
  normalizeAccounting,
  periodStarts,
  type NormalizedAccounting,
  type RawAccountingRow,
} from './normalize.js';

export const DRAIN_CURSOR = 'radacct_raw';
export const DRAIN_REASON = 'worker:accounting.drain';
/** Rows younger than this are left for the next tick (identity values may commit out of order). */
export const DEFAULT_DRAIN_LAG_MS = 5_000;
/** A row that fails this many times in a row is logged and skipped so it cannot block the drain. */
export const POISON_ROW_ATTEMPTS = 3;

export interface DrainDeps {
  db: Db;
  state: WorkerState;
  logger: Logger;
  batchSize: number;
  lagMs?: number;
  now?: () => Date;
}

export interface DrainResult {
  read: number;
  processed: number;
  duplicates: number;
  unresolved: number;
  skipped: number;
  cursor: number;
  /** Active sessions whose counters grew (input for quota evaluation). */
  touchedSessionIds: string[];
}

interface NasInfo {
  id: string;
  organization_id: string;
  site_id: string;
  network_device_id: string | null;
  timezone: string;
}

interface SessionRow {
  id: string;
  organization_id: string;
  site_id: string;
  nas_client_id: string;
  user_id: string | null;
  client_device_id: string | null;
  voucher_id: string | null;
  acct_unique_id: string;
  acct_session_id: string;
  started_at: Date;
  status: SessionStatus;
  terminate_cause: string | null;
  input_octets: number;
  output_octets: number;
  session_time_s: number;
  last_interim_at: Date | null;
  timezone: string;
}

type Outcome = 'processed' | 'duplicate' | 'unresolved';

interface RecordResult {
  outcome: Outcome;
  touchedSessionId: string | null;
}

const failures = new Map<number, number>();

export async function drainOnce(deps: DrainDeps): Promise<DrainResult> {
  const lagMs = deps.lagMs ?? DEFAULT_DRAIN_LAG_MS;
  const now = (deps.now ?? (() => new Date()))();
  let cursor = await deps.state.getCursor(DRAIN_CURSOR);
  const rows = (await deps.db
    .selectFrom('radius.radacct_raw')
    .select([
      'radacctid',
      'acctsessionid',
      'acctuniqueid',
      'username',
      'nasipaddress',
      'nasidentifier',
      'nasportid',
      'acctsessiontime',
      'acctinputoctets',
      'acctoutputoctets',
      'acctinterval',
      'calledstationid',
      'callingstationid',
      'acctterminatecause',
      'framedipaddress',
      'class',
      'acctstatustype',
      'eventtimestamp',
      'acctdelaytime',
      'received_at',
      'packet_src_ip',
    ])
    .where('radacctid', '>', cursor)
    .orderBy('radacctid')
    .limit(deps.batchSize)
    .execute()) as RawAccountingRow[];

  const result: DrainResult = {
    read: rows.length,
    processed: 0,
    duplicates: 0,
    unresolved: 0,
    skipped: 0,
    cursor,
    touchedSessionIds: [],
  };
  const touched = new Set<string>();
  const nasCache = new Map<string, NasInfo | null>();

  for (const row of rows) {
    // Prefix rule: never move the cursor past a row that may still have uncommitted predecessors.
    if (now.getTime() - row.received_at.getTime() < lagMs) break;
    try {
      const rec = normalizeAccounting(row);
      const outcome = await withPlatform(deps.db, { reason: DRAIN_REASON, audit: false }, (trx) =>
        processRecord(trx, rec, nasCache),
      );
      failures.delete(row.radacctid);
      if (outcome.outcome === 'duplicate') result.duplicates += 1;
      else if (outcome.outcome === 'unresolved') result.unresolved += 1;
      else result.processed += 1;
      if (outcome.touchedSessionId !== null) touched.add(outcome.touchedSessionId);
    } catch (error) {
      const attempts = (failures.get(row.radacctid) ?? 0) + 1;
      failures.set(row.radacctid, attempts);
      if (attempts < POISON_ROW_ATTEMPTS) {
        deps.logger.warn(
          { err: error, radacctid: row.radacctid, attempts },
          'accounting row failed; will retry next tick',
        );
        break;
      }
      failures.delete(row.radacctid);
      result.skipped += 1;
      deps.logger.error(
        { err: error, radacctid: row.radacctid, attempts },
        'accounting row skipped after repeated failures',
      );
    }
    cursor = row.radacctid;
    await deps.state.setCursor(DRAIN_CURSOR, cursor);
  }
  result.cursor = cursor;
  result.touchedSessionIds = [...touched];
  return result;
}

async function lookupNas(
  trx: DbTransaction,
  nasIp: string,
  cache: Map<string, NasInfo | null>,
): Promise<NasInfo | null> {
  if (cache.has(nasIp)) return cache.get(nasIp) ?? null;
  const nas = await trx
    .selectFrom('nas_clients as n')
    .innerJoin('sites as s', 's.id', 'n.site_id')
    .select(['n.id', 'n.organization_id', 'n.site_id', 'n.network_device_id', 's.timezone'])
    .where(sql<boolean>`n.nas_ip = ${nasIp}::inet`)
    .where('n.deleted_at', 'is', null)
    .where('n.status', '=', 'active')
    .executeTakeFirst();
  const value = nas ?? null;
  cache.set(nasIp, value);
  return value;
}

function sessionQuery(trx: DbTransaction) {
  return trx
    .selectFrom('sessions as se')
    .innerJoin('sites as st', 'st.id', 'se.site_id')
    .select([
      'se.id',
      'se.organization_id',
      'se.site_id',
      'se.nas_client_id',
      'se.user_id',
      'se.client_device_id',
      'se.voucher_id',
      'se.acct_unique_id',
      'se.acct_session_id',
      'se.started_at',
      'se.status',
      'se.terminate_cause',
      'se.input_octets',
      'se.output_octets',
      'se.session_time_s',
      'se.last_interim_at',
      'st.timezone',
    ]);
}

/**
 * A session may only be attached to records of the NAS that owns it: same organization AND the
 * same NAS client (Class / Acct-Unique-Session-Id are NAS-supplied and can be echoed by another
 * tenant's NAS; roaming between NAS creates a new session per NAS, SIM-18).
 */
function ownedBy(session: SessionRow, nas: NasInfo): boolean {
  return session.organization_id === nas.organization_id && session.nas_client_id === nas.id;
}

/** Class → session id, else acct_unique_id, else (NAS, Acct-Session-Id) of an open session. */
async function findSession(
  trx: DbTransaction,
  rec: NormalizedAccounting,
  nas: NasInfo | null,
): Promise<SessionRow | null> {
  // The NAS binding is the truth (infra/freeradius/README.md): without an authenticated NAS
  // a record is never attached to a session, and never to another tenant's session because
  // of a forged or stale Class / Acct-Unique-Session-Id.
  if (nas === null) return null;
  if (rec.classSessionId !== null) {
    const byClass = await sessionQuery(trx)
      .where('se.id', '=', rec.classSessionId)
      .executeTakeFirst();
    if (byClass && ownedBy(byClass, nas)) return byClass;
  }
  const byUnique = await sessionQuery(trx)
    .where('se.acct_unique_id', '=', rec.acctUniqueId)
    .executeTakeFirst();
  if (byUnique && ownedBy(byUnique, nas)) return byUnique;
  const byNas = await sessionQuery(trx)
    .where('se.nas_client_id', '=', nas.id)
    .where('se.acct_session_id', '=', rec.acctSessionId)
    .where('se.status', 'in', ['authorized', 'active', 'stale'])
    .orderBy('se.started_at', 'desc')
    .executeTakeFirst();
  return byNas ?? null;
}

async function createSession(
  trx: DbTransaction,
  rec: NormalizedAccounting,
  nas: NasInfo,
): Promise<SessionRow | null> {
  const user =
    rec.username === null
      ? undefined
      : await trx
          .selectFrom('users')
          .select('id')
          .where('organization_id', '=', nas.organization_id)
          .where(sql<boolean>`lower(username) = lower(${rec.username})`)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
  const device =
    rec.mac === null
      ? undefined
      : await trx
          .selectFrom('client_devices')
          .select('id')
          .where('organization_id', '=', nas.organization_id)
          .where(sql<boolean>`mac = ${rec.mac}::macaddr`)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
  const idTaken =
    rec.classSessionId !== null &&
    (await trx
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', rec.classSessionId)
      .executeTakeFirst()) !== undefined;
  const id = rec.classSessionId !== null && !idTaken ? rec.classSessionId : newId();
  const startedAt =
    rec.statusType === 'start'
      ? rec.effectiveTime
      : new Date(rec.effectiveTime.getTime() - rec.sessionTimeS * 1000);
  await trx
    .insertInto('sessions')
    .values({
      id,
      organization_id: nas.organization_id,
      site_id: nas.site_id,
      nas_client_id: nas.id,
      network_device_id: nas.network_device_id,
      user_id: user?.id ?? null,
      client_device_id: device?.id ?? null,
      acct_session_id: rec.acctSessionId,
      acct_unique_id: rec.acctUniqueId,
      username_raw: rec.username,
      mac: rec.mac,
      framed_ip: rec.framedIp,
      nas_port_id: rec.nasPortId,
      called_station_id: rec.calledStationId,
      calling_station_id: rec.callingStationId,
      started_at: startedAt,
      status: 'active',
    })
    .onConflict((oc) => oc.column('acct_unique_id').doNothing())
    .execute();
  // Re-read scoped to the authenticated organization AND NAS: when the (globally unique)
  // acct_unique_id already belongs to another tenant's / NAS's session the insert above was a
  // no-op and that foreign row must never be returned (cross-tenant attribution defect, SIM-18).
  const created = await sessionQuery(trx)
    .where('se.acct_unique_id', '=', rec.acctUniqueId)
    .where('se.organization_id', '=', nas.organization_id)
    .where('se.nas_client_id', '=', nas.id)
    .executeTakeFirst();
  return created ?? null;
}

export const ACCT_UNIQUE_ID_COLLISION_ACTION = 'accounting:acct_unique_id_collision';
/** At most one collision audit row per (NAS, acct_unique_id) within this window. */
export const COLLISION_AUDIT_WINDOW_S = 3600;

/**
 * Security anomaly: an authenticated NAS reported an Acct-Unique-Session-Id that belongs to a
 * session of another NAS (possibly another tenant). The record is kept for the reporting
 * organization without a session; no session or usage counter changes. The audit row is
 * platform-level (organization_id NULL) so neither tenant learns about the other.
 */
async function recordCollision(
  trx: DbTransaction,
  rec: NormalizedAccounting,
  nas: NasInfo,
): Promise<void> {
  await insertAccountingRecord(trx, rec, nas.organization_id, null);
  // One audit row per (NAS, acct_unique_id) per window: a NAS retransmitting / interim-updating a
  // colliding session must not flood the audit log (review F6). Every record is still stored.
  const recent = await trx
    .selectFrom('audit_logs')
    .select('id')
    .where('action', '=', ACCT_UNIQUE_ID_COLLISION_ACTION)
    .where('target_id', '=', nas.id)
    .where(sql<boolean>`after->>'acct_unique_id' = ${rec.acctUniqueId}`)
    .where('created_at', '>', sql<Date>`now() - make_interval(secs => ${COLLISION_AUDIT_WINDOW_S})`)
    .limit(1)
    .executeTakeFirst();
  if (recent !== undefined) return;
  await trx
    .insertInto('audit_logs')
    .values({
      organization_id: null,
      actor_type: 'system',
      actor_id: null,
      action: ACCT_UNIQUE_ID_COLLISION_ACTION,
      target_type: 'nas_client',
      target_id: nas.id,
      after: JSON.stringify({
        reporting_organization_id: nas.organization_id,
        nas_client_id: nas.id,
        acct_unique_id: rec.acctUniqueId,
        acct_session_id: rec.acctSessionId,
        radacctid: String(rec.radacctId),
        status_type: rec.statusType,
      }),
    })
    .execute();
}

function sessionEventData(
  session: SessionRow,
  rec: NormalizedAccounting,
  status: SessionStatus,
  counters: { inputOctets: number; outputOctets: number; sessionTimeS: number },
  terminateCause: string | null,
): Record<string, unknown> {
  return {
    session_id: session.id,
    nas_client_id: session.nas_client_id,
    user_id: session.user_id,
    client_device_id: session.client_device_id,
    acct_session_id: rec.acctSessionId,
    status,
    input_octets: counters.inputOctets,
    output_octets: counters.outputOctets,
    session_time_s: counters.sessionTimeS,
    terminate_cause: terminateCause,
    event_time: rec.eventTime.toISOString(),
  };
}

async function insertAccountingRecord(
  trx: DbTransaction,
  rec: NormalizedAccounting,
  organizationId: string | null,
  sessionId: string | null,
): Promise<number> {
  const inserted = await trx
    .insertInto('accounting_records')
    .values({
      organization_id: organizationId,
      session_id: sessionId,
      acct_unique_id: rec.acctUniqueId,
      acct_session_id: rec.acctSessionId,
      status_type: rec.statusType,
      nas_ip: rec.nasIp,
      nas_identifier: rec.nasIdentifier,
      username: rec.username,
      calling_station_id: rec.callingStationId,
      called_station_id: rec.calledStationId,
      framed_ip: rec.framedIp,
      event_time: rec.eventTime,
      received_at: rec.receivedAt,
      input_octets: rec.inputOctets,
      output_octets: rec.outputOctets,
      session_time_s: rec.sessionTimeS,
      terminate_cause: rec.terminateCause,
      raw: JSON.stringify({
        radacctid: String(rec.radacctId),
        class_session_id: rec.classSessionId,
        effective_time: rec.effectiveTime.toISOString(),
        acct_interval_s: rec.interimIntervalS,
      }),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}

export async function processRecord(
  trx: DbTransaction,
  rec: NormalizedAccounting,
  nasCache: Map<string, NasInfo | null> = new Map(),
): Promise<RecordResult> {
  // Tenant attribution comes from the authenticated packet source only (migration 014):
  // NAS-IP-Address is NAS-supplied and could name another tenant's NAS.
  const nas = rec.packetSrcIp === null ? null : await lookupNas(trx, rec.packetSrcIp, nasCache);

  const prior = await trx
    .selectFrom('accounting_records')
    .select(sql<boolean>`bool_or(raw->>'radacctid' = ${String(rec.radacctId)})`.as('same'))
    // records of OTHER organizations sharing this (NAS-chosen) id must not change our count
    .select(
      sql<number>`count(*) FILTER (WHERE organization_id IS NOT DISTINCT FROM ${nas?.organization_id ?? null}::uuid)`.as(
        'n',
      ),
    )
    .where('acct_unique_id', '=', rec.acctUniqueId)
    .executeTakeFirstOrThrow();
  if (prior.same === true) return { outcome: 'duplicate', touchedSessionId: null };
  /** First accounting packet of this session: counts towards usage_counters.session_count. */
  const firstRecord = Number(prior.n) === 0;

  if (rec.statusType === 'accounting_on' || rec.statusType === 'accounting_off') {
    await insertAccountingRecord(trx, rec, nas?.organization_id ?? null, null);
    if (nas === null) return { outcome: 'unresolved', touchedSessionId: null };
    // NAS reboot / accounting restart: its open sessions are no longer reliable (AAA §5.3 (3)).
    // Authorizations that never started (D-036) are marked stale too; a later Start revives them.
    const staled = await trx
      .updateTable('sessions')
      .set({ status: 'stale' })
      .where('nas_client_id', '=', nas.id)
      .where('status', 'in', ['authorized', 'active'])
      .where('started_at', '<=', rec.effectiveTime)
      .returning(['id', 'site_id'])
      .execute();
    for (const s of staled) {
      await emitEvent(trx, 'session.updated', nas.organization_id, s.site_id, {
        session_id: s.id,
        nas_client_id: nas.id,
        status: 'stale',
        reason: rec.statusType,
      });
    }
    return { outcome: 'processed', touchedSessionId: null };
  }

  let session = await findSession(trx, rec, nas);
  let isNew = false;
  if (session === null) {
    if (nas === null) {
      await insertAccountingRecord(trx, rec, null, null);
      return { outcome: 'unresolved', touchedSessionId: null };
    }
    session = await createSession(trx, rec, nas);
    if (session === null) {
      await recordCollision(trx, rec, nas);
      return { outcome: 'unresolved', touchedSessionId: null };
    }
    isNew = true;
  }

  const stored = {
    inputOctets: session.input_octets,
    outputOctets: session.output_octets,
    sessionTimeS: session.session_time_s,
  };
  const incoming = {
    inputOctets: rec.inputOctets,
    outputOctets: rec.outputOctets,
    sessionTimeS: rec.sessionTimeS,
  };
  const delta = counterDelta(stored, incoming);
  const counters = maxCounters(stored, incoming);

  let status: SessionStatus = session.status;
  let terminateCause = session.terminate_cause;
  let stoppedAt: Date | null | undefined;
  let lastInterimAt: Date | null | undefined;
  let revived = false;
  // A session the reaper / Accounting-On closed or marked stale that reports again: its last
  // sign of life is this packet, whatever the type, so the reaper cannot close it again on the
  // old timestamp (review F5). Interim updates set last_interim_at below anyway.
  const wasDormant =
    status === 'stale' ||
    status === 'expired' ||
    (status === 'stopped' && terminateCause === 'lost_interim');
  if (wasDormant && rec.statusType !== 'interim') {
    lastInterimAt =
      session.last_interim_at !== null && session.last_interim_at > rec.receivedAt
        ? session.last_interim_at
        : rec.receivedAt;
  }
  if (rec.statusType === 'stop') {
    status = 'stopped';
    terminateCause = rec.terminateCause ?? terminateCause ?? 'unknown';
    stoppedAt = rec.effectiveTime;
  } else {
    if (rec.statusType === 'interim') {
      lastInterimAt =
        session.last_interim_at !== null && session.last_interim_at > rec.receivedAt
          ? session.last_interim_at
          : rec.receivedAt;
    }
    if (status === 'authorized') {
      // D-036: the first Accounting-Start (or an Interim, if the Start was lost) promotes the
      // authorization to an active session.
      status = 'active';
    } else if (
      status === 'stale' ||
      status === 'expired' ||
      (status === 'stopped' && terminateCause === 'lost_interim')
    ) {
      // The NAS is still reporting this session: undo a stale mark, an authorization expiry
      // or a lost-interim reap.
      revived = status !== 'stale';
      status = 'active';
      terminateCause = null;
      stoppedAt = null;
    }
  }

  // Sessions pre-created by /internal/aaa/authorize carry placeholders (acct_unique_id =
  // Class value, acct_session_id may be ''): adopt the real identifiers on first accounting.
  const adoptUniqueId =
    session.acct_unique_id !== rec.acctUniqueId &&
    (await trx
      .selectFrom('sessions')
      .select('id')
      .where('acct_unique_id', '=', rec.acctUniqueId)
      .executeTakeFirst()) === undefined;
  const adoptStart =
    rec.statusType === 'start' &&
    stored.inputOctets === 0 &&
    stored.outputOctets === 0 &&
    stored.sessionTimeS === 0;

  await trx
    .updateTable('sessions')
    .set({
      ...(adoptUniqueId ? { acct_unique_id: rec.acctUniqueId } : {}),
      ...(session.acct_session_id === '' ? { acct_session_id: rec.acctSessionId } : {}),
      ...(adoptStart ? { started_at: rec.effectiveTime } : {}),
      input_octets: sql<number>`GREATEST(input_octets, ${counters.inputOctets})`,
      output_octets: sql<number>`GREATEST(output_octets, ${counters.outputOctets})`,
      session_time_s: sql<number>`GREATEST(session_time_s, ${counters.sessionTimeS})`,
      status,
      terminate_cause: terminateCause,
      ...(stoppedAt !== undefined ? { stopped_at: stoppedAt } : {}),
      ...(lastInterimAt !== undefined ? { last_interim_at: lastInterimAt } : {}),
      framed_ip: sql<string | null>`COALESCE(${rec.framedIp}::inet, framed_ip)`,
      username_raw: sql<string | null>`COALESCE(username_raw, ${rec.username})`,
      mac: sql<string | null>`COALESCE(mac, ${rec.mac}::macaddr)`,
      calling_station_id: sql<string | null>`COALESCE(calling_station_id, ${rec.callingStationId})`,
      called_station_id: sql<string | null>`COALESCE(called_station_id, ${rec.calledStationId})`,
      nas_port_id: sql<string | null>`COALESCE(nas_port_id, ${rec.nasPortId})`,
    })
    .where('id', '=', session.id)
    .execute();

  const recordId = await insertAccountingRecord(trx, rec, session.organization_id, session.id);

  const countSession = isNew || firstRecord;
  const hasDelta = delta.inputOctets > 0 || delta.outputOctets > 0 || delta.sessionTimeS > 0;
  if (hasDelta || countSession) {
    const periods = periodStarts(rec.effectiveTime, session.timezone);
    const subjects = [
      ['user', session.user_id],
      ['client_device', session.client_device_id],
      ['voucher', session.voucher_id],
    ] as const;
    for (const [subjectType, subjectId] of subjects) {
      if (subjectId === null) continue;
      for (const [periodType, periodStart] of [
        ['daily', periods.daily],
        ['monthly', periods.monthly],
        ['total', periods.total],
      ] as const) {
        await trx
          .insertInto('usage_counters')
          .values({
            organization_id: session.organization_id,
            subject_type: subjectType,
            subject_id: subjectId,
            period_type: periodType,
            period_start: periodStart,
            bytes_in: delta.inputOctets,
            bytes_out: delta.outputOctets,
            session_count: countSession ? 1 : 0,
            session_time_s: delta.sessionTimeS,
            last_record_id: recordId,
          })
          .onConflict((oc) =>
            oc.columns(['subject_type', 'subject_id', 'period_type', 'period_start']).doUpdateSet({
              bytes_in: sql<number>`usage_counters.bytes_in + excluded.bytes_in`,
              bytes_out: sql<number>`usage_counters.bytes_out + excluded.bytes_out`,
              session_count: sql<number>`usage_counters.session_count + excluded.session_count`,
              session_time_s: sql<number>`usage_counters.session_time_s + excluded.session_time_s`,
              last_record_id: sql<number>`GREATEST(usage_counters.last_record_id, excluded.last_record_id)`,
            }),
          )
          .execute();
      }
    }
  }

  const data = sessionEventData(session, rec, status, counters, terminateCause);
  if (countSession) {
    await emitEvent(trx, 'session.started', session.organization_id, session.site_id, data);
  }
  if (rec.statusType === 'stop') {
    await emitEvent(trx, 'session.stopped', session.organization_id, session.site_id, data);
  } else if (
    rec.statusType === 'interim' ||
    revived ||
    (!countSession && rec.statusType === 'start')
  ) {
    await emitEvent(trx, 'session.updated', session.organization_id, session.site_id, data);
  }

  const bytesGrew = delta.inputOctets > 0 || delta.outputOctets > 0;
  return {
    outcome: 'processed',
    touchedSessionId: bytesGrew && status === 'active' ? session.id : null,
  };
}
