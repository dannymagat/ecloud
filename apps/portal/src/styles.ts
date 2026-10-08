/**
 * Portal stylesheet (ADMIN_UI_ARCHITECTURE.md §4): one small file served from the portal origin
 * (`/static/portal.css`, CSP `style-src 'self'`), no web fonts, no third-party assets. Theme
 * tokens arrive as CSS custom properties (`--p-<token>`, same names as the P6-B designer).
 * Logical properties only (`margin-inline`, `padding-block`, `text-align: start`) so `dir="rtl"`
 * needs no second stylesheet (Q77). Focus is always visible (WCAG 2.2 AA).
 */
import { createHash } from 'node:crypto';

export const PORTAL_CSS = `*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--p-background,#f4f6f8);color:var(--p-text,#1d2733);line-height:1.5}
.skip{position:absolute;inset-inline-start:-999px}
.skip:focus{inset-inline-start:.5rem;inset-block-start:.5rem;background:var(--p-surface,#fff);padding:.5rem}
main{max-inline-size:26rem;margin-inline:auto;padding-block:2rem;padding-inline:1rem}
.card{background:var(--p-surface,#fff);border-radius:.75rem;padding:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.logo{display:block;max-inline-size:12rem;max-block-size:5rem;margin-inline:auto;margin-block-end:1rem}
h1{font-size:1.4rem;margin-block:0 .5rem;text-align:center}
p{margin-block:.5rem}
.site{text-align:center;color:var(--p-muted,#55606e);font-size:.9rem;margin-block-start:0}
.muted{color:var(--p-muted,#55606e);font-size:.9rem}
.notice{border-inline-start:.25rem solid var(--p-brand,#0b6bcb);padding-inline-start:.75rem}
.error{color:var(--p-error,#b42318);font-weight:600}
label{display:block;font-weight:600;margin-block-start:.75rem}
input[type=text],input[type=password]{display:block;inline-size:100%;padding:.6rem;border:1px solid var(--p-muted,#55606e);border-radius:.4rem;font:inherit;background:#fff;color:#1d2733}
.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}
.check input{margin-block-start:.3rem}
button,.button{display:block;inline-size:100%;margin-block-start:1rem;padding:.7rem;border:0;border-radius:.4rem;background:var(--p-brand,#0b6bcb);color:var(--p-brand-text,#fff);font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
.methods{list-style:none;padding:0;margin:0}
.methods a{margin-block-start:.75rem}
.terms{max-block-size:14rem;overflow:auto;border:1px solid var(--p-muted,#55606e);border-radius:.4rem;padding:.75rem;white-space:pre-wrap;font-size:.9rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}
dt{font-weight:600}
dd{margin:0}
a{color:var(--p-brand,#0b6bcb)}
:focus-visible{outline:3px solid var(--p-brand,#0b6bcb);outline-offset:2px}
.links{margin-block-start:1rem;text-align:center}
footer{margin-block-start:1.5rem;text-align:center}
`;

/** Content hash for the immutable stylesheet URL. */
export const PORTAL_CSS_HASH = createHash('sha256').update(PORTAL_CSS).digest('hex').slice(0, 12);
export const PORTAL_CSS_PATH = `/static/portal.${PORTAL_CSS_HASH}.css`;
