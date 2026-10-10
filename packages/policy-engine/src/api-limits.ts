/**
 * "API limits" translation target (Cycle D; docs/VENDOR_INTEGRATION_RESEARCH.md §3 "No API
 * limits output from translate()", §3.6–§3.8). Controller-API vendors take rate / time / data
 * limits as API body fields, not RADIUS reply attributes, so this is a second translation target
 * next to `translate()` / `buildReplyAttributes`. Pure; `translate()` is unchanged.
 *
 * Every field gets one D-028 four-state status. Nothing is VERIFIED_SUPPORTED: the API fields
 * are DOCUMENTED by the vendor, no lab test exists, so device-side fields are
 * REQUIRES_DEVICE_TEST at best (plan V1/V12). Fields the controller API cannot express are
 * UNSUPPORTED or ECLOUD_SIDE_ONLY, never silently dropped.
 *
 * Rounding never grants more than the policy: minutes and MB are rounded DOWN (minimum 1 when
 * the policy value is positive, because 0 would mean "no limit" or be refused by the vendor).
 * Units: 1 MB = 1 000 000 bytes (UniFi `dataUsageLimitMBytes`: MB vs MiB REQUIRES_DEVICE_TEST,
 * the decimal reading grants less). kbit/s = 1 000 bit/s, as in the policy model.
 */
import type { AdapterFieldStatus, EvidenceLevel, PolicyField } from '@ecloud/shared';
import type { EnforcementFields } from './intent.js';

export const API_LIMIT_TARGETS = ['unifi-network', 'omada-controller', 'mist'] as const;
export type ApiLimitTarget = (typeof API_LIMIT_TARGETS)[number];

export type ApiLimitMechanism =
  'controller_api' | 'signed_grant' | 'ecloud_side' | 'none' | 'not_set';

export interface ApiFieldResult {
  readonly field: PolicyField;
  readonly status: AdapterFieldStatus;
  readonly evidenceLevel: EvidenceLevel;
  readonly mechanism: ApiLimitMechanism;
  /** Vendor API field carrying the value, when any. */
  readonly apiField: string | null;
  readonly note: string;
}

export interface ApiLimits {
  /** Authorisation duration actually granted (seconds), after rounding / clipping. */
  readonly durationS: number;
  readonly dataLimitBytes: bigint | null;
  readonly downloadKbps: number | null;
  readonly uploadKbps: number | null;
}

export interface UnifiLimitBody {
  readonly timeLimitMinutes?: number;
  readonly dataUsageLimitMBytes?: number;
  readonly rxRateLimitKbps?: number;
  readonly txRateLimitKbps?: number;
}

export interface OmadaLimitBody {
  /** Duration in milliseconds (doc unit 6.2.10; semantics REQUIRES_DEVICE_TEST). */
  readonly timeMs: number;
  readonly totalTrafficLimitBytes?: number;
  readonly downloadRateLimitKbps?: number;
  readonly uploadRateLimitKbps?: number;
}

export interface ApiLimitsPlan {
  readonly target: ApiLimitTarget;
  readonly limits: ApiLimits;
  readonly unifi: UnifiLimitBody | null;
  readonly omada: OmadaLimitBody | null;
  readonly mist: { readonly authorizeMinutes: number } | null;
  readonly fields: readonly ApiFieldResult[];
}

export interface ApiLimitInput {
  readonly fields: Partial<EnforcementFields>;
  /**
   * Derived session cap (seconds) from the resolver's clip (schedule end, validity, voucher
   * expiry …) when known; the smaller of this and `session_timeout_s` is granted.
   */
  readonly sessionCapS?: number | null;
  /** Remaining quota bytes when ECLOUD knows them (it usually does not in API mode). */
  readonly remainingQuotaBytes?: bigint | null;
  /** Used when neither the policy nor the clip sets a duration. Default 24 h. */
  readonly defaultDurationS?: number;
}

export const API_LIMITS_DEFAULT_DURATION_S = 24 * 3600;

const DOC: Readonly<Record<ApiLimitTarget, string>> = Object.freeze({
  'unifi-network':
    'help.ui.com 31228198640023 (AUTHORIZE_GUEST_ACCESS body fields), docs/VENDOR_INTEGRATION_RESEARCH.md §3.6',
  'omada-controller':
    'support.omadanetworks.com document 132060 (Omada Controller 6.2.10 extPortal/auth body), research §3.7',
  mist: 'juniper.net guest-access-external-portal (token authorize_min), research §3.8',
});

const MAX_RATE_KBPS = 100_000_000;

function positiveInt(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

const unset = (v: unknown): boolean => v === null || v === undefined;

function minBig(values: readonly (bigint | null | undefined)[]): bigint | null {
  let out: bigint | null = null;
  for (const v of values) {
    if (typeof v === 'bigint' && v > 0n && (out === null || v < out)) out = v;
  }
  return out;
}

/** Translates the enforcement fields into the vendor API body for `target`. */
export function translateApiLimits(target: ApiLimitTarget, input: ApiLimitInput): ApiLimitsPlan {
  const f = input.fields;
  const doc = DOC[target];
  const result: ApiFieldResult[] = [];
  const add = (
    field: PolicyField,
    status: AdapterFieldStatus,
    mechanism: ApiLimitMechanism,
    apiField: string | null,
    note: string,
  ): void => {
    result.push({ field, status, evidenceLevel: 'DOCUMENTED', mechanism, apiField, note });
  };

  // --- duration -------------------------------------------------------------------------
  const policyTimeout = positiveInt(f.session_timeout_s);
  const cap = positiveInt(input.sessionCapS ?? null);
  const candidates = [policyTimeout, cap].filter((v): v is number => v !== null);
  const rawDuration =
    candidates.length > 0
      ? Math.min(...candidates)
      : (positiveInt(input.defaultDurationS) ?? API_LIMITS_DEFAULT_DURATION_S);
  const minutes = Math.max(1, Math.floor(rawDuration / 60));
  const durationS = target === 'omada-controller' ? rawDuration : minutes * 60;

  // --- rates ----------------------------------------------------------------------------
  const rateApi = target !== 'mist';
  const down = rateApi ? positiveInt(f.download_rate_kbps) : null;
  const up = rateApi ? positiveInt(f.upload_rate_kbps) : null;
  if (down !== null && down > MAX_RATE_KBPS) throw new RangeError('download rate out of range');
  if (up !== null && up > MAX_RATE_KBPS) throw new RangeError('upload rate out of range');

  // --- data -----------------------------------------------------------------------------
  const configured = minBig([f.quota_total_bytes, f.quota_daily_bytes, f.quota_monthly_bytes]);
  const dataBytes = target === 'mist' ? null : minBig([configured, input.remainingQuotaBytes]);

  let unifi: UnifiLimitBody | null = null;
  let omada: OmadaLimitBody | null = null;
  let mist: { authorizeMinutes: number } | null = null;
  let dataLimitBytes: bigint | null = null;

  if (target === 'unifi-network') {
    const mb = dataBytes === null ? null : dataBytes / 1_000_000n;
    const mbytes = mb === null ? null : Number(mb < 1n ? 1n : mb);
    dataLimitBytes = mbytes === null ? null : BigInt(mbytes) * 1_000_000n;
    unifi = {
      timeLimitMinutes: minutes,
      ...(mbytes !== null ? { dataUsageLimitMBytes: mbytes } : {}),
      // ASSUMPTION (research §6 item 7): rx = client download, tx = client upload.
      ...(down !== null ? { rxRateLimitKbps: down } : {}),
      ...(up !== null ? { txRateLimitKbps: up } : {}),
    };
  } else if (target === 'omada-controller') {
    const bytes =
      dataBytes === null || dataBytes > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(dataBytes);
    dataLimitBytes = bytes === null ? null : BigInt(bytes);
    omada = {
      timeMs: rawDuration * 1000,
      ...(bytes !== null ? { totalTrafficLimitBytes: bytes } : {}),
      ...(down !== null ? { downloadRateLimitKbps: down } : {}),
      ...(up !== null ? { uploadRateLimitKbps: up } : {}),
    };
  } else {
    mist = { authorizeMinutes: minutes };
  }

  // --- per-field statuses (every POLICY_FIELD exactly once) ------------------------------
  const timeField =
    target === 'unifi-network'
      ? 'timeLimitMinutes'
      : target === 'omada-controller'
        ? 'time'
        : 'authorize_min';
  add(
    'session_timeout_s',
    'REQUIRES_DEVICE_TEST',
    target === 'mist' ? 'signed_grant' : 'controller_api',
    timeField,
    `${doc}; granted ${String(durationS)} s (rounded down${target === 'omada-controller' ? '' : ' to whole minutes'})${target === 'omada-controller' ? '; `time` unit/semantics differ between Omada docs (ms vs µs, expiry vs duration): REQUIRES_DEVICE_TEST' : ''}`,
  );
  if (target === 'mist') {
    for (const field of ['download_rate_kbps', 'upload_rate_kbps'] as const) {
      add(
        field,
        'UNSUPPORTED',
        'none',
        null,
        `${doc}: the grant token carries only authorize_min; the trailing 0/0/0 fields are undocumented and never used`,
      );
    }
  } else {
    const [downField, upField] =
      target === 'unifi-network'
        ? ['rxRateLimitKbps', 'txRateLimitKbps']
        : ['downloadRateLimitKbps', 'uploadRateLimitKbps'];
    const dirNote =
      target === 'unifi-network'
        ? '; rx/tx direction is an ASSUMPTION (rx = client download): REQUIRES_DEVICE_TEST'
        : '';
    add(
      'download_rate_kbps',
      'REQUIRES_DEVICE_TEST',
      unset(f.download_rate_kbps) ? 'not_set' : 'controller_api',
      downField,
      `${doc}${dirNote}`,
    );
    add(
      'upload_rate_kbps',
      'REQUIRES_DEVICE_TEST',
      unset(f.upload_rate_kbps) ? 'not_set' : 'controller_api',
      upField,
      `${doc}${dirNote}`,
    );
  }
  if (target === 'mist') {
    for (const field of [
      'quota_total_bytes',
      'quota_daily_bytes',
      'quota_monthly_bytes',
    ] as const) {
      add(
        field,
        'UNSUPPORTED',
        'none',
        null,
        `${doc}: no data limit in the grant; no accounting in this mode`,
      );
    }
  } else {
    const dataField =
      target === 'unifi-network' ? 'dataUsageLimitMBytes' : 'totalTrafficLimitBytes';
    add(
      'quota_total_bytes',
      'REQUIRES_DEVICE_TEST',
      unset(f.quota_total_bytes) ? 'not_set' : 'controller_api',
      dataField,
      `${doc}; sent as a per-authorisation cap (smallest configured quota)${target === 'unifi-network' ? '; MB rounded down, MB vs MiB REQUIRES_DEVICE_TEST' : ''}`,
    );
    for (const field of ['quota_daily_bytes', 'quota_monthly_bytes'] as const) {
      add(
        field,
        'UNSUPPORTED',
        'none',
        null,
        'no RADIUS accounting in API mode: ECLOUD cannot observe usage to carry a period quota across authorisations (the smallest quota is still sent as a per-authorisation cap)',
      );
    }
  }
  add(
    'idle_timeout_s',
    'UNSUPPORTED',
    'none',
    null,
    `${doc}: no idle-timeout field in the documented API`,
  );
  add('vlan_id', 'UNSUPPORTED', 'none', null, `${doc}: no VLAN field in the documented API`);
  for (const field of ['burst_download_kbps', 'burst_upload_kbps', 'burst_duration_s'] as const) {
    add(
      field,
      'UNSUPPORTED',
      'none',
      null,
      'no burst field in the documented API (and no engine burst enforcement, D-028 stage 10)',
    );
  }
  for (const field of ['valid_from', 'valid_until', 'voucher_validity', 'schedule_id'] as const) {
    add(
      field,
      'ECLOUD_SIDE_ONLY',
      'ecloud_side',
      null,
      'checked by ECLOUD before authorising; the granted duration is clipped to the remaining window',
    );
  }
  for (const field of ['max_concurrent_sessions', 'max_devices'] as const) {
    add(
      field,
      'ECLOUD_SIDE_ONLY',
      'ecloud_side',
      null,
      'counted by ECLOUD over its API-authorised sessions only (no device sessions are observable)',
    );
  }

  return {
    target,
    limits: { durationS, dataLimitBytes, downloadKbps: down, uploadKbps: up },
    unifi,
    omada,
    mist,
    fields: result,
  };
}
