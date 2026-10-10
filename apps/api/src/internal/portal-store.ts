/**
 * Short-lived captive-portal state in the KV store (Redis in production, CAPTIVE_PORTAL_ARCHITECTURE
 * §7.2 / SECURITY_ARCHITECTURE §5.6): portal flows (15 min), the redirect replay store, and the
 * identity broker's single-use portal credentials (90 s). Nothing here is durable on purpose:
 * a credential that outlives Redis would outlive its 90 s TTL anyway, and the durable trail is
 * `portal_login_attempts` + `auth_events` + `sessions`. No subscriber password is ever stored;
 * the portal credential password is kept only as a SHA-256 hash (it is 96 random bits).
 */
import { randomBytes } from 'node:crypto';
import type { DeploymentMode } from '@ecloud/adapters';
import type { KvStore } from '../kv.js';
import { safeEqual, sha256Hex } from '../crypto.js';

export const FLOW_TTL_S = 15 * 60;
/** (NAS, client MAC, sessionid) → flow, for `res=` callbacks that arrive after the flow page. */
export const FLOW_INDEX_TTL_S = 60 * 60;
export const REPLAY_TTL_S = 24 * 60 * 60;
/** CAPTIVE_PORTAL_ARCHITECTURE.md §7.1: portal credential TTL 90 s. */
export const CREDENTIAL_TTL_S = 90;
/** Consumption marker outlives the credential so a late replay is still recognised. */
export const CREDENTIAL_USED_TTL_S = 10 * 60;

export const PORTAL_CREDENTIAL_RE = /^pc-[0-9a-f]{16}$/;

export function isPortalCredentialUsername(value: string): boolean {
  return PORTAL_CREDENTIAL_RE.test(value);
}

/** §7.2 states (CREDENTIAL_ISSUED and LOGON_SENT collapse: the API builds the hand-off itself). */
export type FlowState = 'ARRIVED' | 'LOGON_SENT' | 'AUTHORIZED' | 'REJECTED' | 'ENDED';

export type PortalMethod = 'password' | 'voucher' | 'click_through';

export interface PortalFlow {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly nasId: string;
  readonly nasIdentifier: string | null;
  readonly adapterKey: string;
  readonly vendorKey: string;
  readonly deploymentMode: DeploymentMode;
  readonly controllerId: string | null;
  readonly captivePortalId: string;
  /** Normalised aa:bb:cc:dd:ee:ff. */
  readonly clientMac: string;
  readonly apMac: string | null;
  readonly clientIp: string | null;
  readonly ssid: string | null;
  /** UAM sessionid (= Acct-Session-Id). */
  readonly sessionId: string | null;
  readonly challenge: string;
  /** UAM fields as received (decoded; no secrets): uamip, uamport, userurl, … */
  readonly fields: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly expiresAt: string;
  state: FlowState;
  /** Username of the latest credential issued for this flow (revoked on re-issue). */
  credentialUsername: string | null;
  /** A previous session of this device on this NAS ended by a timeout (expired notice). */
  readonly previousSessionExpired: boolean;
  /** Cycle C: post-back flows (external-portal-postback); absent for UAM flows. */
  readonly postback?: PostbackFlowData;
}

/** What a post-back flow needs to rebuild its hand-off (no secrets). */
export interface PostbackFlowData {
  readonly profile: string;
  /** Redirect query exactly as received (Cambium appends it to the login URL). */
  readonly rawQuery: string;
  /** Validated `nas_clients.adapter_config` at redirect time. */
  readonly adapterConfig: Readonly<Record<string, unknown>>;
  readonly nasIp: string | null;
  /** Raw vendor nonce (`magic`, `ga_Qv`), the replay identity; null = ECLOUD login token. */
  readonly vendorNonce: string | null;
}

/** Identity proven at the portal; re-checked by AAA when the credential is presented. */
export type BrokerIdentity =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'voucher'; readonly voucherId: string }
  | { readonly kind: 'click_through' };

export interface StoredCredential {
  readonly username: string;
  readonly passwordSha256: string;
  readonly flowId: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly nasId: string;
  readonly clientMac: string;
  readonly sessionId: string | null;
  /** Hash of the redirect identity marked as consumed when AAA accepts the credential. */
  readonly replayKey: string;
  readonly identity: BrokerIdentity;
  readonly expiresAt: string;
}

const flowKey = (id: string) => `pf:flow:${id}`;
const credKey = (username: string) => `pf:cred:${username}`;
const credUsedKey = (username: string) => `pf:cred-used:${username}`;

export function flowIndexKey(nasId: string, clientMac: string, sessionId: string | null): string {
  return `pf:idx:${sha256Hex([nasId, clientMac, sessionId ?? ''].join('|'))}`;
}

/** Replay identity of a redirect (MULTI_VENDOR_INTEGRATION_PLAN.md §6.2 `isReplay` key). */
export interface ReplayIdentity {
  nasId: string;
  sessionId: string | null;
  challenge: string;
  clientMac: string;
  /** Cycle A: vendor / ECLOUD nonces get their own namespace. */
  nonceKind?: 'uam-challenge' | 'vendor-nonce' | 'ecloud-login-token';
}

function isUamKind(k: ReplayIdentity): boolean {
  return k.nonceKind === undefined || k.nonceKind === 'uam-challenge';
}

/**
 * Unambiguous replay key (Cycle A review L4): SHA-256 over the JSON array
 * `[kind, nasId, sessionId, challenge, clientMac]`, so no field value (a NAS-chosen `sessionid`
 * may contain anything) can shift into another field. UAM challenges are hex and compared
 * case-insensitively; vendor / ECLOUD nonces exactly.
 */
export function replayKey(k: ReplayIdentity): string {
  const uam = isUamKind(k);
  const fields = [
    uam ? 'uam-challenge' : k.nonceKind,
    k.nasId,
    k.sessionId,
    uam ? k.challenge.toLowerCase() : k.challenge,
    k.clientMac,
  ];
  return `pf:replay:v2:${sha256Hex(JSON.stringify(fields))}`;
}

/**
 * Pre-Cycle-A UAM key (`|`-joined). Read-only migration aid: markers written before the upgrade
 * live at most REPLAY_TTL_S (24 h); `isReplayed` also checks this key for UAM identities so a
 * redirect consumed just before the upgrade stays consumed. Remove 24 h after every portal API
 * replica runs the v2 code (nothing writes legacy keys any more).
 */
export function legacyReplayKey(k: ReplayIdentity): string | null {
  if (!isUamKind(k)) return null;
  return `pf:replay:${sha256Hex([k.nasId, k.sessionId ?? '', k.challenge.toLowerCase(), k.clientMac].join('|'))}`;
}

function parse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Stores the flow until its own `expiresAt` (never extended by an update). */
export async function saveFlow(kv: KvStore, flow: PortalFlow, now: Date): Promise<void> {
  const remaining = Math.ceil((Date.parse(flow.expiresAt) - now.getTime()) / 1000);
  await kv.set(
    flowKey(flow.id),
    JSON.stringify(flow),
    Math.max(1, Math.min(FLOW_TTL_S, remaining)),
  );
}

/** The flow, or null when unknown or past its `expiresAt`. */
export async function loadFlow(kv: KvStore, id: string, now: Date): Promise<PortalFlow | null> {
  const flow = parse<PortalFlow>(await kv.get(flowKey(id)));
  if (flow === null || Date.parse(flow.expiresAt) <= now.getTime()) return null;
  return flow;
}

export async function indexFlow(kv: KvStore, flow: PortalFlow): Promise<void> {
  await kv.set(flowIndexKey(flow.nasId, flow.clientMac, flow.sessionId), flow.id, FLOW_INDEX_TTL_S);
}

export async function findIndexedFlow(
  kv: KvStore,
  key: { nasId: string; clientMac: string; sessionId: string | null },
  now: Date,
): Promise<PortalFlow | null> {
  const id = await kv.get(flowIndexKey(key.nasId, key.clientMac, key.sessionId));
  return id === null ? null : loadFlow(kv, id, now);
}

/** True when the identity was consumed (v2 key, or a legacy UAM key inside its TTL). */
export async function isReplayed(kv: KvStore, identity: ReplayIdentity): Promise<boolean> {
  if ((await kv.get(replayKey(identity))) !== null) return true;
  const legacy = legacyReplayKey(identity);
  return legacy !== null && (await kv.get(legacy)) !== null;
}

export async function markReplayed(kv: KvStore, key: string): Promise<void> {
  await kv.set(key, '1', REPLAY_TTL_S);
}

/** `pc-<16 hex>` and a 16-character password (16 bytes ≤ the UAM PAP block, CP §7.4). */
export function newCredentialPair(): { username: string; password: string } {
  return {
    username: `pc-${randomBytes(8).toString('hex')}`,
    password: randomBytes(12).toString('base64url'),
  };
}

export async function storeCredential(
  kv: KvStore,
  credential: StoredCredential,
  ttlSeconds: number = CREDENTIAL_TTL_S,
): Promise<void> {
  await kv.set(credKey(credential.username), JSON.stringify(credential), ttlSeconds);
}

export async function loadCredential(
  kv: KvStore,
  username: string,
): Promise<StoredCredential | null> {
  return parse<StoredCredential>(await kv.get(credKey(username)));
}

export async function revokeCredential(kv: KvStore, username: string): Promise<void> {
  await kv.del(credKey(username));
}

/** Atomic single-use claim (SET NX). False when the credential was already consumed. */
export async function claimCredential(kv: KvStore, username: string): Promise<boolean> {
  return kv.set(credUsedKey(username), '1', CREDENTIAL_USED_TTL_S, true);
}

export function credentialPasswordMatches(stored: StoredCredential, password: string): boolean {
  return safeEqual(sha256Hex(password), stored.passwordSha256);
}
