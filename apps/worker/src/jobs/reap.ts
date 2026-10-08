/**
 * `sessions.reap`: an active session with no accounting for longer than
 * 2 × interim interval + grace is closed as `stopped` / `lost_interim` (AAA §5.3 missing-Stop
 * rule (2), with the Phase 3 threshold). A late Interim revives it (accounting/drain.ts).
 */
import { withPlatform, type Db } from '@ecloud/db';
import { sql } from 'kysely';
import { emitEvent } from '../events.js';

export const REAP_REASON = 'worker:sessions.reap';
export const LOST_INTERIM_CAUSE = 'lost_interim';

export function reapCutoff(now: Date, interimIntervalS: number, graceS: number): Date {
  return new Date(now.getTime() - (2 * interimIntervalS + graceS) * 1000);
}

/** Last sign of life: the latest Interim, else the start. */
export function lastSeen(session: { started_at: Date; last_interim_at: Date | null }): Date {
  return session.last_interim_at ?? session.started_at;
}

export function isLost(
  session: { started_at: Date; last_interim_at: Date | null },
  now: Date,
  interimIntervalS: number,
  graceS: number,
): boolean {
  return lastSeen(session) < reapCutoff(now, interimIntervalS, graceS);
}

export interface ReapDeps {
  db: Db;
  interimIntervalS: number;
  graceS: number;
  now?: () => Date;
}

export async function reapSessions(deps: ReapDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = reapCutoff(now, deps.interimIntervalS, deps.graceS);
  return withPlatform(deps.db, { reason: REAP_REASON, audit: false }, async (trx) => {
    const reaped = await trx
      .updateTable('sessions')
      .set({
        status: 'stopped',
        terminate_cause: LOST_INTERIM_CAUSE,
        stopped_at: sql<Date>`COALESCE(last_interim_at, started_at)`,
      })
      .where('status', '=', 'active')
      .where(sql<boolean>`COALESCE(last_interim_at, started_at) < ${cutoff}`)
      .returning([
        'id',
        'organization_id',
        'site_id',
        'nas_client_id',
        'user_id',
        'acct_session_id',
        'input_octets',
        'output_octets',
        'session_time_s',
        'stopped_at',
      ])
      .execute();
    for (const s of reaped) {
      await emitEvent(trx, 'session.stopped', s.organization_id, s.site_id, {
        session_id: s.id,
        nas_client_id: s.nas_client_id,
        user_id: s.user_id,
        acct_session_id: s.acct_session_id,
        status: 'stopped',
        terminate_cause: LOST_INTERIM_CAUSE,
        input_octets: s.input_octets,
        output_octets: s.output_octets,
        session_time_s: s.session_time_s,
        stopped_at: s.stopped_at?.toISOString() ?? null,
      });
    }
    return reaped.length;
  });
}

// ------------------------------------------------------------------------------------------
// D-036: authorizations that never received accounting
// ------------------------------------------------------------------------------------------

export const AUTHORIZATION_EXPIRED_CAUSE = 'authorization_expired';

export function authorizationCutoff(now: Date, ttlS: number): Date {
  return new Date(now.getTime() - ttlS * 1000);
}

export interface ExpireAuthorizationsDeps {
  db: Db;
  /** WORKER_AUTHORIZATION_TTL_S: how long an Access-Accept may wait for Accounting-Start. */
  ttlS: number;
  now?: () => Date;
}

/**
 * `authorized` sessions (Access-Accept sent by /internal/aaa/authorize) older than the TTL
 * become `expired`: the client never came up (or the NAS sends no accounting), so the slot must
 * not keep counting towards concurrency. A late Start/Interim revives the row (drain.ts).
 */
export async function expireAuthorizations(deps: ExpireAuthorizationsDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = authorizationCutoff(now, deps.ttlS);
  return withPlatform(deps.db, { reason: REAP_REASON, audit: false }, async (trx) => {
    const expired = await trx
      .updateTable('sessions')
      .set({ status: 'expired', terminate_cause: AUTHORIZATION_EXPIRED_CAUSE, stopped_at: now })
      .where('status', '=', 'authorized')
      .where('started_at', '<', cutoff)
      .returning(['id', 'organization_id', 'site_id', 'nas_client_id', 'user_id'])
      .execute();
    for (const s of expired) {
      await emitEvent(trx, 'session.stopped', s.organization_id, s.site_id, {
        session_id: s.id,
        nas_client_id: s.nas_client_id,
        user_id: s.user_id,
        status: 'expired',
        terminate_cause: AUTHORIZATION_EXPIRED_CAUSE,
        stopped_at: now.toISOString(),
      });
    }
    return expired.length;
  });
}
