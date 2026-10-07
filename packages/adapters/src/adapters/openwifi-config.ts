/**
 * `openwifi-config`: uCentral config push through the EZE controller (NETWORK_INTEGRATION.md
 * §7.3). Per-SSID granularity: every station of the SSID gets the same ceiling, so only
 * site-scoped intent translates; there is no RADIUS reply path at all.
 */
import type { AdapterCapabilities, EnforcementPlan } from '@ecloud/policy-engine';
import { attributeTable, createAdapter, decl, fieldTable } from '../base.js';
import { EV } from '../evidence.js';
import type { ConfigFragment, NasAdapter, Unsupported } from '../types.js';

const RATE_VERIFIED =
  "NETWORK_INTEGRATION.md §2 row 'Per-SSID up/down cap (per-station ceiling)': ssids[].rate-limit.ingress-rate/egress-rate (Mbit/s) → tc HTB per station, VERIFIED CODE + DOCS; §7.3 SSID-level rate-limit{ingress-rate (client upload), egress-rate (client download)} integers; POLICY_ENGINE.md §3.1 row rate_limit (openwifi-config)";
const RATE_NOTE =
  'per-SSID: every station gets the same ceiling (site-scoped intent only, else granularity_mismatch); integer Mbit/s, ceil(kbps/1000); sub-Mbit not expressible (A2 §7.3); end-to-end direction mapping REQUIRES DEVICE TEST (A2 §11 item 2)';
const QUOTA_UNSUPPORTED =
  "POLICY_ENGINE.md §3.1 row quota (openwifi-config): UNSUPPORTED; NETWORK_INTEGRATION.md §2 row 'Daily / monthly quota': not a device feature";
const SESSION_VERIFIED =
  "NETWORK_INTEGRATION.md §2 row 'Session timeout / idle timeout (captive)': captive.session-timeout / captive.idle-timeout VERIFIED CODE + DOCS (schema $defs.service.captive); POLICY_ENGINE.md §3.1 row session_timeout (openwifi-config): per-SSID NAS default only";
const IDLE_VERIFIED =
  "NETWORK_INTEGRATION.md §2 row 'Session/idle timeout (802.1X)': ssids[].max-inactivity per-SSID (schema interface.ssid.max-inactivity, default 300); POLICY_ENGINE.md §3.1 row idle_timeout (openwifi-config): per-SSID max-inactivity / captive.idle-timeout VERIFIED CODE";
const VLAN_RDT =
  'POLICY_ENGINE.md §3.1 row vlan (openwifi-config): static per-SSID VLAN / vlan-awareness VERIFIED CODE — not per client; NETWORK_INTEGRATION.md §7.3 lists no uCentral key mapping a policy vlan_id to an SSID VLAN id → REQUIRES DEVICE TEST';
const PUSH_VERIFIED =
  "NETWORK_INTEGRATION.md §5 row 'uCentral configure {uuid, when, config}': any schema key (rate-limit, ACL, captive timers …), VERIFIED DOCS (PROTOCOL.md) + CODE (ap_apply.ts l.475-528); re-applies hostapd/uspot → portal sessions reset (VERIFIED DOCS)";

export const capabilities: AdapterCapabilities = {
  key: 'openwifi-config',
  version: '0.1.0',
  portalType: 'config-only',
  granularity: 'per-ssid',
  rateUnit: 'mbps-int',
  rateFamilies: [],
  quotaAttributes: {},
  octetWidth: null,
  sessionTimeoutAttr: null,
  idleTimeoutAttr: null,
  interimIntervalAttr: null,
  vlanAttrs: [],
  classAttr: null,
  disconnect: {
    status: 'UNSUPPORTED',
    target: 'none',
    identifyBy: [],
    acctStopEmitted: 'unknown',
    evidence:
      'POLICY_ENGINE.md §3.1 row disconnect (openwifi-config): none. Last-resort PROPOSED fallback: push access-control-list deny for the MAC (keys VERIFIED CODE) — re-applies hostapd/uspot and resets portal sessions (A2 §5)',
    note: 'not an RFC 5176 path; the ACL fallback is PROPOSED only and not implemented here',
  },
  coaChange: {
    // Owner rule D-006 / D-034: the uCentral `configure` push itself is VERIFIED CODE,
    // but its effect on *existing* sessions (live rate change, portal reset) is
    // NETWORK_INTEGRATION.md §11 item 1 → REQUIRES_DEVICE_TEST (DT-02).
    status: 'REQUIRES_DEVICE_TEST',
    changeable: [
      'rate-limit.egress-rate',
      'rate-limit.ingress-rate',
      'max-inactivity',
      'captive.session-timeout',
    ],
    evidence: PUSH_VERIFIED,
    note: 'a config re-push, not RADIUS CoA; side effect: portal sessions reset (A2 §5) → batch outside schedule windows (POLICY_ENGINE.md §4.3 e)',
  },
  macAuth: {
    status: 'VERIFIED_SUPPORTED',
    evidence:
      "NETWORK_INTEGRATION.md §2 row 'RADIUS MAC authentication': ssids[].radius.authentication.mac-filter VERIFIED CODE + DOCS; §7.3 keys mac-filter, captive.mac-auth, mac-format",
    usernameRule:
      'format per mac-format key; the RADIUS username/password rule itself is REQUIRES DEVICE TEST for hostapd (A2 §11 item 7)',
  },
  fields: fieldTable([
    decl('download_rate_kbps', 'VERIFIED_SUPPORTED', RATE_VERIFIED, RATE_NOTE),
    decl('upload_rate_kbps', 'VERIFIED_SUPPORTED', RATE_VERIFIED, RATE_NOTE),
    decl('burst_download_kbps', 'UNSUPPORTED', EV.burstAbsent),
    decl('burst_upload_kbps', 'UNSUPPORTED', EV.burstAbsent),
    decl('burst_duration_s', 'UNSUPPORTED', EV.burstAbsent),
    decl('quota_daily_bytes', 'UNSUPPORTED', QUOTA_UNSUPPORTED),
    decl('quota_monthly_bytes', 'UNSUPPORTED', QUOTA_UNSUPPORTED),
    decl('quota_total_bytes', 'UNSUPPORTED', QUOTA_UNSUPPORTED),
    decl(
      'session_timeout_s',
      'VERIFIED_SUPPORTED',
      SESSION_VERIFIED,
      'per-SSID default for captive SSIDs only (captive.session-timeout); site-scoped intent only',
    ),
    decl(
      'idle_timeout_s',
      'VERIFIED_SUPPORTED',
      IDLE_VERIFIED,
      'per-SSID default (max-inactivity); site-scoped intent only',
    ),
    decl('max_concurrent_sessions', 'UNSUPPORTED', EV.configOnlyNoPerClient),
    decl('max_devices', 'UNSUPPORTED', EV.configOnlyNoPerClient),
    decl('valid_from', 'UNSUPPORTED', EV.configOnlyNoPerClient),
    decl('valid_until', 'UNSUPPORTED', EV.configOnlyNoPerClient),
    decl('voucher_validity', 'UNSUPPORTED', EV.configOnlyNoPerClient),
    decl('schedule_id', 'UNSUPPORTED', EV.configOnlyNoPerClient),
    decl('vlan_id', 'REQUIRES_DEVICE_TEST', VLAN_RDT),
  ]),
  attributes: attributeTable([]),
};

function renderConfig(plan: EnforcementPlan): ConfigFragment | Unsupported {
  if (plan.adapter !== 'openwifi-config')
    return { unsupported: true, reason: `plan for ${plan.adapter}` };
  if (plan.configPushChanges.length === 0)
    return {
      unsupported: true,
      reason: 'no site-scoped field translates to an SSID config change',
    };
  return {
    scope: 'ssid',
    changes: plan.configPushChanges.map((c) => ({ path: c.path, value: c.value })),
    status: 'VERIFIED_SUPPORTED',
    evidence: PUSH_VERIFIED,
    sideEffect:
      'configure push re-applies hostapd/uspot and resets portal sessions (NETWORK_INTEGRATION.md §5)',
  };
}

export const adapter: NasAdapter = createAdapter(capabilities, {
  disconnectMandatory: [],
  renderConfig,
});
