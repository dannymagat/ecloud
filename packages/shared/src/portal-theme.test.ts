import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTAL_COLORS,
  DEFAULT_PORTAL_STRINGS,
  contrastIssues,
  contrastRatio,
  localeDirection,
  resolvePortalColors,
  resolvePortalStrings,
} from './portal-theme.js';

describe('portal theme tokens', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(() => contrastRatio('red', '#ffffff')).toThrow(RangeError);
  });

  it('ships an accessible default palette and reports failing pairs', () => {
    expect(contrastIssues({ ...DEFAULT_PORTAL_COLORS })).toEqual([]);
    const issues = contrastIssues({ ...DEFAULT_PORTAL_COLORS, text: '#cccccc' });
    expect(issues.map((i) => `${i.foreground}/${i.background}`)).toEqual([
      'text/background',
      'text/surface',
    ]);
  });

  it('fills missing or malformed colours with defaults and lower-cases hex', () => {
    const colors = resolvePortalColors({ brand: '#ABCDEF', text: 'url(x)', extra: '#000000' });
    expect(colors.brand).toBe('#abcdef');
    expect(colors.text).toBe(DEFAULT_PORTAL_COLORS.text);
    expect(colors).not.toHaveProperty('extra');
    expect(resolvePortalColors(null)).toEqual(DEFAULT_PORTAL_COLORS);
  });

  it('resolves strings: locale override, then English override, then catalogue default', () => {
    const strings = resolvePortalStrings(
      { en: { welcome_title: 'Hi', login_button: 'Go' }, ar: { welcome_title: 'مرحبا', bogus: 1 } },
      'ar',
    );
    expect(strings.welcome_title).toBe('مرحبا');
    expect(strings.login_button).toBe('Go');
    expect(strings.success_text).toBe(DEFAULT_PORTAL_STRINGS.success_text);
    expect(strings).not.toHaveProperty('bogus');
  });

  it('derives the text direction from the language subtag', () => {
    expect(localeDirection('ar-AE')).toBe('rtl');
    expect(localeDirection('he')).toBe('rtl');
    expect(localeDirection('en')).toBe('ltr');
    expect(localeDirection('fr-CA')).toBe('ltr');
  });
});
