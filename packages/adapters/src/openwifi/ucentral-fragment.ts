/**
 * `openwifi-config` export: the uCentral config fragment for SITE-SCOPED SSID rate limits
 * (`interfaces[].ssids[].rate-limit{ingress-rate, egress-rate}`, integer Mbit/s —
 * NETWORK_INTEGRATION.md §7.3, §2 row "Per-SSID up/down cap").
 *
 * EXPORT / PREVIEW ONLY. Nothing in this module talks to a controller: Phase 7 makes no
 * EZECONTROL change, so the fragment is handed to an operator (API download / admin "download
 * fragment") and never pushed. Every fragment is validated against the vendored copy of the
 * uCentral JSON schema (`schema/ucentral.full.json`, see `UCENTRAL_SCHEMA_SOURCE`) with ajv 8
 * (API_ARCHITECTURE.md §2: "ajv 8 only inside the openwifi adapter").
 *
 * Honesty rules (D-028, V12): the rate-limit keys are VERIFIED_FROM_SOURCE, not lab validated;
 * the end-to-end direction mapping (ingress = client upload, egress = client download) and the
 * per-station-vs-aggregate semantics are REQUIRES DEVICE TEST (DT-02). The export therefore
 * never claims `deviceEnforced: true` unless the adapter declaration carries device evidence.
 */
import type { ConfigPushChange, EnforcementPlan } from '@ecloud/policy-engine';
import {
  isDeviceEnforced,
  type AdapterFieldStatus,
  type EvidenceLevel,
  type PolicyField,
} from '@ecloud/shared';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { capabilities } from '../adapters/openwifi-config.js';
import ucentralSchema from './schema/ucentral.full.json' with { type: 'json' };

/** Provenance of the vendored schema copy (re-checked by `ucentral-fragment.test.ts`). */
export const UCENTRAL_SCHEMA_SOURCE = {
  vendoredPath: 'packages/adapters/src/openwifi/schema/ucentral.full.json',
  copiedFrom: 'ezecontroller src/schemas/ucentral.full.json',
  ezecontrollerCommit: '3d6719a0916ae361cff9a576142c3486623abcc9',
  sha256: 'e1f1dffe3ed207c34dca7c8643659dae8d3737fc648f254c1f17b2fa7ba7add1',
  schemaId: 'https://openwrt.org/ucentral.schema.json',
  dialect: 'http://json-schema.org/draft-07/schema#',
  note: 'uCentral schema as pinned by ezecontroller (PHASE2_VALIDATION.md §2.1: schema 4.2.0); unmodified byte copy',
} as const;

export const RATE_LIMIT_FRAGMENT_KIND = 'ucentral-ssid-rate-limit/v1';

const RATE_FIELDS: readonly PolicyField[] = ['download_rate_kbps', 'upload_rate_kbps'];
const RATE_PATH = /^interfaces\[\]\.ssids\[(.*)\]\.rate-limit\.(ingress-rate|egress-rate)$/;

export interface RateLimitKeys {
  'ingress-rate'?: number;
  'egress-rate'?: number;
}

/** A partial uCentral configuration: one interface, one SSID (matched by `name`), rate-limit only. */
export interface UcentralRateLimitFragment {
  readonly interfaces: readonly [
    { readonly ssids: readonly [{ readonly name: string; readonly 'rate-limit': RateLimitKeys }] },
  ];
}

export interface FragmentChange {
  readonly path: string;
  readonly value: number;
  readonly field: PolicyField;
  readonly status: AdapterFieldStatus;
  readonly evidenceLevel: EvidenceLevel;
  readonly deviceEnforced: boolean;
  readonly evidence: string;
}

export interface FragmentOmission {
  readonly field: PolicyField;
  readonly path: string | null;
  readonly reason: string;
}

export interface SchemaValidation {
  readonly valid: boolean;
  readonly schemaId: string;
  readonly schemaSha256: string;
  readonly errors: readonly { readonly path: string; readonly message: string }[];
}

export interface RateLimitFragmentExport {
  readonly kind: typeof RATE_LIMIT_FRAGMENT_KIND;
  /** Always export/preview: ECLOUD never pushes this to a controller in Phase 7. */
  readonly mode: 'export_preview_only';
  readonly adapter: 'openwifi-config';
  readonly adapterVersion: string;
  readonly ssid: string;
  readonly fragment: UcentralRateLimitFragment;
  readonly changes: readonly FragmentChange[];
  /** Config-push changes of the plan that this rate-limit fragment deliberately leaves out. */
  readonly omitted: readonly FragmentOmission[];
  readonly validation: SchemaValidation;
  /** True only if every change is VERIFIED_SUPPORTED with device evidence (V12). */
  readonly deviceEnforced: boolean;
  readonly warnings: readonly string[];
}

export interface FragmentUnavailable {
  readonly unsupported: true;
  readonly reason: string;
  readonly omitted: readonly FragmentOmission[];
}

export const FRAGMENT_WARNINGS: readonly string[] = [
  'Export/preview only: ECLOUD did not push this fragment to any controller.',
  'Per-SSID rate-limit: every station of the SSID gets the same ceiling (site-scoped intent only).',
  'Direction mapping ingress-rate = client upload, egress-rate = client download is REQUIRES DEVICE TEST (NETWORK_INTEGRATION.md §11 item 2, DT-02).',
  'Applying it through the controller re-applies hostapd/uspot and resets captive-portal sessions (NETWORK_INTEGRATION.md §5).',
  'Values are integer Mbit/s rounded up from kbit/s; sub-Mbit rates are not expressible (§7.3).',
];

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
  // The upstream schema uses custom formats (uc-mac, uc-ip, …) and a few non-standard keywords
  // ("decription"); strict mode would reject the unmodified copy, so formats are not asserted.
  compiled ??= new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(
    ucentralSchema,
  );
  return compiled;
}

/** Validates any (partial) uCentral configuration document against the vendored schema. */
export function validateUcentralConfig(config: unknown): SchemaValidation {
  const validate = validator();
  const valid = validate(config);
  const errors = (validate.errors ?? []).map((e: ErrorObject) => ({
    path: e.instancePath === '' ? '/' : e.instancePath,
    message: e.message ?? e.keyword,
  }));
  return {
    valid,
    schemaId: UCENTRAL_SCHEMA_SOURCE.schemaId,
    schemaSha256: UCENTRAL_SCHEMA_SOURCE.sha256,
    errors,
  };
}

function omissionsOf(changes: readonly ConfigPushChange[]): FragmentOmission[] {
  return changes
    .filter((c) => !RATE_PATH.test(c.path))
    .map((c) => ({
      field: c.field,
      path: c.path,
      reason: 'not a rate limit: outside the rate-limit export (P7-B scope)',
    }));
}

/**
 * Builds the rate-limit fragment of an `openwifi-config` plan. The plan must come from
 * `translate()` with `ssidRef` set to the SSID name; rates appear only for site-scoped intent
 * (the translator flags group/user layers as `granularity_mismatch`).
 */
export function exportRateLimitFragment(
  plan: EnforcementPlan,
  ssid: string,
): RateLimitFragmentExport | FragmentUnavailable {
  if (plan.adapter !== 'openwifi-config') {
    return {
      unsupported: true,
      reason: `plan for ${plan.adapter}, not openwifi-config`,
      omitted: [],
    };
  }
  const omitted: FragmentOmission[] = omissionsOf(plan.configPushChanges);
  for (const u of plan.unenforceable) {
    if ((RATE_FIELDS as readonly string[]).includes(u.field)) {
      omitted.push({
        field: u.field as PolicyField,
        path: null,
        reason: u.detail === undefined ? u.reason : `${u.reason}: ${u.detail}`,
      });
    }
  }
  if (plan.decision === 'reject') {
    return {
      unsupported: true,
      reason: `resolution rejected (${plan.reasonCode ?? 'unknown'}): no fragment for a rejected policy`,
      omitted,
    };
  }

  const rateLimit: RateLimitKeys = {};
  const changes: FragmentChange[] = [];
  for (const c of plan.configPushChanges) {
    const m = RATE_PATH.exec(c.path);
    if (m === null) continue;
    if (m[1] !== ssid) {
      return {
        unsupported: true,
        reason: `plan was translated for SSID "${m[1] ?? ''}", not "${ssid}"`,
        omitted,
      };
    }
    if (typeof c.value !== 'number' || !Number.isInteger(c.value) || c.value < 1) {
      return {
        unsupported: true,
        reason: `${c.path}: ${String(c.value)} is not a positive integer Mbit/s value`,
        omitted,
      };
    }
    const key = m[2] as keyof RateLimitKeys;
    rateLimit[key] = c.value;
    const decl = capabilities.fields[c.field];
    changes.push({
      path: c.path,
      value: c.value,
      field: c.field,
      status: c.status,
      evidenceLevel: decl.evidenceLevel,
      deviceEnforced: isDeviceEnforced(c.status, decl.evidenceLevel),
      evidence: c.evidence,
    });
  }
  if (changes.length === 0) {
    return {
      unsupported: true,
      reason:
        'no site-scoped download/upload rate translates to an SSID rate-limit (unset, sub-Mbit, or set on a user/group layer)',
      omitted,
    };
  }

  const fragment: UcentralRateLimitFragment = {
    interfaces: [{ ssids: [{ name: ssid, 'rate-limit': rateLimit }] }],
  };
  const validation = validateUcentralConfig(fragment);
  if (!validation.valid) {
    return {
      unsupported: true,
      reason: `fragment failed uCentral schema validation: ${validation.errors
        .map((e) => `${e.path} ${e.message}`)
        .join('; ')}`,
      omitted,
    };
  }
  return {
    kind: RATE_LIMIT_FRAGMENT_KIND,
    mode: 'export_preview_only',
    adapter: 'openwifi-config',
    adapterVersion: plan.adapterVersion,
    ssid,
    fragment,
    changes,
    omitted,
    validation,
    deviceEnforced: changes.every((c) => c.deviceEnforced),
    warnings: FRAGMENT_WARNINGS,
  };
}

export function isFragmentExport(
  value: RateLimitFragmentExport | FragmentUnavailable,
): value is RateLimitFragmentExport {
  return !('unsupported' in value);
}
