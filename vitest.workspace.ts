// Vitest project list for the npm workspaces monorepo.
// Vitest >= 4 no longer reads this file automatically; vitest.config.ts imports it and feeds
// it to `test.projects`. Each workspace that contains `src/**/*.test.ts` becomes one project.
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TestProjectConfiguration } from 'vitest/config';

export const ROOT_DIR = import.meta.dirname;
export const WORKSPACE_GROUPS = ['packages', 'apps'] as const;

export interface WorkspaceInfo {
  /** npm package name, e.g. `@ecloud/shared`. */
  name: string;
  /** Absolute directory of the workspace. */
  dir: string;
  /** Absolute path of `src/index.ts` (used for source aliases in tests). */
  entry: string;
}

export function listWorkspaces(): WorkspaceInfo[] {
  const result: WorkspaceInfo[] = [];
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = resolve(ROOT_DIR, group);
    if (!existsSync(groupDir)) continue;
    for (const child of readdirSync(groupDir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const dir = join(groupDir, child.name);
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      result.push({
        name: `@ecloud/${child.name}`,
        dir,
        entry: join(dir, 'src', 'index.ts'),
      });
    }
  }
  return result;
}

/**
 * Workspaces whose integration suite resets the shared test database
 * (`migrateTestDatabase({ reset: true })`). They run first (groupOrder 0); every other
 * workspace runs in group 1, so no suite migrates or reads while the reset is in flight.
 */
export const DATABASE_RESET_WORKSPACES: readonly string[] = ['@ecloud/db'];

/**
 * Cross-package suites in `tests/` (isolation, security, aaa-contract, e2e) run last
 * (groupOrder 2), after every package project.
 */
export const crossPackageProject: TestProjectConfiguration = {
  extends: true,
  root: resolve(ROOT_DIR, 'tests'),
  test: {
    name: 'tests',
    include: ['**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    sequence: { groupOrder: 2 },
  },
};

/**
 * Workspaces with their own Vitest project file (browser code: jsdom + React plugin). They are
 * referenced by path instead of the generic node project below.
 */
export const OWN_CONFIG_WORKSPACES: Readonly<Record<string, string>> = {
  '@ecloud/admin': resolve(ROOT_DIR, 'apps/admin/vitest.config.ts'),
};

export const workspaceProjects: TestProjectConfiguration[] = [
  ...Object.values(OWN_CONFIG_WORKSPACES),
  ...listWorkspaces()
    .filter((ws) => !(ws.name in OWN_CONFIG_WORKSPACES))
    .map((ws) => ({
      extends: true as const,
      root: ws.dir,
      test: {
        name: ws.name.replace('@ecloud/', ''),
        include: ['src/**/*.test.ts'],
        sequence: { groupOrder: DATABASE_RESET_WORKSPACES.includes(ws.name) ? 0 : 1 },
      },
    })),
  crossPackageProject,
];

export default workspaceProjects;
