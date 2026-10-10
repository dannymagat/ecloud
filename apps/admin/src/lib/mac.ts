/**
 * Client-side mirror of `@ecloud/shared` mac.ts (canonicalUnicastMac / MAC_ADDRESS_RULE) for
 * instant form feedback; the API remains the authority. Parity is asserted by mac.test.ts.
 */
const COLON = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const DASH = /^[0-9a-f]{2}(?:-[0-9a-f]{2}){5}$/;
const DOTTED = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/;
const BARE = /^[0-9a-f]{12}$/;

export const MAC_ADDRESS_RULE =
  'a unicast MAC address (aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, aabb.ccdd.eeff or aabbccddeeff)';

/** Canonical `aa:bb:cc:dd:ee:ff` of a unicast MAC, else null. */
export function canonicalUnicastMac(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v.length > 17) return null;
  if (!(COLON.test(v) || DASH.test(v) || DOTTED.test(v) || BARE.test(v))) return null;
  // No bracket character class here: Tailwind scans src/ and would read one as a CSS property.
  const mac =
    v
      .replace(/-|:|\./g, '')
      .match(/../g)
      ?.join(':') ?? null;
  if (mac === null || mac === '00:00:00:00:00:00') return null;
  const first = Number.parseInt(mac.slice(0, 2), 16);
  return (first & 0x01) === 0 ? mac : null;
}
