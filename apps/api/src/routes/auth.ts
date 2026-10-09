/**
 * Admin authentication (API_ARCHITECTURE.md §4): login (Argon2id, generic failure, per-IP and
 * per-account limits, lockout), TOTP enrol/confirm/verify, logout, /auth/me, invitation accept.
 */
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword, withPlatform } from '@ecloud/db';
import { ConflictError, NotFoundError, UnauthorizedError, newId } from '@ecloud/shared';
import { z } from 'zod';
import { auditSnapshot, writeAudit } from '../audit.js';
import { permissionsByScope } from '../auth/authorize.js';
import {
  clearSessionCookie,
  parentCookieName,
  parseCookies,
  setSessionCookie,
} from '../auth/middleware.js';
import { MfaCodec, newRecoveryCodes, normalizeRecoveryCode } from '../auth/mfa.js';
import { AUTHN_ACCESS } from '../auth/principal.js';
import {
  LOGIN_LIMITS,
  assertNotLocked,
  clearFailures,
  hitLimit,
  recordFailure,
} from '../auth/rate-limit.js';
import { createAdminSession, revokeSessionByToken } from '../auth/sessions.js';
import type { AppDeps, Principal } from '../context.js';
import { randomToken, sha256Hex } from '../crypto.js';
import { ServiceUnavailableError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { logAuthFailure } from '../security-events.js';

const TAG = ['auth'];
const MFA_CHALLENGE_TTL_S = 300;

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  password: z.string().min(1).max(1024),
});

const MfaVerifyBody = z
  .object({
    mfa_token: z.string().min(20).max(128),
    code: z
      .string()
      .regex(/^[0-9]{6}$/)
      .optional(),
    recovery_code: z.string().min(8).max(32).optional(),
  })
  .refine((b) => (b.code === undefined) !== (b.recovery_code === undefined), {
    message: 'exactly one of code or recovery_code is required',
  });

const MfaConfirmBody = z.object({ code: z.string().regex(/^[0-9]{6}$/) });

const AcceptInvitationBody = z.object({
  token: z.string().min(20).max(128),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  display_name: z.string().trim().min(1).max(200).optional(),
});

const SessionResponse = z.object({
  mfa_required: z.boolean(),
  mfa_token: z.string().optional(),
  administrator: z.looseObject({ id: z.string(), email: z.string() }).optional(),
});

interface MfaChallenge {
  administratorId: string;
  /** Legacy field; attempts are counted atomically under `<challenge key>:attempts`. */
  attempts?: number;
}

let dummyHash: Promise<string> | undefined;
/** Verifies against a throw-away hash so unknown emails cost the same as wrong passwords. */
function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(randomToken(24));
  return dummyHash.then((hash) => verifyPassword(hash, password)).catch(() => false);
}

function adminView(row: { id: string; email: string; display_name: string; status: string }) {
  return { id: row.id, email: row.email, display_name: row.display_name, status: row.status };
}

export function authRoutes(deps: AppDeps): AnyRouteSpec[] {
  const now = deps.now ?? (() => new Date());
  const mfa = new MfaCodec(deps.config.mfaEncryptionKey);
  const ttl = deps.config.session.ttlSeconds;

  const login = defineRoute({
    method: 'post',
    path: '/api/v1/auth/login',
    summary: 'Log in with email and password',
    tags: TAG,
    auth: 'public',
    body: LoginBody,
    responses: {
      200: { description: 'Session created or MFA challenge issued', schema: SessionResponse },
      401: { description: 'Invalid credentials (generic)' },
      429: { description: 'Rate limited or account locked' },
    },
    handler: async ({ body, res, ctx }) => {
      await hitLimit(
        deps,
        `login:ip:${ctx.ip ?? 'unknown'}`,
        LOGIN_LIMITS.perIp,
        LOGIN_LIMITS.windowSeconds,
      );
      await assertNotLocked(deps, body.email);
      const at = now();
      const admin = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, (trx) =>
        trx
          .selectFrom('administrators as a')
          .leftJoin('mfa_credentials as m', (join) =>
            join.onRef('m.administrator_id', '=', 'a.id').on('m.verified_at', 'is not', null),
          )
          .select((eb) => [
            'a.id',
            'a.email',
            'a.display_name',
            'a.status',
            'a.password_hash',
            'a.mfa_enforced',
            'a.mfa_reenrol_required',
            'm.id as mfa_id',
            eb
              .exists(
                eb
                  .selectFrom('role_bindings as rb')
                  .select('rb.id')
                  .whereRef('rb.administrator_id', '=', 'a.id')
                  .where('rb.scope_type', '=', 'platform')
                  .where((w) =>
                    w.or([w('rb.expires_at', 'is', null), w('rb.expires_at', '>', at)]),
                  ),
              )
              .as('platform_bound'),
          ])
          .where((eb) => eb(eb.fn('lower', ['a.email']), '=', body.email))
          .where('a.deleted_at', 'is', null)
          .executeTakeFirst(),
      );
      const ok =
        admin?.password_hash !== undefined && admin.password_hash !== null
          ? await verifyPassword(admin.password_hash, body.password).catch(() => false)
          : await dummyVerify(body.password);
      if (!ok || admin === undefined || admin.status !== 'active') {
        await recordFailure(deps, body.email);
        await withPlatform(deps.dbPlatform, AUTHN_ACCESS, (trx) =>
          writeAudit(trx, ctx, {
            organizationId: null,
            action: 'auth:login:failed',
            targetType: admin === undefined ? null : 'administrator',
            targetId: admin?.id ?? null,
          }),
        );
        logAuthFailure(deps.logger, 'admin_login_failed', ctx.ip, ctx.requestId);
        throw new UnauthorizedError({ detail: 'Invalid email or password.' });
      }
      await clearFailures(deps, body.email);

      if (admin.mfa_id !== null) {
        const token = randomToken(32);
        const challenge: MfaChallenge = { administratorId: admin.id, attempts: 0 };
        const stored = await deps.kv
          .set(`mfa:${sha256Hex(token)}`, JSON.stringify(challenge), MFA_CHALLENGE_TTL_S)
          .catch(() => false);
        if (!stored) throw new ServiceUnavailableError('MFA challenge store unavailable.');
        ctx.audited = true; // audited on completion (auth:login)
        return { status: 200, body: { mfa_required: true, mfa_token: token } };
      }

      const session = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
        const s = await createAdminSession(trx, {
          administratorId: admin.id,
          ttlSeconds: ttl,
          now: at,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await trx
          .updateTable('administrators')
          .set({ last_login_at: at })
          .where('id', '=', admin.id)
          .execute();
        await writeAudit(
          trx,
          { ...ctx, principal: adminPrincipalStub(admin.id, s.id) },
          {
            organizationId: null,
            action: 'auth:login',
            targetType: 'administrator',
            targetId: admin.id,
            after: { mfa: false },
          },
        );
        return s;
      });
      ctx.audited = true;
      setSessionCookie(deps, res, session.token, ttl);
      return {
        status: 200,
        body: {
          mfa_required: false,
          administrator: adminView(admin),
          // Until enrolment is confirmed the session holds no permissions (auth/principal.ts).
          mfa_enrolment_required:
            admin.mfa_enforced || admin.mfa_reenrol_required || admin.platform_bound,
        },
      };
    },
  });

  const mfaVerify = defineRoute({
    method: 'post',
    path: '/api/v1/auth/mfa/verify',
    summary: 'Complete a login with a TOTP or recovery code',
    tags: TAG,
    auth: 'public',
    body: MfaVerifyBody,
    responses: {
      200: { description: 'Session created', schema: SessionResponse },
      401: { description: 'Invalid or expired challenge / code' },
    },
    handler: async ({ body, res, ctx }) => {
      await hitLimit(
        deps,
        `mfa:ip:${ctx.ip ?? 'unknown'}`,
        LOGIN_LIMITS.perIp,
        LOGIN_LIMITS.windowSeconds,
      );
      const key = `mfa:${sha256Hex(body.mfa_token)}`;
      const mfaFailed = (detail: string): UnauthorizedError => {
        logAuthFailure(deps.logger, 'admin_mfa_failed', ctx.ip, ctx.requestId);
        return new UnauthorizedError({ detail });
      };
      let raw: string | null;
      let attempts: number;
      try {
        raw = await deps.kv.get(key);
        // P10-A: atomic counter (INCR). The former read-modify-write of `attempts` let parallel
        // requests on one challenge each see the same count and exceed LOGIN_LIMITS.mfaAttempts.
        attempts = raw === null ? 0 : await deps.kv.incr(`${key}:attempts`, MFA_CHALLENGE_TTL_S);
      } catch {
        throw new ServiceUnavailableError('MFA challenge store unavailable.');
      }
      if (raw === null) throw mfaFailed('MFA challenge expired.');
      const challenge = JSON.parse(raw) as MfaChallenge;
      if (attempts > LOGIN_LIMITS.mfaAttempts) {
        await deps.kv.del(key).catch(() => undefined);
        throw mfaFailed('MFA challenge expired.');
      }
      const at = now();

      const result = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
        const row = await trx
          .selectFrom('mfa_credentials as m')
          .innerJoin('administrators as a', 'a.id', 'm.administrator_id')
          .select([
            'm.id',
            'm.secret_enc',
            'm.recovery_codes_hash',
            'a.id as administrator_id',
            'a.email',
            'a.display_name',
            'a.status',
          ])
          .where('m.administrator_id', '=', challenge.administratorId)
          .where('m.verified_at', 'is not', null)
          .where('a.deleted_at', 'is', null)
          .executeTakeFirst();
        if (row === undefined || row.status !== 'active') return null;
        let method: 'totp' | 'recovery_code';
        if (body.code !== undefined) {
          if (!(await mfa.check(mfa.open(row.secret_enc), body.code))) return null;
          method = 'totp';
          await trx
            .updateTable('mfa_credentials')
            .set({ last_used_at: at })
            .where('id', '=', row.id)
            .execute();
        } else {
          const hash = sha256Hex(normalizeRecoveryCode(body.recovery_code ?? ''));
          if (!row.recovery_codes_hash.includes(hash)) return null;
          method = 'recovery_code';
          await trx
            .updateTable('mfa_credentials')
            .set({
              recovery_codes_hash: row.recovery_codes_hash.filter((h) => h !== hash),
              last_used_at: at,
            })
            .where('id', '=', row.id)
            .execute();
        }
        const session = await createAdminSession(trx, {
          administratorId: row.administrator_id,
          ttlSeconds: ttl,
          now: at,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          mfaVerifiedAt: at,
        });
        await trx
          .updateTable('administrators')
          .set({ last_login_at: at })
          .where('id', '=', row.administrator_id)
          .execute();
        await writeAudit(
          trx,
          { ...ctx, principal: adminPrincipalStub(row.administrator_id, session.id) },
          {
            organizationId: null,
            action: 'auth:login',
            targetType: 'administrator',
            targetId: row.administrator_id,
            after: { mfa: method },
          },
        );
        return { session, admin: row };
      });
      if (result === null) throw mfaFailed('Invalid MFA code.');
      ctx.audited = true;
      await deps.kv.del(key);
      await deps.kv.del(`${key}:attempts`).catch(() => undefined);
      setSessionCookie(deps, res, result.session.token, ttl);
      return {
        status: 200,
        body: {
          mfa_required: false,
          administrator: adminView({ ...result.admin, id: result.admin.administrator_id }),
        },
      };
    },
  });

  const mfaEnrol = defineRoute({
    method: 'post',
    path: '/api/v1/auth/mfa/enrol',
    summary: 'Start TOTP enrolment (secret shown once)',
    tags: TAG,
    auth: 'session',
    responses: {
      201: {
        description: 'Unverified TOTP credential created',
        schema: z.object({ secret: z.string(), otpauth_uri: z.string() }),
      },
      409: { description: 'TOTP already enrolled' },
    },
    handler: async ({ ctx }) => {
      const principal = ctx.principal as Extract<Principal, { kind: 'admin' }>;
      const secret = mfa.newSecret();
      await withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
        const existing = await trx
          .selectFrom('mfa_credentials')
          .select(['id', 'verified_at'])
          .where('administrator_id', '=', principal.administratorId)
          .where('type', '=', 'totp')
          .executeTakeFirst();
        if (existing?.verified_at !== undefined && existing.verified_at !== null) {
          throw new ConflictError({ detail: 'TOTP is already enrolled.' });
        }
        if (existing === undefined) {
          await trx
            .insertInto('mfa_credentials')
            .values({
              id: newId(),
              administrator_id: principal.administratorId,
              type: 'totp',
              label: 'authenticator',
              secret_enc: mfa.seal(secret),
            })
            .execute();
        } else {
          await trx
            .updateTable('mfa_credentials')
            .set({ secret_enc: mfa.seal(secret), recovery_codes_hash: [] })
            .where('id', '=', existing.id)
            .execute();
        }
        await writeAudit(trx, ctx, {
          organizationId: null,
          action: 'auth:mfa:enrol',
          targetType: 'administrator',
          targetId: principal.administratorId,
        });
      });
      return {
        status: 201,
        body: { secret, otpauth_uri: mfa.uri(secret, principal.email) },
      };
    },
  });

  const mfaConfirm = defineRoute({
    method: 'post',
    path: '/api/v1/auth/mfa/confirm',
    summary: 'Confirm TOTP enrolment; returns recovery codes once',
    tags: TAG,
    auth: 'session',
    body: MfaConfirmBody,
    responses: {
      200: {
        description: 'TOTP verified',
        schema: z.object({ recovery_codes: z.array(z.string()) }),
      },
      401: { description: 'Invalid code' },
      404: { description: 'No pending enrolment' },
    },
    handler: async ({ body, ctx }) => {
      const principal = ctx.principal as Extract<Principal, { kind: 'admin' }>;
      const at = now();
      const codes = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
        const row = await trx
          .selectFrom('mfa_credentials')
          .select(['id', 'secret_enc', 'verified_at'])
          .where('administrator_id', '=', principal.administratorId)
          .where('type', '=', 'totp')
          .executeTakeFirst();
        if (row === undefined || row.verified_at !== null) {
          throw new NotFoundError('pending MFA enrolment');
        }
        if (!(await mfa.check(mfa.open(row.secret_enc), body.code))) {
          throw new UnauthorizedError({ detail: 'Invalid MFA code.' });
        }
        const recovery = newRecoveryCodes();
        await trx
          .updateTable('mfa_credentials')
          .set({ verified_at: at, last_used_at: at, recovery_codes_hash: recovery.hashes })
          .where('id', '=', row.id)
          .execute();
        // The code just proved possession of the factor: the enrolling session is now MFA-verified.
        await trx
          .updateTable('admin_sessions')
          .set({ mfa_verified_at: at })
          .where('id', '=', principal.sessionId)
          .execute();
        // D-038: a confirmed new factor completes the re-enrolment forced by an MFA reset.
        await trx
          .updateTable('administrators')
          .set({ mfa_reenrol_required: false })
          .where('id', '=', principal.administratorId)
          .where('mfa_reenrol_required', '=', true)
          .execute();
        await writeAudit(trx, ctx, {
          organizationId: null,
          action: 'auth:mfa:confirm',
          targetType: 'administrator',
          targetId: principal.administratorId,
        });
        return recovery.codes;
      });
      return { status: 200, body: { recovery_codes: codes } };
    },
  });

  const logout = defineRoute({
    method: 'post',
    path: '/api/v1/auth/logout',
    summary: 'Revoke the current session',
    tags: TAG,
    auth: 'session',
    responses: { 204: { description: 'Logged out' } },
    handler: async ({ req, res, ctx }) => {
      const cookies = parseCookies(req.get('Cookie'));
      const name = deps.config.session.cookieName;
      const at = now();
      await withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
        for (const cookie of [name, parentCookieName(name)]) {
          const token = cookies.get(cookie);
          if (token) await revokeSessionByToken(trx, token, at);
        }
        const principal = ctx.principal as Extract<Principal, { kind: 'admin' }>;
        await writeAudit(trx, ctx, {
          organizationId: principal.impersonation?.organizationId ?? null,
          action: 'auth:logout',
          targetType: 'administrator',
          targetId: principal.administratorId,
        });
      });
      clearSessionCookie(deps, res);
      clearSessionCookie(deps, res, parentCookieName(name));
      return { status: 204 };
    },
  });

  const me = defineRoute({
    method: 'get',
    path: '/api/v1/auth/me',
    summary: 'Current principal, bindings and effective permissions',
    tags: TAG,
    auth: 'principal',
    responses: { 200: { description: 'Principal', schema: z.looseObject({ kind: z.string() }) } },
    handler: async ({ ctx }) => {
      const principal = ctx.principal as Principal;
      const permissions_by_scope = permissionsByScope(principal);
      if (principal.kind === 'api_key') {
        return {
          status: 200,
          body: {
            kind: 'api_key',
            api_key: { id: principal.apiKeyId, organization_id: principal.organizationId },
            permissions_by_scope,
          },
        };
      }
      const row = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, async (trx) => {
        const admin = await trx
          .selectFrom('administrators')
          .select([
            'id',
            'email',
            'display_name',
            'status',
            'mfa_enforced',
            'mfa_reenrol_required',
            'last_login_at',
          ])
          .where('id', '=', principal.administratorId)
          .executeTakeFirstOrThrow();
        const cred = await trx
          .selectFrom('mfa_credentials')
          .select(['verified_at'])
          .where('administrator_id', '=', principal.administratorId)
          .executeTakeFirst();
        const bindings = await trx
          .selectFrom('role_bindings as rb')
          .innerJoin('roles as r', 'r.id', 'rb.role_id')
          .select([
            'rb.id',
            'rb.scope_type',
            'rb.organization_id',
            'rb.site_id',
            'rb.expires_at',
            'r.id as role_id',
            'r.key as role_key',
            'r.name as role_name',
          ])
          .where('rb.administrator_id', '=', principal.administratorId)
          .execute();
        return { admin, enrolled: cred !== undefined && cred.verified_at !== null, bindings };
      });
      const hasPlatformBinding = row.bindings.some((b) => b.scope_type === 'platform');
      return {
        status: 200,
        body: {
          kind: 'admin',
          administrator: {
            ...adminView(row.admin),
            last_login_at: row.admin.last_login_at,
          },
          mfa: {
            enrolled: row.enrolled,
            // SECURITY_ARCHITECTURE.md §6.2: mandatory for platform bindings.
            required:
              row.admin.mfa_enforced || row.admin.mfa_reenrol_required || hasPlatformBinding,
            // D-038: set by an MFA reset until a new factor is confirmed.
            reenrol_required: row.admin.mfa_reenrol_required,
            // true: this session holds no permissions until TOTP is confirmed / used at login.
            pending: principal.mfaPending,
          },
          bindings: row.bindings,
          permissions_by_scope,
          impersonation:
            principal.impersonation === null
              ? null
              : {
                  organization_id: principal.impersonation.organizationId,
                  reason: principal.impersonation.reason,
                  expires_at: principal.impersonation.expiresAt.toISOString(),
                },
        },
      };
    },
  });

  const acceptInvitation = defineRoute({
    method: 'post',
    path: '/api/v1/auth/accept-invitation',
    summary: 'Accept an administrator invitation (creates or links the account)',
    tags: TAG,
    auth: 'public',
    body: AcceptInvitationBody,
    responses: {
      200: { description: 'Invitation accepted, session created', schema: SessionResponse },
      401: { description: 'Invalid or expired invitation / password' },
    },
    handler: async ({ body, res, ctx }) => {
      await hitLimit(
        deps,
        `invite:ip:${ctx.ip ?? 'unknown'}`,
        LOGIN_LIMITS.perIp,
        LOGIN_LIMITS.windowSeconds,
      );
      const at = now();
      const tokenHash = sha256Hex(body.token);
      const invitation = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, (trx) =>
        trx
          .selectFrom('invitations')
          .selectAll()
          .where('token_hash', '=', tokenHash)
          .where('accepted_at', 'is', null)
          .where('expires_at', '>', at)
          .executeTakeFirst(),
      );
      if (invitation === undefined) {
        logAuthFailure(deps.logger, 'admin_invitation_failed', ctx.ip, ctx.requestId);
        throw new UnauthorizedError({ detail: 'Invalid invitation.' });
      }
      const existing = await withPlatform(deps.dbPlatform, AUTHN_ACCESS, (trx) =>
        trx
          .selectFrom('administrators')
          .select(['id', 'password_hash', 'status'])
          .where((eb) => eb(eb.fn('lower', ['email']), '=', invitation.email))
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      );
      if (existing !== undefined) {
        const ok =
          existing.password_hash !== null &&
          existing.status === 'active' &&
          (await verifyPassword(existing.password_hash, body.password).catch(() => false));
        if (!ok) {
          logAuthFailure(deps.logger, 'admin_invitation_failed', ctx.ip, ctx.requestId);
          throw new UnauthorizedError({ detail: 'Invalid invitation.' });
        }
      }
      const passwordHash =
        existing === undefined
          ? await hashPassword(body.password, { memoryKib: deps.config.base.argon2.memoryKib })
          : null;

      const outcome = await withPlatform(
        deps.dbPlatform,
        {
          reason: 'invitation accept',
          actorType: 'system',
          organizationId: invitation.organization_id,
          requestId: ctx.requestId,
          ip: ctx.ip,
        },
        async (trx) => {
          const claimed = await trx
            .updateTable('invitations')
            .set({ accepted_at: at })
            .where('id', '=', invitation.id)
            .where('accepted_at', 'is', null)
            .returning('id')
            .executeTakeFirst();
          if (claimed === undefined) throw new UnauthorizedError({ detail: 'Invalid invitation.' });
          let administratorId = existing?.id;
          if (administratorId === undefined) {
            administratorId = newId();
            await trx
              .insertInto('administrators')
              .values({
                id: administratorId,
                email: invitation.email,
                display_name: body.display_name ?? invitation.email,
                password_hash: passwordHash,
                status: 'active',
              })
              .execute();
          }
          await trx
            .updateTable('invitations')
            .set({ accepted_administrator_id: administratorId })
            .where('id', '=', invitation.id)
            .execute();
          const bindingId = newId();
          await trx
            .insertInto('role_bindings')
            .values({
              id: bindingId,
              administrator_id: administratorId,
              role_id: invitation.role_id,
              scope_type: invitation.scope_type,
              organization_id: invitation.organization_id,
              site_id: invitation.site_id,
              granted_by: invitation.invited_by,
            })
            .onConflict((oc) => oc.doNothing())
            .execute();
          const session = await createAdminSession(trx, {
            administratorId,
            ttlSeconds: ttl,
            now: at,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          await writeAudit(
            trx,
            { ...ctx, principal: adminPrincipalStub(administratorId, session.id) },
            {
              organizationId: invitation.organization_id,
              action: 'administrator:invitation:accept',
              targetType: 'administrator',
              targetId: administratorId,
              after: auditSnapshot({
                invitation_id: invitation.id,
                role_id: invitation.role_id,
                scope_type: invitation.scope_type,
                site_id: invitation.site_id,
              }),
            },
          );
          return { administratorId, session };
        },
      );
      ctx.audited = true;
      setSessionCookie(deps, res, outcome.session.token, ttl);
      return {
        status: 200,
        body: {
          mfa_required: false,
          administrator: { id: outcome.administratorId, email: invitation.email },
        },
      };
    },
  });

  return [login, mfaVerify, mfaEnrol, mfaConfirm, logout, me, acceptInvitation];
}

/** Minimal principal used to attribute audit rows written before the request had one. */
function adminPrincipalStub(administratorId: string, sessionId: string): Principal {
  return {
    kind: 'admin',
    administratorId,
    email: '',
    sessionId,
    impersonation: null,
    grants: [],
    mfaVerifiedAt: null,
    mfaPending: false,
  };
}
