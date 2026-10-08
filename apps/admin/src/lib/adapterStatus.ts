/**
 * Four-state adapter field status (D-028). Only `VERIFIED_SUPPORTED` may be presented as
 * device-enforced; every other value (and anything unrecognised) is shown as NOT enforced.
 * Kept in sync with packages/shared `ADAPTER_FIELD_STATUSES` / `POLICY_FIELDS` (drift test).
 */
export const ADAPTER_FIELD_STATUSES = [
  'VERIFIED_SUPPORTED',
  'REQUIRES_DEVICE_TEST',
  'UNSUPPORTED',
  'ECLOUD_SIDE_ONLY',
] as const;

export type AdapterFieldStatus = (typeof ADAPTER_FIELD_STATUSES)[number];

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

/** Engine adapter keys (D-012 / D-035). */
export const ADAPTER_KEYS = [
  'openwifi-hostapd-radius',
  'openwifi-uspot-uam',
  'uspot-upstream-uam',
  'coovachilli-uam',
] as const;

export interface StatusPresentation {
  /** Normalised status; unknown inputs fall back to REQUIRES_DEVICE_TEST (never VERIFIED). */
  status: AdapterFieldStatus;
  label: string;
  description: string;
  tone: 'success' | 'warning' | 'danger' | 'info';
  /** True only for VERIFIED_SUPPORTED. */
  deviceEnforced: boolean;
}

const PRESENTATION: Record<AdapterFieldStatus, Omit<StatusPresentation, 'status'>> = {
  VERIFIED_SUPPORTED: {
    label: 'Verified',
    description: 'Enforced by the device; verified by a recorded device test.',
    tone: 'success',
    deviceEnforced: true,
  },
  REQUIRES_DEVICE_TEST: {
    label: 'Needs device test',
    description: 'Sent to the device but NOT verified; do not rely on it being enforced.',
    tone: 'warning',
    deviceEnforced: false,
  },
  UNSUPPORTED: {
    label: 'Unsupported',
    description: 'This adapter cannot enforce the field.',
    tone: 'danger',
    deviceEnforced: false,
  },
  ECLOUD_SIDE_ONLY: {
    label: 'ECLOUD side',
    description: 'Tracked and enforced by ECLOUD (e.g. at authorization), not by the device.',
    tone: 'info',
    deviceEnforced: false,
  },
};

export function isAdapterFieldStatus(value: unknown): value is AdapterFieldStatus {
  return typeof value === 'string' && (ADAPTER_FIELD_STATUSES as readonly string[]).includes(value);
}

export function presentStatus(value: unknown): StatusPresentation {
  const status: AdapterFieldStatus = isAdapterFieldStatus(value) ? value : 'REQUIRES_DEVICE_TEST';
  const base = PRESENTATION[status];
  return {
    status,
    ...base,
    description: isAdapterFieldStatus(value)
      ? base.description
      : `Unknown status "${String(value)}": treated as not verified.`,
  };
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
