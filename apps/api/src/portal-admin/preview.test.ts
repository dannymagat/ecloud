import {
  DEFAULT_PORTAL_COLORS,
  PORTAL_PREVIEW_PAGES,
  resolvePortalStrings,
  type PortalPreviewSample,
  type PortalPreviewTheme,
} from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { PREVIEW_HEADERS, renderPortalPreview } from './preview.js';

const PNG_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function theme(overrides: Partial<PortalPreviewTheme> = {}): PortalPreviewTheme {
  return {
    colors: { ...DEFAULT_PORTAL_COLORS },
    strings: resolvePortalStrings({ en: { welcome_title: '<script>alert(1)</script>' } }, 'en'),
    logoSrc: PNG_URI,
    locale: 'en',
    dir: 'ltr',
    ...overrides,
  };
}

const sample: PortalPreviewSample = {
  portalName: 'Lobby "Wi-Fi"',
  siteName: 'HQ <main>',
  loginMethods: ['password', 'voucher', 'click_through'],
  termsText: 'Terms & <b>conditions</b>',
  termsVersion: '3',
};

/**
 * Contract checks on the portal renderer as the API uses it (`RenderPortalPreview` in
 * @ecloud/shared/portal-theme): the preview is served under PREVIEW_HEADERS, so it must be
 * self-contained, script-free and escape every operator string.
 */
describe('portal page preview (P6-A templates through the P6-B contract)', () => {
  it.each(PORTAL_PREVIEW_PAGES)('renders %s self-contained, escaped and under 50 KB', (page) => {
    const html = renderPortalPreview(theme(), page, sample);
    expect(html.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(Buffer.byteLength(html)).toBeLessThan(50 * 1024);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/(src|href|action)="(https?:)?\/\//i);
    expect(html).not.toMatch(/\ssrc="\//);
    expect(html).not.toContain('<b>conditions</b>');
    expect(html).not.toContain('HQ <main>');
  });

  it('sets lang/dir for RTL locales and drops non-data logo sources', () => {
    const rtl = renderPortalPreview(theme({ locale: 'ar', dir: 'rtl' }), 'login', sample);
    expect(rtl).toMatch(/<html[^>]*\bdir="rtl"/);
    expect(rtl).toMatch(/<html[^>]*\blang="ar"/);
    const remote = renderPortalPreview(
      theme({ logoSrc: 'https://evil.test/x.png' }),
      'login',
      sample,
    );
    expect(remote).not.toContain('evil.test');
    expect(renderPortalPreview(theme(), 'login', sample)).toContain(PNG_URI);
  });

  it('never lets a colour value break out of the style block', () => {
    const html = renderPortalPreview(
      theme({ colors: { ...DEFAULT_PORTAL_COLORS, brand: 'red;}</style><script>' } }),
      'login',
      sample,
    );
    expect(html).not.toContain('</style><script>');
  });

  it('serves previews under a no-script sandbox CSP', () => {
    expect(PREVIEW_HEADERS['Content-Security-Policy']).toMatch(/default-src 'none'/);
    expect(PREVIEW_HEADERS['Content-Security-Policy']).toMatch(/\bsandbox\b/);
    expect(PREVIEW_HEADERS['Content-Security-Policy']).not.toMatch(/script-src/);
    expect(PREVIEW_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });
});
