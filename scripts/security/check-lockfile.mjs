#!/usr/bin/env node
/**
 * Lockfile integrity gate (P10-A, SECURITY_ARCHITECTURE.md §6.9 / T17). No dependencies.
 *
 *   node scripts/security/check-lockfile.mjs [path/to/package-lock.json]
 *
 * Fails (exit 1) when package-lock.json
 *   - is not lockfileVersion 3,
 *   - has a third-party package without `resolved` or without a sha512 `integrity`,
 *   - resolves a package from anywhere but https://registry.npmjs.org/ (git, http, file, tarball
 *     URLs, other registries),
 *   - links a workspace path that is not one of the root package.json workspaces.
 * `npm ci` (CI) additionally refuses a lockfile that is out of sync with package.json, and
 * `npm audit signatures` verifies the registry signatures of what was installed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const lockPath = resolve(process.argv[2] ?? 'package-lock.json');
const root = dirname(lockPath);
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const REGISTRY = 'https://registry.npmjs.org/';
const workspaceGlobs = (pkg.workspaces ?? []).map((w) => w.replace(/\/\*$/, '/'));
const isWorkspacePath = (p) =>
  workspaceGlobs.some((w) =>
    w.endsWith('/') ? p.startsWith(w) && !p.slice(w.length).includes('/') : p === w,
  );

const problems = [];
if (lock.lockfileVersion !== 3)
  problems.push(`lockfileVersion is ${lock.lockfileVersion}, expected 3`);

let thirdParty = 0;
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === '') continue;
  if (!path.includes('node_modules/')) {
    // workspace package source entry (e.g. "apps/api")
    if (!isWorkspacePath(path)) problems.push(`${path}: non-workspace local package`);
    continue;
  }
  if (entry.link === true) {
    if (!isWorkspacePath(entry.resolved ?? ''))
      problems.push(`${path}: link to non-workspace ${entry.resolved}`);
    continue;
  }
  thirdParty += 1;
  if (typeof entry.resolved !== 'string') problems.push(`${path}: missing "resolved"`);
  else if (!entry.resolved.startsWith(REGISTRY))
    problems.push(`${path}: resolved outside ${REGISTRY}: ${entry.resolved}`);
  if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
    problems.push(`${path}: missing sha512 integrity`);
  }
}

if (problems.length > 0) {
  for (const p of problems) process.stderr.write(`check-lockfile: ${p}\n`);
  process.stderr.write(`check-lockfile: ${problems.length} problem(s)\n`);
  process.exit(1);
}
process.stdout.write(
  `check-lockfile: OK (${thirdParty} registry packages, all sha512 + ${REGISTRY})\n`,
);
