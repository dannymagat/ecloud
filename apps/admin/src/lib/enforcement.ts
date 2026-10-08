/**
 * Session enforcement (Phase 7). Typed view of the P7-A contract documented in
 * API_ARCHITECTURE.md "Session-enforcement API contract (consumed by P7-B admin views)":
 *   GET  /api/v1/orgs/{orgId}/sessions/{id}/enforcement         (session:read)
 *   POST /api/v1/orgs/{orgId}/policies/{id}/impact-preview      (policy:preview, writes nothing)
 * plus the openwifi-config rate-limit fragment export (P7-B):
 *   GET  /api/v1/orgs/{orgId}/sites/{siteId}/openwifi-config/rate-limit-fragment
 * The endpoints are feature-detected through the live OpenAPI document (`hasOperation`), so the
 * UI shows an explicit "not available" state against an API that does not serve them yet.
 *
 * Honesty rules (D-028, V12, Q67): a field is shown as device-enforced only when the API says so
 * AND its status/evidence allow it; REQUIRES_DEVICE_TEST and ECLOUD_SIDE_ONLY fields carry an
 * amber flag; no change is described as "immediate" unless its strategy is a lab-validated CoA.
 */
import { isAdapterFieldStatus, isEvidenceLevel, type AdapterFieldStatus } from './adapterStatus';

export const SESSION_ENFORCEMENT_PATH = '/api/v1/orgs/{orgId}/sessions/{id}/enforcement';
export const IMPACT_PREVIEW_PATH = '/api/v1/orgs/{orgId}/policies/{id}/impact-preview';
export const RATE_LIMIT_FRAGMENT_PATH =
  '/api/v1/orgs/{orgId}/sites/{siteId}/openwifi-config/rate-limit-fragment';

export const STRATEGIES = ['coa_change', 'disconnect_reauth', 'next_reauth', 'none'] as const;
export type EnforcementStrategy = (typeof STRATEGIES)[number];
export type EnforcementState = 'pending' | 'applied' | 'unsupported' | 'superseded';

export interface EnforcementChange {
  id: string;
  change_id: string;
  trigger: string;
  strategy: EnforcementStrategy;
  state: EnforcementState;
  reason: string;
  policy_id: string | null;
  expected_apply_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface EnforcementField {
  field: string;
  value: unknown;
  set: boolean;
  status: string;
  evidence: string;
  evidence_level: string | null;
  device_enforced: boolean;
  /** `radius` | `ecloud_side` | `none` | `not_set` (string: tolerate additions). */
  mechanism: string;
  attributes: string[];
  amber: boolean;
  detail?: string;
}

export interface SentAttribute {
  name: string;
  value: unknown;
  field: string;
  status: string;
  evidence_level: string | null;
  device_enforced: boolean;
  experimental?: true;
}

export interface CapabilityEvidence {
  status: string;
  evidence_level: string | null;
  device_enforced: boolean;
}

export interface SessionEnforcementView {
  session_id: string;
  status: string;
  site_id: string | null;
  nas_client_id: string | null;
  adapter_key: string | null;
  adapter_version: string | null;
  snapshot: {
    policy_id: string | null;
    policy_version: number | null;
    hash: string | null;
    authorized_at: string | null;
    effective: Record<string, unknown>;
  } | null;
  attributes_sent: SentAttribute[];
  fields: EnforcementField[];
  unenforceable: { field: string; status: string; reason: string; detail?: string }[];
  session_timeout: { value_s: number | null; sent: boolean; expected_reauth_by: string | null };
  strategy_evidence: {
    coa_change: CapabilityEvidence;
    disconnect: CapabilityEvidence;
    dispatcher_enabled: boolean;
    strategy: EnforcementStrategy;
  };
  pending_change: EnforcementChange | null;
  history: EnforcementChange[];
  counter_anomalies: {
    id: string;
    counter: string;
    previous: number | string;
    observed: number | string;
    estimated_lost_bytes: number | string;
    applied: boolean;
    reason: string;
    created_at: string;
  }[];
}

export interface ImpactPreview {
  policy_id: string;
  evaluated_sessions: number;
  affected_sessions: number;
  by_strategy: Partial<Record<EnforcementStrategy, number>>;
  max_apply_latency_s: number | null;
  session_timeout_cap_s: number;
  sessions: {
    session_id: string;
    site_id: string | null;
    nas_client_id: string | null;
    adapter_key: string | null;
    strategy: EnforcementStrategy;
    state: EnforcementState;
    reason: string;
    expected_apply_by: string | null;
  }[];
  truncated: boolean;
  message?: string;
}

/** The fragment export envelope (`available=false` carries `reason` and `omitted`). */
export interface RateLimitFragmentExport {
  available: boolean;
  mode: 'export_preview_only';
  pushed: false;
  site_id: string;
  ssid: string;
  reason: string | null;
  resolution: {
    decision: 'accept' | 'reject';
    reason_code: string | null;
    policy_id: string | null;
    policy_version: number | null;
    snapshot_hash: string;
  };
  fragment: Record<string, unknown> | null;
  changes: {
    path: string;
    value: number;
    field: string;
    status: string;
    evidence_level: string;
    device_enforced: boolean;
    evidence: string;
  }[];
  omitted: { field: string; path: string | null; reason: string }[];
  validation: {
    valid: boolean;
    schema_id: string;
    schema_sha256: string;
    errors: { path: string; message: string }[];
  } | null;
  device_enforced: boolean;
  warnings: string[];
  adapter: 'openwifi-config';
  adapter_version: string;
}

export const STRATEGY_LABEL: Record<EnforcementStrategy, string> = {
  coa_change: 'CoA change (when lab-validated)',
  disconnect_reauth: 'Disconnect + re-authentication',
  next_reauth: 'At next re-authentication',
  none: 'Cannot be applied',
};

export function strategyLabel(strategy: unknown): string {
  return typeof strategy === 'string' && strategy in STRATEGY_LABEL
    ? STRATEGY_LABEL[strategy as EnforcementStrategy]
    : `Unknown strategy (${String(strategy)})`;
}

export const STATE_TONE: Record<EnforcementState, 'warning' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning',
  applied: 'success',
  unsupported: 'danger',
  superseded: 'neutral',
};

export function stateTone(state: unknown): 'warning' | 'success' | 'danger' | 'neutral' {
  return typeof state === 'string' && state in STATE_TONE
    ? STATE_TONE[state as EnforcementState]
    : 'neutral';
}

/**
 * Amber flag (Q67): the field is sent/tracked but not device-proven. REQUIRES_DEVICE_TEST and
 * ECLOUD_SIDE_ONLY are amber; an unknown status is treated as REQUIRES_DEVICE_TEST (amber).
 */
export function isAmberStatus(status: unknown): boolean {
  if (!isAdapterFieldStatus(status)) return true;
  return status === 'REQUIRES_DEVICE_TEST' || status === 'ECLOUD_SIDE_ONLY';
}

export function amberReason(status: unknown): string {
  return status === 'ECLOUD_SIDE_ONLY'
    ? 'Enforced by ECLOUD (at authorization / accounting), not by the device'
    : 'Sent to the device but not verified on a lab device (needs device test)';
}

const DEVICE_LEVELS = new Set(['LAB_VALIDATED', 'PRODUCTION_VALIDATED']);

/**
 * V12 guard for API-provided flags: "device enforced" is shown only when the API says so AND
 * the status is VERIFIED_SUPPORTED with lab/production evidence. A contradictory payload is
 * shown as not device-enforced.
 */
export function showDeviceEnforced(
  apiFlag: unknown,
  status: unknown,
  evidenceLevel: unknown,
): boolean {
  return (
    apiFlag === true &&
    status === 'VERIFIED_SUPPORTED' &&
    isEvidenceLevel(evidenceLevel) &&
    DEVICE_LEVELS.has(evidenceLevel)
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Human duration for Session-Timeout bounds: whole minutes when ≥ 60 s ("30 min"). */
export function formatBound(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round((minutes / 60) * 10) / 10} h`;
}

const STRATEGY_PHRASE: Record<EnforcementStrategy, (bound: string | null) => string> = {
  next_reauth: (bound) =>
    bound === null
      ? 'applies at next login (no Session-Timeout cap configured, so no upper bound)'
      : `applies at next login, at most ${bound}`,
  // Neutral wording: the UI must not assert lab validation itself (V12); the API only selects
  // this strategy when the adapter's CoA capability carries lab evidence.
  coa_change: () =>
    'applied to the live session by CoA, if the NAS supports it (device-tested only)',
  disconnect_reauth: () =>
    'session is disconnected and re-authenticates, if the NAS supports Disconnect (device-tested only)',
  none: () => 'cannot be applied (NAS without an engine adapter)',
};

/**
 * The impact sentence, e.g. "3 sessions affected; strategy next_reauth; applies at next login,
 * at most 30 min". Built from the numbers (not the server `message`) so the wording is uniform.
 */
export function impactSummary(impact: ImpactPreview): string {
  const n = impact.affected_sessions;
  if (n === 0) {
    return `No open sessions affected (${plural(impact.evaluated_sessions, 'session')} evaluated).`;
  }
  const latency = impact.max_apply_latency_s ?? (impact.session_timeout_cap_s || null);
  const bound = latency !== null && latency > 0 ? formatBound(latency) : null;
  const used = STRATEGIES.filter((s) => (impact.by_strategy[s] ?? 0) > 0);
  if (used.length === 1) {
    const s = used[0]!;
    return `${plural(n, 'session')} affected; strategy ${s}; ${STRATEGY_PHRASE[s](bound)}`;
  }
  const parts = used.map((s) => `${impact.by_strategy[s] ?? 0} ${s}`);
  return `${plural(n, 'session')} affected; strategies ${parts.join(', ')}${
    used.includes('next_reauth') ? `; next_reauth ${STRATEGY_PHRASE.next_reauth(bound)}` : ''
  }`;
}

export interface AmberFlag {
  field: string;
  adapter: string;
  status: AdapterFieldStatus | 'UNKNOWN';
  reason: string;
}

/**
 * Amber flags for `fields` across adapter columns (simulate / catalogue field tables),
 * optionally limited to the adapters of the affected sessions.
 */
export function amberFlags(
  columns: readonly { adapter: string; fields: readonly { field: string; status: unknown }[] }[],
  fields: readonly string[],
  adapters?: readonly string[],
): AmberFlag[] {
  const keep = adapters === undefined ? null : new Set(adapters);
  const out: AmberFlag[] = [];
  for (const column of columns) {
    if (keep !== null && !keep.has(column.adapter)) continue;
    for (const field of fields) {
      const cell = column.fields.find((f) => f.field === field);
      if (cell === undefined || !isAmberStatus(cell.status)) continue;
      out.push({
        field,
        adapter: column.adapter,
        status: isAdapterFieldStatus(cell.status) ? cell.status : 'UNKNOWN',
        reason: amberReason(cell.status),
      });
    }
  }
  return out;
}
