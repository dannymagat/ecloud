import { sourced } from './base.js';
import { SRC } from './source-refs.js';

/**
 * Evidence strings shared by several adapters (brief rule 3: every declaration cites the doc
 * section it rests on). Adapter-specific evidence lives in each adapter file.
 */
export const EV = {
  concurrencyEcloudSide:
    "NETWORK_INTEGRATION.md §2 row 'Concurrent devices per subscriber': not a device feature → ECLOUD AAA (reject/Disconnect); POLICY_ENGINE.md §1.1 rows max_concurrent_sessions / max_devices: ECLOUD-side only",
  validityEcloudSide:
    "POLICY_ENGINE.md §1.1 rows valid_from / valid_until: ECLOUD-side (reject outside; Session-Timeout clipped to valid_until); NETWORK_INTEGRATION.md §7.2 row 'daily/monthly quota, concurrency, validity, schedule': decided in ECLOUD before Accept",
  voucherEcloudSide:
    "POLICY_ENGINE.md §1.1 row 'voucher validity': ECLOUD-side (clip Session-Timeout); CAPTIVE_PORTAL_ARCHITECTURE.md §7.5 row 'Session timeout / account validity': Session-Timeout = min(remaining validity, policy)",
  scheduleEcloudSide:
    'POLICY_ENGINE.md §1.1 row schedule_id: ECLOUD-side (deny out-of-window; Session-Timeout clipped to window end); AAA_ARCHITECTURE.md §4.3 row Schedule: ECLOUD rejects outside window',
  burstAbsent:
    "NETWORK_INTEGRATION.md §2 row 'Burst size': no schema key, ratelimit uses fixed `burst 2k` (VERIFIED DOCS, absence); POLICY_ENGINE.md §3.1 row burst: UNSUPPORTED on all adapters",
  burstRadius:
    'CAPTIVE_PORTAL_ARCHITECTURE.md §7.5 row Burst: not expressible via RADIUS; POLICY_ENGINE.md §3.1 row burst: UNSUPPORTED',
  configOnlyNoPerClient:
    'POLICY_ENGINE.md §4.3 (e) openwifi-config: config-only adapter has no per-client decision point; per-client intent is granularity_mismatch / unsupported',
} as const;

/** Shared evidence with structured source references (rule V10). */
export const EV_SOURCED = {
  /** Absence verified in source (plan §4.2: UNSUPPORTED + source → VERIFIED_FROM_SOURCE). */
  burstAbsent: sourced(EV.burstAbsent, [SRC.V003]),
} as const;
