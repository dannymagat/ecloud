/**
 * Admin SPA build (ADMIN_UI_ARCHITECTURE.md §1, D-029): one Vite build of static files served
 * by Caddy next to the API; the SPA calls same-origin `/api/v1` with the session cookie.
 * Dev: `/api` (and the health probes) are proxied to the local API listener (API_PORT).
 * The proxy keeps the browser's Origin header so the API CSRF check (PUBLIC_ADMIN_ORIGIN)
 * sees the Vite origin; run the API with PUBLIC_ADMIN_ORIGIN=http://localhost:5173.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = process.env.API_PORT ?? '3000';
const apiTarget = process.env.ADMIN_DEV_API_TARGET ?? `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/healthz': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    // Maps are emitted for debugging but not referenced from the bundles.
    sourcemap: 'hidden',
    // Self-contained output: fonts and icons are bundled, nothing is loaded from a CDN.
    assetsInlineLimit: 0,
  },
});
