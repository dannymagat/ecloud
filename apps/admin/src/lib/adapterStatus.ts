/**
 * Four-state adapter field status (D-028) plus the evidence level of
 * MULTI_VENDOR_INTEGRATION_PLAN.md §4.4. A cell is presented as device-enforced ONLY when its
 * status is VERIFIED_SUPPORTED **and** its evidence is LAB_VALIDATED / PRODUCTION_VALIDATED with
 * a recorded device-test reference (rule V12, R-39). Source-verified cells read "Verified
 * (source)" / "Expected (source-verified, not device-tested)". Anything unrecognised falls back
 * to the weakest presentation. Kept in sync with packages/shared `ADAPTER_FIELD_STATUSES`,
 * `EVIDENCE_LEVELS`, `POLICY_FIELDS` and `isDeviceEnforced` (drift tests).
 */
export const ADAPTER_FIELD_STATUSES = [
  'VERIFIED_SUPPORTED',
  'REQUIRES_DEVICE_TEST',
  'UNSUPPORTED',
  'ECLOUD_SIDE_ONLY',
] as const;

export type AdapterFieldStatus = (typeof ADAPTER_FIELD_STATUSES)[number];

export const EVIDENCE_LEVELS = [
  'DOCUMENTED',
  'VERIFIED_FROM_SOURCE',
  'SIMULATOR_TESTED',
  'LAB_VALIDATED',
  'PRODUCTION_VALIDATED',
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return typeof value === 'string' && (EVIDENCE_LEVELS as readonly string[]).includes(value);
}

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

/** Engine adapter keys a NAS may use (D-012 / D-035; Cycle A adds the generic 802.1X one). */
export const ADAPTER_KEYS = [
  'openwifi-hostapd-radius',
  'openwifi-uspot-uam',
  'uspot-upstream-uam',
  'coovachilli-uam',
  'generic-radius-8021x',
  // Cycle E (D-044): Meraki MR splash sign-on; RADIUS from the Meraki Cloud (platform flag).
  'meraki-splash',
] as const;

/** Human labels for the NAS adapter dropdown (the key stays visible for support). */
export const ADAPTER_LABELS: Readonly<Record<(typeof ADAPTER_KEYS)[number], string>> = {
  'openwifi-hostapd-radius': 'EZEAP 802.1X / MAC auth (hostapd)',
  'openwifi-uspot-uam': 'EZEAP captive portal (TIP uspot)',
  'uspot-upstream-uam': 'OpenWrt uspot captive portal',
  'coovachilli-uam': 'CoovaChilli gateway captive portal',
  'generic-radius-8021x': 'Any vendor: 802.1X / MAC auth (generic RADIUS)',
  'meraki-splash': 'Cisco Meraki MR splash: sign-on with RADIUS (cloud RADIUS)',
};

export interface StatusPresentation {
  /** Normalised status; unknown inputs fall back to REQUIRES_DEVICE_TEST (never VERIFIED). */
  status: AdapterFieldStatus;
  /** Normalised evidence level; null when absent or unrecognised. */
  evidenceLevel: EvidenceLevel | null;
  label: string;
  /** Policy-preview cell text (plan §4.4). */
  previewLabel: string;
  description: string;
  tone: 'success' | 'warning' | 'danger' | 'info';
  /** Outlined = expected from source; solid = proven on a device. */
  variant: 'solid' | 'outline';
  /** V12: true only for VERIFIED_SUPPORTED + LAB/PRODUCTION evidence with a device-test ref. */
  deviceEnforced: boolean;
}

export interface PresentOptions {
  /** Device-test / record references (e.g. `DT-04`); required for "Lab validated". */
  dtRefs?: readonly string[];
}

const EVIDENCE_LABEL: Record<EvidenceLevel, string> = {
  DOCUMENTED: 'Documented',
  VERIFIED_FROM_SOURCE: 'Verified (source)',
  SIMULATOR_TESTED: 'Simulator tested',
  LAB_VALIDATED: 'Lab validated',
  PRODUCTION_VALIDATED: 'Production validated',
};

export const SOURCE_VERIFIED_DESCRIPTION =
  'Mechanism confirmed in vendor/firmware source for this adapter. Not yet proven on a lab device.';

type Base = Omit<StatusPresentation, 'status' | 'evidenceLevel'>;

const NEEDS_TEST: Base = {
  label: 'Needs device test',
  previewLabel: 'Needs device test',
  description: 'Sent to the device but NOT verified; do not rely on it being enforced.',
  tone: 'warning',
  variant: 'outline',
  deviceEnforced: false,
};

const OTHER: Record<'UNSUPPORTED' | 'ECLOUD_SIDE_ONLY', Base> = {
  UNSUPPORTED: {
    label: 'Unsupported',
    previewLabel: 'Unsupported',
    description: 'This adapter cannot enforce the field.',
    tone: 'danger',
    variant: 'solid',
    deviceEnforced: false,
  },
  ECLOUD_SIDE_ONLY: {
    label: 'ECLOUD side',
    previewLabel: 'ECLOUD side',
    description: 'Tracked and enforced by ECLOUD (e.g. at authorization), not by the device.',
    tone: 'info',
    variant: 'solid',
    deviceEnforced: false,
  },
};

export function isAdapterFieldStatus(value: unknown): value is AdapterFieldStatus {
  return typeof value === 'string' && (ADAPTER_FIELD_STATUSES as readonly string[]).includes(value);
}

function verifiedPresentation(level: EvidenceLevel | null, refs: readonly string[]): Base {
  if ((level === 'LAB_VALIDATED' || level === 'PRODUCTION_VALIDATED') && refs.length > 0) {
    return {
      label: EVIDENCE_LABEL[level],
      previewLabel: EVIDENCE_LABEL[level],
      description: `${level === 'LAB_VALIDATED' ? 'Proven on a lab device' : 'Observed in production'} (${refs.join(', ')}).`,
      tone: 'success',
      variant: 'solid',
      deviceEnforced: true,
    };
  }
  if (level === 'DOCUMENTED' || level === 'SIMULATOR_TESTED') {
    // Forbidden combination (validator V1/V2): weakest presentation.
    return {
      ...NEEDS_TEST,
      description: `Claimed supported with only ${EVIDENCE_LABEL[level].toLowerCase()} evidence: treated as not verified.`,
    };
  }
  if (level === null) {
    // Today's API payload carries no evidence level: say so instead of implying source evidence.
    return {
      label: 'Verified (evidence level not reported)',
      previewLabel: 'Expected (evidence level not reported, not device-tested)',
      description:
        'Declared supported by the adapter; the evidence level was not reported. Not proven on a lab device.',
      tone: 'success',
      variant: 'outline',
      deviceEnforced: false,
    };
  }
  // VERIFIED_FROM_SOURCE, or lab/production evidence without a DT reference.
  return {
    label: 'Verified (source)',
    previewLabel: 'Expected (source-verified, not device-tested)',
    description:
      level === 'LAB_VALIDATED' || level === 'PRODUCTION_VALIDATED'
        ? `${SOURCE_VERIFIED_DESCRIPTION} (No device-test reference recorded.)`
        : SOURCE_VERIFIED_DESCRIPTION,
    tone: 'success',
    variant: 'outline',
    deviceEnforced: false,
  };
}

export function presentStatus(
  value: unknown,
  evidenceLevel?: unknown,
  options: PresentOptions = {},
): StatusPresentation {
  const level = isEvidenceLevel(evidenceLevel) ? evidenceLevel : null;
  const refs = (options.dtRefs ?? []).filter((r) => typeof r === 'string' && r.trim() !== '');
  if (!isAdapterFieldStatus(value)) {
    return {
      status: 'REQUIRES_DEVICE_TEST',
      evidenceLevel: level,
      ...NEEDS_TEST,
      description: `Unknown status "${String(value)}": treated as not verified.`,
    };
  }
  let base: Base;
  if (value === 'VERIFIED_SUPPORTED') base = verifiedPresentation(level, refs);
  else if (value === 'REQUIRES_DEVICE_TEST')
    base = level
      ? {
          ...NEEDS_TEST,
          description: `${NEEDS_TEST.description} Evidence: ${EVIDENCE_LABEL[level]}.`,
        }
      : NEEDS_TEST;
  else base = OTHER[value];
  return { status: value, evidenceLevel: level, ...base };
}

export const FIELD_LABELS: Record<PolicyField, string> = {
  download_rate_kbps: 'Download rate',
  upload_rate_kbps: 'Upload rate',
  burst_download_kbps: 'Burst download',
  burst_upload_kbps: 'Burst upload',
  burst_duration_s: 'Burst duration',
  quota_daily_bytes: 'Daily quota',
  quota_monthly_bytes: 'Monthly quota',
  quota_total_bytes: 'Total quota',
  session_timeout_s: 'Session timeout',
  idle_timeout_s: 'Idle timeout',
  max_concurrent_sessions: 'Concurrent sessions',
  max_devices: 'Max devices',
  valid_from: 'Valid from',
  valid_until: 'Valid until',
  voucher_validity: 'Voucher validity',
  schedule_id: 'Schedule',
  vlan_id: 'VLAN',
};

export function fieldLabel(field: string): string {
  return (FIELD_LABELS as Record<string, string>)[field] ?? field;
}
