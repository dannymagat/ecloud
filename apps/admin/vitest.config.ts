/**
 * Vitest project for the admin SPA: jsdom + Testing Library. Referenced from the root
 * vitest.workspace.ts so `npm test` at the root runs these suites too.
 */
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  resolve: {
    alias: [
      // Drift tests compare local constants against the shared catalogue sources.
      {
        find: /^@ecloud\/shared$/,
        replacement: resolve(import.meta.dirname, '../../packages/shared/src/index.ts'),
      },
    ],
  },
  test: {
    name: 'admin',
    root: import.meta.dirname,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    sequence: { groupOrder: 1 },
  },
});
