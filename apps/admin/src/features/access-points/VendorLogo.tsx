/**
 * Vendor logos (D-045): each vendor's official logo, self-hosted under `/vendor-logos/` (no
 * external loading; the CSP stays 'self'), sanitized SVG (see vendorLogos.test.ts and
 * public/vendor-logos/SOURCES.md). Logos identify compatible hardware only.
 *
 * Tiles are white in light mode and a light grey in dark mode (token `logo-tile`) so dark logos
 * stay visible. A vendor without a reliable official logo gets a text wordmark tile.
 */
import { useState } from 'react';
import { cx } from '../../components/ui';

/** Logo files present in public/vendor-logos (asserted against the directory by a test). */
export const AVAILABLE_LOGOS: ReadonlySet<string> = new Set<string>([
  'alcatel-lucent',
  'aruba',
  'cambium',
  'cisco',
  'cisco-meraki',
  'draytek',
  'engenius',
  'extreme',
  'fortinet',
  'huawei',
  'juniper-mist',
  'mikrotik',
  'openwrt',
  'ruckus',
  'ruijie',
  'teltonika',
  'tplink-omada',
  'ubiquiti',
  'zyxel',
]);

/** Setup-guide gallery vendor key → logo file key (several gallery entries share a brand). */
export const LOGO_FOR_VENDOR: Readonly<Record<string, string>> = {
  'ezeap-openwifi': 'ezelink',
  'openwrt-uspot': 'openwrt',
  teltonika: 'teltonika',
  mikrotik: 'mikrotik',
  cambium: 'cambium',
  aruba: 'aruba',
  'cisco-wlc': 'cisco-catalyst',
  'cisco-meraki': 'cisco-meraki',
  fortinet: 'fortinet',
  ruckus: 'ruckus',
  'tplink-omada-portal': 'tplink-omada',
  'tplink-omada-api': 'tplink-omada',
  'ubiquiti-unifi': 'ubiquiti',
  'juniper-mist': 'juniper-mist',
  huawei: 'huawei',
  grandstream: 'grandstream',
  engenius: 'engenius',
  zyxel: 'zyxel',
  draytek: 'draytek',
  ruijie: 'ruijie',
  extreme: 'extreme',
  'alcatel-lucent': 'alcatel-lucent',
  tanaza: 'tanaza',
  openmesh: 'openmesh',
};

/** A brand whose own logo is missing may use its parent brand's logo. */
const LOGO_FALLBACK: Readonly<Record<string, string>> = {
  'cisco-catalyst': 'cisco',
};

/** `/vendor-logos/<key>.svg` for a gallery vendor key, or null (wordmark tile). */
export function vendorLogoSrc(vendorKey: string | null | undefined): string | null {
  if (vendorKey === null || vendorKey === undefined) return null;
  const key = LOGO_FOR_VENDOR[vendorKey];
  if (key === undefined) return null;
  if (AVAILABLE_LOGOS.has(key)) return `/vendor-logos/${key}.svg`;
  const parent = LOGO_FALLBACK[key];
  return parent !== undefined && AVAILABLE_LOGOS.has(parent) ? `/vendor-logos/${parent}.svg` : null;
}

/** Short wordmark text of a vendor name (drops a parenthesised product line). */
export function wordmark(name: string): string {
  if (/^any vendor/i.test(name)) return 'Any vendor';
  return name.replace(/\s*\(.*\)\s*$/, '').trim();
}

export const LOGO_NOTICE =
  'Logos are trademarks of their respective owners and identify compatible hardware only.';

/**
 * The logo in its tile. Decorative when a visible name accompanies it (`decorative`), else the
 * image carries the vendor name as alt text.
 */
export function VendorLogo({
  vendorKey,
  name,
  size = 'md',
  decorative = false,
  className,
}: {
  vendorKey: string | null | undefined;
  name: string;
  size?: 'sm' | 'md' | 'lg';
  decorative?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : vendorLogoSrc(vendorKey);
  const box =
    size === 'sm' ? 'h-8 w-16 p-1' : size === 'lg' ? 'h-[4.5rem] w-full p-2' : 'h-12 w-28 p-2';
  const text = wordmark(name);
  // Text wordmarks never break inside a word: the font shrinks (container-query width) until the
  // longest word fits, then whole words wrap onto at most two lines.
  const longest = Math.max(1, ...text.split(/\s+/).map((w) => w.length));
  const maxRem = size === 'sm' ? 0.625 : size === 'lg' ? 1 : 0.75;
  const fontSize = `clamp(0.5rem, calc(100cqw / ${String((longest * 0.62).toFixed(2))}), ${String(maxRem)}rem)`;
  return (
    <span
      data-testid="vendor-logo"
      data-vendor={vendorKey ?? ''}
      style={{ containerType: 'inline-size' }}
      className={cx(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-logo-tile',
        box,
        className,
      )}
    >
      {src !== null ? (
        <img
          src={src}
          alt={decorative ? '' : `${wordmark(name)} logo`}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full max-h-full w-full object-contain"
        />
      ) : (
        <span
          aria-hidden={decorative || undefined}
          className={cx(
            'line-clamp-2 max-w-full text-center font-semibold leading-tight tracking-tight text-logo-ink [hyphens:none] [overflow-wrap:normal] [word-break:normal]',
          )}
          style={{ fontSize }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
