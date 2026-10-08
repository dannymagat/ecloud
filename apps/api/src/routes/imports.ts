/**
 * Subscriber CSV import (API_ARCHITECTURE.md §3.2 `{o}/users/import`).
 *
 * - Body `{ csv, dry_run? }` (JSON, ≤ 1 MB like every public body; no multipart dependency).
 *   Header row required; columns: `username` (required), `password`, `display_name`, `email`,
 *   `phone`, `site_id`, `user_group_id`, `status`, `valid_from`, `valid_until`, `max_devices`,
 *   `auth_methods` (`;`-separated). Unknown columns are rejected.
 * - Validation is all-or-nothing: every row is checked with the same schema as
 *   `POST /users`, duplicate usernames inside the file and references (`site_id`,
 *   `user_group_id`, re-checked inside the tenant, G9) are reported per row as a 400 with
 *   `errors[].path = body.csv.rows[<line>].<column>`; nothing is written then.
 * - Idempotent: usernames that already exist (case-insensitive) are skipped, not updated, so
 *   re-running the same file creates nothing new; `Idempotency-Key` is required as for every
 *   import (API_ARCHITECTURE.md §3.1).
 * - Synchronous and capped at MAX_IMPORT_ROWS (Argon2id per password); larger files are a
 *   Phase 5 async job.
 */
import { hashPassword } from '@ecloud/db';
import { ForbiddenError, ValidationError, newId, type ValidationIssue } from '@ecloud/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { evaluate } from '../auth/authorize.js';
import type { AppDeps } from '../context.js';
import { OrgParams, problemResponses } from '../http/common.js';
import { CsvParseError, parseCsv } from '../http/csv.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { inTenant } from '../tenant.js';
import { UserCreate } from './resources.js';

export const MAX_IMPORT_ROWS = 500;

export const IMPORT_COLUMNS = [
  'username',
  'password',
  'display_name',
  'email',
  'phone',
  'site_id',
  'user_group_id',
  'status',
  'valid_from',
  'valid_until',
  'max_devices',
  'auth_methods',
] as const;
type ImportColumn = (typeof IMPORT_COLUMNS)[number];

const ImportBody = z.strictObject({
  csv: z.string().min(1).max(900_000),
  dry_run: z.boolean().optional(),
});

const ImportQuery = z.object({
  dry_run: z.enum(['true', 'false', '1', '0']).optional(),
});

const ImportResult = z.object({
  dry_run: z.boolean(),
  created: z.number().int(),
  skipped: z.array(z.object({ row: z.number().int(), username: z.string(), reason: z.string() })),
  users: z.array(
    z.object({ row: z.number().int(), id: z.string().nullable(), username: z.string() }),
  ),
});

type UserRow = z.output<typeof UserCreate>;

interface ParsedRow {
  line: number;
  value: UserRow;
}

/** CSV cell → the JSON value `POST /users` would receive (empty cell = column not given). */
function toInput(
  header: readonly ImportColumn[],
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  header.forEach((column, i) => {
    const raw = (fields[i] ?? '').trim();
    if (raw === '') return;
    if (column === 'max_devices') out[column] = /^\d+$/.test(raw) ? Number(raw) : raw;
    else if (column === 'auth_methods') {
      out[column] = raw
        .split(';')
        .map((m) => m.trim())
        .filter((m) => m !== '');
    } else out[column] = column === 'password' ? (fields[i] ?? '') : raw;
  });
  return out;
}

export function parseUserCsv(text: string): { rows: ParsedRow[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (error) {
    const line = error instanceof CsvParseError ? error.line : 0;
    return {
      rows: [],
      issues: [{ path: `body.csv.rows[${String(line)}]`, message: (error as Error).message }],
    };
  }
  const [headerRow, ...data] = table;
  if (headerRow === undefined) {
    return { rows: [], issues: [{ path: 'body.csv', message: 'header row is missing' }] };
  }
  const header = headerRow.map((h) => h.trim().toLowerCase());
  for (const h of header) {
    if (!(IMPORT_COLUMNS as readonly string[]).includes(h)) {
      issues.push({ path: 'body.csv.header', message: `unknown column ${h}` });
    }
  }
  if (new Set(header).size !== header.length) {
    issues.push({ path: 'body.csv.header', message: 'duplicate column' });
  }
  if (!header.includes('username')) {
    issues.push({ path: 'body.csv.header', message: 'column username is required' });
  }
  if (data.length === 0) issues.push({ path: 'body.csv', message: 'no data rows' });
  if (data.length > MAX_IMPORT_ROWS) {
    issues.push({ path: 'body.csv', message: `at most ${String(MAX_IMPORT_ROWS)} rows` });
  }
  if (issues.length > 0) return { rows: [], issues };

  const rows: ParsedRow[] = [];
  const seen = new Map<string, number>();
  data.forEach((fields, index) => {
    const line = index + 2; // 1-based, after the header
    const prefix = `body.csv.rows[${String(line)}]`;
    if (fields.length !== header.length) {
      issues.push({
        path: prefix,
        message: `expected ${String(header.length)} fields, got ${String(fields.length)}`,
      });
      return;
    }
    const parsed = UserCreate.safeParse(toInput(header as ImportColumn[], fields));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          path: [prefix, ...issue.path.map(String)].join('.'),
          message: issue.message,
        });
      }
      return;
    }
    const key = parsed.data.username.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      issues.push({
        path: `${prefix}.username`,
        message: `duplicate of row ${String(first)}`,
      });
      return;
    }
    seen.set(key, line);
    rows.push({ line, value: parsed.data });
  });
  return { rows, issues };
}

export function importRoutes(deps: AppDeps): AnyRouteSpec[] {
  const argonMemory = deps.config.base.argon2.memoryKib;

  const importUsers = defineRoute({
    method: 'post',
    path: '/api/v1/orgs/:orgId/users/import',
    summary: 'Import subscriber users from CSV (validated, all-or-nothing, existing skipped)',
    tags: ['users'],
    auth: 'principal',
    permission: 'user:create',
    scope: 'any-site',
    params: OrgParams,
    query: ImportQuery,
    body: ImportBody,
    idempotency: 'required',
    responses: {
      200: { description: 'Dry run: what would be created / skipped', schema: ImportResult },
      201: { description: 'Users created (existing usernames skipped)', schema: ImportResult },
      ...problemResponses,
    },
    handler: async ({ params, query, body, ctx }) => {
      const dryRun = body.dry_run === true || query.dry_run === 'true' || query.dry_run === '1';
      const { rows, issues } = parseUserCsv(body.csv);
      if (issues.length > 0) throw new ValidationError(issues.slice(0, 200));

      // Argon2id outside the transaction keeps the tenant transaction short.
      const hashes = new Map<number, string>();
      if (!dryRun) {
        for (const row of rows) {
          if (typeof row.value.password === 'string') {
            hashes.set(
              row.line,
              await hashPassword(row.value.password, { memoryKib: argonMemory }),
            );
          }
        }
      }

      const result = await inTenant(deps, params.orgId, async (trx) => {
        const refIssues: ValidationIssue[] = [];
        const siteIds = [
          ...new Set(rows.map((r) => r.value.site_id).filter((v) => typeof v === 'string')),
        ];
        const groupIds = [
          ...new Set(rows.map((r) => r.value.user_group_id).filter((v) => typeof v === 'string')),
        ];
        const sites = new Set(
          siteIds.length === 0
            ? []
            : (
                await trx
                  .selectFrom('sites')
                  .select('id')
                  .where('id', 'in', siteIds)
                  .where('deleted_at', 'is', null)
                  .execute()
              ).map((s) => s.id),
        );
        const groups = new Set(
          groupIds.length === 0
            ? []
            : (
                await trx
                  .selectFrom('user_groups')
                  .select('id')
                  .where('id', 'in', groupIds)
                  .execute()
              ).map((g) => g.id),
        );
        for (const row of rows) {
          const prefix = `body.csv.rows[${String(row.line)}]`;
          const siteId = row.value.site_id ?? null;
          if (siteId !== null && !sites.has(siteId)) {
            refIssues.push({ path: `${prefix}.site_id`, message: 'site not found' });
            continue;
          }
          const groupId = row.value.user_group_id ?? null;
          if (groupId !== null && !groups.has(groupId)) {
            refIssues.push({ path: `${prefix}.user_group_id`, message: 'user group not found' });
            continue;
          }
          // Organization-wide users need an organization grant; site users the site grant.
          if (!evaluate(ctx.principal, 'user:create', { organizationId: params.orgId, siteId })) {
            throw new ForbiddenError({
              detail: `Row ${String(row.line)}: user:create is not granted for this scope.`,
            });
          }
        }
        if (refIssues.length > 0) throw new ValidationError(refIssues.slice(0, 200));

        const existing = new Set(
          (
            await trx
              .selectFrom('users')
              .select(sql<string>`lower(username)`.as('u'))
              .where(
                sql<string>`lower(username)`,
                'in',
                rows.map((r) => r.value.username.toLowerCase()),
              )
              .where('deleted_at', 'is', null)
              .execute()
          ).map((u) => u.u),
        );
        const skipped = rows
          .filter((r) => existing.has(r.value.username.toLowerCase()))
          .map((r) => ({ row: r.line, username: r.value.username, reason: 'exists' }));
        const fresh = rows.filter((r) => !existing.has(r.value.username.toLowerCase()));
        if (dryRun) {
          return {
            skipped,
            users: fresh.map((r) => ({ row: r.line, id: null, username: r.value.username })),
          };
        }
        const users: { row: number; id: string | null; username: string }[] = [];
        if (fresh.length > 0) {
          const values = fresh.map((r) => {
            const { password: _password, auth_methods, ...rest } = r.value;
            const id = newId();
            users.push({ row: r.line, id, username: r.value.username });
            return {
              ...rest,
              id,
              organization_id: params.orgId,
              auth_methods: auth_methods ?? ['password'],
              password_hash: hashes.get(r.line) ?? null,
            };
          });
          await trx.insertInto('users').values(values).execute();
        }
        await writeAudit(trx, ctx, {
          organizationId: params.orgId,
          action: 'user:create',
          targetType: 'user_import',
          after: {
            created: users.length,
            skipped: skipped.length,
            usernames: users.map((u) => u.username),
          },
        });
        return { skipped, users };
      });
      if (dryRun) ctx.audited = true; // nothing was written: a dry run is a read
      return {
        status: dryRun ? 200 : 201,
        body: {
          dry_run: dryRun,
          created: dryRun ? 0 : result.users.length,
          skipped: result.skipped,
          users: result.users,
        },
      };
    },
  });

  return [importUsers];
}
