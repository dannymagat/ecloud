/**
 * D-045: every self-hosted vendor logo is a sanitized SVG (no script, no event handler, no
 * foreignObject, no external reference, a viewBox), every listed logo exists, every file is
 * listed with its source, and the trademark notice is recorded.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOGOS, LOGO_FOR_VENDOR, LOGO_NOTICE, vendorLogoSrc } from './VendorLogo';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../public/vendor-logos');
const files = readdirSync(DIR).filter((f) => f.endsWith('.svg'));
const ALLOWED_NAMESPACES = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink']);

/** Problems of one SVG document (empty = clean). */
function svgProblems(svg: string): string[] {
  const out: string[] = [];
  if (/<script/i.test(svg)) out.push('script element');
  if (/<foreignObject/i.test(svg)) out.push('foreignObject');
  if (/\son[a-z]+\s*=/i.test(svg)) out.push('event handler attribute');
  if (/javascript:/i.test(svg)) out.push('javascript: URL');
  if (/<!ENTITY/i.test(svg)) out.push('entity declaration');
  if (/@import/i.test(svg)) out.push('@import');
  if (/<(?:iframe|embed|object|image)\b/i.test(svg)) out.push('embedded content');
  for (const m of svg.matchAll(/(?:https?:)?\/\/[^\s"'<>)]+/gi)) {
    const url = m[0];
    const before = svg.slice(Math.max(0, (m.index ?? 0) - 14), m.index);
    if (ALLOWED_NAMESPACES.has(url) && /xmlns(?::xlink)?="$/.test(before)) continue;
    out.push(`external URL ${url}`);
  }
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    if (!m[1]?.startsWith('#')) out.push(`non-local href ${m[1] ?? ''}`);
  }
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  if (root === '') out.push('no <svg> root');
  if (!/\sviewBox\s*=/.test(root)) out.push('no viewBox');
  return out;
}

describe('vendor logo SVG sanitization', () => {
  it('the checker catches the forbidden constructs', () => {
    const bad = [
      '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 1 1" onload="x()"></svg>',
      '<svg viewBox="0 0 1 1"><foreignObject/></svg>',
      '<svg viewBox="0 0 1 1"><use href="https://evil.example/x.svg#a"/></svg>',
      '<svg viewBox="0 0 1 1"><a xlink:href="javascript:alert(1)"/></svg>',
      '<svg viewBox="0 0 1 1"><style>@import url(//evil.example/a.css)</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ];
    for (const svg of bad) expect(svgProblems(svg), svg).not.toEqual([]);
    expect(
      svgProblems(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><use xlink:href="#a"/></svg>',
      ),
    ).toEqual([]);
  });

  it.each(files)('%s is clean', (file) => {
    const svg = readFileSync(join(DIR, file), 'utf8');
    expect(svgProblems(svg)).toEqual([]);
    expect(svg.length).toBeLessThan(150_000);
  });

  it('AVAILABLE_LOGOS matches the files on disk', () => {
    expect([...AVAILABLE_LOGOS].sort()).toEqual(files.map((f) => f.slice(0, -4)).sort());
  });

  it('SOURCES.md records every logo and the trademark notice', () => {
    const sources = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');
    expect(sources).toContain(LOGO_NOTICE);
    for (const file of files) expect(sources, file).toContain(file.slice(0, -4));
  });

  it('maps gallery vendors to self-hosted logos with brand fallbacks', () => {
    expect(vendorLogoSrc('mikrotik')).toBe('/vendor-logos/mikrotik.svg');
    expect(vendorLogoSrc('tplink-omada-api')).toBe('/vendor-logos/tplink-omada.svg');
    // no separate Catalyst logo: the Cisco logo
    expect(vendorLogoSrc('cisco-wlc')).toBe('/vendor-logos/cisco.svg');
    expect(vendorLogoSrc('coovachilli')).toBeNull();
    expect(vendorLogoSrc(null)).toBeNull();
    for (const src of Object.keys(LOGO_FOR_VENDOR).map(vendorLogoSrc)) {
      if (src !== null) expect(src).toMatch(/^\/vendor-logos\/[a-z0-9-]+\.svg$/);
    }
  });
});
