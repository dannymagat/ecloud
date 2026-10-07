/**
 * Authentication + CSRF middleware for the public listener.
 *  - `Authorization: Bearer eck_…` → API key principal (CSRF-exempt: not ambient).
 *  - session cookie → administrator principal; an expired impersonation session falls back to
 *    the parent session kept in `<cookie>_parent`.
 *  - CSRF (SECURITY_ARCHITECTURE.md §6.4): every state-changing request that is cookie
 *    authenticated — or that would create a cookie (login, MFA verify, invitation accept) —
 *    must carry `Origin` (or `Referer`) equal to PUBLIC_ADMIN_ORIGIN and `X-Requested-With`.
 */
import { UnauthorizedError } from '@ecloud/shared';
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import type { AppDeps } from '../context.js';
import { CsrfError } from '../http/errors.js';
import { resolveApiKey, resolveSession } from './principal.js';

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      cookies.set(name, raw);
    }
  }
  return cookies;
}

export function parentCookieName(cookieName: string): string {
  return `${cookieName}_parent`;
}

export function sessionCookieOptions(deps: AppDeps, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.config.session.secureCookie,
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

export function setSessionCookie(
  deps: AppDeps,
  res: Response,
  token: string,
  maxAgeSeconds: number,
  name = deps.config.session.cookieName,
): void {
  res.cookie(name, token, sessionCookieOptions(deps, maxAgeSeconds));
}

export function clearSessionCookie(
  deps: AppDeps,
  res: Response,
  name = deps.config.session.cookieName,
): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions(deps, 0);
  res.clearCookie(name, options);
}

/** Paths whose unauthenticated POST sets a session cookie: CSRF-checked like cookie requests. */
const COOKIE_ISSUING_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/mfa/verify',
  '/api/v1/auth/accept-invitation',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function authenticate(deps: AppDeps): RequestHandler {
  const now = deps.now ?? (() => new Date());
  return async (req, res, next) => {
    const authorization = req.get('Authorization');
    if (authorization !== undefined) {
      const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
      const principal =
        match?.[1] === undefined ? null : await resolveApiKey(deps, match[1], req.ctx.ip, now());
      if (principal === null) {
        // Presenting a credential that does not verify is always a 401 (never anonymous).
        throw new UnauthorizedError({ detail: 'Invalid API key.' });
      }
      req.ctx.principal = principal;
      req.ctx.authMethod = 'api_key';
      next();
      return;
    }
    const cookies = parseCookies(req.get('Cookie'));
    const cookieName = deps.config.session.cookieName;
    const token = cookies.get(cookieName);
    if (token !== undefined && token !== '') {
      let lookup = await resolveSession(deps, token, now());
      const parentToken = cookies.get(parentCookieName(cookieName));
      if (lookup === null && parentToken !== undefined && parentToken !== '') {
        // Impersonation expired: fall back to the support admin's own session.
        lookup = await resolveSession(deps, parentToken, now());
        if (lookup !== null) {
          setSessionCookie(deps, res, parentToken, deps.config.session.ttlSeconds);
          clearSessionCookie(deps, res, parentCookieName(cookieName));
        }
      }
      if (lookup !== null) {
        req.ctx.principal = lookup.principal;
        req.ctx.authMethod = 'cookie';
      }
    }
    next();
  };
}

function originOf(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function csrfProtection(deps: AppDeps): RequestHandler {
  const allowed = new URL(deps.config.base.origins.admin).origin;
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const cookieAuthenticated = req.ctx.authMethod === 'cookie';
    const issuesCookie = req.ctx.authMethod === null && COOKIE_ISSUING_PATHS.has(req.path);
    if (!cookieAuthenticated && !issuesCookie) {
      next();
      return;
    }
    const origin = originOf(req.get('Origin')) ?? originOf(req.get('Referer'));
    if (origin === null) throw new CsrfError('Origin or Referer header is required.');
    if (origin !== allowed) throw new CsrfError('Request origin is not allowed.');
    const requestedWith = req.get('X-Requested-With');
    if (requestedWith === undefined || requestedWith.trim() === '') {
      throw new CsrfError('X-Requested-With header is required.');
    }
    next();
  };
}

export function requestIsImpersonating(req: Request): boolean {
  const p = req.ctx.principal;
  return p !== null && p.kind === 'admin' && p.impersonation !== null;
}
