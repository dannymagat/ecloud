/**
 * Tenant bootstrap: the minimum set of rows a NAS needs before a guest can reach the internet
 * (owner instruction, 2026-10-14: "create and populate database with default user and all
 * default value needed to allow sample user to access internet").
 *
 * WHY THIS EXISTS AS A SCRIPT RATHER THAN ADMIN CLICKS. Two of the values it writes cannot be
 * written through the API at all. `POST /nas/:id/rotate-secret` and the portal's
 * rotate-uam-secret both GENERATE a random secret and show it once; neither accepts a value.
 * That is deliberate product behaviour — a human never chooses a shared secret — and it is
 * exactly what the owner's instruction requires us to bypass. Everything else here could be
 * done in the admin; those two could not, which is the whole reason the script exists.
 *
 * WHY IT IS NOT PART OF `packages/db` seed. That seed runs on every deployment and reconciles
 * platform truth: the permission catalogue and the role templates, which are code. This writes
 * one customer's data. Mixing them would mean a deploy could recreate a tenant's NAS.
 *
 * NO SECRET IS WRITTEN IN THIS FILE. Every secret — the two shared secrets and the sample
 * user's password — is supplied at run time through the environment and never committed. The
 * values the owner chose are platform defaults published by the controller, which makes them
 * non-secret in effect, but a non-secret credential in a git repository is still a credential
 * in a git repository: it outlives the decision, it is copied into forks and backups, and the
 * next reader cannot tell it was deliberate. The caller supplies them; this module seals them.
 *
 * IDEMPOTENT. Every step is find-or-create keyed on a natural identifier, and re-running
 * reconciles rather than duplicates. The next NAS, the Pending List work and the fleet-default
 * rollout all want a repeatable path, and a bootstrap that cannot be run twice gets run once,
 * by hand, differently each time.
 *
 * AUDIT. Every write emits an `audit_logs` row with `actor_type = 'system'` naming this script
 * and the owner's authorisation. The sealed-secret steps record in their `after` payload that
 * the value is a published platform default providing no secrecy, so a later reader does not
 * have to guess why a NAS secret is a dictionary word, and does not "fix" it into something the
 * controller no longer matches.
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '@ecloud/db';
import { newId } from '@ecloud/shared';
import { sealNasSecret } from '../crypto.js';
import { sealUamSecret } from '../internal/portal.js';
import { buildSnapshot } from '../internal/portal-snapshot.js';

export interface BootstrapInput {
  readonly organizationId: string;
  readonly siteName: string;
  /** `sites.slug`, required and unique per organization. */
  readonly siteSlug: string;
  readonly timezone: string;
  readonly nasName: string;
  readonly nasIdentifier: string;
  /** CIDR, e.g. `192.168.203.226/32`. */
  readonly nasIp: string;
  readonly adapterKey: string;
  /**
   * RADIUS shared secret, from the environment. When this is the published platform default it
   * provides no secrecy: a captured Access-Request yields the User-Password, and
   * Message-Authenticator is an HMAC keyed on it, so the protection it normally gives is absent.
   * Security for a production NAS rests on replacing it per NAS before real use.
   */
  readonly radiusSecret: string;
  /** UAM signing secret, from the environment. Same caveat as `radiusSecret`. */
  readonly uamSecret: string;
  /** True when the supplied secrets are the controller's published defaults; recorded in audit. */
  readonly secretsArePlatformDefaults: boolean;
  readonly portalName: string;
  /** `captive_portals.public_slug`, the portal's own URL segment. */
  readonly portalSlug: string;
  /** `captive_portals.network_ref`: how the adapter names this network to the NAS. */
  readonly networkRef: string;
  readonly walledGarden: readonly string[];
  readonly policyName: string;
  readonly downloadKbps: number;
  readonly uploadKbps: number;
  readonly username: string;
  /** Argon2id hash. The clear password never reaches this module. */
  readonly passwordHash: string;
  readonly userValidDays: number;
  readonly dataEncryptionKey: string;
  readonly now: Date;
}

export interface BootstrapStep {
  readonly entity: string;
  readonly id: string;
  readonly created: boolean;
}

type Db = Kysely<Database>;

/**
 * Key-order-independent JSON, for comparing a snapshot we just built against one PostgreSQL
 * returned. `jsonb` stores keys in its own order, so a plain `JSON.stringify` of the two never
 * matches and every run would publish an identical new version.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function secretNote(isDefault: boolean): string {
  return isDefault
    ? 'platform default published by the controller; provides no secrecy, replace per NAS before production use'
    : 'tenant-specific value supplied at run time';
}

async function audit(
  db: Db,
  organizationId: string,
  action: string,
  targetType: string,
  targetId: string,
  after: Record<string, unknown>,
): Promise<void> {
  await db
    .insertInto('audit_logs')
    .values({
      organization_id: organizationId,
      actor_type: 'system',
      action,
      target_type: targetType,
      target_id: targetId,
      before: JSON.stringify({}),
      after: JSON.stringify({ ...after, script: 'apps/api/src/bootstrap/tenant.ts' }),
    })
    .execute();
}

/**
 * Creates the rows, or adopts the ones already there.
 *
 * The caller runs this inside ONE transaction. A half-bootstrapped tenant — a NAS with no
 * portal, a portal with no published version — is the state this exercise spent a day escaping,
 * and the database can refuse to produce it for us.
 */
export async function bootstrapTenant(
  db: Db,
  input: BootstrapInput,
): Promise<readonly BootstrapStep[]> {
  const steps: BootstrapStep[] = [];
  const note = secretNote(input.secretsArePlatformDefaults);

  // --- site ---------------------------------------------------------------------------------
  // Matched on name within the organization, which is what the unique index uses. A soft-deleted
  // site of that name is REVIVED rather than duplicated: two sites with one name is exactly the
  // confusion that cost an afternoon, and the index would refuse the second anyway.
  // Live first, then newest, for the reason the NAS query learned on 2026-10-15: picking an
  // arbitrary row among a live one and older deleted ones revives the wrong row. `uq_sites_org_slug`
  // is partial on `deleted_at IS NULL`, so deleted rows CAN share a name or slug with a live one.
  // Matched on name, not slug: production's live EZELINK-HQ carries slug `ezelink123` while a
  // DELETED row holds `ezelink-hq`, which is this CLI's default — matching on slug would revive
  // the deleted row and leave two live sites with the NAS still pointing at the first.
  const existingSite = await db
    .selectFrom('sites')
    .select(['id', 'deleted_at'])
    .where('organization_id', '=', input.organizationId)
    .where('name', '=', input.siteName)
    .orderBy(sql`(deleted_at is null)`, 'desc')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  let siteId: string;
  if (existingSite === undefined) {
    const row = await db
      .insertInto('sites')
      .values({
        organization_id: input.organizationId,
        name: input.siteName,
        slug: input.siteSlug,
        timezone: input.timezone,
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    siteId = row.id;
    steps.push({ entity: 'site', id: siteId, created: true });
    await audit(db, input.organizationId, 'site:create', 'site', siteId, { name: input.siteName });
  } else {
    siteId = existingSite.id;
    if (existingSite.deleted_at !== null) {
      await db
        .updateTable('sites')
        .set({ deleted_at: null, status: 'active' })
        .where('id', '=', siteId)
        .execute();
      await audit(db, input.organizationId, 'site:restore', 'site', siteId, {
        note: 'soft-deleted site with the bootstrap name revived rather than duplicated',
      });
    }
    steps.push({ entity: 'site', id: siteId, created: false });
  }

  // --- NAS ------------------------------------------------------------------------------
  // Matched on nas_identifier, which is what the portal's byNasid lookup keys on. Two live rows
  // sharing an identifier make that lookup ambiguous, so a soft-deleted row is revived and
  // re-pointed rather than a second one added.
  //
  // A LIVE row with the identifier must win over any deleted one. The first production run
  // (2026-10-15) ordered by created_at alone, picked the newest row (soft-deleted), revived it
  // and set its address, and collided on uq_nas_clients_ip with the older row still live on
  // that address. Live first, then newest: a live row is reconciled in place, and a deleted row
  // is revived only when nothing live carries the identifier.
  const existingNas = await db
    .selectFrom('nas_clients')
    .select(['id', 'secret_version'])
    .where('organization_id', '=', input.organizationId)
    .where('nas_identifier', '=', input.nasIdentifier)
    .orderBy(sql`(deleted_at is null)`, 'desc')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  // Task 10: there is NO shared `sealedNasSecret` any more, and that is the point of the change.
  // One ciphertext was computed here and written to whichever row the branch below chose; under
  // the v2 envelope a ciphertext is bound to one row id and one version, so a value sealed for
  // the insert cannot legally be written by the update, and vice versa. Each branch seals its own.
  let nasId: string;
  if (existingNas === undefined) {
    // The id is pre-generated because the seal needs it; the insert then carries it.
    nasId = newId();
    await db
      .insertInto('nas_clients')
      .values({
        id: nasId,
        organization_id: input.organizationId,
        site_id: siteId,
        name: input.nasName,
        nas_identifier: input.nasIdentifier,
        nas_ip: input.nasIp,
        adapter_type_key: input.adapterKey,
        adapter_key: input.adapterKey,
        secret_ref: sealNasSecret(input.dataEncryptionKey, input.radiusSecret, {
          organizationId: input.organizationId,
          nasId,
          secretVersion: 1,
        }),
        status: 'active',
      })
      .execute();
    steps.push({ entity: 'nas_client', id: nasId, created: true });
  } else {
    nasId = existingNas.id;
    // The version RISES on the reconcile path. Bootstrap takes the secret from the environment
    // and cannot tell whether it differs from the one already sealed in the row without opening
    // it, so it treats every reconcile as a possible rotation. Over-counting a rotation is
    // harmless — the counter is monotonic and only its order matters — whereas writing a new
    // plaintext at an unchanged version would leave the previous ciphertext replayable.
    const nextVersion = Number(existingNas.secret_version) + 1;
    await db
      .updateTable('nas_clients')
      .set({
        deleted_at: null,
        status: 'active',
        site_id: siteId,
        name: input.nasName,
        nas_ip: input.nasIp,
        adapter_type_key: input.adapterKey,
        adapter_key: input.adapterKey,
        secret_ref: sealNasSecret(input.dataEncryptionKey, input.radiusSecret, {
          organizationId: input.organizationId,
          nasId,
          secretVersion: nextVersion,
        }),
        secret_version: nextVersion,
      })
      .where('id', '=', nasId)
      .execute();
    steps.push({ entity: 'nas_client', id: nasId, created: false });
  }
  await audit(db, input.organizationId, 'nas:secret:set', 'nas_client', nasId, {
    secret: note,
    adapter_key: input.adapterKey,
    nas_ip: input.nasIp,
  });

  // --- portal, published in the same transaction ------------------------------------------
  // Migration 038: an unpublished portal serves guests nothing, so the version is written and
  // pointed at here rather than left as a step someone has to remember.
  const existingPortal = await db
    .selectFrom('captive_portals')
    .select(['id', 'uam_secret_version'])
    .where('organization_id', '=', input.organizationId)
    .where('site_id', '=', siteId)
    .where('portal_type', '=', 'uspot')
    .executeTakeFirst();
  // As with the NAS above: no shared ciphertext, because each row's seal is bound to that row.
  const draft = {
    name: input.portalName,
    template_key: 'quick_connect',
    auth_methods: ['password'],
    method_order: ['password'],
    identity_provider_ids: [],
    redirect_url: null,
    terms_version: null,
    registration_fields: [],
    locales: ['en'],
    theme: null,
  } as const;
  const snapshot = buildSnapshot(draft);
  let portalId: string;
  if (existingPortal === undefined) {
    portalId = newId();
    await db
      .insertInto('captive_portals')
      .values({
        id: portalId,
        organization_id: input.organizationId,
        site_id: siteId,
        name: input.portalName,
        public_slug: input.portalSlug,
        network_ref: input.networkRef,
        portal_type: 'uspot',
        auth_methods: [...draft.auth_methods],
        walled_garden: [...input.walledGarden],
        uam_secret_ref: sealUamSecret(input.dataEncryptionKey, input.uamSecret, {
          organizationId: input.organizationId,
          portalId,
          secretVersion: 1,
        }),
        status: 'active',
      })
      .execute();
    steps.push({ entity: 'captive_portal', id: portalId, created: true });
  } else {
    portalId = existingPortal.id;
    const nextUamVersion = Number(existingPortal.uam_secret_version) + 1;
    await db
      .updateTable('captive_portals')
      .set({
        status: 'active',
        name: input.portalName,
        auth_methods: [...draft.auth_methods],
        walled_garden: [...input.walledGarden],
        uam_secret_ref: sealUamSecret(input.dataEncryptionKey, input.uamSecret, {
          organizationId: input.organizationId,
          portalId,
          secretVersion: nextUamVersion,
        }),
        uam_secret_version: nextUamVersion,
      })
      .where('id', '=', portalId)
      .execute();
    steps.push({ entity: 'captive_portal', id: portalId, created: false });
  }
  // Publish only when the snapshot actually differs. Re-running must not stack identical
  // versions: a history where every entry is the same is one nobody can read, and rollback
  // becomes guesswork.
  const published = await db
    .selectFrom('captive_portals as p')
    .leftJoin('portal_versions as v', 'v.id', 'p.published_version_id')
    .select(['v.id as version_id', 'v.snapshot as snapshot'])
    .where('p.id', '=', portalId)
    .executeTakeFirst();
  const publishedId = published?.version_id ?? null;
  const unchanged = publishedId !== null && canonical(published?.snapshot) === canonical(snapshot);
  if (unchanged) {
    steps.push({ entity: 'portal_version', id: String(publishedId), created: false });
  } else {
    const maxVersion = await db
      .selectFrom('portal_versions')
      .select((eb) => eb.fn.coalesce(eb.fn.max('version'), eb.lit(0)).as('v'))
      .where('captive_portal_id', '=', portalId)
      .executeTakeFirst();
    const versionRow = await db
      .insertInto('portal_versions')
      .values({
        organization_id: input.organizationId,
        captive_portal_id: portalId,
        version: Number(maxVersion?.v ?? 0) + 1,
        snapshot: JSON.stringify(snapshot),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('captive_portals')
      .set({ published_version_id: versionRow.id })
      .where('id', '=', portalId)
      .execute();
    steps.push({ entity: 'portal_version', id: versionRow.id, created: true });
  }
  await audit(db, input.organizationId, 'captive_portal:secret:set', 'captive_portal', portalId, {
    secret: note,
    published: unchanged ? 'snapshot unchanged; no new version' : 'new version published',
  });

  // --- default policy -----------------------------------------------------------------
  // `is_default` is what makes this resolve with no assignment: the engine injects it at the
  // organization_default layer when nothing more specific matched. Rule 9 requires an org
  // default to be site- or group-scoped and forbids binding it to a site_id.
  const existingPolicy = await db
    .selectFrom('policies')
    .select(['id'])
    .where('organization_id', '=', input.organizationId)
    .where('is_default', '=', true)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  let policyId: string;
  if (existingPolicy === undefined) {
    const row = await db
      .insertInto('policies')
      .values({
        organization_id: input.organizationId,
        name: input.policyName,
        scope_type: 'site',
        site_id: null,
        is_default: true,
        status: 'active',
        download_rate_kbps: input.downloadKbps,
        upload_rate_kbps: input.uploadKbps,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    policyId = row.id;
    steps.push({ entity: 'policy', id: policyId, created: true });
    await audit(db, input.organizationId, 'policy:create', 'policy', policyId, {
      is_default: true,
      download_rate_kbps: input.downloadKbps,
      upload_rate_kbps: input.uploadKbps,
    });
  } else {
    policyId = existingPolicy.id;
    steps.push({ entity: 'policy', id: policyId, created: false });
  }

  // --- sample user ----------------------------------------------------------------------
  const validUntil = new Date(input.now.getTime() + input.userValidDays * 86_400_000);
  // Same ordering, same reason: `uq_users_org_username` is partial on `deleted_at IS NULL`.
  const existingUser = await db
    .selectFrom('users')
    .select(['id'])
    .where('organization_id', '=', input.organizationId)
    .where('username', '=', input.username)
    .orderBy(sql`(deleted_at is null)`, 'desc')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  let userId: string;
  if (existingUser === undefined) {
    const row = await db
      .insertInto('users')
      .values({
        organization_id: input.organizationId,
        site_id: siteId,
        username: input.username,
        password_hash: input.passwordHash,
        auth_methods: ['password'],
        status: 'active',
        valid_from: input.now,
        valid_until: validUntil,
        origin: 'admin',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = row.id;
    steps.push({ entity: 'user', id: userId, created: true });
  } else {
    userId = existingUser.id;
    await db
      .updateTable('users')
      .set({
        deleted_at: null,
        status: 'active',
        site_id: siteId,
        password_hash: input.passwordHash,
        valid_from: input.now,
        valid_until: validUntil,
      })
      .where('id', '=', userId)
      .execute();
    steps.push({ entity: 'user', id: userId, created: false });
  }
  await audit(db, input.organizationId, 'user:bootstrap', 'user', userId, {
    username: input.username,
    valid_until: validUntil.toISOString(),
  });

  return steps;
}
