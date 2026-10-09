import {
  DEFAULT_PORTAL_COLORS,
  DEFAULT_PORTAL_STRINGS,
  PORTAL_PREVIEW_PAGES,
  loadConfig,
  type PortalPreviewSample,
  type PortalPreviewTheme,
} from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { PORTAL_DEV_DEFAULTS, loadPortalConfig } from './config.js';
import { MESSAGE_KEYS, t } from './i18n.js';
import { DEFAULT_THEME, renderPage, renderPreview } from './pages.js';
import {
  csrfToken,
  newNonce,
  readCookie,
  signFlowToken,
  verifyCsrf,
  verifyFlowToken,
} from './state.js';

const SECRET = 'unit-test-state-secret-0123456789';
const FLOW = '01900000-0000-7000-8000-0000000000f1';

describe('flow token + CSRF (signed short-lived state)', () => {
  const now = new Date('2026-10-08T06:00:00Z');
  const exp = new Date(now.getTime() + 60_000);

  it('round-trips and rejects tampering, foreign keys, expiry and malformed tokens', () => {
    const token = signFlowToken(SECRET, FLOW, exp);
    expect(verifyFlowToken(SECRET, token, now)).toBe(FLOW);
    expect(verifyFlowToken(SECRET, token, new Date(exp.getTime() + 1))).toBeNull();
    expect(verifyFlowToken('other-secret-0123456789', token, now)).toBeNull();
    const [id, e, sig] = token.split('.') as [string, string, string];
    expect(verifyFlowToken(SECRET, `${id}.${String(Number(e) + 600)}.${sig}`, now)).toBeNull();
    expect(verifyFlowToken(SECRET, `${id.replace('f1', 'f2')}.${e}.${sig}`, now)).toBeNull();
    expect(verifyFlowToken(SECRET, `${token}.x`, now)).toBeNull();
    expect(verifyFlowToken(SECRET, 'garbage', now)).toBeNull();
  });

  it('CSRF token is bound to flow and cookie nonce', () => {
    const nonce = newNonce();
    const token = csrfToken(SECRET, FLOW, nonce);
    expect(verifyCsrf(SECRET, FLOW, nonce, token)).toBe(true);
    expect(verifyCsrf(SECRET, FLOW, newNonce(), token)).toBe(false);
    expect(verifyCsrf(SECRET, FLOW.replace('f1', 'f2'), nonce, token)).toBe(false);
    expect(verifyCsrf(SECRET, FLOW, undefined, token)).toBe(false);
    expect(verifyCsrf(SECRET, FLOW, nonce, undefined)).toBe(false);
    expect(verifyCsrf(SECRET, FLOW, 'short', token)).toBe(false);
  });

  it('reads one cookie out of a header', () => {
    expect(readCookie('a=1; pf=xyz; b=2', 'pf')).toBe('xyz');
    expect(readCookie('a=1', 'pf')).toBeUndefined();
    expect(readCookie(undefined, 'pf')).toBeUndefined();
  });
});

describe('portal config', () => {
  it('uses dev defaults outside production and refuses them in production', () => {
    const dev = loadPortalConfig({ NODE_ENV: 'test' });
    expect(dev.stateSecret).toBe(PORTAL_DEV_DEFAULTS.PORTAL_STATE_SECRET);
    expect(dev.internalApiUrl).toBe('http://127.0.0.1:3001');
    expect(dev.secureCookies).toBe(false);
    const prodEnv = {
      NODE_ENV: 'production',
      INTERNAL_API_TOKEN: 'p'.repeat(40),
      DATABASE_URL: 'postgres://u:p@db:5432/x',
      DATABASE_URL_PLATFORM: 'postgres://u2:p2@db:5432/x',
      REDIS_URL: 'redis://redis:6379',
      PUBLIC_ADMIN_ORIGIN: 'https://ezecloud.ezelink.ai',
      PUBLIC_API_ORIGIN: 'https://api.ezecloud.ezelink.ai',
      PUBLIC_PORTAL_ORIGIN: 'https://portal.ezecloud.ezelink.ai',
    };
    let base;
    try {
      base = loadConfig(prodEnv);
    } catch {
      // Other production rules of @ecloud/shared are not under test here.
      base = { ...loadConfig({ NODE_ENV: 'test' }), isProduction: true };
    }
    expect(() => loadPortalConfig(prodEnv, base)).toThrow(/PORTAL_STATE_SECRET/);
    expect(() =>
      loadPortalConfig(
        { ...prodEnv, PORTAL_STATE_SECRET: 's'.repeat(40), PORTAL_COOKIE_SECURE: 'false' },
        base,
      ),
    ).toThrow(/PORTAL_COOKIE_SECURE/);
    const ok = loadPortalConfig({ ...prodEnv, PORTAL_STATE_SECRET: 's'.repeat(40) }, base);
    expect(ok.secureCookies).toBe(true);
  });
});

describe('message catalogue + RTL readiness', () => {
  it('fills placeholders and has a non-empty English text for every key', () => {
    for (const key of MESSAGE_KEYS) expect(t(key).length).toBeGreaterThan(0);
    expect(t('form.rate_limited', { minutes: 5 })).toContain('5 minute(s)');
    expect(t('terms.version', {})).toContain('{version}');
  });

  it('renders dir="rtl" for an RTL locale without a second stylesheet', () => {
    const html = renderPage(
      { ...DEFAULT_THEME, locale: 'ar', dir: 'rtl' },
      null,
      { page: 'expired' },
      { mode: 'inline' },
    );
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });
});

describe('renderPreview (P6-B designer contract)', () => {
  const theme: PortalPreviewTheme = {
    colors: { ...DEFAULT_PORTAL_COLORS, brand: '#123456' },
    strings: { ...DEFAULT_PORTAL_STRINGS, welcome_title: 'Hi <there>' },
    logoSrc: 'data:image/png;base64,iVBORw0KGgo=',
    locale: 'en',
    dir: 'ltr',
  };
  const sample: PortalPreviewSample = {
    portalName: 'Lobby',
    siteName: 'Site & Co',
    loginMethods: ['password', 'voucher', 'click_through'],
    termsText: 'Terms <b>bold</b>',
    termsVersion: '2',
  };

  it.each(PORTAL_PREVIEW_PAGES)('%s: self-contained, no script, no URL, no form action', (page) => {
    const html = renderPreview(theme, page, sample);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script|<link|action=|https?:\/\/|src="\/|href="\//);
    expect(html).toContain('--p-brand:#123456');
    expect(html).toContain('<style>');
    expect(html).toContain('Site &amp; Co');
    expect(Buffer.byteLength(html)).toBeLessThan(50 * 1024);
  });

  it('escapes operator text and drops a non-data logo', () => {
    const landing = renderPreview(theme, 'landing', sample);
    expect(landing).toContain('Hi &lt;there&gt;');
    expect(landing).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(renderPreview(theme, 'terms', sample)).toContain('Terms &lt;b&gt;bold&lt;/b&gt;');
    const remote = renderPreview(
      { ...theme, logoSrc: 'https://evil.example/x.png' },
      'login',
      sample,
    );
    expect(remote).not.toContain('evil.example');
  });
});
