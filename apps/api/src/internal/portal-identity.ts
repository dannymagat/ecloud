/**
 * Identity checks of the captive-portal identity broker (D-018, CAPTIVE_PORTAL_ARCHITECTURE.md
 * §7.1): run once when the portal asks for a credential and again by AAA when the credential is
 * presented (an account disabled or a voucher revoked within the 90 s window is still refused).
 * The rules mirror `/internal/aaa/authorize` (users: Argon2id, status, site, validity; vouchers:
 * HMAC lookup, status, site, D-037 limits). Rejections carry an internal reason only; callers map
 * every rejection to one generic message (same response body/status for unknown account and wrong
 * password, SECURITY §5.4-§5.5). Timing: an unknown user still costs one Argon2id verification
 * (dummy hash); response times are NOT guaranteed identical (lookup/row differences remain).
 */
import { hashPassword, verifyPassword, type DbTransaction } from '@ecloud/db';
import { randomBytes } from 'node:crypto';
import { normalizeVoucherCode } from '../crypto.js';
import { voucherHash } from '../routes/vouchers.js';

export class IdentityRejected extends Error {
  constructor(
    readonly reason: string,
    readonly replyMessage = 'Access denied',
  ) {
    super(reason);
  }
}

export interface UsableUser {
  readonly id: string;
  readonly userGroupId: string | null;
}

const USER_COLUMNS = [
  'id',
  'site_id',
  'password_hash',
  'auth_methods',
  'status',
  'valid_from',
  'valid_until',
  'user_group_id',
] as const;

type UserRow = {
  id: string;
  site_id: string | null;
  password_hash: string | null;
  auth_methods: string[];
  status: string;
  valid_from: Date | null;
  valid_until: Date | null;
  user_group_id: string | null;
};

function assertUserUsable(user: UserRow, siteId: string, now: Date): UsableUser {
  if (user.status !== 'active') throw new IdentityRejected(`user_${user.status}`);
  if (user.site_id !== null && user.site_id !== siteId) throw new IdentityRejected('site_mismatch');
  if (user.valid_from !== null && user.valid_from.getTime() > now.getTime()) {
    throw new IdentityRejected('user_not_yet_valid');
  }
  if (user.valid_until !== null && user.valid_until.getTime() <= now.getTime()) {
    throw new IdentityRejected('user_expired');
  }
  return { id: user.id, userGroupId: user.user_group_id };
}

export type PasswordVerifier = (hash: string, password: string) => Promise<boolean>;

let dummy: { memoryKib: number; hash: Promise<string> } | undefined;

/**
 * Argon2id hash of a random value with the configured parameters, computed once per process.
 * Used so an unknown username (or a user without a password) costs one Argon2id verification
 * like a known one. This removes the gross "no hash computed" timing difference; it does not
 * claim full timing indistinguishability (DB lookup and row shape still differ slightly).
 */
export function dummyPasswordHash(memoryKib: number): Promise<string> {
  if (dummy?.memoryKib !== memoryKib) {
    dummy = { memoryKib, hash: hashPassword(randomBytes(24).toString('base64url'), { memoryKib }) };
  }
  return dummy.hash;
}

/**
 * True only for an existing user with a password hash, the `password` method enabled and a
 * matching password. Every path runs exactly one `verify` call (against the dummy hash when
 * there is no usable hash).
 */
export async function checkSubscriberPassword(
  user: Pick<UserRow, 'password_hash' | 'auth_methods'> | undefined,
  password: string,
  opts: { verify: PasswordVerifier; dummyHash: () => Promise<string> },
): Promise<boolean> {
  const hash = user?.password_hash ?? null;
  if (user === undefined || hash === null) {
    await opts.verify(await opts.dummyHash(), password).catch(() => false);
    return false;
  }
  const match = await opts.verify(hash, password).catch(() => false);
  return match && user.auth_methods.includes('password');
}

/** Username + password at the portal (case-insensitive username, Argon2id). */
export async function verifySubscriberLogin(
  trx: DbTransaction,
  input: {
    username: string;
    password: string;
    siteId: string;
    now: Date;
    argon2MemoryKib: number;
    verify?: PasswordVerifier;
  },
): Promise<UsableUser> {
  const user = (await trx
    .selectFrom('users')
    .select([...USER_COLUMNS])
    .where((eb) => eb(eb.fn('lower', ['username']), '=', input.username.toLowerCase()))
    .where('deleted_at', 'is', null)
    .executeTakeFirst()) as UserRow | undefined;
  const ok = await checkSubscriberPassword(user, input.password, {
    verify: input.verify ?? verifyPassword,
    dummyHash: () => dummyPasswordHash(input.argon2MemoryKib),
  });
  if (!ok || user === undefined) throw new IdentityRejected('bad_credentials');
  return assertUserUsable(user, input.siteId, input.now);
}

/** AAA re-check of a user the portal already verified. */
export async function recheckUser(
  trx: DbTransaction,
  input: { userId: string; siteId: string; now: Date },
): Promise<UsableUser> {
  const user = (await trx
    .selectFrom('users')
    .select([...USER_COLUMNS])
    .where('id', '=', input.userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()) as UserRow | undefined;
  if (user === undefined) throw new IdentityRejected('user_deleted');
  return assertUserUsable(user, input.siteId, input.now);
}

export interface UsableVoucher {
  readonly id: string;
  readonly batchId: string;
  readonly boundUserId: string | null;
  readonly activatedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly durationS: number | null;
  readonly batchValidFrom: Date | null;
  readonly batchValidUntil: Date | null;
}

async function loadVoucher(
  trx: DbTransaction,
  where: { codeHash: string } | { id: string },
  lock: boolean,
) {
  let query = trx
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
    .where('v.deleted_at', 'is', null);
  query =
    'codeHash' in where
      ? query.where('v.code_hash', '=', where.codeHash)
      : query.where('v.id', '=', where.id);
  return lock ? query.forUpdate().executeTakeFirst() : query.executeTakeFirst();
}

type VoucherRow = NonNullable<Awaited<ReturnType<typeof loadVoucher>>>;

function assertVoucherUsable(v: VoucherRow, siteId: string, now: Date): UsableVoucher {
  if (v.status === 'revoked' || v.status === 'exhausted' || v.status === 'expired') {
    throw new IdentityRejected(`voucher_${v.status}`, 'Voucher is no longer valid');
  }
  if (v.site_id !== null && v.site_id !== siteId) throw new IdentityRejected('site_mismatch');
  if (v.max_uses !== null && v.use_count >= v.max_uses) {
    throw new IdentityRejected('voucher_exhausted', 'Voucher is no longer valid');
  }
  if (v.expires_at !== null && v.expires_at.getTime() <= now.getTime()) {
    throw new IdentityRejected('voucher_expired', 'Voucher expired');
  }
  if (v.valid_from !== null && v.valid_from.getTime() > now.getTime()) {
    throw new IdentityRejected('voucher_not_yet_valid', 'Voucher not yet valid');
  }
  if (v.valid_until !== null && v.valid_until.getTime() <= now.getTime()) {
    throw new IdentityRejected('voucher_expired', 'Voucher expired');
  }
  return {
    id: v.id,
    batchId: v.batch_id,
    boundUserId: v.bound_user_id,
    activatedAt: v.activated_at,
    expiresAt: v.expires_at,
    durationS: v.duration_s,
    batchValidFrom: v.valid_from,
    batchValidUntil: v.valid_until,
  };
}

/** Voucher code at the portal (HMAC lookup; the code is never stored or logged). */
export async function verifyVoucherCode(
  trx: DbTransaction,
  input: { pepper: string; code: string; siteId: string; now: Date },
): Promise<UsableVoucher> {
  const code = normalizeVoucherCode(input.code);
  if (code.length < 4 || code.length > 64) throw new IdentityRejected('bad_credentials');
  const v = await loadVoucher(trx, { codeHash: voucherHash(input.pepper, code) }, false);
  if (v === undefined) throw new IdentityRejected('bad_credentials');
  return assertVoucherUsable(v, input.siteId, input.now);
}

/** AAA re-check (row locked: the caller consumes one use in the same transaction). */
export async function recheckVoucher(
  trx: DbTransaction,
  input: { voucherId: string; siteId: string; now: Date },
): Promise<UsableVoucher> {
  const v = await loadVoucher(trx, { id: input.voucherId }, true);
  if (v === undefined) throw new IdentityRejected('voucher_deleted');
  return assertVoucherUsable(v, input.siteId, input.now);
}

/**
 * Click-through: the subject is the device (a device observation, not a person). The
 * `client_devices` row is created on first use so the policy layer can resolve it.
 */
export async function clickThroughDevice(
  trx: DbTransaction,
  input: { organizationId: string; mac: string; now: Date },
): Promise<string> {
  const existing = await trx
    .selectFrom('client_devices')
    .select(['id', 'blocked'])
    .where('mac', '=', input.mac)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (existing !== undefined) {
    if (existing.blocked) throw new IdentityRejected('device_blocked', 'Device is blocked');
    return existing.id;
  }
  const created = await trx
    .insertInto('client_devices')
    .values({
      organization_id: input.organizationId,
      mac: input.mac,
      first_seen_at: input.now,
      last_seen_at: input.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return created.id;
}
