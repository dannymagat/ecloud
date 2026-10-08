/**
 * Portal page preview for the admin designer (ADMIN_UI_ARCHITECTURE.md §3 "Captive portal
 * designer", §4). The API resolves the (draft) theme and sample data and renders the page with
 * the REAL portal templates (`renderPreview` exported by `@ecloud/portal`, contract
 * `RenderPortalPreview` in `@ecloud/shared/portal-theme`), then serves it framed by the admin app
 * under the strict headers below.
 */
import { renderPreview } from '@ecloud/portal';
import type { RenderPortalPreview } from '@ecloud/shared';

/** Headers of a served preview: nothing but inline styles and data: images, no script, no forms. */
export const PREVIEW_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
});

/** The renderer used by the preview endpoint (single swap point). */
export const renderPortalPreview: RenderPortalPreview = renderPreview;
