// @vitest-environment node
/**
 * Dashboard tile colours (styles.css `--tile-*`): white text must reach WCAG 4.5:1 (normal text)
 * on every tile, in light and in dark mode.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function tiles(selector: string): Record<string, string> {
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(
    (m) => m[1]!.trim() === selector && m[2]!.includes('--tile-'),
  );
  const out: Record<string, string> = {};
  for (const b of blocks)
    for (const m of b[2]!.matchAll(/--tile-([a-z]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const contrastWithWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);

describe('dashboard tile palette', () => {
  const light = tiles(':root');
  const dark = tiles('.dark');
  const names = ['teal', 'rose', 'blue', 'gold', 'red', 'green', 'violet'];

  it('defines every tile colour for both themes', () => {
    expect(Object.keys(light).sort()).toEqual([...names].sort());
    expect(Object.keys(dark).sort()).toEqual([...names].sort());
  });

  it.each(names)('white text on %s meets 4.5:1 in light and dark mode', (name) => {
    expect(contrastWithWhite(light[name]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastWithWhite(dark[name]!)).toBeGreaterThanOrEqual(4.5);
  });
});
