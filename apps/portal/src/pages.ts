/**
 * Server-rendered portal pages (ADMIN_UI_ARCHITECTURE.md §4): plain HTML forms, no script, no
 * third-party assets, every dynamic value HTML-escaped. One template set serves both the live
 * portal (stylesheet from the portal origin + a nonce'd `<style>` with the theme tokens) and the
 * admin designer preview (`renderPreview`, fully inline, forms without an action, P6-B contract
 * in `@ecloud/shared` `RenderPortalPreview`).
 */
import {
  DEFAULT_PORTAL_COLORS,
  DEFAULT_PORTAL_STRINGS,
  HEX_COLOR_RE,
  localeDirection,
  type PortalColors,
  type PortalPreviewPage,
  type PortalPreviewSample,
  type PortalPreviewTheme,
  type PortalStringKey,
  type RenderPortalPreview,
} from '@ecloud/shared';
import { DEFAULT_LOCALE, t, type MessageKey } from './i18n.js';
import { PORTAL_CSS, PORTAL_CSS_PATH } from './styles.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PageTheme {
  readonly colors: PortalColors;
  readonly strings: Readonly<Record<PortalStringKey, string>>;
  /** `/a/{assetId}` (live) or a `data:` URI (preview); null = no logo. */
  readonly logoSrc: string | null;
  readonly locale: string;
  readonly dir: 'ltr' | 'rtl';
}

export const DEFAULT_THEME: PageTheme = Object.freeze({
  colors: DEFAULT_PORTAL_COLORS,
  strings: DEFAULT_PORTAL_STRINGS,
  logoSrc: null,
  locale: DEFAULT_LOCALE,
  dir: localeDirection(DEFAULT_LOCALE),
});

export interface Branding {
  readonly portalName: string;
  readonly siteName: string;
}

export type PortalMethod = 'password' | 'voucher' | 'click_through';

/** A form target; `null` renders a non-functional form (preview). */
export interface FormTarget {
  readonly action: string;
  readonly csrf: string;
}

export interface SessionStatus {
  readonly startedAt: Date;
  readonly bytes: bigint;
  readonly durationS: number;
}

export type PageBody =
  | {
      readonly page: 'landing';
      readonly methods: readonly { readonly method: PortalMethod; readonly href: string | null }[];
      readonly notice: 'session_expired' | null;
    }
  | {
      readonly page: 'login';
      readonly form: FormTarget | null;
      readonly error: string | null;
      readonly username: string;
      readonly backHref: string | null;
    }
  | {
      readonly page: 'voucher';
      readonly form: FormTarget | null;
      readonly error: string | null;
      readonly backHref: string | null;
    }
  | {
      readonly page: 'terms';
      readonly form: FormTarget | null;
      readonly error: string | null;
      readonly termsText: string | null;
      readonly termsVersion: string | null;
      readonly backHref: string | null;
    }
  | {
      readonly page: 'success';
      readonly continueUrl: string | null;
      readonly statusHref: string | null;
    }
  | { readonly page: 'error'; readonly message: string; readonly retryHref: string | null }
  | { readonly page: 'expired' }
  | {
      readonly page: 'status';
      readonly session: SessionStatus | null;
      readonly logout: FormTarget | null;
    }
  | { readonly page: 'logout' }
  | {
      /**
       * Cycle B (MikroTik): POST hand-off to the router's `$(link-login-only)`. A plain form the
       * user submits (no script, ADMIN_UI §4); the router origin is in the CSP form-action.
       */
      readonly page: 'handoff';
      readonly action: string;
      readonly fields: Readonly<Record<string, string>>;
    };

export type PageName = PageBody['page'];

export type StyleMode =
  { readonly mode: 'link'; readonly nonce: string } | { readonly mode: 'inline' };

function cssVariables(colors: PortalColors): string {
  // Colours are validated `#rrggbb`; re-checked so nothing can escape the declaration.
  return Object.entries(colors)
    .filter(([, value]) => HEX_COLOR_RE.test(value))
    .map(([token, value]) => `--p-${token.replace(/_/g, '-')}:${value}`)
    .join(';');
}

const TITLE_KEYS: Readonly<Record<PageName, MessageKey>> = {
  landing: 'title.landing',
  login: 'title.login',
  voucher: 'title.voucher',
  terms: 'title.terms',
  success: 'title.success',
  error: 'title.error',
  expired: 'title.expired',
  status: 'title.status',
  logout: 'title.logout',
  handoff: 'title.handoff',
};

function errorLine(message: string | null): string {
  // role=alert: announced by screen readers (ADMIN_UI_ARCHITECTURE §4 accessibility).
  return message === null ? '' : `<p class="error" role="alert">${escapeHtml(message)}</p>`;
}

function formOpen(form: FormTarget | null): string {
  if (form === null) return '<form>';
  return `<form method="post" action="${escapeHtml(form.action)}"><input type="hidden" name="csrf" value="${escapeHtml(form.csrf)}">`;
}

function back(href: string | null, locale: string): string {
  return href === null
    ? ''
    : `<p class="links"><a href="${escapeHtml(href)}">${escapeHtml(t('form.back', {}, locale))}</a></p>`;
}

function formatBytes(bytes: bigint): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${String(h)} h ${String(m)} min` : `${String(m)} min`;
}

function body(theme: PageTheme, b: PageBody): string {
  const s = theme.strings;
  const l = theme.locale;
  switch (b.page) {
    case 'landing': {
      const notice =
        b.notice === 'session_expired'
          ? `<p class="notice" role="status">${escapeHtml(s.expired_text)}</p>`
          : '';
      const items = b.methods
        .map(
          (m) =>
            `<li><a class="button" ${m.href === null ? '' : `href="${escapeHtml(m.href)}"`}>${escapeHtml(
              m.method === 'password'
                ? s.login_button
                : m.method === 'voucher'
                  ? s.voucher_button
                  : s.click_through_button,
            )}</a></li>`,
        )
        .join('');
      const list =
        b.methods.length === 0
          ? `<p>${escapeHtml(t('landing.none', {}, l))}</p>`
          : `<p class="muted">${escapeHtml(t('landing.choose', {}, l))}</p><ul class="methods">${items}</ul>`;
      return `${notice}<p>${escapeHtml(s.welcome_text)}</p>${list}`;
    }
    case 'login':
      return `${errorLine(b.error)}${formOpen(b.form)}<label for="username">${escapeHtml(t('form.username', {}, l))}</label><input type="text" id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="253" value="${escapeHtml(b.username)}"><label for="password">${escapeHtml(t('form.password', {}, l))}</label><input type="password" id="password" name="password" autocomplete="current-password" required maxlength="256"><button type="submit">${escapeHtml(s.login_button)}</button></form>${back(b.backHref, l)}`;
    case 'voucher':
      return `${errorLine(b.error)}${formOpen(b.form)}<label for="code">${escapeHtml(t('form.voucher', {}, l))}</label><input type="text" id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required maxlength="64" inputmode="text"><button type="submit">${escapeHtml(s.voucher_button)}</button></form>${back(b.backHref, l)}`;
    case 'terms': {
      const version =
        b.termsVersion === null
          ? ''
          : `<p class="muted">${escapeHtml(t('terms.version', { version: b.termsVersion }, l))}</p>`;
      const text = b.termsText ?? t('terms.none', {}, l);
      return `${errorLine(b.error)}<div class="terms" tabindex="0">${escapeHtml(text)}</div>${version}${formOpen(b.form)}<label class="check" for="accept"><input type="checkbox" id="accept" name="accept_terms" value="yes" required> ${escapeHtml(t('form.accept_terms', {}, l))}</label><button type="submit">${escapeHtml(s.click_through_button)}</button></form>${back(b.backHref, l)}`;
    }
    case 'success': {
      const cont =
        b.continueUrl === null
          ? ''
          : `<a class="button" href="${escapeHtml(b.continueUrl)}" rel="noreferrer">${escapeHtml(t('success.continue', {}, l))}</a>`;
      const status =
        b.statusHref === null
          ? ''
          : `<p class="links"><a href="${escapeHtml(b.statusHref)}">${escapeHtml(t('success.status', {}, l))}</a></p>`;
      return `<p role="status">${escapeHtml(s.success_text)}</p>${cont}${status}`;
    }
    case 'error': {
      const retry =
        b.retryHref === null
          ? ''
          : `<a class="button" href="${escapeHtml(b.retryHref)}">${escapeHtml(t('error.retry', {}, l))}</a>`;
      return `<p class="error" role="alert">${escapeHtml(b.message)}</p>${retry}`;
    }
    case 'expired':
      return `<p role="status">${escapeHtml(t('expired.flow', {}, l))}</p>`;
    case 'status': {
      const details =
        b.session === null
          ? `<p class="muted">${escapeHtml(t('status.unknown', {}, l))}</p>`
          : `<dl><dt>${escapeHtml(t('status.connected_since', {}, l))}</dt><dd><time datetime="${escapeHtml(b.session.startedAt.toISOString())}">${escapeHtml(b.session.startedAt.toISOString().replace('T', ' ').slice(0, 16))} UTC</time></dd><dt>${escapeHtml(t('status.duration', {}, l))}</dt><dd>${escapeHtml(formatDuration(b.session.durationS))}</dd><dt>${escapeHtml(t('status.data_used', {}, l))}</dt><dd>${escapeHtml(formatBytes(b.session.bytes))}</dd></dl>`;
      return `<p role="status">${escapeHtml(s.success_text)}</p>${details}${formOpen(b.logout)}<button type="submit">${escapeHtml(t('status.logout', {}, l))}</button></form>`;
    }
    case 'logout':
      return `<p role="status">${escapeHtml(t('logout.text', {}, l))}</p>`;
    case 'handoff': {
      const hidden = Object.entries(b.fields)
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
        )
        .join('');
      return `<p role="status">${escapeHtml(t('handoff.text', {}, l))}</p><form method="post" action="${escapeHtml(b.action)}">${hidden}<button type="submit">${escapeHtml(t('handoff.submit', {}, l))}</button></form>`;
    }
  }
}

/** Complete HTML5 document for one page. */
export function renderPage(
  theme: PageTheme,
  branding: Branding | null,
  page: PageBody,
  style: StyleMode,
): string {
  const l = theme.locale;
  const heading =
    page.page === 'landing' ? theme.strings.welcome_title : t(TITLE_KEYS[page.page], {}, l);
  const vars = `:root{${cssVariables(theme.colors)}}`;
  const head =
    style.mode === 'link'
      ? `<link rel="stylesheet" href="${PORTAL_CSS_PATH}"><style nonce="${escapeHtml(style.nonce)}">${vars}</style>`
      : `<style>${PORTAL_CSS}${vars}</style>`;
  const logo =
    theme.logoSrc === null
      ? ''
      : `<img class="logo" src="${escapeHtml(theme.logoSrc)}" alt="${escapeHtml(branding?.portalName ?? '')}">`;
  const site =
    branding === null || branding.siteName === ''
      ? ''
      : `<p class="site">${escapeHtml(branding.siteName)}</p>`;
  const footer =
    theme.strings.footer_text === ''
      ? ''
      : `<footer class="muted">${escapeHtml(theme.strings.footer_text)}</footer>`;
  return `<!doctype html><html lang="${escapeHtml(l)}" dir="${theme.dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(heading)}</title>${head}</head><body><a class="skip" href="#main">${escapeHtml(t('skip.main', {}, l))}</a><main id="main"><div class="card">${logo}<h1>${escapeHtml(heading)}</h1>${site}${body(theme, page)}</div>${footer}</main></body></html>`;
}

const DATA_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

function sampleBody(page: PortalPreviewPage, sample: PortalPreviewSample): PageBody {
  switch (page) {
    case 'landing':
      return {
        page: 'landing',
        methods: sample.loginMethods.map((method) => ({ method, href: null })),
        notice: null,
      };
    case 'login':
      return { page: 'login', form: null, error: null, username: '', backHref: null };
    case 'voucher':
      return { page: 'voucher', form: null, error: null, backHref: null };
    case 'terms':
      return {
        page: 'terms',
        form: null,
        error: null,
        termsText: sample.termsText,
        termsVersion: sample.termsVersion,
        backHref: null,
      };
    case 'success':
      return { page: 'success', continueUrl: null, statusHref: null };
    case 'error':
      return { page: 'error', message: t('error.generic'), retryHref: null };
    case 'expired':
      return { page: 'expired' };
    case 'status':
      return {
        page: 'status',
        session: {
          startedAt: new Date('2026-01-01T08:00:00Z'),
          bytes: 157_286_400n,
          durationS: 2_700,
        },
        logout: null,
      };
  }
}

/**
 * Designer preview (P6-B contract): self-contained document (inline CSS, no script, no external
 * URL, no form action); the logo only as a `data:image/(png|jpeg|webp)` URI.
 */
export const renderPreview: RenderPortalPreview = (theme, page, sample) => {
  const pageTheme: PageTheme = {
    colors: theme.colors,
    strings: theme.strings,
    logoSrc: theme.logoSrc !== null && DATA_IMAGE_RE.test(theme.logoSrc) ? theme.logoSrc : null,
    locale: theme.locale,
    dir: theme.dir,
  };
  return renderPage(
    pageTheme,
    { portalName: sample.portalName, siteName: sample.siteName },
    sampleBody(page, sample),
    { mode: 'inline' },
  );
};

export type { PortalPreviewTheme };
