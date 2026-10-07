/**
 * Shared adapter implementation: every adapter is a capability record plus this small amount of
 * code. Nothing here sends packets; AAA (`coa-dispatcher`, FreeRADIUS) does.
 */
import type { PolicyField } from '@ecloud/shared';
import {
  POLICY_FIELDS,
  type AdapterFieldDeclaration,
  type AdapterFieldStatus,
} from '@ecloud/shared';
import {
  translate,
  type AdapterCapabilities,
  type AttributeDeclaration,
  type EffectivePolicy,
  type EnforcementPlan,
  type RadiusVendor,
  type TranslationContext,
} from '@ecloud/policy-engine';
import type {
  ConfigFragment,
  DisconnectDescription,
  DisconnectRequest,
  NasAdapter,
  RadiusAttribute,
  SessionRef,
  Unsupported,
} from './types.js';

export interface AdapterExtras {
  /** Attributes the NAS requires in a Disconnect (subset of `disconnect.identifyBy`). */
  readonly disconnectMandatory: readonly string[];
  readonly disconnectNote?: string;
  readonly renderConfig?: (plan: EnforcementPlan) => ConfigFragment | Unsupported;
}

/** Helper for terse declaration tables. */
export function decl(
  field: PolicyField,
  status: AdapterFieldStatus,
  evidence: string,
  note?: string,
): AdapterFieldDeclaration {
  return note ? { field, status, evidence, note } : { field, status, evidence };
}

export function attr(
  name: string,
  status: AdapterFieldStatus,
  evidence: string,
  vendor?: RadiusVendor,
  note?: string,
): AttributeDeclaration {
  return { name, status, evidence, ...(vendor ? { vendor } : {}), ...(note ? { note } : {}) };
}

/** Builds the `fields` record from a list and asserts every POLICY_FIELDS entry appears once. */
export function fieldTable(
  declarations: readonly AdapterFieldDeclaration[],
): Readonly<Record<PolicyField, AdapterFieldDeclaration>> {
  const out: Partial<Record<PolicyField, AdapterFieldDeclaration>> = {};
  for (const d of declarations) {
    if (out[d.field]) throw new Error(`duplicate declaration for ${d.field}`);
    out[d.field] = d;
  }
  for (const f of POLICY_FIELDS) if (!out[f]) throw new Error(`missing declaration for ${f}`);
  return out as Record<PolicyField, AdapterFieldDeclaration>;
}

export function attributeTable(
  declarations: readonly AttributeDeclaration[],
): Readonly<Record<string, AttributeDeclaration>> {
  const out: Record<string, AttributeDeclaration> = {};
  for (const d of declarations) {
    if (out[d.name]) throw new Error(`duplicate attribute declaration for ${d.name}`);
    out[d.name] = d;
  }
  return out;
}

const SESSION_ATTR_SOURCES: Readonly<Record<string, keyof SessionRef>> = {
  'User-Name': 'userName',
  'Acct-Session-Id': 'acctSessionId',
  'Calling-Station-Id': 'callingStationId',
  'NAS-Identifier': 'nasIdentifier',
  'NAS-IP-Address': 'nasIpAddress',
  'Framed-IP-Address': 'framedIpAddress',
};

function identityAttributes(session: SessionRef, identifyBy: readonly string[]): RadiusAttribute[] {
  const out: RadiusAttribute[] = [];
  for (const name of identifyBy) {
    const key = SESSION_ATTR_SOURCES[name];
    if (!key) continue;
    const value = session[key];
    if (typeof value === 'string' && value.length > 0) out.push({ name, value });
  }
  return out;
}

export function createAdapter(
  capabilities: AdapterCapabilities,
  extras: AdapterExtras,
): NasAdapter {
  const describeDisconnect = (): DisconnectDescription => ({
    target: capabilities.disconnect.target,
    status: capabilities.disconnect.status,
    identifyBy: capabilities.disconnect.identifyBy,
    mandatory: extras.disconnectMandatory,
    acctStopEmitted: capabilities.disconnect.acctStopEmitted,
    evidence: capabilities.disconnect.evidence,
    ...((extras.disconnectNote ?? capabilities.disconnect.note)
      ? { note: extras.disconnectNote ?? capabilities.disconnect.note }
      : {}),
  });

  const buildDisconnect = (session: SessionRef): DisconnectRequest | Unsupported => {
    if (
      capabilities.disconnect.target === 'none' ||
      capabilities.disconnect.status === 'UNSUPPORTED'
    ) {
      return {
        unsupported: true,
        reason: `${capabilities.key} has no Disconnect target (${capabilities.disconnect.evidence})`,
      };
    }
    const attributes = identityAttributes(session, capabilities.disconnect.identifyBy);
    const present = new Set(attributes.map((a) => a.name));
    const missing = extras.disconnectMandatory.filter((m) => !present.has(m));
    if (missing.length > 0)
      return {
        unsupported: true,
        reason: `missing mandatory identification attribute(s): ${missing.join(', ')}`,
      };
    if (attributes.length === 0)
      return {
        unsupported: true,
        reason: 'no identification attribute available for this session',
      };
    return {
      kind: 'disconnect',
      target: capabilities.disconnect.target,
      status: capabilities.disconnect.status,
      attributes,
      acctStopEmitted: capabilities.disconnect.acctStopEmitted,
      evidence: capabilities.disconnect.evidence,
    };
  };

  const adapter: NasAdapter = {
    key: capabilities.key,
    version: capabilities.version,
    capabilities: () => capabilities,
    translate: (effective: EffectivePolicy, ctx: TranslationContext) =>
      translate(effective, capabilities, ctx),
    buildReplyAttributes: (plan, options) => {
      if (plan.adapter !== capabilities.key)
        throw new Error(`plan for ${plan.adapter} given to ${capabilities.key}`);
      return plan.radiusReplyAttributes
        .filter((a) => options?.includeExperimental === true || a.experimental !== true)
        .filter((a) => capabilities.attributes[a.name] !== undefined)
        .map((a) =>
          a.vendor
            ? { name: a.name, value: a.value, vendor: a.vendor }
            : { name: a.name, value: a.value },
        );
    },
    describeDisconnect,
    buildDisconnect,
    buildCoa: (session, plan) => {
      if (
        capabilities.coaChange.changeable.length === 0 ||
        capabilities.coaChange.status === 'UNSUPPORTED'
      ) {
        return {
          unsupported: true,
          reason: `${capabilities.key}: CoA attribute changes not supported (${capabilities.coaChange.evidence})`,
        };
      }
      if (plan.adapter !== capabilities.key)
        throw new Error(`plan for ${plan.adapter} given to ${capabilities.key}`);
      const disconnect = buildDisconnect(session);
      if ('unsupported' in disconnect) return disconnect;
      const changeable = new Set(capabilities.coaChange.changeable);
      const changes = plan.radiusReplyAttributes
        .filter((a) => a.experimental !== true && changeable.has(a.name))
        .map((a) =>
          a.vendor
            ? { name: a.name, value: a.value, vendor: a.vendor }
            : { name: a.name, value: a.value },
        );
      if (changes.length === 0)
        return {
          unsupported: true,
          reason: 'plan carries no attribute the NAS can change via CoA',
        };
      return {
        kind: 'coa',
        status: capabilities.coaChange.status,
        attributes: [...disconnect.attributes, ...changes],
        evidence: capabilities.coaChange.evidence,
      };
    },
    ...(extras.renderConfig ? { renderConfig: extras.renderConfig } : {}),
  };
  return adapter;
}
