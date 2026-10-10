/**
 * Static capability record of a NAS adapter (POLICY_ENGINE.md §3, owner amendment 3 / D-028).
 * Defined here (not in `@ecloud/adapters`) so the translation layer stays free of adapter code;
 * `@ecloud/adapters` re-exports the type and ships the five concrete records.
 */
import type {
  AdapterFieldDeclaration,
  AdapterFieldStatus,
  EvidenceLevel,
  EvidenceRef,
  PolicyField,
} from '@ecloud/shared';

export const ADAPTER_KEYS = [
  'openwifi-hostapd-radius',
  'openwifi-uspot-uam',
  'uspot-upstream-uam',
  'coovachilli-uam',
  'openwifi-config',
  /** Cycle A (D-044): vendor-neutral 802.1X / MAC-auth NAS (no portal). */
  'generic-radius-8021x',
  /** Cycle C (D-044): F3 external captive portal post-back engine (vendor profiles). */
  'external-portal-postback',
] as const;

export type AdapterKey = (typeof ADAPTER_KEYS)[number];

export type PortalType =
  | 'none-8021x-macauth'
  | 'uam-chillispot'
  | 'uam-chillispot+capport'
  | 'uam-chillispot+wispr+json'
  | 'config-only'
  /** Cycle C: AP/controller redirects to ECLOUD, the browser posts credentials back to the AP. */
  | 'external-postback';

/**
 * `mikrotik-rate-string`: one combined `rx/tx` string attribute (Mikrotik-Rate-Limit, rendered by
 * `renderMikrotikRateLimit`), not two numeric attributes.
 */
export type RateUnit = 'bps' | 'kbps' | 'mbps-int' | 'mikrotik-rate-string';
export type RateAttrFamily = 'wispr' | 'chillispot' | 'mikrotik';
export type RadiusVendor = 'WISPr' | 'ChilliSpot' | 'CoovaChilli' | 'Mikrotik';

/** A labelled claim about one mechanism (flag) of the adapter. */
export interface AdapterFlag {
  readonly status: AdapterFieldStatus;
  readonly evidence: string;
  /** MULTI_VENDOR_INTEGRATION_PLAN.md §4 (additive; required, no default). */
  readonly evidenceLevel: EvidenceLevel;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly note?: string;
}

/** Verification status of one RADIUS reply attribute the adapter may receive. */
export interface AttributeDeclaration extends AdapterFlag {
  readonly name: string;
  readonly vendor?: RadiusVendor;
}

export interface RateFamilyDeclaration {
  readonly family: RateAttrFamily;
  readonly unit: RateUnit;
  /** Download attribute; for a combined family (`combined` set) the same name as `up`. */
  readonly down: string;
  readonly up: string;
  readonly vendor: RadiusVendor;
  /**
   * Combined family: both directions travel in ONE attribute of this name (MikroTik
   * `Mikrotik-Rate-Limit = "rx/tx"`). Absent for the two-attribute families.
   */
  readonly combined?: string;
}

export interface QuotaAttributes {
  readonly total?: string;
  readonly input?: string;
  readonly output?: string;
  readonly totalGigawords?: string;
  readonly inputGigawords?: string;
  readonly outputGigawords?: string;
}

export interface DisconnectCapability extends AdapterFlag {
  /** `rfc5176-das`: the NAS's own RFC 5176 DAS (vendor-neutral 802.1X / MAC-auth NAS). */
  readonly target: 'hostapd-das' | 'uspot-das' | 'coaport' | 'rfc5176-das' | 'none';
  /** Identification attributes the NAS needs in the Disconnect-Request. */
  readonly identifyBy: readonly string[];
  readonly acctStopEmitted: boolean | 'unknown';
}

export interface CoaChangeCapability extends AdapterFlag {
  readonly changeable: readonly string[];
}

export interface MacAuthCapability extends AdapterFlag {
  readonly usernameRule?: string;
}

export interface AdapterCapabilities {
  readonly key: AdapterKey;
  /** Stored in `policy_translations.adapter_version`. */
  readonly version: string;
  readonly portalType: PortalType;
  readonly granularity: 'per-client' | 'per-ssid';
  /** Unit of the primary rate mechanism; null when the adapter has no rate mechanism at all. */
  readonly rateUnit: RateUnit | null;
  /** Rate attribute families this adapter can receive, in preference order. Empty = none. */
  readonly rateFamilies: readonly RateFamilyDeclaration[];
  readonly quotaAttributes: QuotaAttributes;
  /** 32 = single octet counter (< 4 GiB); 64 = Octets + Gigawords. */
  readonly octetWidth: 32 | 64 | null;
  readonly sessionTimeoutAttr: string | null;
  readonly idleTimeoutAttr: string | null;
  readonly interimIntervalAttr: string | null;
  readonly vlanAttrs: readonly string[];
  readonly classAttr: string | null;
  readonly disconnect: DisconnectCapability;
  readonly coaChange: CoaChangeCapability;
  readonly macAuth: MacAuthCapability;
  /** Exactly one declaration per POLICY_FIELDS entry. */
  readonly fields: Readonly<Record<PolicyField, AdapterFieldDeclaration>>;
  /** Per-attribute statuses; translation never emits an attribute absent from this map. */
  readonly attributes: Readonly<Record<string, AttributeDeclaration>>;
}

export function fieldStatus(adapter: AdapterCapabilities, field: PolicyField): AdapterFieldStatus {
  return adapter.fields[field].status;
}

export function attributeStatus(
  adapter: AdapterCapabilities,
  name: string,
): AdapterFieldStatus | null {
  return adapter.attributes[name]?.status ?? null;
}

export function isVerified(status: AdapterFieldStatus | null): boolean {
  return status === 'VERIFIED_SUPPORTED';
}
