/**
 * Vendor-neutral adapter contract (MULTI_VENDOR_INTEGRATION_PLAN.md §6.2; names binding). It is
 * composed AROUND the unchanged first-party `NasAdapter` (plan §1 item 1): no engine output
 * changes. The package stays pure — NAS lookups and site signals are injected by the caller.
 */
import type { EvidenceLevel, EvidenceRef, Lifecycle, ResearchStatus } from '@ecloud/shared';
import type { EffectivePolicy, EnforcementPlan, TranslationContext } from '@ecloud/policy-engine';
import type { CapabilityGroup, DeploymentMode } from '../registry/types.js';
import type { AccountingQuirks, NormalizedAccounting, RawAccountingRow } from './accounting.js';
import type {
  DisconnectRequest,
  NasAdapter,
  RadiusAttribute,
  SessionRef,
  Unsupported,
} from '../types.js';

export type { DeploymentMode } from '../registry/types.js';
export type {
  AccountingAnomaly,
  AccountingAnomalyKind,
  AccountingQuirks,
  NormalizedAccounting,
  RawAccountingRow,
} from './accounting.js';

export type AuthorizationStrategy = 'browser-form' | 'backend-api';

export interface HotspotContext {
  /** Resolved server-side from the registered NAS, never from the query. */
  readonly organizationId: string;
  readonly siteId: string;
  readonly vendorKey: string;
  readonly controllerId: string | null;
  readonly nas: {
    readonly id: string;
    readonly identifier: string | null;
    readonly adapterKey: string | null;
  };
  /** Normalised aa:bb:cc:dd:ee:ff. */
  readonly apMac: string | null;
  /** Normalised; a device observation, not a person (spec §5). */
  readonly clientMac: string;
  readonly ssid: string | null;
  readonly clientIp: string | null;
  /** UAM sessionid = Acct-Session-Id (CAPTIVE_PORTAL_ARCHITECTURE.md §0 item 5). */
  readonly nasSessionId: string | null;
  readonly policyRef: {
    readonly policyId: string | null;
    readonly snapshotHash: string | null;
  } | null;
  readonly deploymentMode: DeploymentMode;
  /** Byte-for-byte raw query substring; secrets never included. */
  readonly vendorOpaque: {
    readonly raw: string;
    readonly fields: Readonly<Record<string, string>>;
  };
  readonly receivedAt: Date;
}

export interface ParsedRedirect {
  readonly vendorKey: string;
  /** Decoded copies for display/lookup; never trusted. */
  readonly params: Readonly<Record<string, string>>;
  /** Exactly as received. */
  readonly rawQuery: string;
  readonly signature: { readonly kind: 'uam-md5' | 'none'; readonly value: string | null };
  readonly result: 'notyet' | 'already' | 'success' | 'failed' | 'logoff' | 'other' | null;
  /**
   * Cycle C (post-back): NAS identifier taken from the ECLOUD portal URL path
   * (`/pb/<profile>/<nasid>/`), which the operator configures on the AP / controller.
   */
  readonly pathNasId?: string | null;
}

export type ContextValidationFailure =
  | 'unknown_nas'
  | 'bad_signature'
  | 'stale'
  | 'tenant_mismatch'
  | 'private_address_required'
  | 'replayed'
  | 'malformed';

export type ContextValidation =
  | { readonly ok: true; readonly context: HotspotContext }
  | { readonly ok: false; readonly reason: ContextValidationFailure; readonly detail: string };

export interface AuthorizationHandoff {
  readonly strategy: AuthorizationStrategy;
  /** No secrets: the credential is single-use (SECURITY_ARCHITECTURE.md §5.6). */
  readonly browser?: {
    readonly method: 'GET-302' | 'POST-form';
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
  };
  readonly backend?: { readonly controllerId: string; readonly operation: 'login' };
  readonly state: 'pending';
}

export interface AuthorizationPlan {
  /** From `engine.translate` — unchanged. */
  readonly enforcement: EnforcementPlan;
  /** From `engine.buildReplyAttributes` — unchanged. */
  readonly replyAttributes: readonly RadiusAttribute[];
  readonly handoff: AuthorizationHandoff;
  /** Registry hint when `enforcement.unenforceable` is non-empty. */
  readonly gatewaySuggestion: string | null;
}

export interface SetupStep {
  readonly id: string;
  readonly title: string;
  readonly setting: string;
  /** Placeholders like `<RADIUS_SECRET>` only. */
  readonly value: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface HealthReport {
  readonly signals: readonly {
    readonly name: string;
    readonly state: 'ok' | 'stale' | 'missing' | 'unknown';
    readonly lastSeenAt: Date | null;
  }[];
}

/** Registered NAS as the caller (portal/api) resolved it. Secrets are passed only to the server-side calls that need them. */
export interface RegisteredNas {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly identifier: string | null;
  readonly adapterKey: string | null;
  readonly controllerId: string | null;
  readonly deploymentMode: DeploymentMode;
  /** Configured `uam-server` / `uamserver` URL (no query string); signed prefix of `md`. */
  readonly uamServerUrl: string | null;
  /** UAM secret, decrypted server-side; never copied into a context or hand-off. */
  readonly uamSecret: string | null;
  /** Cycle C: registered RADIUS source address (`nas_clients.nas_ip`), a valid login host. */
  readonly nasIp?: string | null;
  /** Cycle C: `nas_clients.adapter_config` (post-back profile selection; no secrets). */
  readonly adapterConfig?: Readonly<Record<string, unknown>> | null;
}

/** Injected lookup (keeps this package free of DB / network). */
export interface NasLookup {
  /**
   * Registered NAS for the redirect's NAS identity fields, or null (→ `unknown_nas`).
   *
   * Cycle A (research "contract gaps"): third-party portals identify the AP by MAC
   * (`ap_mac`, `apmac`, `mac`, `ga_ap_mac`, `apMac`), so the query also carries `apMac`
   * (canonical `aa:bb:cc:dd:ee:ff`, unicast) and, for controller-based vendors, the registered
   * `controllerId`. Implementations MUST fail closed (null) when the fields resolve to no NAS,
   * to more than one NAS, or to different NAS (e.g. `nasid` → A, `apMac` → B).
   */
  findNas(query: {
    readonly nasid: string | null;
    readonly called: string | null;
    readonly apMac?: string | null;
    readonly controllerId?: string | null;
  }): Promise<RegisteredNas | null>;
  /**
   * Required. Organization the portal request is already bound to (e.g. by a signed flow or a
   * tenant host). `null` is an explicit statement that the request carries no tenant binding
   * (single shared portal hostname, SECURITY §5.7) — the tenant then comes only from the
   * registered NAS (R-26). A non-null value that differs from the NAS's organization fails with
   * `tenant_mismatch`.
   */
  readonly expectedOrganizationId: string | null;
  /**
   * Required. True when this (NAS, sessionid, challenge, client MAC) was already consumed.
   * Validation fails closed (`replayed`) if no replay check is supplied at runtime.
   *
   * `challenge` is the freshness value of the redirect: the UAM challenge, a vendor nonce
   * (`magic`, `ga_Qv`, `login_url`, `t`) or, for post-back vendors that send none, the id of an
   * ECLOUD-issued login token (`vendor/login-token.ts`). `nonceKind` says which (default
   * `uam-challenge`) so the replay namespaces never collide.
   */
  isReplay(key: {
    readonly nasId: string;
    readonly sessionId: string | null;
    readonly challenge: string;
    readonly clientMac: string;
    readonly nonceKind?: 'uam-challenge' | 'vendor-nonce' | 'ecloud-login-token';
  }): Promise<boolean>;
  now?(): Date;
}

/** ECLOUD-side observations only; devices are never probed (plan §6.1). */
export interface SiteSignals {
  readonly now: Date;
  readonly lastAccessRequestAt: Date | null;
  readonly lastAccountingAt: Date | null;
  /** Expected interim interval in seconds (null = unknown). */
  readonly interimIntervalS: number | null;
  /** `undefined` = the site has no WireGuard peer to observe. */
  readonly lastWireguardHandshakeAt?: Date | null;
}

/** Single-use portal credential from the identity broker (D-018, SECURITY §5.6). */
export interface BrokerCredential {
  readonly username: string;
  /** ≤ 16 bytes (CAPTIVE_PORTAL_ARCHITECTURE.md §7.4). */
  readonly password: string;
  readonly expiresAt: Date;
  readonly boundNasId: string;
  readonly boundClientMac: string;
}

export interface CapabilityReportCell {
  readonly group: CapabilityGroup;
  readonly capability: string;
  /** Presented status (V11 override applied). */
  readonly status: ResearchStatus;
  readonly engineStatus: ResearchStatus;
  readonly evidenceLevel: EvidenceLevel | null;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly dtRefs: readonly string[];
  /** V12. */
  readonly deviceEnforced: boolean;
  readonly note?: string;
}

export interface CapabilityReport {
  readonly adapterKey: string;
  readonly vendorKey: string;
  /** Registry row the report was resolved against (null = engine record only). */
  readonly rowKey: string | null;
  readonly lifecycle: Lifecycle | null;
  readonly sourceVersionMatchesDevice: boolean | null;
  readonly cells: readonly CapabilityReportCell[];
}

/** Server-side secrets an operation may need; never echoed into its output. */
export interface HandoffSecrets {
  readonly uamSecret: string | null;
}

export interface VendorAdapter {
  /** = engine key for first-party. */
  readonly key: string;
  readonly vendorKey: string;
  /** The unchanged first-party adapter (same object as `getAdapter(key)`). */
  readonly engine: NasAdapter | null;
  readonly strategies: readonly AuthorizationStrategy[];
  discoverCapabilities(ctx: {
    readonly modelKey?: string;
    readonly firmware?: string;
  }): CapabilityReport;
  parseRedirect(req: {
    readonly url: string;
    readonly method: string;
  }): ParsedRedirect | Unsupported;
  validateContext(parsed: ParsedRedirect, lookup: NasLookup): Promise<ContextValidation>;
  buildAuthorization(
    ctx: HotspotContext,
    identity: BrokerCredential,
    effective: EffectivePolicy,
    tctx: TranslationContext,
    secrets?: HandoffSecrets,
  ): AuthorizationPlan | Unsupported;
  authorizeSession(
    ctx: HotspotContext,
    credential: BrokerCredential,
    secrets?: HandoffSecrets,
  ): AuthorizationHandoff | Unsupported;
  revokeSession(
    session: SessionRef,
  ): DisconnectRequest | { readonly browserLogoutUrl: string } | Unsupported;
  normalizeAccounting(row: RawAccountingRow): NormalizedAccounting;
  /**
   * Optional per-vendor accounting quirks hook (plan §6.1, §8.3 SIM-14). Report only: it never
   * changes `normalizeAccounting` output. Absent = no known quirks for this vendor.
   */
  readonly accountingQuirks?: AccountingQuirks;
  buildSetupGuide(site: { readonly siteId: string; readonly nasId: string }): readonly SetupStep[];
  healthCheck(signals: SiteSignals): HealthReport;
}
