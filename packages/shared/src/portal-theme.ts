/**
 * Captive-portal theme tokens and the page-preview contract (Phase 6 P6-B).
 *
 * Shared by the API (validation, preview rendering), the admin designer (form, contrast hints)
 * and the portal service (rendering). Browser-safe: no Node imports, so the admin app imports
 * it through the `@ecloud/shared/portal-theme` subpath without pulling in config/logger code.
 *
 * Persistence (migration 006): `portal_themes.colors` holds `PortalColors`,
 * `portal_themes.strings` holds `{ [locale]: PortalStrings }`, `portal_themes.logo_asset_ref`
 * holds a `portal_assets.id` (served on the portal origin at `/a/{assetId}`).
 */

/** Colour tokens, injected as CSS custom properties (`--p-<token>`) by the renderer. */
export const PORTAL_COLOR_TOKENS = [
  'brand',
  'brand_text',
  'background',
  'surface',
  'text',
  'muted',
  'error',
] as const;
export type PortalColorToken = (typeof PORTAL_COLOR_TOKENS)[number];
export type PortalColors = Record<PortalColorToken, string>;

export const DEFAULT_PORTAL_COLORS: Readonly<PortalColors> = Object.freeze({
  brand: '#0b6bcb',
  brand_text: '#ffffff',
  background: '#f4f6f8',
  surface: '#ffffff',
  text: '#1d2733',
  muted: '#55606e',
  error: '#b42318',
});

/** `#rrggbb` only: no names, no `url()`, nothing that can escape a CSS declaration. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Per-locale texts an operator may override. Missing keys fall back to the message catalogue. */
export const PORTAL_STRING_KEYS = [
  'welcome_title',
  'welcome_text',
  'login_button',
  'voucher_button',
  'click_through_button',
  'success_text',
  'error_text',
  'expired_text',
  'footer_text',
] as const;
export type PortalStringKey = (typeof PORTAL_STRING_KEYS)[number];
export type PortalStrings = Partial<Record<PortalStringKey, string>>;
export const PORTAL_STRING_MAX_LENGTH = 1000;

/** English defaults (Q77: English first; RTL-ready layout). */
export const DEFAULT_PORTAL_STRINGS: Readonly<Record<PortalStringKey, string>> = Object.freeze({
  welcome_title: 'Welcome',
  welcome_text: 'Sign in to get online.',
  login_button: 'Sign in',
  voucher_button: 'Use voucher',
  click_through_button: 'Accept and connect',
  success_text: 'You are connected.',
  error_text: 'Sign-in failed. Please try again.',
  expired_text: 'Your session has expired. Please sign in again.',
  footer_text: '',
});

/** Login methods an administrator can toggle on a portal (social/IdP: Q64, not in the pilot). */
export const PORTAL_LOGIN_METHODS = ['password', 'voucher', 'click_through'] as const;
export type PortalLoginMethod = (typeof PORTAL_LOGIN_METHODS)[number];

/** Locales whose script is right-to-left (layout uses logical CSS properties, `dir` on <html>). */
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'dv', 'yi']);

export function localeDirection(locale: string): 'ltr' | 'rtl' {
  const language = locale.toLowerCase().split('-', 1)[0] ?? '';
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

/** WCAG 2.x relative luminance of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  if (!HEX_COLOR_RE.test(hex)) throw new RangeError('expected #rrggbb');
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio (1 … 21) between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text/background pairs that must reach WCAG 2.2 AA (4.5:1) — ADMIN_UI_ARCHITECTURE.md §4. */
export const PORTAL_CONTRAST_PAIRS: readonly (readonly [PortalColorToken, PortalColorToken])[] = [
  ['text', 'background'],
  ['text', 'surface'],
  ['muted', 'surface'],
  ['brand_text', 'brand'],
  ['error', 'surface'],
];
export const MIN_CONTRAST_RATIO = 4.5;

export interface ContrastIssue {
  foreground: PortalColorToken;
  background: PortalColorToken;
  ratio: number;
}

/** Pairs below 4.5:1 (empty when the palette is acceptable). */
export function contrastIssues(colors: PortalColors): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const [fg, bg] of PORTAL_CONTRAST_PAIRS) {
    const ratio = contrastRatio(colors[fg], colors[bg]);
    if (ratio < MIN_CONTRAST_RATIO) {
      issues.push({ foreground: fg, background: bg, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return issues;
}

/** Fills missing tokens with the defaults (stored themes may predate a token). */
export function resolvePortalColors(
  stored: Record<string, unknown> | null | undefined,
): PortalColors {
  const out = { ...DEFAULT_PORTAL_COLORS };
  for (const token of PORTAL_COLOR_TOKENS) {
    const value = stored?.[token];
    if (typeof value === 'string' && HEX_COLOR_RE.test(value)) out[token] = value.toLowerCase();
  }
  return out;
}

/** Texts for `locale`: stored overrides for that locale, then English overrides, then defaults. */
export function resolvePortalStrings(
  stored: Record<string, unknown> | null | undefined,
  locale: string,
): Record<PortalStringKey, string> {
  const out: Record<PortalStringKey, string> = { ...DEFAULT_PORTAL_STRINGS };
  for (const source of [stored?.en, stored?.[locale]]) {
    if (source === null || typeof source !== 'object') continue;
    for (const key of PORTAL_STRING_KEYS) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === 'string') out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Page-preview contract (P6-B ↔ P6-A)
// ---------------------------------------------------------------------------------------------

/** Pages the designer can preview (the portal pages of P6-A, AC 1). */
export const PORTAL_PREVIEW_PAGES = [
  'landing',
  'login',
  'voucher',
  'terms',
  'success',
  'error',
  'expired',
  'status',
] as const;
export type PortalPreviewPage = (typeof PORTAL_PREVIEW_PAGES)[number];

/** Resolved theme handed to the renderer: everything already validated and defaulted. */
export interface PortalPreviewTheme {
  colors: PortalColors;
  strings: Record<PortalStringKey, string>;
  /**
   * Logo source. For previews this is a `data:image/(png|jpeg|webp);base64,…` URI (the preview is
   * framed by the admin origin and must not fetch from the portal origin); live pages use
   * `/a/{assetId}` on the portal origin. `null` = no logo.
   */
  logoSrc: string | null;
  locale: string;
  dir: 'ltr' | 'rtl';
}

/** Sample data for the preview (never real subscriber data). */
export interface PortalPreviewSample {
  portalName: string;
  siteName: string;
  loginMethods: readonly PortalLoginMethod[];
  termsText: string | null;
  termsVersion: string | null;
}

/**
 * The stable preview interface. P6-A's portal templates are expected to export a function of
 * this type as `renderPreview` (from `@ecloud/portal`); the API calls it through
 * `apps/api/src/portal-admin/preview.ts`. Requirements on the returned document:
 *  - complete HTML5 document, **self-contained** (inline CSS only, no external URLs, no script):
 *    it is served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
 *    img-src data:; sandbox` and framed by the admin app;
 *  - every operator-supplied string HTML-escaped;
 *  - forms must not be functional (no `action` to a NAS; the sandbox blocks submission anyway).
 */
export type RenderPortalPreview = (
  theme: PortalPreviewTheme,
  page: PortalPreviewPage,
  sample: PortalPreviewSample,
) => string;
