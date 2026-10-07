/**
 * NAS adapter plugin interface (POLICY_ENGINE.md §8.3). Capability types come from
 * `@ecloud/policy-engine` so the translation layer never depends on this package.
 */
import type { AdapterFieldStatus } from '@ecloud/shared';
import type {
  AdapterCapabilities,
  AdapterKey,
  DisconnectCapability,
  EffectivePolicy,
  EnforcementPlan,
  RadiusVendor,
  TranslationContext,
} from '@ecloud/policy-engine';

export type {
  AdapterCapabilities,
  AdapterKey,
  AttributeDeclaration,
  CoaChangeCapability,
  DisconnectCapability,
  MacAuthCapability,
  PortalType,
  QuotaAttributes,
  RateAttrFamily,
  RateFamilyDeclaration,
  RateUnit,
  RadiusVendor,
} from '@ecloud/policy-engine';

export interface RadiusAttribute {
  readonly name: string;
  readonly value: string | number;
  readonly vendor?: RadiusVendor;
}

/** Identity of a live session as the AAA layer knows it (for Disconnect / CoA). */
export interface SessionRef {
  readonly sessionId: string;
  readonly userName?: string | null;
  readonly acctSessionId?: string | null;
  readonly callingStationId?: string | null;
  readonly nasIdentifier?: string | null;
  readonly nasIpAddress?: string | null;
  readonly framedIpAddress?: string | null;
}

export type Unsupported = { readonly unsupported: true; readonly reason: string };

export interface DisconnectDescription {
  readonly target: DisconnectCapability['target'];
  readonly status: AdapterFieldStatus;
  readonly identifyBy: readonly string[];
  readonly mandatory: readonly string[];
  readonly acctStopEmitted: boolean | 'unknown';
  readonly evidence: string;
  readonly note?: string;
}

export interface DisconnectRequest {
  readonly kind: 'disconnect';
  readonly target: DisconnectCapability['target'];
  readonly status: AdapterFieldStatus;
  readonly attributes: readonly RadiusAttribute[];
  readonly acctStopEmitted: boolean | 'unknown';
  readonly evidence: string;
}

export interface CoaRequest {
  readonly kind: 'coa';
  readonly status: AdapterFieldStatus;
  readonly attributes: readonly RadiusAttribute[];
  readonly evidence: string;
}

export interface ConfigFragment {
  readonly scope: 'ssid';
  readonly changes: readonly { readonly path: string; readonly value: string | number | boolean }[];
  readonly status: AdapterFieldStatus;
  readonly evidence: string;
  readonly sideEffect: string;
}

export interface NasAdapter {
  readonly key: AdapterKey;
  /** Stored in `policy_translations.adapter_version`. */
  readonly version: string;
  /** Static, labelled capability record (POLICY_ENGINE.md §3, D-028). */
  capabilities(): AdapterCapabilities;
  /** Intent → device plan. Pure; must not touch the network. */
  translate(effective: EffectivePolicy, ctx: TranslationContext): EnforcementPlan;
  /** Reply attributes in FreeRADIUS dictionary names; `experimental` ones only when asked. */
  buildReplyAttributes(
    plan: EnforcementPlan,
    options?: { readonly includeExperimental?: boolean },
  ): RadiusAttribute[];
  /** What an RFC 5176 Disconnect to this NAS type must carry (status per D4). */
  describeDisconnect(): DisconnectDescription;
  /** Build (not send) a Disconnect-Request for this session; AAA sends it. */
  buildDisconnect(session: SessionRef): DisconnectRequest | Unsupported;
  /** Build a CoA carrying only attributes `coaChange.changeable` covers. */
  buildCoa(session: SessionRef, plan: EnforcementPlan): CoaRequest | Unsupported;
  /** Optional: SSID config fragment for site-scoped intent (openwifi-config only). */
  renderConfig?(plan: EnforcementPlan): ConfigFragment | Unsupported;
}
