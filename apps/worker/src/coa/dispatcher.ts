/**
 * `coa.disconnect` / `coa.change` dispatcher (AAA_ARCHITECTURE.md §6 `coa-dispatcher`).
 *
 * D-006 / D-034: every adapter's Disconnect and CoA are REQUIRES_DEVICE_TEST. The dispatcher
 * is OFF unless ECLOUD_COA_ENABLED=true; while off it records the action as skipped
 * (`status = 'unsupported'`, `error = 'skipped_disabled'` — the schema CHECK has no
 * `skipped_disabled` value yet, see the Phase 3 report) and sends nothing. A session is only
 * ever closed by the dispatcher after a literal Disconnect-ACK.
 */
import {
  type CoaRequest,
  type DisconnectRequest,
  type RadiusAttribute,
  type SessionRef,
  type Unsupported,
} from '@ecloud/adapters';
import {
  withPlatform,
  type Db,
  type SessionActionStatus,
  type SessionActionType,
  type SessionStatus,
} from '@ecloud/db';
import type { EnforcementPlan } from '@ecloud/policy-engine';
import type { Logger } from '@ecloud/shared';
import { resolveAdapter } from '../nas-adapter.js';
import { emitEvent } from '../events.js';
import type { SecretResolver } from '../infra/secrets.js';
import {
  sendDynamicAuthorization,
  type RadclientOutcome,
  type RadclientRunner,
} from './radclient.js';

export const DISPATCH_REASON = 'worker:coa.dispatch';
export const SKIPPED_DISABLED = 'skipped_disabled';

export interface DispatcherDeps {
  db: Db;
  logger: Logger;
  coaEnabled: boolean;
  radclientPath: string;
  timeoutS: number;
  retries: number;
  defaultCoaPort: number;
  resolveSecret: SecretResolver;
  runner?: RadclientRunner;
  now?: () => Date;
}

export interface DispatchContext {
  /** 1-based attempt number (BullMQ `attemptsMade + 1`). */
  attempt: number;
  maxAttempts: number;
}

export type DispatchResult =
  | { status: 'skipped_disabled' }
  | { status: 'unsupported'; reason: string }
  | { status: 'ack'; sessionClosed: boolean }
  | { status: 'nak'; errorCause: string | null }
  | { status: 'timeout'; final: boolean }
  | { status: 'error'; message: string; final: boolean }
  | { status: 'not_found' }
  | { status: 'already_done'; current: SessionActionStatus };

/** Thrown for a transient failure so BullMQ retries the job (and finally moves it to the DLQ). */
export class RetryableDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableDispatchError';
  }
}

const TERMINAL: readonly SessionActionStatus[] = ['ack', 'nak', 'timeout', 'unsupported'];

function isPlan(value: unknown): value is EnforcementPlan {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { adapter?: unknown }).adapter === 'string' &&
    Array.isArray((value as { radiusReplyAttributes?: unknown }).radiusReplyAttributes)
  );
}

/** RFC 5176 hygiene added to every request (AAA §6: Event-Timestamp, Message-Authenticator). */
export function withRequestHygiene(
  attributes: readonly RadiusAttribute[],
  now: Date,
): RadiusAttribute[] {
  const names = new Set(attributes.map((a) => a.name));
  const out = [...attributes];
  if (!names.has('Event-Timestamp')) {
    out.push({ name: 'Event-Timestamp', value: Math.floor(now.getTime() / 1000) });
  }
  // radclient replaces the 0x00 placeholder with the real HMAC-MD5.
  if (!names.has('Message-Authenticator')) {
    out.push({ name: 'Message-Authenticator', value: '0x00' });
  }
  return out;
}

/** Everything the dispatcher needs about one session_actions row (joined with session + NAS). */
export interface ActionContext {
  id: string;
  organization_id: string;
  action: SessionActionType;
  status: SessionActionStatus;
  payload: unknown;
  session_id: string;
  site_id: string;
  session_status: SessionStatus;
  username_raw: string | null;
  acct_session_id: string;
  calling_station_id: string | null;
  framed_ip: string | null;
  nas_ip: string;
  nas_identifier: string | null;
  coa_port: number | null;
  secret_ref: string;
  adapter_key: string | null;
}

export type DispatchDecision =
  | {
      kind: 'final';
      status: SessionActionStatus;
      error: string | null;
      closeSession: boolean;
      result: DispatchResult;
    }
  | { kind: 'retry'; message: string };

export type PerformDeps = Pick<
  DispatcherDeps,
  | 'coaEnabled'
  | 'radclientPath'
  | 'timeoutS'
  | 'retries'
  | 'defaultCoaPort'
  | 'resolveSecret'
  | 'runner'
> & {
  /** Called once, right before the packet is sent (status pending → sent). */
  onSend?: () => Promise<void>;
};

const final = (
  status: SessionActionStatus,
  error: string | null,
  result: DispatchResult,
  closeSession = false,
): DispatchDecision => ({ kind: 'final', status, error, closeSession, result });

/** Pure-ish core (no DB): decides, builds, sends and interprets one Disconnect / CoA. */
export async function performDispatch(
  row: ActionContext,
  deps: PerformDeps,
  ctx: DispatchContext,
  now: Date,
): Promise<DispatchDecision> {
  if (!deps.coaEnabled) {
    return final('unsupported', SKIPPED_DISABLED, { status: 'skipped_disabled' });
  }
  const adapter = resolveAdapter(row.adapter_key);
  if (adapter === null) {
    const reason = `no NAS adapter for adapter_key ${row.adapter_key ?? 'NULL'}`;
    return final('unsupported', reason, { status: 'unsupported', reason });
  }
  const sessionRef: SessionRef = {
    sessionId: row.session_id,
    userName: row.username_raw,
    acctSessionId: row.acct_session_id,
    callingStationId: row.calling_station_id,
    nasIdentifier: row.nas_identifier,
    nasIpAddress: row.nas_ip,
    framedIpAddress: row.framed_ip,
  };
  let built: DisconnectRequest | CoaRequest | Unsupported;
  if (row.action === 'disconnect') {
    built = adapter.buildDisconnect(sessionRef);
  } else {
    const plan = (row.payload as { plan?: unknown } | null)?.plan;
    built = isPlan(plan)
      ? adapter.buildCoa(sessionRef, plan)
      : { unsupported: true, reason: 'payload.plan (EnforcementPlan) missing' };
  }
  if ('unsupported' in built) {
    return final('unsupported', built.reason, { status: 'unsupported', reason: built.reason });
  }
  const secret = await deps.resolveSecret(row.secret_ref);
  if (secret === undefined) {
    const reason = 'NAS secret reference could not be resolved';
    return final('unsupported', reason, { status: 'unsupported', reason });
  }
  await deps.onSend?.();
  const outcome: RadclientOutcome = await sendDynamicAuthorization({
    radclientPath: deps.radclientPath,
    host: row.nas_ip,
    // Cycle B: the adapter's documented DAS default (MikroTik 1700) before the deployment one.
    port: row.coa_port ?? adapter.capabilities().disconnect.defaultPort ?? deps.defaultCoaPort,
    command: row.action === 'disconnect' ? 'disconnect' : 'coa',
    secret,
    attributes: withRequestHygiene(built.attributes, now),
    timeoutS: deps.timeoutS,
    retries: deps.retries,
    ...(deps.runner ? { runner: deps.runner } : {}),
  });
  const isFinal = ctx.attempt >= ctx.maxAttempts;
  switch (outcome.result) {
    case 'ack': {
      // Close the ECLOUD session only where the NAS is known NOT to send Acct-Stop (TIP uspot).
      const close =
        built.kind === 'disconnect' &&
        built.acctStopEmitted === false &&
        row.session_status !== 'stopped';
      return final('ack', null, { status: 'ack', sessionClosed: close }, close);
    }
    case 'nak':
      return final(
        'nak',
        outcome.errorCause !== null ? `Error-Cause=${outcome.errorCause}` : 'NAK',
        { status: 'nak', errorCause: outcome.errorCause },
      );
    case 'timeout':
      return isFinal
        ? final('timeout', `no reply after ${String(ctx.attempt)} attempt(s)`, {
            status: 'timeout',
            final: true,
          })
        : {
            kind: 'retry',
            message: `no reply from ${row.nas_ip} (attempt ${String(ctx.attempt)})`,
          };
    case 'error':
      // The schema has no `error` status; an exhausted local failure is recorded as `timeout`.
      return isFinal
        ? final('timeout', `radclient error: ${outcome.message}`, {
            status: 'error',
            message: outcome.message,
            final: true,
          })
        : { kind: 'retry', message: `radclient error: ${outcome.message}` };
  }
}

export async function dispatchSessionAction(
  deps: DispatcherDeps,
  sessionActionId: string,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const now = (deps.now ?? (() => new Date()))();
  const row = (await deps.db
    .selectFrom('session_actions as a')
    .innerJoin('sessions as s', 's.id', 'a.session_id')
    .innerJoin('nas_clients as n', 'n.id', 's.nas_client_id')
    .select([
      'a.id',
      'a.organization_id',
      'a.action',
      'a.status',
      'a.payload',
      's.id as session_id',
      's.site_id',
      's.status as session_status',
      's.username_raw',
      's.acct_session_id',
      's.calling_station_id',
      's.framed_ip',
      'n.nas_ip',
      'n.nas_identifier',
      'n.coa_port',
      'n.secret_ref',
      'n.adapter_key',
    ])
    .where('a.id', '=', sessionActionId)
    .executeTakeFirst()) as ActionContext | undefined;
  if (row === undefined) return { status: 'not_found' };
  if (TERMINAL.includes(row.status)) return { status: 'already_done', current: row.status };

  const decision = await performDispatch(
    row,
    {
      ...deps,
      onSend: async () => {
        if (row.status !== 'pending') return;
        await withPlatform(
          deps.db,
          { reason: DISPATCH_REASON, audit: false, organizationId: row.organization_id },
          (trx) =>
            trx
              .updateTable('session_actions')
              .set({ status: 'sent' })
              .where('id', '=', row.id)
              .execute(),
        );
      },
    },
    ctx,
    now,
  );
  if (decision.kind === 'retry') throw new RetryableDispatchError(decision.message);

  const eventName =
    row.action === 'disconnect' ? 'session.disconnect_result' : 'session.coa_result';
  await withPlatform(
    deps.db,
    { reason: DISPATCH_REASON, audit: false, organizationId: row.organization_id },
    async (trx) => {
      await trx
        .updateTable('session_actions')
        .set({ status: decision.status, error: decision.error, completed_at: now })
        .where('id', '=', row.id)
        .execute();
      if (decision.closeSession) {
        await trx
          .updateTable('sessions')
          .set({ status: 'stopped', stopped_at: now, terminate_cause: 'admin_reset' })
          .where('id', '=', row.session_id)
          .where('status', '<>', 'stopped')
          .execute();
        await emitEvent(trx, 'session.stopped', row.organization_id, row.site_id, {
          session_id: row.session_id,
          status: 'stopped',
          terminate_cause: 'admin_reset',
          closed_by: 'disconnect_ack',
        });
      }
      await emitEvent(trx, eventName, row.organization_id, row.site_id, {
        session_id: row.session_id,
        session_action_id: row.id,
        action: row.action,
        status: decision.status,
        error: decision.error,
      });
    },
  );
  if (decision.result.status === 'skipped_disabled') {
    deps.logger.info(
      { sessionActionId, action: row.action },
      'CoA/Disconnect disabled (ECLOUD_COA_ENABLED=false); action skipped',
    );
  }
  return decision.result;
}
