/**
 * "Download MikroTik installation script" (Access Points page, D-045): a RouterOS script for one
 * `mikrotik-hotspot` NAS that applies the ECLOUD side of the MikroTik setup guide
 * (`@ecloud/adapters` mikrotikSetupGuide): RADIUS server entry, `/radius incoming`, HotSpot
 * profile RADIUS settings and the walled-garden entry of the ECLOUD portal host.
 *
 * NEVER contains the RADIUS shared secret (D-033 / D-045): the administrator pastes it into the
 * marked variable (the script refuses to run with the placeholder). Values that are not known
 * from configuration stay placeholders and stop the script the same way. Pure: no I/O.
 *
 * Status: DOCUMENTED, not device-tested (REQUIRES_DEVICE_TEST, D-028).
 */
import { MIKROTIK_PORTAL_PATH } from '@ecloud/adapters';

export const SECRET_PLACEHOLDER = 'PASTE_RADIUS_SECRET_HERE';
export const ADDRESS_PLACEHOLDER = 'ECLOUD_RADIUS_ADDRESS';
/** RouterOS default HotSpot server profile name (created by the HotSpot setup wizard). */
export const DEFAULT_HOTSPOT_PROFILE = 'hsprof1';
export const MIKROTIK_DEFAULT_DAS_PORT = 1700;

export interface MikrotikScriptInput {
  nas: {
    id: string;
    name: string;
    nasIp: string | null;
    nasIdentifier: string | null;
    coaPort: number | null;
  };
  /** RADIUS_ADVERTISED_ADDRESS (null = not configured). */
  radiusAddress: string | null;
  authPort: number;
  acctPort: number;
  /** PUBLIC_PORTAL_ORIGIN. */
  portalOrigin: string;
  generatedAt: Date;
}

/** Characters that can never break out of a RouterOS quoted string or a comment line. */
const SAFE_VALUE = /^[A-Za-z0-9._:-]{1,253}$/;

/** A value that is safe inside a RouterOS `"…"` string, or null. */
function safe(value: string | null): string | null {
  return value !== null && SAFE_VALUE.test(value) ? value : null;
}

/** One line of comment text: no line breaks / control characters. */
function commentText(value: string): string {
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, 200);
}

/** `ecloud-mikrotik-<name>.rsc`, ASCII only (Content-Disposition safe). */
export function mikrotikScriptFilename(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `ecloud-mikrotik-${slug === '' ? id.slice(0, 8) : slug}.rsc`;
}

export function renderMikrotikScript(input: MikrotikScriptInput): string {
  const { nas } = input;
  // Operator configuration, but still never trusted into an unquoted RouterOS token.
  const portalHost = safe(new URL(input.portalOrigin).hostname);
  const address = safe(input.radiusAddress);
  const nasIp = safe(nas.nasIp);
  const identity = safe(nas.nasIdentifier);
  const dasPort = nas.coaPort ?? MIKROTIK_DEFAULT_DAS_PORT;
  const lines = [
    `# ECLOUD RouterOS HotSpot configuration for NAS "${commentText(nas.name)}" (${nas.id})`,
    `# Generated ${input.generatedAt.toISOString()}. Status: documented, not yet device-tested.`,
    '# Review every line before running it on the router.',
    '#',
    '# The RADIUS shared secret is NOT in this file. In ECLOUD open Access Points > RADIUS Secret,',
    `# "Reveal and copy" it, paste it in place of ${SECRET_PLACEHOLDER} below, then upload the`,
    '# file to the router and run: /import file-name=<this file>',
    '{',
    `:local radiusSecret "${SECRET_PLACEHOLDER}"`,
    `:local radiusAddress "${address ?? ADDRESS_PLACEHOLDER}"`,
    '# The HotSpot server profile of the guest network (RouterOS default: hsprof1).',
    `:local hotspotProfile "${DEFAULT_HOTSPOT_PROFILE}"`,
    `:if ($radiusSecret = "${SECRET_PLACEHOLDER}") do={ :error "ECLOUD: paste the RADIUS shared secret into radiusSecret first" }`,
    `:if ($radiusAddress = "${ADDRESS_PLACEHOLDER}") do={ :error "ECLOUD: set radiusAddress (the ECLOUD RADIUS address is not configured)" }`,
  ];
  if (identity !== null) {
    lines.push(
      '# 1. Router identity = the NAS identifier registered in ECLOUD (sent as NAS-Identifier).',
      `/system identity set name="${identity}"`,
    );
  } else {
    lines.push(
      '# 1. Router identity: no NAS identifier is registered in ECLOUD for this NAS; set one in',
      '#    ECLOUD and the same value here with /system identity set name=<NAS identifier>.',
    );
  }
  lines.push(
    '# 2. RADIUS server for the HotSpot service (authentication + accounting).',
    `/radius add service=hotspot address=$radiusAddress secret=$radiusSecret authentication-port=${String(input.authPort)} accounting-port=${String(input.acctPort)}${nasIp !== null ? ` src-address=${nasIp}` : ''} comment="ECLOUD"`,
    '# 3. Accept Disconnect / CoA from ECLOUD (RouterOS default accept=no).',
    `/radius incoming set accept=yes port=${String(dasPort)}`,
    '# 4. HotSpot profile: RADIUS authentication + accounting, HTTP-CHAP login.',
    '/ip hotspot profile set [find name=$hotspotProfile] use-radius=yes radius-accounting=yes radius-interim-update=received login-by=http-chap',
    '# 5. Walled garden: guests must reach the ECLOUD portal before they log in.',
    portalHost !== null
      ? `/ip hotspot walled-garden add dst-host="${portalHost}" comment="ECLOUD portal"`
      : '# (the portal host name has unusual characters: add its walled-garden entry by hand)',
    '}',
    '#',
    '# 6. login.html: in ECLOUD download "MikroTik login.html" for this NAS and upload it to the',
    '#    HotSpot html-directory of the profile (Files > hotspot/login.html), replacing the file',
    `#    there. It redirects guests to ${commentText(input.portalOrigin)}${MIKROTIK_PORTAL_PATH} (no secret inside).`,
    '',
  );
  return lines.join('\n');
}
