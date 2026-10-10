/**
 * Strict MAC address handling for identities that select a tenant (Cycle A, D-044): access-point
 * MACs that third-party portals send in their redirect (`ap_mac`, `apmac`, `ga_ap_mac`, ...).
 *
 * Accepted spellings (one separator style per value, case-insensitive):
 *   `aa:bb:cc:dd:ee:ff`, `aa-bb-cc-dd-ee-ff`, `aabb.ccdd.eeff` (Cisco), `aabbccddeeff`.
 * Canonical form: lowercase, colon-separated (`aa:bb:cc:dd:ee:ff`).
 *
 * Mixed separators (`aa:bb-cc...`), embedded text and anything else are refused, so a value that
 * merely *contains* twelve hex digits never becomes a MAC.
 */

const COLON = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const DASH = /^[0-9a-f]{2}(?:-[0-9a-f]{2}){5}$/;
const DOTTED = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/;
const BARE = /^[0-9a-f]{12}$/;

/** Canonical `aa:bb:cc:dd:ee:ff`, or null when `value` is not exactly one MAC address. */
export function canonicalMacStrict(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v.length > 17) return null;
  if (!(COLON.test(v) || DASH.test(v) || DOTTED.test(v) || BARE.test(v))) return null;
  const hex = v.replace(/[-:.]/g, '');
  return hex.match(/../g)?.join(':') ?? null;
}

/**
 * True for an individual (unicast) address that can identify one device: not all-zero, not
 * broadcast, and the I/G (group) bit of the first octet clear. Locally administered addresses
 * are allowed (several vendors derive BSSIDs from them).
 */
export function isUnicastMac(canonical: string): boolean {
  if (canonical === '00:00:00:00:00:00') return false;
  const first = Number.parseInt(canonical.slice(0, 2), 16);
  return Number.isInteger(first) && (first & 0x01) === 0;
}

/** Canonical unicast MAC, else null (the rule the access-point registry enforces). */
export function canonicalUnicastMac(value: string | null | undefined): string | null {
  const mac = canonicalMacStrict(value);
  return mac !== null && isUnicastMac(mac) ? mac : null;
}

/** Validation message for API fields that take a MAC address identity. */
export const MAC_ADDRESS_RULE =
  'a unicast MAC address (aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, aabb.ccdd.eeff or aabbccddeeff)';
