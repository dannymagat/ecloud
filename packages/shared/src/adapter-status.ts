import type { EvidenceLevel, EvidenceRef } from './evidence.js';

/**
 * Owner's four-state enforceability enum (DECISIONS.md D-028). Every adapter reports every
 * policy field with exactly one of these; nothing is presented as device-enforced unless it is
 * VERIFIED_SUPPORTED, and that label may only be used with cited evidence
 * (POLICY_ENGINE.md §3, NETWORK_INTEGRATION.md §2, CAPTIVE_PORTAL_ARCHITECTURE.md).
 */
export const ADAPTER_FIELD_STATUSES = [
  'VERIFIED_SUPPORTED',
  'REQUIRES_DEVICE_TEST',
  'UNSUPPORTED',
  'ECLOUD_SIDE_ONLY',
] as const;

export type AdapterFieldStatus = (typeof ADAPTER_FIELD_STATUSES)[number];

export function isAdapterFieldStatus(value: unknown): value is AdapterFieldStatus {
  return typeof value === 'string' && (ADAPTER_FIELD_STATUSES as readonly string[]).includes(value);
}

/**
 * Policy intent fields an adapter must declare a status for (POLICY_ENGINE.md §1.1, column
 * names of the A6 `policies` table). Notes:
 * - `max_devices` is the A6 column; the brief's `max_concurrent_devices` is the same field.
 * - `voucher_validity` stands for `voucher_batches.valid_from/valid_until` and `duration_s`
 *   (POLICY_ENGINE.md §1.1 "voucher validity"); it is not a `policies` column.
 */
export const POLICY_FIELDS = [
  'download_rate_kbps',
  'upload_rate_kbps',
  'burst_download_kbps',
  'burst_upload_kbps',
  'burst_duration_s',
  'quota_daily_bytes',
  'quota_monthly_bytes',
  'quota_total_bytes',
  'session_timeout_s',
  'idle_timeout_s',
  'max_concurrent_sessions',
  'max_devices',
  'valid_from',
  'valid_until',
  'voucher_validity',
  'schedule_id',
  'vlan_id',
] as const;

export type PolicyField = (typeof POLICY_FIELDS)[number];

/** Alias accepted by the brief for `max_devices`. */
export const POLICY_FIELD_ALIASES: Readonly<Record<string, PolicyField>> = Object.freeze({
  max_concurrent_devices: 'max_devices',
});

/**
 * Non-enforcement columns of a policy (POLICY_ENGINE.md §1.1): they steer resolution and
 * versioning and are never translated to a NAS attribute.
 */
export const POLICY_METADATA_FIELDS = [
  'scope_type',
  'priority',
  'status',
  'is_default',
  'version',
] as const;

export type PolicyMetadataField = (typeof POLICY_METADATA_FIELDS)[number];

export function isPolicyField(value: unknown): value is PolicyField {
  return typeof value === 'string' && (POLICY_FIELDS as readonly string[]).includes(value);
}

/**
 * One capability declaration of an adapter for one field. `evidence` must cite the document
 * section the status rests on (brief rule 3), e.g. `POLICY_ENGINE.md §3.1 row download_rate_kbps`.
 */
export interface AdapterFieldDeclaration {
  readonly field: PolicyField;
  readonly status: AdapterFieldStatus;
  readonly evidence: string;
  /** How the claim is backed (MULTI_VENDOR_INTEGRATION_PLAN.md §4); required, no default. */
  readonly evidenceLevel: EvidenceLevel;
  /** Structured references (rule V10: VERIFIED_FROM_SOURCE needs ≥ 1 `source` ref). */
  readonly evidenceRefs?: readonly EvidenceRef[];
  /** Optional free-text caveat shown in the enforceability preview. */
  readonly note?: string;
}
