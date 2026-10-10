/**
 * Teltonika RutOS Hotspot profile on the existing `coovachilli-uam` adapter (Cycle B, D-044;
 * docs/VENDOR_INTEGRATION_RESEARCH.md §1 Teltonika row, §3.2). No new engine adapter: RutOS
 * Hotspot "uses CoovaChilli" (vendor wiki, search extract only), so the UAM redirect, `md`
 * signature, PAP-XOR `/logon` hand-off and the CoovaChilli RADIUS attribute families are the
 * coovachilli-uam ones.
 *
 * What differs is the setup guide and the evidence: the Teltonika wiki pages returned HTTP 403 to
 * every fetcher on 2026-10-10, so RutOS UI field names are NOT quoted here unless the research
 * doc recorded them ("UAM port" 3990, "UAM secret", walled garden "Allowlist", "Password
 * encoding", landing page). Everything else names the CoovaChilli concept and is marked
 * REQUIRES_CLARIFICATION; device behaviour (UAM parameter set, `md`, password encoding, CoA) is
 * REQUIRES_DEVICE_TEST (registry row `teltonika-rutos-hotspot`, V11 override).
 */
import type { EvidenceRef } from '@ecloud/shared';
import type { SetupStep } from './types.js';

export const TELTONIKA_VENDOR_KEY = 'teltonika';

/** Registry row of the profile (compatibility.ts). */
export const TELTONIKA_ROW_KEY = 'teltonika-rutos-hotspot';

const R32: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §1 (Teltonika row), §3.2 (coovachilli-uam for Teltonika)',
};
const WIKI: EvidenceRef = {
  kind: 'url',
  ref: 'Teltonika wiki, RutOS Hotspot pages (search extract only: "Hotspot service uses CoovaChilli", UAM port 3990, UAM secret; direct fetch HTTP 403 on 2026-10-10)',
  url: 'https://wiki.teltonika-networks.com/',
};
const REFS = [R32, WIKI];
const RC = 'RutOS UI label REQUIRES_CLARIFICATION';

function step(id: string, title: string, setting: string, value: string): SetupStep {
  return { id, title, setting, value, evidenceRefs: REFS };
}

/** Teltonika RutOS Hotspot guide (placeholders for every secret, D-033). */
export function teltonikaSetupGuide(
  portalOrigin: string,
  site: { readonly nasId: string },
): readonly SetupStep[] {
  const portalHost = new URL(portalOrigin).host;
  return [
    step(
      'landing-page',
      `External landing page = the ECLOUD CoovaChilli portal entry (${RC})`,
      'Hotspot landing page: external URL (uamserver)',
      `${portalOrigin}/uam/chilli/`,
    ),
    step('uam-port', 'UAM port (research: default 3990)', 'UAM port', '3990'),
    step(
      'uam-secret',
      'UAM secret: REQUIRED (ECLOUD refuses unsigned redirects, SECURITY §5.2); store the same value on the ECLOUD captive portal',
      'UAM secret',
      '<UAM_SECRET>',
    ),
    step(
      'password-encoding',
      'Password encoding must match ECLOUD (CoovaChilli PAP-XOR with the UAM secret); option semantics REQUIRES_DEVICE_TEST',
      'Password encoding',
      '<MATCH_COOVACHILLI_PAP_XOR> (REQUIRES_DEVICE_TEST)',
    ),
    step(
      'nasid',
      `NAS identifier = the identifier registered in ECLOUD (CoovaChilli radiusnasid; ${RC})`,
      'NAS identifier (radiusnasid)',
      site.nasId,
    ),
    step(
      'radius-auth',
      `RADIUS authentication server (${RC})`,
      'RADIUS authentication {server, port, secret}',
      '<ECLOUD_RADIUS_ADDRESS>, 1812, <RADIUS_SECRET>',
    ),
    step(
      'radius-acct',
      `RADIUS accounting server (${RC})`,
      'RADIUS accounting {server, port, secret}',
      '<ECLOUD_RADIUS_ADDRESS>, 1813, <RADIUS_SECRET>',
    ),
    step(
      'walled-garden',
      'Walled garden in Allowlist mode: the ECLOUD portal and enabled identity-provider hosts',
      'Walled garden (Allowlist)',
      `${portalHost}, <IDP_HOSTS>`,
    ),
    step(
      'coa',
      'Disconnect / CoA: whether RutOS exposes CoovaChilli coaport is REQUIRES_CLARIFICATION; leave ECLOUD CoA off until a device test (D-006)',
      'CoA port (coaport)',
      '<REQUIRES_CLARIFICATION>',
    ),
    step(
      'ecloud-nas',
      'Register the router in ECLOUD: adapter coovachilli-uam, NAS IP = RADIUS source address, NAS identifier as above; captive portal type coovachilli with the UAM secret',
      'ECLOUD NAS {nas_ip, nas_identifier, adapter_key}',
      `<REGISTERED_NAS_IP>, ${site.nasId}, coovachilli-uam`,
    ),
  ];
}
