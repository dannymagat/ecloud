/**
 * AAA side of the identity broker (D-018; SECURITY_ARCHITECTURE.md §5.6): an Access-Request whose
 * User-Name is a portal credential `pc-<16 hex>` is authenticated against the single-use record
 * the portal flow created, never against `users`/`vouchers` directly.
 *
 * Checks, all fail-closed with a generic Reply-Message: credential known and not expired; PAP
 * password matches (SHA-256, constant time); the authenticated NAS (packet source, resolved by
 * `aaa.ts`) is the NAS the credential is bound to, in the same organization; Calling-Station-Id
 * is the bound client MAC; Acct-Session-Id equals the UAM sessionid when one was bound; the
 * credential was not consumed before (atomic SET NX). The proven identity is then re-checked (a
 * user disabled or a voucher revoked within the TTL is refused) and the redirect is marked as
 * consumed in the replay store. Retransmits of the same packet are answered from the AAA
 * retransmit cache (`aaa.ts`), so they never reach the single-use claim.
 */
import type { Subject } from '@ecloud/policy-engine';
import type { DbTransaction } from '@ecloud/db';
import type { AppDeps } from '../context.js';
import {
  claimCredential,
  credentialPasswordMatches,
  loadCredential,
  loadFlow,
  markReplayed,
  revokeCredential,
  saveFlow,
} from './portal-store.js';
import {
  IdentityRejected,
  clickThroughDevice,
  recheckUser,
  recheckVoucher,
} from './portal-identity.js';
import { attr, macFrom, type RadiusRequestBody } from './radius.js';

export type PortalAuthMethod = 'portal_password' | 'portal_voucher' | 'portal_click_through';

export interface PortalIdentity {
  subject: Subject;
  authMethod: PortalAuthMethod;
  userId: string | null;
  voucherId: string | null;
  voucherBatchId: string | null;
  groupIds: string[];
}

export interface PortalNas {
  readonly id: string;
  readonly organization_id: string;
  readonly site_id: string;
}

export async function identifyPortalCredential(
  deps: AppDeps,
  trx: DbTransaction,
  body: RadiusRequestBody,
  nas: PortalNas,
  now: Date,
): Promise<PortalIdentity> {
  const username = attr(body, 'User-Name') ?? '';
  const password = attr(body, 'User-Password');
  const credential = await loadCredential(deps.kv, username);
  if (credential === null) throw new IdentityRejected('portal_credential_unknown');
  if (password === undefined || !credentialPasswordMatches(credential, password)) {
    throw new IdentityRejected('portal_credential_bad_password');
  }
  if (Date.parse(credential.expiresAt) <= now.getTime()) {
    throw new IdentityRejected('portal_credential_expired');
  }
  if (credential.organizationId !== nas.organization_id) {
    throw new IdentityRejected('portal_credential_tenant_mismatch');
  }
  if (credential.nasId !== nas.id) throw new IdentityRejected('portal_credential_nas_mismatch');
  if (macFrom(attr(body, 'Calling-Station-Id')) !== credential.clientMac) {
    throw new IdentityRejected('portal_credential_mac_mismatch');
  }
  if (
    credential.sessionId !== null &&
    (attr(body, 'Acct-Session-Id') ?? '') !== credential.sessionId
  ) {
    throw new IdentityRejected('portal_credential_session_mismatch');
  }
  if (!(await claimCredential(deps.kv, username))) {
    throw new IdentityRejected('portal_credential_consumed');
  }

  let identity: PortalIdentity;
  const id = credential.identity;
  if (id.kind === 'user') {
    const user = await recheckUser(trx, { userId: id.userId, siteId: nas.site_id, now });
    identity = {
      subject: { kind: 'user', user_id: user.id },
      authMethod: 'portal_password',
      userId: user.id,
      voucherId: null,
      voucherBatchId: null,
      groupIds: user.userGroupId === null ? [] : [user.userGroupId],
    };
  } else if (id.kind === 'voucher') {
    const v = await recheckVoucher(trx, { voucherId: id.voucherId, siteId: nas.site_id, now });
    identity = {
      subject: {
        kind: 'voucher',
        user_id: v.boundUserId,
        voucher: {
          batch_id: v.batchId,
          expires_at: v.expiresAt,
          activated_at: v.activatedAt,
          duration_s: v.durationS,
          batch_valid_from: v.batchValidFrom,
          batch_valid_until: v.batchValidUntil,
        },
      },
      authMethod: 'portal_voucher',
      userId: v.boundUserId,
      voucherId: v.id,
      voucherBatchId: v.batchId,
      groupIds: [],
    };
  } else {
    const deviceId = await clickThroughDevice(trx, {
      organizationId: nas.organization_id,
      mac: credential.clientMac,
      now,
    });
    identity = {
      subject: { kind: 'client_device', client_device_id: deviceId },
      authMethod: 'portal_click_through',
      userId: null,
      voucherId: null,
      voucherBatchId: null,
      groupIds: [],
    };
  }

  // The redirect that led here is now consumed (validateContext → `replayed` from now on).
  await markReplayed(deps.kv, credential.replayKey);
  await revokeCredential(deps.kv, username);
  const flow = await loadFlow(deps.kv, credential.flowId, now).catch(() => null);
  if (flow !== null && flow.state === 'LOGON_SENT') {
    flow.state = 'AUTHORIZED';
    await saveFlow(deps.kv, flow, now).catch(() => undefined);
  }
  return identity;
}
