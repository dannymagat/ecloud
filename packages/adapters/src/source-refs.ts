/**
 * Structured `source` evidence references back-filled from the PHASE2_VALIDATION.md ledger
 * (§2.1–§2.3 V-rows) for every VERIFIED_FROM_SOURCE declaration (plan §4.2, rule V10). Each
 * `ref` starts with the V-row id and quotes the primary-evidence column of that row (V-146…V-148
 * were added on 2026-10-08 after a fresh read of the cached Phase 2 sources). The one ref without
 * a V-row (openwifi-config captive session-timeout renderer mapping) says so explicitly.
 * `appliesTo` names the code base / version the source analysis covers (plan §4.2 notes).
 */
import type { EvidenceRef } from '@ecloud/shared';

export const APPLIES_TIP_USPOT =
  'TIP wlan-ap feeds/ucentral/uspot (same code base on EZE-AP1832 r32912 per DT-01; behaviour not device-tested)';
export const APPLIES_UPSTREAM_USPOT = 'f00b4r0 uspot e0c19eb / openwrt-packages 87080bf';
export const APPLIES_COOVA_MASTER = 'coova-chilli master';
export const APPLIES_UCENTRAL_4_2 =
  'uCentral schema 4.2.0 as pinned by ezecontroller (ucentral.full.json) + wlan-ucentral-schema renderer';
export const APPLIES_WLAN_AP = 'TIP wlan-ap tree (feeds/ucentral/ratelimit)';

function src(ref: string, appliesTo: string): EvidenceRef {
  return { kind: 'source', ref, appliesTo };
}

/** Keyed by V-row id (plus `_U`/`_T` suffix where one row covers both uspot code bases). */
export const SRC = {
  // §2.1 EZEAP / uCentral / ratelimit
  V001: src(
    'V-001 · ucentral.full.json $defs.interface.ssid.rate-limit; wlan-ucentral-schema interface/ssid.uc generate_rate_limit_config(); wlan-ap feeds/ucentral/ratelimit/files/usr/bin/ratelimit',
    APPLIES_UCENTRAL_4_2,
  ),
  V003: src('V-003 · wlan-ap ratelimit l.21 (fixed `burst 2k`, no schema key)', APPLIES_WLAN_AP),
  V006: src(
    'V-006 · schema $defs.interface.ssid.max-inactivity → hostapd max_inactivity',
    APPLIES_UCENTRAL_4_2,
  ),
  V012: src(
    'V-012 · schema radius.authentication.mac-filter; ssid.uc l.255-266; ezecontroller ap_config_engine.ts l.266-276',
    APPLIES_UCENTRAL_4_2,
  ),
  CAPTIVE_RENDERER_SESSION_TIMEOUT: src(
    'no dedicated V-row · wlan-ucentral-schema renderer interface/captive.uc generate_uspot_base_config maps captive.session-timeout → uspot session_timeout (CAPTIVE_PORTAL_ARCHITECTURE.md §3.1)',
    APPLIES_UCENTRAL_4_2,
  ),
  // §2.2 uspot
  V050_T: src(
    'V-050 · T uspot.uc client_add l.215-227 (Session-Timeout cause 5, Idle-Timeout cause 4)',
    APPLIES_TIP_USPOT,
  ),
  V050_U: src(
    'V-050 · U uspot client_enable (Session-Timeout, Idle-Timeout)',
    APPLIES_UPSTREAM_USPOT,
  ),
  V051_T: src(
    'V-051 · T uspot.uc l.216-222 (Acct-Interim-Interval unless NAS acct_interval set)',
    APPLIES_TIP_USPOT,
  ),
  V146_U: src(
    'V-146 · f00b4r0 uspot.uc L481-510 client_enable (interval = acct_interval || reply Acct-Interim-Interval; next_interim), L339-349 client_interim, L694-695',
    APPLIES_UPSTREAM_USPOT,
  ),

  V052: src(
    'V-052 · T uspot.uc l.179-204 client_ratelimit (WISPr-Bandwidth-Max-Up/Down → ratelimit client_set)',
    APPLIES_TIP_USPOT,
  ),
  V053_T: src(
    'V-053 · T client_ratelimit (ChilliSpot-Bandwidth-Max-Up/Down kbit/s ×1000)',
    APPLIES_TIP_USPOT,
  ),
  V053_U: src(
    'V-053 · U client_ratelimit (WISPr / ChilliSpot bandwidth families)',
    APPLIES_UPSTREAM_USPOT,
  ),
  V054_T: src(
    'V-054 · T uspot.uc l.225, l.349-353 (ChilliSpot-Max-Total-Octets, 32-bit only)',
    APPLIES_TIP_USPOT,
  ),
  V054_U: src(
    'V-054 · f00b4r0 README (ChilliSpot-Max-{Input,Output,Total}-Octets + Gigawords)',
    APPLIES_UPSTREAM_USPOT,
  ),
  V055_T: src(
    'V-055 · T uspot.uc (VLAN Tunnel-*, Filter-Id, WISPr-Redirection-URL not honoured)',
    APPLIES_TIP_USPOT,
  ),
  V055_U: src('V-055 · uspot.uc (T and U: VLAN Tunnel-* not honoured)', APPLIES_UPSTREAM_USPOT),
  V056_T: src('V-056 · T uspot.uc (Class copied into accounting)', APPLIES_TIP_USPOT),
  V056_U: src('V-056 · U uspot.uc (Class copied into accounting)', APPLIES_UPSTREAM_USPOT),
  V059: src(
    'V-059 · wlan-ap uspot src/ (no radius-das.c); renderer emits no das_*',
    APPLIES_TIP_USPOT,
  ),
  V061_T: src(
    'V-061 · T handler.uc L22-37 (MAC-auth User-Name / User-Password / Call-Check)',
    APPLIES_TIP_USPOT,
  ),
  V147_U: src(
    'V-147 · f00b4r0 handler.uc L22-33 (mac-auth first on UAM); uspot.uc L879-901 client_auth try_macauth (User-Name = MAC + mac_suffix, Password = mac_passwd || MAC, Service-Type Call-Check)',
    APPLIES_UPSTREAM_USPOT,
  ),

  // §2.3 CoovaChilli (upstream master analysed; EZEGATE runs 1.2.9)
  V073: src(
    'V-073 · coova-chilli doc/attributes, doc/dictionary.coovachilli, src/chilli.c',
    APPLIES_COOVA_MASTER,
  ),
  V074: src(
    'V-074 · src/cmdline.ggo L99-100; chilli.c cb_radius_coa_ind L4855-4958',
    APPLIES_COOVA_MASTER,
  ),
  V148: src(
    'V-148 · coova-chilli src/chilli.c L1545-1595 auth_radius (User-Name = MAC + macsuffix, User-Password = macpasswd || User-Name, Service-Type Framed), L5072-5084 / L5156-5158 macauth trigger',
    APPLIES_COOVA_MASTER,
  ),
} as const satisfies Record<string, EvidenceRef>;
