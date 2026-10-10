/**
 * MikroTik RouterOS rate format (Cycle A, D-044; docs/VENDOR_INTEGRATION_RESEARCH.md §3.3).
 *
 * `Mikrotik-Rate-Limit` (vendor 14988, attribute 8, string; FreeRADIUS ships it in the stock
 * `dictionary.mikrotik`). Vendor documentation (read 2026-10-10,
 * https://help.mikrotik.com/docs/display/ROS/RADIUS and
 * http://manual.mikrotik.com/docs/authentication-authorization-accounting/radius/):
 *
 *   rx-rate[/tx-rate] [rx-burst-rate[/tx-burst-rate] [rx-burst-threshold[/tx-burst-threshold]
 *   [rx-burst-time[/tx-burst-time] [priority] [rx-rate-min[/tx-rate-min]]]]
 *
 *   "from the point of view of the router (so "rx" is client upload, and "tx" is client
 *   download). All rates should be numbers with optional 'k' (1,000s) or 'M' (1,000,000s).
 *   If tx-rate is not specified, rx-rate is as tx-rate too."
 *
 * Consequences encoded here:
 *  - rx = client UPLOAD, tx = client DOWNLOAD; both are ALWAYS rendered (a lone `rx` would also
 *    cap the download at the upload rate).
 *  - A direction the policy leaves unset is rendered as `0`. "0 = unlimited" is documented for
 *    `Ascend-Data-Rate` / `Ascend-Xmit-Rate` on the same page, NOT explicitly for
 *    `Mikrotik-Rate-Limit`: REQUIRES_DEVICE_TEST (see {@link MIKROTIK_RATE_ATTRIBUTE}).
 *  - Units: ECLOUD intent is integer kbit/s (1 kbit = 1,000 bit). A multiple of 1,000 kbit/s is
 *    written `<n>M`, any other value `<n>k`.
 *  - Burst is expressible in the syntax, but the policy engine has no burst enforcement (D-028
 *    stage 10, POLICY_ENGINE §3.1), so `translate()` never emits it. The renderer accepts an
 *    explicit burst block for the later MikroTik adapter (Cycle B) and the device tests.
 *
 * Pure; no I/O. Nothing here claims device behaviour: every declaration below is
 * DOCUMENTED / REQUIRES_DEVICE_TEST (D-028, plan V1/V12) until a lab test passes.
 */
import type { AdapterFieldDeclaration, EvidenceRef, PolicyField } from '@ecloud/shared';
import type { AttributeDeclaration, RateFamilyDeclaration } from './capabilities.js';

export const MIKROTIK_RATE_LIMIT_ATTRIBUTE = 'Mikrotik-Rate-Limit';

/** Vendor documentation actually read (2026-10-10). */
export const MIKROTIK_RADIUS_DOCS: readonly EvidenceRef[] = Object.freeze([
  {
    kind: 'url',
    ref: 'MikroTik RouterOS manual: RADIUS, "Access-Accept" attribute list (Mikrotik-Rate-Limit)',
    url: 'https://help.mikrotik.com/docs/display/ROS/RADIUS',
  },
  {
    kind: 'url',
    ref: 'MikroTik manual (manual.mikrotik.com mirror): RADIUS attribute list',
    url: 'http://manual.mikrotik.com/docs/authentication-authorization-accounting/radius/',
  },
  { kind: 'doc-section', ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.3 (F2 mikrotik-hotspot)' },
]);

/** Rate family record for a MikroTik adapter (`rateFamilies`), Cycle B consumes it. */
export const MIKROTIK_RATE_FAMILY: RateFamilyDeclaration = Object.freeze({
  family: 'mikrotik',
  unit: 'mikrotik-rate-string',
  down: MIKROTIK_RATE_LIMIT_ATTRIBUTE,
  up: MIKROTIK_RATE_LIMIT_ATTRIBUTE,
  combined: MIKROTIK_RATE_LIMIT_ATTRIBUTE,
  vendor: 'Mikrotik',
});

const RATE_EVIDENCE =
  'MikroTik RADIUS manual (read 2026-10-10): Mikrotik-Rate-Limit "rx-rate[/tx-rate] ..." from the router\'s point of view (rx = client upload, tx = client download), units k/M; no lab test (D-028)';

/** Attribute declaration a MikroTik adapter puts in `attributes` (never VERIFIED, V1/V12). */
export const MIKROTIK_RATE_ATTRIBUTE: AttributeDeclaration = Object.freeze({
  name: MIKROTIK_RATE_LIMIT_ATTRIBUTE,
  status: 'REQUIRES_DEVICE_TEST',
  evidence: RATE_EVIDENCE,
  evidenceLevel: 'DOCUMENTED',
  evidenceRefs: MIKROTIK_RADIUS_DOCS,
  vendor: 'Mikrotik',
  note: 'rendered as "<upload>/<download>" (rx/tx); an unset direction is "0", whose "unlimited" meaning is documented only for Ascend-*-Rate: REQUIRES_DEVICE_TEST',
});

const BURST_EVIDENCE =
  'POLICY_ENGINE.md §3.1 / D-028 stage 10: the engine has no burst enforcement; the MikroTik syntax supports burst (vendor doc) but ECLOUD does not emit it';

function field(
  name: PolicyField,
  status: AdapterFieldDeclaration['status'],
  evidence: string,
  note?: string,
): AdapterFieldDeclaration {
  return {
    field: name,
    status,
    evidence,
    evidenceLevel: 'DOCUMENTED',
    evidenceRefs: MIKROTIK_RADIUS_DOCS,
    ...(note ? { note } : {}),
  };
}

/**
 * Four-state field declarations for the rate/burst fields of a MikroTik adapter (D-028):
 * rates REQUIRES_DEVICE_TEST (documented only), burst UNSUPPORTED (engine). The remaining
 * POLICY_FIELDS are declared by the Cycle B adapter itself.
 */
export const MIKROTIK_RATE_FIELD_DECLARATIONS: readonly AdapterFieldDeclaration[] = Object.freeze([
  field(
    'download_rate_kbps',
    'REQUIRES_DEVICE_TEST',
    RATE_EVIDENCE,
    'tx part of Mikrotik-Rate-Limit',
  ),
  field(
    'upload_rate_kbps',
    'REQUIRES_DEVICE_TEST',
    RATE_EVIDENCE,
    'rx part of Mikrotik-Rate-Limit',
  ),
  field('burst_download_kbps', 'UNSUPPORTED', BURST_EVIDENCE),
  field('burst_upload_kbps', 'UNSUPPORTED', BURST_EVIDENCE),
  field('burst_duration_s', 'UNSUPPORTED', BURST_EVIDENCE),
]);

/** Thrown for input the attribute cannot carry (negative, fractional, inconsistent burst). */
export class MikrotikRateError extends RangeError {}

function assertKbps(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MikrotikRateError(
      `${what} must be a non-negative integer kbit/s (got ${String(value)})`,
    );
  }
}

/** `0` → `0`; multiples of 1,000 kbit/s → `<n>M`; otherwise `<n>k`. */
export function formatMikrotikRate(kbps: number): string {
  assertKbps(kbps, 'rate');
  if (kbps === 0) return '0';
  return kbps % 1000 === 0 ? `${String(kbps / 1000)}M` : `${String(kbps)}k`;
}

export interface MikrotikBurst {
  /** Client download burst rate (tx-burst-rate), kbit/s. */
  readonly downloadKbps: number;
  /** Client upload burst rate (rx-burst-rate), kbit/s. */
  readonly uploadKbps: number;
  /** Optional thresholds (kbit/s); the device uses the rates when both are omitted. */
  readonly thresholdDownloadKbps?: number;
  readonly thresholdUploadKbps?: number;
  /** Burst time in whole seconds (rx and tx); device default 1 s when omitted. */
  readonly timeS?: number;
}

export interface MikrotikRateInput {
  /** Client download (tx), kbit/s; null = not limited by this policy. */
  readonly downloadKbps: number | null;
  /** Client upload (rx), kbit/s; null = not limited by this policy. */
  readonly uploadKbps: number | null;
  readonly burst?: MikrotikBurst;
}

const pair = (rx: string, tx: string): string => `${rx}/${tx}`;

/**
 * `Mikrotik-Rate-Limit` value for a normalised policy, or null when neither direction is set
 * (no attribute at all, rather than a meaningless "0/0").
 */
export function renderMikrotikRateLimit(input: MikrotikRateInput): string | null {
  const { downloadKbps, uploadKbps, burst } = input;
  if (downloadKbps === null && uploadKbps === null) {
    if (burst !== undefined) throw new MikrotikRateError('burst needs a base rate');
    return null;
  }
  const rx = uploadKbps ?? 0;
  const tx = downloadKbps ?? 0;
  const parts = [pair(formatMikrotikRate(rx), formatMikrotikRate(tx))];
  if (burst !== undefined) {
    assertKbps(burst.uploadKbps, 'burst upload');
    assertKbps(burst.downloadKbps, 'burst download');
    if (rx === 0 || tx === 0) {
      throw new MikrotikRateError(
        'burst needs both base rates (an unlimited direction has no burst)',
      );
    }
    if (burst.uploadKbps <= rx || burst.downloadKbps <= tx) {
      throw new MikrotikRateError('burst rate must exceed the base rate in both directions');
    }
    parts.push(pair(formatMikrotikRate(burst.uploadKbps), formatMikrotikRate(burst.downloadKbps)));
    const hasThreshold =
      burst.thresholdUploadKbps !== undefined || burst.thresholdDownloadKbps !== undefined;
    if (hasThreshold || burst.timeS !== undefined) {
      // Positional syntax: a burst time needs the threshold slot; default to the base rates
      // (the documented device behaviour when both thresholds are omitted).
      const thRx = burst.thresholdUploadKbps ?? rx;
      const thTx = burst.thresholdDownloadKbps ?? tx;
      assertKbps(thRx, 'burst threshold upload');
      assertKbps(thTx, 'burst threshold download');
      if (thRx > rx || thTx > tx) {
        throw new MikrotikRateError('burst threshold must not exceed the base rate');
      }
      parts.push(pair(formatMikrotikRate(thRx), formatMikrotikRate(thTx)));
    }
    if (burst.timeS !== undefined) {
      if (!Number.isSafeInteger(burst.timeS) || burst.timeS < 1) {
        throw new MikrotikRateError('burst time must be a positive integer number of seconds');
      }
      parts.push(pair(String(burst.timeS), String(burst.timeS)));
    }
  }
  return parts.join(' ');
}
