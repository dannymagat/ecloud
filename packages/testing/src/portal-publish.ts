/**
 * Publishing a fixture captive portal (migration 038).
 *
 * The portal runtime serves the published snapshot, never the draft row, so a test that inserts a
 * `captive_portals` row and stops has built a portal no guest can use: every flow read answers
 * `flow_not_found`. This helper is the test-side equivalent of
 * `POST /captive-portals/{id}/publish`.
 *
 * It writes the snapshot directly rather than calling the API because most suites are testing the
 * portal runtime, not the admin surface, and should not need an authenticated administrator to set
 * up a portal. Suites that test publishing itself go through the route.
 */
import type { Db } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import { sql } from 'kysely';
import type { Pool } from 'pg';

export interface PublishPortalInput {
  readonly organizationId: string;
  readonly captivePortalId: string;
  readonly name?: string;
  readonly methods: readonly string[];
  readonly methodOrder?: readonly string[];
  readonly templateKey?: string;
  readonly termsVersion?: string | null;
  readonly redirectUrl?: string | null;
  /** `{ colors, strings, logo_asset_id, custom_css }`; null = the portal has no theme. */
  readonly theme?: {
    readonly colors?: Record<string, unknown>;
    readonly strings?: Record<string, unknown>;
    readonly logo_asset_id?: string | null;
    readonly custom_css?: string | null;
  } | null;
  readonly locales?: readonly string[];
  readonly registrationFields?: readonly Record<string, unknown>[];
}

export function portalSnapshotFor(input: PublishPortalInput): Record<string, unknown> {
  const locales = input.locales === undefined || input.locales.length === 0 ? ['en'] : [...input.locales];
  return {
    template_key: input.templateKey ?? 'branded_multi_login',
    name: input.name ?? 'Portal',
    methods: [...input.methods],
    method_order: input.methodOrder === undefined ? [] : [...input.methodOrder],
    identity_provider_ids: [],
    redirect_url: input.redirectUrl ?? null,
    terms_version: input.termsVersion === undefined ? '1' : input.termsVersion,
    theme:
      input.theme === undefined || input.theme === null
        ? null
        : {
            colors: input.theme.colors ?? {},
            strings: input.theme.strings ?? {},
            logo_asset_id: input.theme.logo_asset_id ?? null,
            custom_css: input.theme.custom_css ?? null,
          },
    locales,
    default_locale: locales[0] ?? 'en',
    registration_fields:
      input.registrationFields === undefined ? [] : [...input.registrationFields],
  };
}

/**
 * Inserts the next snapshot version and points the portal at it, the way the publish route does.
 * Returns the new `portal_versions.id`.
 *
 * `db` is anything with a `query(sql, params)`: a `pg` Pool, or a Kysely instance's driver. The
 * two signatures suites actually use are a Pool and a Kysely `Db`, so both are accepted.
 */
export async function publishPortalFixture(
  db: Pick<Pool, 'query'>,
  input: PublishPortalInput,
): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO portal_versions (id, organization_id, captive_portal_id, version, snapshot)
     SELECT $1, $2, $3, coalesce(max(version), 0) + 1, $4::jsonb
       FROM portal_versions WHERE captive_portal_id = $3`,
    [id, input.organizationId, input.captivePortalId, JSON.stringify(portalSnapshotFor(input))],
  );
  await db.query('UPDATE captive_portals SET published_version_id = $1 WHERE id = $2', [
    id,
    input.captivePortalId,
  ]);
  return id;
}

/**
 * The Kysely form, for the suites that build fixtures through `deps.dbPlatform` rather than a raw
 * pool. Same effect as {@link publishPortalFixture}.
 */
export async function publishPortalFixtureKysely(
  db: Db,
  input: PublishPortalInput,
): Promise<string> {
  const id = newId();
  const snapshot = JSON.stringify(portalSnapshotFor(input));
  await sql`
    INSERT INTO portal_versions (id, organization_id, captive_portal_id, version, snapshot)
    SELECT ${id}::uuid, ${input.organizationId}::uuid, ${input.captivePortalId}::uuid,
           coalesce(max(version), 0) + 1, ${snapshot}::jsonb
      FROM portal_versions WHERE captive_portal_id = ${input.captivePortalId}::uuid
  `.execute(db);
  await db
    .updateTable('captive_portals')
    .set({ published_version_id: id })
    .where('id', '=', input.captivePortalId)
    .execute();
  return id;
}
