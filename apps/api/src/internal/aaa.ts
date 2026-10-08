/**
 * Internal AAA endpoints for FreeRADIUS rlm_rest (docs/contracts/aaa-authorize.md).
 *
 * authorize: NAS → tenant/site/adapter (nas_clients by packet source IP, then the
 * `ECLOUD-Client-Shortname` = nas id; both are server-side facts tied to the shared secret.
 * NAS-Identifier is NAS-supplied and never selects a tenant, SECURITY_ARCHITECTURE.md §3.2)
 * → subject (subscriber
 * `users` with Argon2id password, `vouchers` by HMAC, or MAC-auth `client_devices`) →
 * resolveEffectivePolicy + adapter translation → `sessions` row (status `authorized`, D-036) →
 * 200 with `control:Auth-Type = Accept`, reply attributes and `reply:Class = ai:<32hex>`; otherwise
 * 401 + Reply-Message. Any backend error is 503 (FreeRADIUS `fail` → reject): never fail open.
 * User-Password is never logged nor persisted.
 *
 * post-auth: writes `auth_events` and closes the provisional session when the final RADIUS
 * outcome was a reject (e.g. local PAP mismatch after a 200). Always 204.
 *
 * Retransmits: the decision is cached for 10 s under SHA-256(src IP, Acct-Session-Id,
 * Calling-Station-Id, User-Name, SHA-256(User-Password)) so a NAS retransmit gets the same
 * answer (same Class, no second voucher use) and a different password does not.
 */
import { verifyPassword, withPlatform, withTenant, type DbTransaction } from '@ecloud/db';
import { resolveEffectivePolicy, toJsonValue, type Subject } from '@ecloud/policy-engine';
import { isUuid, newId } from '@ecloud/shared';
import type { Request, RequestHandler, Response } from 'express';
import type { AppDeps } from '../context.js';
import { normalizeVoucherCode, safeEqual, sha256Hex } from '../crypto.js';
import { nasAdapter } from '../nas-adapter.js';
import { AUTHN_ACCESS } from '../auth/principal.js';
import { loadResolutionInput } from '../policy-data.js';
import { voucherHash } from '../routes/vouchers.js';
import {
  FORBIDDEN_REPLY_ATTRIBUTES,
  PolicyBuilder,
  attr,
  classForSession,
  dictionaryName,
  hasAttr,
  macFrom,
  sessionIdFromReplyClass,
  type RadiusRequestBody,
} from './radius.js';

export const RETRANSMIT_TTL_S = 10;
const DECISION_TTL_S = 60;

interface NasRow {
  id: string;
  organization_id: string;
  site_id: string;
  nas_identifier: string | null;
  adapter_type_key: string;
  adapter_key: string | null;
  network_device_id: string | null;
}

interface CachedDecision {
  status: 200 | 401;
  body: unknown;
}

/** Facts about a decision kept for post-auth (no secrets). */
interface DecisionFacts {
  organization_id: string | null;
  nas_client_id: string | null;
  session_id: string | null;
  policy_id: string | null;
  auth_method: string | null;
  reason: string | null;
}

class Reject extends Error {
  constructor(
    readonly reason: string,
    readonly replyMessage: string,
    readonly facts: Partial<DecisionFacts> = {},
  ) {
    super(reason);
  }
}

const REPLY_MESSAGES: Readonly<Record<string, string>> = {
  quota_daily: 'Daily data quota exceeded',
  quota_monthly: 'Monthly data quota exceeded',
  quota_total: 'Data quota exceeded',
  schedule: 'Access is not allowed at this time',
  concurrency_sessions: 'Too many active sessions',
  concurrency_devices: 'Too many devices',
  voucher_expired: 'Voucher expired',
  voucher_not_yet_valid: 'Voucher not yet valid',
};

function rejectBody(message: string): unknown {
  return new PolicyBuilder().set('reply', 'Reply-Message', message).build();
}

function keyParts(body: RadiusRequestBody): string[] {
  return [
    attr(body, 'ECLOUD-Packet-Src-IP-Address') ?? '',
    attr(body, 'Acct-Session-Id') ?? '',
    macFrom(attr(body, 'Calling-Station-Id')) ?? attr(body, 'Calling-Station-Id') ?? '',
    attr(body, 'User-Name') ?? '',
  ];
}

export function retransmitKey(body: RadiusRequestBody): string {
  const password = attr(body, 'User-Password') ?? '';
  return `aaa:rt:${sha256Hex([...keyParts(body), sha256Hex(password)].join('|'))}`;
}

export function decisionKey(body: RadiusRequestBody): string {
  return `aaa:dec:${sha256Hex(keyParts(body).join('|'))}`;
}

/**
 * Only server-side facts select the NAS (and so the tenant): the UDP source address and the
 * `clients.conf` shortname, both bound to the client's shared secret. Packet attributes
 * (NAS-Identifier, NAS-IP-Address) can be set to anything by any accepted client, so a
 * fallback on them would let one tenant's NAS authenticate against another tenant
 * (SECURITY_ARCHITECTURE.md §3.2: NAS-Identifier never distinguishes across tenants).
 */
export async function resolveNas(deps: AppDeps, body: RadiusRequestBody): Promise<NasRow | null> {
  const srcIp = attr(body, 'ECLOUD-Packet-Src-IP-Address');
  const shortname = attr(body, 'ECLOUD-Client-Shortname');
  return withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
    const base = () =>
      trx
        .selectFrom('nas_clients')
        .select([
          'id',
          'organization_id',
          'site_id',
          'nas_identifier',
          'adapter_type_key',
          'adapter_key',
          'network_device_id',
        ])
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null);
    if (srcIp !== undefined && srcIp !== '') {
      const byIp = await base()
        .where('nas_ip', '=', srcIp)
        .executeTakeFirst()
        .catch(() => undefined);
      if (byIp !== undefined) return byIp;
    }
    if (shortname !== undefined && isUuid(shortname)) {
      const byId = await base().where('id', '=', shortname).executeTakeFirst();
      if (byId !== undefined) return byId;
    }
    return null;
  });
}

interface Identity {
  subject: Subject;
  authMethod: 'password' | 'voucher' | 'mac';
  userId: string | null;
  voucherId: string | null;
  voucherBatchId: string | null;
  groupIds: string[];
}

async function identify(
  deps: AppDeps,
  trx: DbTransaction,
  body: RadiusRequestBody,
  nas: NasRow,
  now: Date,
): Promise<Identity> {
  const userName = attr(body, 'User-Name') ?? '';
  const password = attr(body, 'User-Password');
  const serviceType = attr(body, 'Service-Type');
  if (userName === '') throw new Reject('missing_username', 'Access denied');
  if (hasAttr(body, 'CHAP-Password')) {
    // ECLOUD stores only one-way hashes: CHAP cannot be verified (contract §2.1).
    throw new Reject('chap_unsupported', 'Authentication method not supported');
  }

  if (serviceType === 'Call-Check') {
    const mac = macFrom(userName) ?? macFrom(attr(body, 'Calling-Station-Id'));
    if (mac === null) throw new Reject('mac_invalid', 'Access denied');
    const device = await trx
      .selectFrom('client_devices')
      .select(['id', 'user_id', 'blocked', 'mac_auth_enabled'])
      .where('mac', '=', mac)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (device === undefined || !device.mac_auth_enabled || device.blocked) {
      throw new Reject('mac_unknown', 'Access denied');
    }
    return {
      subject: { kind: 'client_device', client_device_id: device.id },
      authMethod: 'mac',
      userId: device.user_id,
      voucherId: null,
      voucherBatchId: null,
      groupIds: [],
    };
  }

  if (password === undefined) throw new Reject('missing_password', 'Access denied');

  const user = await trx
    .selectFrom('users')
    .select([
      'id',
      'site_id',
      'password_hash',
      'auth_methods',
      'status',
      'valid_from',
      'valid_until',
      'user_group_id',
    ])
    .where((eb) => eb(eb.fn('lower', ['username']), '=', userName.toLowerCase()))
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (user !== undefined) {
    const ok =
      user.password_hash !== null &&
      user.auth_methods.includes('password') &&
      (await verifyPassword(user.password_hash, password).catch(() => false));
    if (!ok) throw new Reject('bad_credentials', 'Access denied', { auth_method: 'password' });
    if (user.status !== 'active') throw new Reject(`user_${user.status}`, 'Account is not active');
    if (user.site_id !== null && user.site_id !== nas.site_id) {
      throw new Reject('site_mismatch', 'Access denied');
    }
    if (user.valid_from !== null && user.valid_from.getTime() > now.getTime()) {
      throw new Reject('user_not_yet_valid', 'Account not yet valid');
    }
    if (user.valid_until !== null && user.valid_until.getTime() <= now.getTime()) {
      throw new Reject('user_expired', 'Account expired');
    }
    return {
      subject: { kind: 'user', user_id: user.id },
      authMethod: 'password',
      userId: user.id,
      voucherId: null,
      voucherBatchId: null,
      groupIds: user.user_group_id === null ? [] : [user.user_group_id],
    };
  }

  // Voucher: User-Name is the code and the PAP password must be the same code.
  const code = normalizeVoucherCode(userName);
  if (!safeEqual(normalizeVoucherCode(password), code)) {
    throw new Reject('bad_credentials', 'Access denied');
  }
  const voucher = await trx
    .selectFrom('vouchers as v')
    .innerJoin('voucher_batches as b', 'b.id', 'v.batch_id')
    .select([
      'v.id',
      'v.status',
      'v.use_count',
      'v.activated_at',
      'v.expires_at',
      'v.bound_user_id',
      'b.id as batch_id',
      'b.site_id',
      'b.valid_from',
      'b.valid_until',
      'b.duration_s',
      'b.max_uses',
    ])
    .where('v.code_hash', '=', voucherHash(deps.config.voucherPepper, code))
    .where('v.deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (voucher === undefined) throw new Reject('bad_credentials', 'Access denied');
  if (
    voucher.status === 'revoked' ||
    voucher.status === 'exhausted' ||
    voucher.status === 'expired'
  ) {
    throw new Reject(`voucher_${voucher.status}`, 'Voucher is no longer valid', {
      auth_method: 'voucher',
    });
  }
  if (voucher.site_id !== null && voucher.site_id !== nas.site_id) {
    throw new Reject('site_mismatch', 'Access denied', { auth_method: 'voucher' });
  }
  // D-037: `duration_s` allows re-login until `expires_at` (first use + duration); `max_uses`
  // allows that many logins; both apply when both are set. Expiry is also enforced by the
  // resolver (POLICY_ENGINE.md voucher layer); it is checked here so the reason is exact.
  if (voucher.max_uses !== null && voucher.use_count >= voucher.max_uses) {
    throw new Reject('voucher_exhausted', 'Voucher is no longer valid', { auth_method: 'voucher' });
  }
  if (voucher.expires_at !== null && voucher.expires_at.getTime() <= now.getTime()) {
    throw new Reject('voucher_expired', REPLY_MESSAGES.voucher_expired ?? 'Voucher expired', {
      auth_method: 'voucher',
    });
  }
  return {
    subject: {
      kind: 'voucher',
      user_id: voucher.bound_user_id,
      voucher: {
        batch_id: voucher.batch_id,
        expires_at: voucher.expires_at,
        activated_at: voucher.activated_at,
        duration_s: voucher.duration_s,
        batch_valid_from: voucher.valid_from,
        batch_valid_until: voucher.valid_until,
      },
    },
    authMethod: 'voucher',
    userId: voucher.bound_user_id,
    voucherId: voucher.id,
    voucherBatchId: voucher.batch_id,
    groupIds: [],
  };
}

async function consumeVoucher(trx: DbTransaction, voucherId: string, now: Date): Promise<void> {
  const v = await trx
    .selectFrom('vouchers as v')
    .innerJoin('voucher_batches as b', 'b.id', 'v.batch_id')
    .select(['v.use_count', 'v.activated_at', 'b.duration_s', 'b.max_uses'])
    .where('v.id', '=', voucherId)
    .executeTakeFirstOrThrow();
  const first = v.activated_at === null;
  const uses = v.use_count + 1;
  await trx
    .updateTable('vouchers')
    .set({
      status: v.max_uses !== null && uses >= v.max_uses ? 'exhausted' : 'active',
      use_count: uses,
      ...(first
        ? {
            activated_at: now,
            expires_at:
              v.duration_s === null ? null : new Date(now.getTime() + v.duration_s * 1000),
          }
        : {}),
    })
    .where('id', '=', voucherId)
    .execute();
}

interface Decision {
  status: 200 | 401;
  body: unknown;
  facts: DecisionFacts;
}

async function decide(deps: AppDeps, body: RadiusRequestBody, now: Date): Promise<Decision> {
  const nas = await resolveNas(deps, body);
  if (nas === null) {
    return {
      status: 401,
      body: rejectBody('Access denied'),
      facts: {
        organization_id: null,
        nas_client_id: null,
        session_id: null,
        policy_id: null,
        auth_method: null,
        reason: 'unknown_nas',
      },
    };
  }
  const requestIdentifier = attr(body, 'NAS-Identifier');
  const baseFacts: DecisionFacts = {
    organization_id: nas.organization_id,
    nas_client_id: nas.id,
    session_id: null,
    policy_id: null,
    auth_method: null,
    reason: null,
  };
  if (
    nas.nas_identifier !== null &&
    requestIdentifier !== undefined &&
    requestIdentifier !== nas.nas_identifier
  ) {
    // SECURITY_ARCHITECTURE.md §3.2: both set and different → reject.
    return {
      status: 401,
      body: rejectBody('Access denied'),
      facts: { ...baseFacts, reason: 'nas_identifier_mismatch' },
    };
  }

  try {
    return await withTenant(deps.db, nas.organization_id, async (trx) => {
      const site = await trx
        .selectFrom('sites as s')
        .innerJoin('organizations as o', 'o.id', 's.organization_id')
        .select(['s.timezone', 's.status as site_status', 'o.status as org_status', 'o.settings'])
        .where('s.id', '=', nas.site_id)
        .where('s.deleted_at', 'is', null)
        .executeTakeFirst();
      if (site === undefined || site.site_status !== 'active' || site.org_status !== 'active') {
        throw new Reject('tenant_inactive', 'Service unavailable for this network');
      }
      const identity = await identify(deps, trx, body, nas, now);
      const mac = macFrom(attr(body, 'Calling-Station-Id'));
      let clientDeviceId: string | null =
        identity.subject.kind === 'client_device' ? identity.subject.client_device_id : null;
      if (mac !== null) {
        const device = await trx
          .selectFrom('client_devices')
          .select(['id', 'blocked'])
          .where('mac', '=', mac)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (device?.blocked === true) {
          throw new Reject('device_blocked', 'Device is blocked', {
            auth_method: identity.authMethod,
          });
        }
        clientDeviceId ??= device?.id ?? null;
      }

      const input = await loadResolutionInput(trx, {
        organizationId: nas.organization_id,
        siteId: nas.site_id,
        timeZone: site.timezone,
        now,
        subject: identity.subject,
        clientDeviceId,
        mac,
        groupIds: identity.groupIds,
        voucherBatchId: identity.voucherBatchId,
      });
      const resolution = resolveEffectivePolicy({ ...input, trigger: 'authorize' });
      if (resolution.decision === 'reject') {
        const code = resolution.reasonCode ?? 'policy_reject';
        throw new Reject(code, REPLY_MESSAGES[code] ?? 'Access denied', {
          auth_method: identity.authMethod,
          policy_id: resolution.snapshot.policy_id,
        });
      }

      const sessionId = newId();
      const classValue = classForSession(sessionId);
      const builder = new PolicyBuilder().set('control', 'Auth-Type', 'Accept');
      const adapter = nasAdapter(nas.adapter_key);
      let emitted: unknown = [];
      let unsupported: unknown = [];
      let adapterVersion: string | null = null;
      if (adapter !== null) {
        adapterVersion = adapter.version;
        const plan = adapter.translate(resolution.effective, {
          clip: resolution.clip,
          controls: resolution.controls,
          now,
          interimIntervalS: deps.config.aaaInterimIntervalS,
        });
        if (plan.decision === 'reject') {
          throw new Reject(plan.reasonCode ?? 'unenforceable', 'Access denied', {
            auth_method: identity.authMethod,
            policy_id: resolution.snapshot.policy_id,
          });
        }
        const attributes = adapter
          .buildReplyAttributes(plan)
          .filter((a) => !FORBIDDEN_REPLY_ATTRIBUTES.has(a.name));
        for (const a of attributes) builder.add('reply', dictionaryName(a.name), a.value);
        emitted = attributes;
        unsupported = plan.unenforceable;
      } else {
        unsupported = [
          { field: '*', reason: `NAS has no engine adapter_key (type ${nas.adapter_type_key})` },
        ];
      }
      builder.set('reply', 'Class', classValue);

      if (identity.voucherId !== null) await consumeVoucher(trx, identity.voucherId, now);

      await trx
        .insertInto('sessions')
        .values({
          id: sessionId,
          organization_id: nas.organization_id,
          site_id: nas.site_id,
          nas_client_id: nas.id,
          network_device_id: nas.network_device_id,
          user_id: identity.userId,
          client_device_id: clientDeviceId,
          voucher_id: identity.voucherId,
          policy_id: resolution.snapshot.policy_id,
          policy_version: resolution.snapshot.policy_version,
          acct_session_id: attr(body, 'Acct-Session-Id') ?? '',
          // Placeholder until accounting arrives: the worker correlates by Class (= this id).
          acct_unique_id: classValue,
          username_raw: (attr(body, 'User-Name') ?? '').slice(0, 253),
          mac,
          framed_ip: attr(body, 'Framed-IP-Address') ?? null,
          nas_port_id: attr(body, 'NAS-Port-Id') ?? null,
          called_station_id: attr(body, 'Called-Station-Id') ?? null,
          calling_station_id: attr(body, 'Calling-Station-Id') ?? null,
          started_at: now,
          // D-036: Access-Accept only; the worker promotes it to 'active' on Accounting-Start
          // and expires it when no accounting arrives within the authorization TTL.
          status: 'authorized',
        })
        .execute();
      await trx
        .insertInto('policy_translations')
        .values({
          organization_id: nas.organization_id,
          policy_id: resolution.snapshot.policy_id,
          policy_version: resolution.snapshot.policy_version ?? 0,
          adapter_type_key: nas.adapter_key ?? nas.adapter_type_key,
          adapter_version: adapterVersion,
          nas_client_id: nas.id,
          session_id: sessionId,
          trigger: 'authorize',
          input_snapshot: JSON.stringify(
            toJsonValue({ effective: resolution.effective, hash: resolution.snapshot.hash }),
          ),
          emitted: JSON.stringify(toJsonValue(emitted)),
          unsupported: JSON.stringify(toJsonValue(unsupported)),
        })
        .execute();

      return {
        status: 200 as const,
        body: builder.build(),
        facts: {
          ...baseFacts,
          session_id: sessionId,
          policy_id: resolution.snapshot.policy_id,
          auth_method: identity.authMethod,
          reason: null,
        },
      };
    });
  } catch (error) {
    if (error instanceof Reject) {
      return {
        status: 401,
        body: rejectBody(error.replyMessage),
        facts: { ...baseFacts, ...error.facts, reason: error.reason },
      };
    }
    throw error;
  }
}

function tokenCheck(deps: AppDeps): RequestHandler {
  const expected = deps.config.base.internalApiToken;
  return (req, res, next) => {
    const presented = req.get('X-Internal-Token') ?? '';
    if (!safeEqual(presented, expected)) {
      // Contract §1: 401 without a body.
      res.status(401).end();
      return;
    }
    next();
  };
}

export function internalTokenGuard(deps: AppDeps): RequestHandler {
  return tokenCheck(deps);
}

function unavailable(res: Response): void {
  res.status(503).type('application/json').send('{}');
}

export function authorizeHandler(deps: AppDeps): RequestHandler {
  const now = deps.now ?? (() => new Date());
  return async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as RadiusRequestBody;
    const rtKey = retransmitKey(body);
    try {
      const cached = await deps.kv.get(rtKey);
      if (cached !== null) {
        const decision = JSON.parse(cached) as CachedDecision;
        req.log.info({ status: decision.status, retransmit: true }, 'aaa authorize (retransmit)');
        res.status(decision.status).json(decision.body);
        return;
      }
      const decision = await decide(deps, body, now());
      const cachedValue: CachedDecision = { status: decision.status, body: decision.body };
      await deps.kv.set(rtKey, JSON.stringify(cachedValue), RETRANSMIT_TTL_S);
      await deps.kv
        .set(decisionKey(body), JSON.stringify(decision.facts), DECISION_TTL_S)
        .catch(() => undefined);
      req.log.info(
        {
          status: decision.status,
          reason: decision.facts.reason,
          organizationId: decision.facts.organization_id,
          nasClientId: decision.facts.nas_client_id,
          sessionId: decision.facts.session_id,
        },
        'aaa authorize',
      );
      res.status(decision.status).json(decision.body);
    } catch (error) {
      req.log.error({ err: error }, 'aaa authorize failed: backend unavailable');
      unavailable(res);
    }
  };
}

export function postAuthHandler(deps: AppDeps): RequestHandler {
  const now = deps.now ?? (() => new Date());
  return async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as RadiusRequestBody;
    try {
      const result = attr(body, 'ECLOUD-Auth-Result') === 'accept' ? 'accept' : 'reject';
      const replyClassSession = sessionIdFromReplyClass(attr(body, 'ECLOUD-Reply-Class'));
      const rawFacts = await deps.kv.get(decisionKey(body)).catch(() => null);
      let facts = rawFacts === null ? null : (JSON.parse(rawFacts) as DecisionFacts);
      if (facts === null && replyClassSession !== null) {
        // Decision cache miss (e.g. other API replica): the Class names our session row, but
        // Class is request data. Trust it only for a session of the NAS that sent the packet.
        const nas = await resolveNas(deps, body);
        const session = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, (trx) =>
          trx
            .selectFrom('sessions')
            .select([
              'id',
              'organization_id',
              'nas_client_id',
              'policy_id',
              'voucher_id',
              'user_id',
            ])
            .where('id', '=', replyClassSession)
            .executeTakeFirst(),
        );
        if (session !== undefined && nas !== null && session.nas_client_id === nas.id) {
          facts = {
            organization_id: session.organization_id,
            nas_client_id: session.nas_client_id,
            session_id: session.id,
            policy_id: session.policy_id,
            auth_method:
              session.voucher_id !== null
                ? 'voucher'
                : session.user_id !== null
                  ? 'password'
                  : null,
            reason: null,
          };
        }
      }
      const reason =
        result === 'reject'
          ? (facts?.reason ??
            attr(body, 'Module-Failure-Message')?.slice(0, 200) ??
            attr(body, 'ECLOUD-Reply-Message')?.slice(0, 200) ??
            null)
          : null;
      const row = {
        organization_id: facts?.organization_id ?? null,
        nas_client_id: facts?.nas_client_id ?? null,
        username: attr(body, 'User-Name')?.slice(0, 253) ?? null,
        calling_station_id: attr(body, 'Calling-Station-Id') ?? null,
        called_station_id: attr(body, 'Called-Station-Id') ?? null,
        nas_ip: attr(body, 'ECLOUD-Packet-Src-IP-Address') ?? null,
        result,
        reason,
        auth_method: facts?.auth_method ?? null,
        policy_id: facts?.policy_id ?? null,
        reply_summary: JSON.stringify({
          decision: attr(body, 'ECLOUD-Decision') ?? null,
          session_id: replyClassSession,
        }),
      } as const;
      if (row.organization_id === null) {
        await withPlatform(deps.dbPlatform, AUTHN_ACCESS, (trx) =>
          trx.insertInto('auth_events').values(row).execute(),
        );
      } else {
        await withTenant(deps.db, row.organization_id, async (trx) => {
          await trx.insertInto('auth_events').values(row).execute();
          // Only the session bound to this decision (cache, or a Class verified against the
          // sending NAS above): never an arbitrary Class value from the packet.
          const sessionId = facts?.session_id ?? null;
          if (result === 'reject' && sessionId !== null) {
            await trx
              .updateTable('sessions')
              .set({ status: 'stopped', stopped_at: now(), terminate_cause: 'auth-rejected' })
              .where('id', '=', sessionId)
              .where('status', 'in', ['authorized', 'active'])
              .where('input_octets', '=', 0)
              .execute();
          }
        });
      }
    } catch (error) {
      // FreeRADIUS ignores the answer (contract §5); log and still acknowledge.
      req.log.error({ err: error }, 'aaa post-auth recording failed');
    }
    res.status(204).end();
  };
}
