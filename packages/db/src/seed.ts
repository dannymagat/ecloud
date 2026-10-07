/**
 * Seeds the permission catalogue and the six role templates from `@ecloud/shared`
 * (PERMISSION_CATALOGUE / ROLE_TEMPLATES) — the single source of truth (D-021).
 *
 * Why a runtime command instead of a generated SQL migration: the catalogue is code; a
 * generated file would be a second copy that drifts and needs a test to keep it equal. `seed`
 * is idempotent and reconciling: it upserts every key, re-syncs each template's permission set
 * (adding and removing), bumps `template_version` when a template changed, and reports (never
 * deletes) keys that exist in the database but not in the catalogue. Deployments run
 * `migrate` then `seed`. Tenant roles copied from a template are untouched (copy-on-write,
 * MULTITENANCY.md §4.3).
 */
import {
  PERMISSION_CATALOGUE,
  ROLE_TEMPLATES,
  newId,
  type PermissionDefinition,
  type RoleTemplate,
} from '@ecloud/shared';
import { withMigrationLock, type MigrationExecutor } from './migrate.js';

export interface SeedTemplateResult {
  key: string;
  roleId: string;
  created: boolean;
  permissionCount: number;
  added: number;
  removed: number;
  templateVersion: number;
}

export interface SeedResult {
  permissions: { total: number; inserted: number; updated: number; orphans: string[] };
  templates: SeedTemplateResult[];
}

export interface SeedOptions {
  catalogue?: readonly PermissionDefinition[];
  templates?: readonly RoleTemplate[];
}

/** Templates may only reference catalogue keys; anything else is a programming error. */
export function validateTemplates(
  catalogue: readonly PermissionDefinition[],
  templates: readonly RoleTemplate[],
): void {
  const known = new Set(catalogue.map((p) => p.key));
  for (const template of templates) {
    const unknown = template.permissions.filter((key) => !known.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `Role template ${template.key} references unknown permissions: ${unknown.join(', ')}`,
      );
    }
  }
}

const UPSERT_PERMISSIONS_SQL = `INSERT INTO permissions (key, resource, action, description, min_scope, is_platform_only)
SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[])
ON CONFLICT (key) DO UPDATE SET
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description,
  min_scope = EXCLUDED.min_scope,
  is_platform_only = EXCLUDED.is_platform_only
WHERE (permissions.resource, permissions.action, permissions.description, permissions.min_scope, permissions.is_platform_only)
  IS DISTINCT FROM (EXCLUDED.resource, EXCLUDED.action, EXCLUDED.description, EXCLUDED.min_scope, EXCLUDED.is_platform_only)
RETURNING key, (xmax = 0) AS inserted`;

const ORPHANS_SQL = 'SELECT key FROM permissions WHERE key <> ALL($1::text[]) ORDER BY key';

const UPSERT_TEMPLATE_SQL = `INSERT INTO roles (id, organization_id, key, name, description, is_template, template_key)
VALUES ($1, NULL, $2, $3, $4, true, $2)
ON CONFLICT (key) WHERE organization_id IS NULL DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_template = true,
  template_key = EXCLUDED.key
RETURNING id, template_version, (xmax = 0) AS created`;

const SELECT_ROLE_PERMISSIONS_SQL =
  'SELECT permission_key FROM role_permissions WHERE role_id = $1';
const DELETE_ROLE_PERMISSIONS_SQL =
  'DELETE FROM role_permissions WHERE role_id = $1 AND permission_key = ANY($2::text[])';
const INSERT_ROLE_PERMISSIONS_SQL = `INSERT INTO role_permissions (role_id, permission_key)
SELECT $1::uuid, unnest($2::text[])
ON CONFLICT DO NOTHING`;
const BUMP_TEMPLATE_VERSION_SQL =
  'UPDATE roles SET template_version = template_version + 1 WHERE id = $1 RETURNING template_version';

export async function seedCatalogue(
  exec: MigrationExecutor,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const catalogue = options.catalogue ?? PERMISSION_CATALOGUE;
  const templates = options.templates ?? ROLE_TEMPLATES;
  validateTemplates(catalogue, templates);

  return withMigrationLock(exec, async () => {
    await exec.query('BEGIN');
    try {
      const upserted = await exec.query<{ key: string; inserted: boolean }>(
        UPSERT_PERMISSIONS_SQL,
        [
          catalogue.map((p) => p.key),
          catalogue.map((p) => p.resource),
          catalogue.map((p) => p.action),
          catalogue.map((p) => p.description),
          catalogue.map((p) => p.minScope),
          catalogue.map((p) => p.platformOnly),
        ],
      );
      const inserted = upserted.rows.filter((r) => r.inserted).length;
      const orphans = (
        await exec.query<{ key: string }>(ORPHANS_SQL, [catalogue.map((p) => p.key)])
      ).rows.map((r) => r.key);

      const templateResults: SeedTemplateResult[] = [];
      for (const template of templates) {
        const role = (
          await exec.query<{ id: string; template_version: number; created: boolean }>(
            UPSERT_TEMPLATE_SQL,
            [
              newId(),
              template.key,
              template.name,
              `${template.name} (platform role template, MULTITENANCY.md §4.3)`,
            ],
          )
        ).rows[0];
        if (role === undefined)
          throw new Error(`Upsert of role template ${template.key} returned no row`);

        const current = new Set(
          (
            await exec.query<{ permission_key: string }>(SELECT_ROLE_PERMISSIONS_SQL, [role.id])
          ).rows.map((r) => r.permission_key),
        );
        const wanted = new Set<string>(template.permissions);
        const toAdd = [...wanted].filter((key) => !current.has(key));
        const toRemove = [...current].filter((key) => !wanted.has(key));
        if (toRemove.length > 0) await exec.query(DELETE_ROLE_PERMISSIONS_SQL, [role.id, toRemove]);
        if (toAdd.length > 0) await exec.query(INSERT_ROLE_PERMISSIONS_SQL, [role.id, toAdd]);

        let templateVersion = role.template_version;
        if (!role.created && (toAdd.length > 0 || toRemove.length > 0)) {
          const bumped = await exec.query<{ template_version: number }>(BUMP_TEMPLATE_VERSION_SQL, [
            role.id,
          ]);
          templateVersion = bumped.rows[0]?.template_version ?? templateVersion + 1;
        }
        templateResults.push({
          key: template.key,
          roleId: role.id,
          created: role.created,
          permissionCount: wanted.size,
          added: toAdd.length,
          removed: toRemove.length,
          templateVersion,
        });
      }
      await exec.query('COMMIT');
      return {
        permissions: {
          total: catalogue.length,
          inserted,
          updated: upserted.rows.length - inserted,
          orphans,
        },
        templates: templateResults,
      };
    } catch (error) {
      await exec.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}
