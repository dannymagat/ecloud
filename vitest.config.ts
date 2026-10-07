import { defineConfig } from 'vitest/config';
import { listWorkspaces, workspaceProjects } from './vitest.workspace.ts';

// Tests import sibling packages by name (`@ecloud/shared`) but resolve to their TypeScript
// sources, so a change in packages/shared is visible to apps/api tests without rebuilding.
const sourceAliases = listWorkspaces().map((ws) => ({
  find: new RegExp(`^${ws.name.replace('/', '\\/')}$`),
  replacement: ws.entry,
}));

export default defineConfig({
  resolve: {
    alias: sourceAliases,
  },
  test: {
    environment: 'node',
    passWithNoTests: true,
    projects: workspaceProjects,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/main.ts', '**/cli.ts'],
    },
  },
});
