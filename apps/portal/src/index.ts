/**
 * ECLOUD captive portal (`portal.ezecloud.ezelink.ai`, D-029). Server-rendered pages only; all
 * decisions are made by the api over `/internal/portal/*` (the portal has no DB credentials and
 * never sees a UAM secret or a subscriber password at rest).
 *
 * Public routes (API_ARCHITECTURE.md "Portal public"):
 *   GET  /uam/uspot/ | /uam/chilli/   UAM entry + `res=` callbacks → 303 /f/{token} or a page
 *   GET  /hotspot/mikrotik/            MikroTik RouterOS login.html entry (Cycle B) → 303 /f/{token}
 *   GET  /pb/{profile}[/{nasid}]/      Cycle C post-back entry (Cambium, Aruba, Cisco, …) → 303
 *                                      /f/{token}; the hand-off is an auto-submitted form to the
 *                                      validated AP / controller login URL
 *   GET  /f/{token}                    landing (enabled methods)
 *   GET  /f/{token}/login|voucher|terms
 *   POST /f/{token}/login|voucher|click → 302 to http://uamip:uamport/logon (adapter hand-off), or
 *                                       (MikroTik) a form POSTing to the router's link-login-only
 *   GET  /f/{token}/status, POST /f/{token}/logout → 302 to http://uamip:uamport/logoff
 *   GET  /a/{assetId}                  branding asset (nosniff; ETag/304 + Cache-Control from the API)
 *   GET  /static/portal.<hash>.css, GET /healthz
 */
import {
  createLogger,
  localeDirection,
  resolvePortalColors,
  resolvePortalStrings,
  type Logger,
} from '@ecloud/shared';
import express, { type Express, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { HttpPortalApi, type FlowView, type IdentifyInput, type PortalApi } from './api-client.js';
import { loadPortalConfig, type PortalConfig } from './config.js';
import { DEFAULT_LOCALE, t } from './i18n.js';
import {
  createMetricsServer,
  createPortalMetrics,
  portalHttpMetrics,
  type PortalMetrics,
} from './metrics.js';
import {
  DEFAULT_THEME,
  renderPage,
  type Branding,
  type PageBody,
  type PageTheme,
  type PortalMethod,
} from './pages.js';
import {
  cookieName,
  csrfToken,
  isNonce,
  newNonce,
  readCookie,
  serializeCookie,
  signFlowToken,
  verifyCsrf,
  verifyFlowToken,
} from './state.js';
import { PORTAL_CSS, PORTAL_CSS_PATH } from './styles.js';

export const PACKAGE_NAME = '@ecloud/portal';

export { renderPreview, renderPage, escapeHtml } from './pages.js';
export { loadPortalConfig, type PortalConfig } from './config.js';
export { HttpPortalApi, type PortalApi } from './api-client.js';
export { signFlowToken, verifyFlowToken } from './state.js';
export { createPortalMetrics, createMetricsServer, type PortalMetrics } from './metrics.js';

/** Default time in-flight requests get to finish on shutdown before connections are cut. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** NAS origin from the API: `http(s)://<IPv4>:<port>` (https only for MikroTik login-by=https). */
const NAS_ORIGIN_RE = /^https?:\/\/(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
const MIKROTIK_LOGIN_PATH_RE = /^(?:\/[A-Za-z0-9_-]{1,32})?\/login$/;
/** Cycle C: validated post-back login origin (`scheme://host[:port]`, host lower-case). */
const LOGIN_ORIGIN_RE = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;
const PROFILE_SEGMENT_RE = /^[a-z][a-z0-9-]{1,39}$/;
const NASID_SEGMENT_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Open-redirect guard for post-back hand-offs: the URL must be http(s), carry no credentials and
 * have exactly the login origin the API validated for this flow (the AP / controller).
 */
export function isPostbackHandoff(url: string, loginOrigin: string | null): boolean {
  if (loginOrigin === null || !LOGIN_ORIGIN_RE.test(loginOrigin)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === '' &&
    parsed.origin === loginOrigin
  );
}

/**
 * Open-redirect guard: a NAS hand-off is followed only when it targets this flow's own
 * `http://uamip:uamport` (validated by the API) and exactly the expected path.
 */
/**
 * Cycle D review F6: the requested page becomes the primary "Continue" only when the tenant
 * configured / allow-listed its host; otherwise the tenant's landing page (if any) is primary
 * and the requested page is a secondary link with its host visible.
 */
export function vendorSuccessBody(o: {
  continueUrl: string | null;
  continueHost: string | null;
  trusted: boolean;
  landingUrl: string | null;
}): {
  page: 'success';
  continueUrl: string | null;
  statusHref: null;
  continueHost: string | null;
  unlisted: { url: string; host: string } | null;
} {
  const hostOf = (u: string): string | null => {
    try {
      return new URL(u).hostname;
    } catch {
      return null;
    }
  };
  if (o.trusted && o.continueUrl !== null) {
    return {
      page: 'success',
      continueUrl: o.continueUrl,
      statusHref: null,
      continueHost: o.continueHost,
      unlisted: null,
    };
  }
  const unlisted =
    o.continueUrl !== null && o.continueHost !== null
      ? { url: o.continueUrl, host: o.continueHost }
      : null;
  return {
    page: 'success',
    continueUrl: o.landingUrl,
    statusHref: null,
    continueHost: o.landingUrl === null ? null : hostOf(o.landingUrl),
    unlisted,
  };
}

/** Cycle D: a Mist grant may only go to https://portal[.<region>].mist.com/authorize. */
export function isMistGrantUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      u.username === '' &&
      u.password === '' &&
      u.port === '' &&
      /^portal\.(?:[a-z0-9-]{1,32}\.)?mist\.com$/.test(u.hostname) &&
      u.pathname === '/authorize'
    );
  } catch {
    return false;
  }
}

export function isNasHandoff(
  url: string,
  nasOrigin: string | null,
  path: '/logon' | '/logoff' | '/logout',
): boolean {
  if (nasOrigin === null || !NAS_ORIGIN_RE.test(nasOrigin)) return false;
  const base = `${nasOrigin}${path}`;
  return url === base || url.startsWith(`${base}?`);
}

/**
 * Cycle B open-redirect guard for a MikroTik POST hand-off: exactly this flow's router origin
 * and a `/login` path (optionally under one language directory), no query or fragment.
 */
export function isMikrotikLoginHandoff(url: string, nasOrigin: string | null): boolean {
  if (nasOrigin === null || !NAS_ORIGIN_RE.test(nasOrigin)) return false;
  if (!url.startsWith(`${nasOrigin}/`)) return false;
  const path = url.slice(nasOrigin.length);
  return MIKROTIK_LOGIN_PATH_RE.test(path);
}

export interface ServerOptions {
  config?: PortalConfig;
  logger?: Logger;
  /** Backend client (default: HTTP to the api internal listener). */
  api?: PortalApi;
  /** Clock (tests may freeze it). */
  now?: () => Date;
  /** Prometheus metrics (Phase 10); recorded only when given. */
  metrics?: PortalMetrics;
}

interface Rendered {
  status: number;
  theme: PageTheme;
  branding: Branding | null;
  body: PageBody;
  /** `http://uamip:uamport` allowed as form-action (SECURITY_ARCHITECTURE.md §5.8). */
  nasOrigin?: string | null;
  /** Cycle C: validated post-back login origin, allowed as form-action. */
  loginOrigin?: string | null;
}

function themeOf(view: FlowView | null): PageTheme {
  if (view === null || view.theme === null) return DEFAULT_THEME;
  const locale = DEFAULT_LOCALE;
  return {
    colors: resolvePortalColors(view.theme.colors),
    strings: resolvePortalStrings(view.theme.strings, locale),
    logoSrc: view.theme.logoAssetId === null ? null : `/a/${view.theme.logoAssetId}`,
    locale,
    dir: localeDirection(locale),
  };
}

function brandingOf(view: FlowView | null): Branding | null {
  return view === null ? null : { portalName: view.portal.name, siteName: view.portal.siteName };
}

/** Builds the captive portal Express 5 application. */
export function createServer(options: ServerOptions = {}): Express {
  const config = options.config ?? loadPortalConfig();
  const logger = options.logger ?? createLogger({ name: 'portal', level: config.base.logLevel });
  const api =
    options.api ??
    new HttpPortalApi(config.internalApiUrl, config.base.internalApiToken, config.apiTimeoutMs);
  const now = options.now ?? (() => new Date());
  const secret = config.stateSecret;
  const cookie = cookieName(config.secureCookies);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  const metrics = options.metrics;
  if (metrics !== undefined) app.use(portalHttpMetrics(metrics));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.secureCookies) {
      // HSTS only means something over HTTPS (production behind Caddy, SECURITY §5.1).
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    next();
  });

  function send(res: Response, page: Rendered): void {
    const nonce = randomBytes(16).toString('base64');
    const nas =
      page.nasOrigin !== undefined && page.nasOrigin !== null && NAS_ORIGIN_RE.test(page.nasOrigin)
        ? ` ${page.nasOrigin}`
        : '';
    const login =
      page.loginOrigin !== undefined &&
      page.loginOrigin !== null &&
      LOGIN_ORIGIN_RE.test(page.loginOrigin)
        ? ` ${page.loginOrigin}`
        : '';
    // Cycle C: only the post-back hand-off page runs a script (nonce'd auto-submit); the
    // Cycle B MikroTik hand-off is a plain form the user submits (no script).
    const handoff = page.body.page === 'handoff' && page.body.autoSubmit;
    const script = handoff ? ` script-src 'nonce-${nonce}';` : '';
    const body: PageBody =
      page.body.page === 'handoff' && page.body.autoSubmit
        ? { ...page.body, scriptNonce: nonce }
        : page.body;
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none';${script} style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; form-action 'self'${nas}${login}; frame-ancestors 'none'; base-uri 'none'`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res
      .status(page.status)
      .type('html')
      .send(renderPage(page.theme, page.branding, body, { mode: 'link', nonce }));
  }

  function errorPage(res: Response, status: number, message: string, view: FlowView | null = null) {
    send(res, {
      status,
      theme: themeOf(view),
      branding: brandingOf(view),
      body: { page: 'error', message, retryHref: null },
    });
  }

  function expiredPage(res: Response): void {
    send(res, { status: 410, theme: DEFAULT_THEME, branding: null, body: { page: 'expired' } });
  }

  /** The browser's CSRF nonce; a new one is issued (and set) when missing. */
  function nonceFor(req: Request, res: Response): string {
    const existing = readCookie(req.headers.cookie, cookie);
    if (isNonce(existing)) return existing;
    const fresh = newNonce();
    res.append('Set-Cookie', serializeCookie(cookie, fresh, config.secureCookies));
    return fresh;
  }

  const tokenOf = (view: FlowView) => signFlowToken(secret, view.id, view.expiresAt);
  const flowHref = (token: string, suffix = '') => `/f/${token}${suffix}`;

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get(PORTAL_CSS_PATH, (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('text/css').send(PORTAL_CSS);
  });

  app.get('/a/:assetId', async (req, res) => {
    const assetId = String(req.params.assetId).toLowerCase();
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (!ASSET_ID_RE.test(assetId)) {
      res.status(404).end();
      return;
    }
    const asset = await api.asset(assetId, req.get('If-None-Match'));
    if (asset === 'unavailable') {
      res.status(503).end();
      return;
    }
    if (asset.headers.etag !== undefined) res.setHeader('ETag', asset.headers.etag);
    // Caching is the API's decision (P6-B): forward it; without one, revalidate every time.
    res.setHeader('Cache-Control', asset.headers['cache-control'] ?? 'no-cache');
    if (asset.status === 304) {
      res.status(304).end();
      return;
    }
    const type = asset.headers['content-type']?.split(';')[0]?.trim() ?? '';
    if (asset.status !== 200 || !ASSET_TYPES.has(type)) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', type);
    res.status(200).end(asset.body);
  });

  // --------------------------------------------------------------------------- UAM entry
  const ENTRY_PATHS = [
    ['uspot', ['/uam/uspot', '/uam/uspot/']],
    ['chilli', ['/uam/chilli', '/uam/chilli/']],
    // Cycle B: the ECLOUD-generated RouterOS login.html sends the browser here.
    ['mikrotik', ['/hotspot/mikrotik', '/hotspot/mikrotik/']],
  ] as const;
  for (const [flavour, paths] of ENTRY_PATHS) {
    app.get([...paths], async (req, res) => {
      // Raw query exactly as the device built it: `md` covers the bytes, not a re-encoding.
      const q = req.originalUrl.indexOf('?');
      const rawQuery = q < 0 ? '' : req.originalUrl.slice(q + 1);
      const outcome = await api.redirect({ flavour, rawQuery, clientIp: req.ip ?? null });
      switch (outcome.kind) {
        case 'flow': {
          nonceFor(req, res);
          const token = signFlowToken(secret, outcome.flowId, outcome.expiresAt);
          res.setHeader('Cache-Control', 'no-store');
          res.redirect(303, flowHref(token));
          return;
        }
        case 'success':
        case 'already': {
          const view = outcome.flowId === null ? null : await api.flow(outcome.flowId);
          const v = view === 'unavailable' ? null : view;
          send(res, {
            status: 200,
            theme: themeOf(v),
            branding: brandingOf(v),
            body: {
              page: 'success',
              continueUrl: v?.continueUrl ?? null,
              statusHref: v === null ? null : flowHref(tokenOf(v), '/status'),
            },
          });
          return;
        }
        case 'failed': {
          const view = await api.flow(outcome.flowId);
          const v = view === 'unavailable' ? null : view;
          send(res, {
            status: 200,
            theme: themeOf(v),
            branding: brandingOf(v),
            body: {
              page: 'error',
              message: t('error.failed'),
              retryHref: v === null ? null : flowHref(tokenOf(v)),
            },
          });
          return;
        }
        case 'logoff':
          send(res, {
            status: 200,
            theme: DEFAULT_THEME,
            branding: null,
            body: { page: 'logout' },
          });
          return;
        case 'rate_limited':
          errorPage(
            res,
            429,
            t('form.rate_limited', { minutes: Math.max(1, Math.ceil(outcome.retryAfter / 60)) }),
          );
          return;
        case 'unavailable':
          errorPage(res, 503, t('error.unavailable'));
          return;
        case 'error':
          // One page for unknown NAS, bad signature, tenant mismatch, replay, malformed.
          errorPage(res, 400, t('error.generic'));
          return;
      }
    });
  }

  // ---------------------------------------------------------------- post-back entry (Cycle C)
  app.get(
    ['/pb/:profile', '/pb/:profile/', '/pb/:profile/:nasid', '/pb/:profile/:nasid/'],
    async (req, res) => {
      const profile = String(req.params.profile);
      const nasid = req.params.nasid === undefined ? null : String(req.params.nasid);
      if (
        !PROFILE_SEGMENT_RE.test(profile) ||
        (nasid !== null && !NASID_SEGMENT_RE.test(nasid)) ||
        api.postbackRedirect === undefined
      ) {
        errorPage(res, 400, t('error.generic'));
        return;
      }
      // Raw query exactly as the device built it (opaque vendor tokens, Cambium query append).
      const q = req.originalUrl.indexOf('?');
      const rawQuery = q < 0 ? '' : req.originalUrl.slice(q + 1);
      const outcome = await api.postbackRedirect({
        profile,
        nasid,
        rawQuery,
        clientIp: req.ip ?? null,
      });
      switch (outcome.kind) {
        case 'flow': {
          nonceFor(req, res);
          const token = signFlowToken(secret, outcome.flowId, outcome.expiresAt);
          res.setHeader('Cache-Control', 'no-store');
          res.redirect(303, flowHref(token));
          return;
        }
        case 'rate_limited':
          errorPage(
            res,
            429,
            t('form.rate_limited', { minutes: Math.max(1, Math.ceil(outcome.retryAfter / 60)) }),
          );
          return;
        case 'unavailable':
          errorPage(res, 503, t('error.unavailable'));
          return;
        default:
          // One page for unknown NAS, unverified AP, foreign login host, replay, malformed.
          errorPage(res, 400, t('error.generic'));
          return;
      }
    },
  );

  // ------------------------------------------------------------------------- flow pages
  type Loaded = { token: string; view: FlowView };

  /** Resolves the signed token + flow; renders expired/unavailable itself when it cannot. */
  async function load(req: Request, res: Response): Promise<Loaded | null> {
    const token = String(req.params.token);
    const flowId = verifyFlowToken(secret, token, now());
    if (flowId === null) {
      expiredPage(res);
      return null;
    }
    const view = await api.flow(flowId);
    if (view === 'unavailable') {
      errorPage(res, 503, t('error.unavailable'));
      return null;
    }
    if (view === null) {
      expiredPage(res);
      return null;
    }
    return { token, view };
  }

  function formPage(
    req: Request,
    res: Response,
    l: Loaded,
    page: 'login' | 'voucher' | 'terms',
    status = 200,
    error: string | null = null,
    username = '',
  ): void {
    const nonce = nonceFor(req, res);
    const action = flowHref(l.token, page === 'terms' ? '/click' : `/${page}`);
    const form = {
      action,
      csrf: csrfToken(secret, l.view.id, nonce),
      ...(l.view.postback ? { loginToken: l.view.postback.loginToken } : {}),
    };
    const backHref = flowHref(l.token);
    const body: PageBody =
      page === 'login'
        ? { page, form, error, username, backHref }
        : page === 'voucher'
          ? { page, form, error, backHref }
          : {
              page,
              form,
              error,
              termsText: l.view.terms?.text ?? null,
              termsVersion: l.view.terms?.version ?? null,
              backHref,
            };
    send(res, {
      status,
      theme: themeOf(l.view),
      branding: brandingOf(l.view),
      body,
      nasOrigin: l.view.nasOrigin,
      loginOrigin: l.view.postback?.loginOrigin ?? null,
    });
  }

  const METHOD_PAGE: Readonly<Record<PortalMethod, 'login' | 'voucher' | 'terms'>> = {
    password: 'login',
    voucher: 'voucher',
    click_through: 'terms',
  };

  // ------------------------------------------------------- Cycle D vendor-API entry points
  // UniFi external portal: the controller sends the guest to `<portal>/guest/s/<site>/?ap=…`;
  // Omada (API mode) and Mist are configured with `/ext/omada` and `/ext/mist`. The API resolves
  // the tenant from a VERIFIED AP MAC only; every refusal is the same generic page.
  const vendorEntry = async (
    req: Request,
    res: Response,
    adapter: 'unifi' | 'omada' | 'mist',
    path: string,
  ): Promise<void> => {
    if (api.vendorRedirect === undefined) {
      errorPage(res, 400, t('error.generic'));
      return;
    }
    const q = req.originalUrl.indexOf('?');
    const rawQuery = q < 0 ? '' : req.originalUrl.slice(q + 1);
    const outcome = await api.vendorRedirect({ adapter, path, rawQuery, clientIp: req.ip ?? null });
    if (outcome.kind === 'flow') {
      nonceFor(req, res);
      const token = signFlowToken(secret, outcome.flowId, outcome.expiresAt);
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(303, flowHref(token));
      return;
    }
    if (outcome.kind === 'rate_limited') {
      errorPage(
        res,
        429,
        t('form.rate_limited', { minutes: Math.max(1, Math.ceil(outcome.retryAfter / 60)) }),
      );
      return;
    }
    if (outcome.kind === 'unavailable') {
      errorPage(res, 503, t('error.unavailable'));
      return;
    }
    errorPage(res, 400, t('error.generic'));
  };
  app.get(['/guest/s/:site', '/guest/s/:site/'], (req, res) =>
    vendorEntry(req, res, 'unifi', `/guest/s/${String(req.params.site)}/`),
  );
  app.get(['/ext/omada', '/ext/omada/'], (req, res) =>
    vendorEntry(req, res, 'omada', '/ext/omada'),
  );
  app.get(['/ext/mist', '/ext/mist/'], (req, res) => vendorEntry(req, res, 'mist', '/ext/mist'));

  app.get('/f/:token', async (req, res) => {
    const l = await load(req, res);
    if (l === null) return;
    if (l.view.state === 'AUTHORIZED') {
      res.redirect(303, flowHref(l.token, '/status'));
      return;
    }
    nonceFor(req, res);
    send(res, {
      status: 200,
      theme: themeOf(l.view),
      branding: brandingOf(l.view),
      body: {
        page: 'landing',
        methods: l.view.methods.map((method) => ({
          method,
          href: flowHref(l.token, `/${METHOD_PAGE[method]}`),
        })),
        notice: l.view.notice,
      },
    });
  });

  for (const method of ['password', 'voucher', 'click_through'] as const) {
    const page = METHOD_PAGE[method];
    app.get(`/f/:token/${page}`, async (req, res) => {
      const l = await load(req, res);
      if (l === null) return;
      if (!l.view.methods.includes(method)) {
        errorPage(res, 404, t('error.not_found'), l.view);
        return;
      }
      formPage(req, res, l, page);
    });
  }

  const urlencoded = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 10 });

  const postRoutes = [
    { path: 'login', method: 'password' },
    { path: 'voucher', method: 'voucher' },
    { path: 'click', method: 'click_through' },
  ] as const;
  for (const route of postRoutes) {
    app.post(`/f/:token/${route.path}`, urlencoded, async (req, res) => {
      const l = await load(req, res);
      if (l === null) return;
      const page = METHOD_PAGE[route.method];
      const form = (req.body ?? {}) as Record<string, unknown>;
      const field = (name: string) => (typeof form[name] === 'string' ? form[name] : '');
      if (!verifyCsrf(secret, l.view.id, readCookie(req.headers.cookie, cookie), form.csrf)) {
        formPage(req, res, l, page, 403, t('form.csrf'));
        return;
      }
      if (!l.view.methods.includes(route.method)) {
        errorPage(res, 404, t('error.not_found'), l.view);
        return;
      }
      const clientIp = req.ip;
      // Cycle C: the single-use login token travels back with the form (post-back flows only).
      const lt = l.view.postback ? { login_token: field('lt').slice(0, 1024) } : {};
      let input: IdentifyInput;
      if (route.method === 'password') {
        if (field('username') === '' || field('password') === '') {
          formPage(req, res, l, page, 422, t('form.rejected'), field('username').slice(0, 253));
          return;
        }
        input = {
          method: 'password',
          username: field('username').slice(0, 253),
          password: field('password').slice(0, 256),
          ...(clientIp === undefined ? {} : { client_ip: clientIp }),
          ...lt,
        };
      } else if (route.method === 'voucher') {
        if (field('code') === '') {
          formPage(req, res, l, page, 422, t('form.rejected'));
          return;
        }
        input = {
          method: 'voucher',
          code: field('code').slice(0, 64),
          ...(clientIp === undefined ? {} : { client_ip: clientIp }),
          ...lt,
        };
      } else {
        if (field('accept_terms') !== 'yes') {
          formPage(req, res, l, page, 422, t('form.rejected'));
          return;
        }
        input = {
          method: 'click_through',
          accept_terms: true,
          ...(clientIp === undefined ? {} : { client_ip: clientIp }),
          ...lt,
        };
      }
      const outcome = await api.identify(l.view.id, input);
      metrics?.logins.inc({ method: route.method, result: outcome.result });
      const username = route.method === 'password' ? field('username').slice(0, 253) : '';
      switch (outcome.result) {
        case 'ok':
          if (l.view.postback) {
            // Cycle C: post-back hand-off to the AP / controller login URL the API validated.
            const origin = l.view.postback.loginOrigin;
            if (!isPostbackHandoff(outcome.handoffUrl, origin)) {
              logger.error({ flowId: l.view.id }, 'portal post-back hand-off URL rejected');
              errorPage(res, 502, t('error.unavailable'), l.view);
              return;
            }
            if (outcome.handoffMethod === 'POST-form' && outcome.fields !== undefined) {
              send(res, {
                status: 200,
                theme: themeOf(l.view),
                branding: brandingOf(l.view),
                body: {
                  page: 'handoff',
                  action: outcome.handoffUrl,
                  fields: Object.entries(outcome.fields),
                  autoSubmit: true,
                  scriptNonce: null,
                },
                loginOrigin: origin,
              });
              return;
            }
            res.setHeader('Cache-Control', 'no-store');
            res.redirect(302, outcome.handoffUrl);
            return;
          }
          if (outcome.handoffForm !== undefined) {
            // MikroTik: the browser POSTs username / password (CHAP hash) / dst / popup to the
            // router itself; the router origin is allowed as form-action for this page only.
            if (!isMikrotikLoginHandoff(outcome.handoffUrl, l.view.nasOrigin)) {
              logger.error({ flowId: l.view.id }, 'portal hand-off URL rejected');
              errorPage(res, 502, t('error.unavailable'), l.view);
              return;
            }
            send(res, {
              status: 200,
              theme: themeOf(l.view),
              branding: brandingOf(l.view),
              body: {
                page: 'handoff',
                action: outcome.handoffUrl,
                fields: Object.entries(outcome.handoffForm),
                autoSubmit: false,
                scriptNonce: null,
              },
              nasOrigin: l.view.nasOrigin,
            });
            return;
          }
          if (!isNasHandoff(outcome.handoffUrl, l.view.nasOrigin, '/logon')) {
            logger.error({ flowId: l.view.id }, 'portal hand-off URL rejected');
            errorPage(res, 502, t('error.unavailable'), l.view);
            return;
          }
          // Authorization hand-off as a 302 (SECURITY §5.8): the NAS decodes the PAP password.
          res.setHeader('Cache-Control', 'no-store');
          res.redirect(302, outcome.handoffUrl);
          return;
        case 'rejected':
          // fail2ban `ecloud-portal` jail (infra/vps/fail2ban): `event` then `ip`, no credentials.
          logger.warn(
            { event: 'portal_auth_failed', ip: req.ip ?? 'unknown', flow_id: l.view.id },
            'security: portal_auth_failed',
          );
          formPage(req, res, l, page, 422, t('form.rejected'), username);
          return;
        case 'rate_limited':
          logger.warn(
            { event: 'portal_auth_rate_limited', ip: req.ip ?? 'unknown', flow_id: l.view.id },
            'security: portal_auth_rate_limited',
          );
          formPage(
            req,
            res,
            l,
            page,
            429,
            t('form.rate_limited', { minutes: Math.max(1, Math.ceil(outcome.retryAfter / 60)) }),
            username,
          );
          return;
        case 'flow_state':
          res.redirect(303, flowHref(l.token, '/status'));
          return;
        case 'flow_not_found':
          expiredPage(res);
          return;
        case 'method_not_allowed':
          errorPage(res, 404, t('error.not_found'), l.view);
          return;
        case 'handoff_unavailable':
          errorPage(res, 400, t('error.generic'), l.view);
          return;
        case 'login_token_invalid':
          formPage(req, res, l, page, 403, t('form.token'), username);
          return;
        case 'vendor_authorized':
          // Cycle D: the controller authorised the device; no NAS hand-off exists.
          send(res, {
            status: 200,
            theme: themeOf(l.view),
            branding: brandingOf(l.view),
            body: vendorSuccessBody(outcome),
          });
          return;
        case 'vendor_grant':
          if (!isMistGrantUrl(outcome.grantUrl)) {
            logger.error({ flowId: l.view.id }, 'portal vendor grant URL rejected');
            errorPage(res, 502, t('error.unavailable'), l.view);
            return;
          }
          res.setHeader('Cache-Control', 'no-store');
          res.redirect(302, outcome.grantUrl);
          return;
        case 'vendor_unavailable':
          errorPage(res, 502, t('error.unavailable'), l.view);
          return;
        case 'unavailable':
          errorPage(res, 503, t('error.unavailable'), l.view);
          return;
      }
    });
  }

  app.get('/f/:token/status', async (req, res) => {
    const l = await load(req, res);
    if (l === null) return;
    const status = await api.status(l.view.id);
    if (status === 'unavailable') {
      errorPage(res, 503, t('error.unavailable'), l.view);
      return;
    }
    const s = status?.session ?? null;
    const nonce = nonceFor(req, res);
    send(res, {
      status: 200,
      theme: themeOf(l.view),
      branding: brandingOf(l.view),
      body: {
        page: 'status',
        session:
          s === null
            ? null
            : {
                startedAt: s.startedAt,
                bytes: s.inputOctets + s.outputOctets,
                durationS: s.sessionTimeS,
              },
        logout: { action: flowHref(l.token, '/logout'), csrf: csrfToken(secret, l.view.id, nonce) },
      },
      nasOrigin: l.view.nasOrigin,
    });
  });

  app.post('/f/:token/logout', urlencoded, async (req, res) => {
    const l = await load(req, res);
    if (l === null) return;
    const form = (req.body ?? {}) as Record<string, unknown>;
    if (!verifyCsrf(secret, l.view.id, readCookie(req.headers.cookie, cookie), form.csrf)) {
      errorPage(res, 403, t('form.csrf'), l.view);
      return;
    }
    const logoff = await api.logout(l.view.id);
    if (logoff === 'unavailable') {
      errorPage(res, 503, t('error.unavailable'), l.view);
      return;
    }
    if (
      logoff === null ||
      !(
        isNasHandoff(logoff.url, l.view.nasOrigin, '/logoff') ||
        isNasHandoff(logoff.url, l.view.nasOrigin, '/logout')
      )
    ) {
      expiredPage(res);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, logoff.url);
  });

  app.use((_req, res) => {
    errorPage(res, 404, t('error.not_found'));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: (e?: unknown) => void) => {
    logger.error({ err: error }, 'portal request failed');
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = (error as { status?: unknown }).status;
    errorPage(
      res,
      typeof status === 'number' && status >= 400 && status < 500 ? status : 500,
      t('error.unavailable'),
    );
  });

  return app;
}

export interface MainOptions {
  config?: PortalConfig;
  logger?: Logger;
  api?: PortalApi;
  /** Install SIGTERM/SIGINT handlers (default true). */
  handleSignals?: boolean;
  shutdownGraceMs?: number;
  /** Where signals are received (default `process`; tests pass their own emitter). */
  signalSource?: Pick<EventEmitter, 'once'>;
  /** Called with 0 after a signal-triggered shutdown (default `process.exit`). */
  exit?: (code: number) => void;
}

export interface RunningPortal {
  server: Server;
  /** The separate `/metrics` listener when `PORTAL_METRICS_PORT` is set. */
  metricsServer: Server | null;
  /** Stops accepting connections, drains in-flight requests (bounded by the grace period). */
  shutdown: () => Promise<void>;
}

/** Closes the listener; after `graceMs` any remaining connections are closed forcibly. */
export function closeServer(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/** Starts the portal listener and resolves once it is accepting connections. */
export async function main(options: MainOptions = {}): Promise<RunningPortal> {
  const config = options.config ?? loadPortalConfig();
  const logger = options.logger ?? createLogger({ name: 'portal', level: config.base.logLevel });
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const metrics = createPortalMetrics();
  const app = createServer({
    config,
    logger,
    metrics,
    ...(options.api ? { api: options.api } : {}),
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.base.ports.portal, (error?: Error) => {
      if (error) reject(error);
      else resolve(s);
    });
  });
  let metricsServer: Server | null = null;
  if (config.metrics !== null) {
    const { host, port } = config.metrics;
    const ms = createMetricsServer(metrics);
    await new Promise<void>((resolve, reject) => {
      ms.once('error', reject);
      ms.listen(port, host, () => {
        ms.off('error', reject);
        resolve();
      });
    });
    metricsServer = ms;
  }
  logger.info(
    {
      port: config.base.ports.portal,
      metrics:
        config.metrics === null ? null : `${config.metrics.host}:${String(config.metrics.port)}`,
    },
    'portal listening',
  );

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info('portal shutting down: draining connections');
      await Promise.all([
        closeServer(server, graceMs),
        ...(metricsServer === null ? [] : [closeServer(metricsServer, graceMs)]),
      ]);
      metrics.stop();
      logger.info('portal stopped');
    })();
    return stopping;
  };

  if (options.handleSignals !== false) {
    const source = options.signalSource ?? process;
    const exit = options.exit ?? ((code: number) => process.exit(code));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      source.once(signal, () => {
        void shutdown().then(() => exit(0));
      });
    }
  }
  return { server, metricsServer, shutdown };
}
