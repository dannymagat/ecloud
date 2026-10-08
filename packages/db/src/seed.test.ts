import { PERMISSION_CATALOGUE, ROLE_TEMPLATES } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import type { MigrationExecutor } from './migrate.js';
import { seedCatalogue, validateTemplates } from './seed.js';

/** Records statements and answers the seed's queries with plausible rows. */
function fakeExecutor(existing: Map<string, Set<string>> = new Map()): MigrationExecutor & {
  statements: { text: string; values?: readonly unknown[] }[];
} {
  const statements: { text: string; values?: readonly unknown[] }[] = [];
  let roleCounter = 0;
  const roleIds = new Map<string, string>();
  return {
    statements,
    query<R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      statements.push({ text, values });
      let rows: Record<string, unknown>[] = [];
      if (text.startsWith('INSERT INTO permissions')) {
        rows = (values?.[0] as string[]).map((key) => ({ key, inserted: true }));
      } else if (text.startsWith('SELECT key FROM permissions')) {
        rows = [{ key: 'legacy:thing' }];
      } else if (text.startsWith('INSERT INTO roles')) {
        const key = values?.[1] as string;
        roleCounter += 1;
        const id = roleIds.get(key) ?? `role-${String(roleCounter)}`;
        roleIds.set(key, id);
        rows = [{ id, template_version: 1, created: !existing.has(key) }];
      } else if (text.startsWith('SELECT permission_key FROM role_permissions')) {
        const key = [...roleIds.entries()].find(([, id]) => id === values?.[0])?.[0] ?? '';
        rows = [...(existing.get(key) ?? [])].map((permission_key) => ({ permission_key }));
      } else if (text.startsWith('UPDATE roles SET template_version')) {
        rows = [{ template_version: 2 }];
      }
      return Promise.resolve({ rows: rows as R[] });
    },
  };
}

describe('validateTemplates', () => {
  it('accepts the shared templates and rejects unknown keys', () => {
    expect(() => validateTemplates(PERMISSION_CATALOGUE, ROLE_TEMPLATES)).not.toThrow();
    expect(() =>
      validateTemplates(PERMISSION_CATALOGUE, [
        { key: 'read_only', name: 'x', defaultScopeTypes: ['site'], permissions: ['nope:never'] },
      ]),
    ).toThrow(/unknown permissions: nope:never/);
  });
});

describe('seedCatalogue', () => {
  it('upserts the whole shared catalogue and every template inside one locked transaction', async () => {
    const exec = fakeExecutor();
    const result = await seedCatalogue(exec);

    expect(result.permissions.total).toBe(PERMISSION_CATALOGUE.length);
    expect(result.permissions.total).toBe(105);
    expect(result.permissions.inserted).toBe(105);
    expect(result.permissions.orphans).toEqual(['legacy:thing']);
    expect(result.templates.map((t) => t.key)).toEqual(ROLE_TEMPLATES.map((t) => t.key));
    expect(result.templates).toHaveLength(6);
    for (const t of result.templates) {
      const template = ROLE_TEMPLATES.find((rt) => rt.key === t.key);
      expect(t.permissionCount).toBe(template?.permissions.length);
      expect(t.added).toBe(template?.permissions.length);
      expect(t.removed).toBe(0);
      expect(t.created).toBe(true);
      expect(t.templateVersion).toBe(1);
    }

    const texts = exec.statements.map((s) => s.text);
    expect(texts[0]).toContain('pg_advisory_lock');
    expect(texts[1]).toBe('BEGIN');
    expect(texts.at(-2)).toBe('COMMIT');
    expect(texts.at(-1)).toContain('pg_advisory_unlock');
    const upsert = exec.statements.find((s) => s.text.startsWith('INSERT INTO permissions'));
    expect((upsert?.values?.[0] as string[]).length).toBe(105);
    expect(upsert?.values?.[4]).toEqual(PERMISSION_CATALOGUE.map((p) => p.minScope));
    // template rows are platform templates: organization_id NULL, is_template true
    const roleInsert = exec.statements.find((s) => s.text.startsWith('INSERT INTO roles'));
    expect(roleInsert?.text).toContain('VALUES ($1, NULL, $2, $3, $4, true, $2)');
    expect(roleInsert?.text).toContain('ON CONFLICT (key) WHERE organization_id IS NULL');
    expect(texts.some((t) => t.startsWith('UPDATE roles SET template_version'))).toBe(false);
  });

  it('reconciles an existing template (adds, removes, bumps template_version)', async () => {
    const readOnly = ROLE_TEMPLATES.find((t) => t.key === 'read_only');
    const stale = new Set<string>([...(readOnly?.permissions.slice(1) ?? []), 'legacy:thing']);
    const exec = fakeExecutor(new Map([['read_only', stale]]));
    const result = await seedCatalogue(exec);
    const t = result.templates.find((r) => r.key === 'read_only');
    expect(t).toMatchObject({ created: false, added: 1, removed: 1, templateVersion: 2 });
    const del = exec.statements.find((s) => s.text.startsWith('DELETE FROM role_permissions'));
    expect(del?.values?.[1]).toEqual(['legacy:thing']);
    const others = result.templates.filter((r) => r.key !== 'read_only');
    expect(others.every((r) => r.templateVersion === 1 && r.created)).toBe(true);
  });

  it('rolls back when a statement fails', async () => {
    const exec = fakeExecutor();
    const original = exec.query.bind(exec);
    exec.query = (text, values) => {
      if (text.startsWith('INSERT INTO roles')) return Promise.reject(new Error('nope'));
      return original(text, values);
    };
    await expect(seedCatalogue(exec)).rejects.toThrow('nope');
    expect(exec.statements.map((s) => s.text)).toContain('ROLLBACK');
  });
});
