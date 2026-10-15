/**
 * Re-seal every v1 secret under the v2 bound envelope (task 10, owner-authorised 2026-10-15).
 *
 * WHAT THIS IS AND IS NOT. It is a one-shot data migration over LIVE SECRETS: it opens each v1
 * ciphertext and writes it back sealed to its own row. The PLAINTEXT NEVER CHANGES. No secret is
 * rotated, nothing a NAS or a controller is configured with becomes stale, and no device needs
 * reconfiguring afterwards.
 *
 * THE VERSION IS NOT BUMPED, and that is the decision most likely to be "corrected" by a later
 * reader. `secret_version` means "how many times has this secret been ROTATED", and it is the
 * monotonic element of the AAD. A re-seal preserves the plaintext, so raising it would record a
 * rotation that did not happen — and the version is bound into the new ciphertext, so the pair
 * must agree. Re-sealing at the current version keeps both true.
 *
 * NO RELOAD IS SIGNALLED. `signalRadiusClientsReload` exists to tell FreeRADIUS that a secret
 * clients.conf depends on has changed. Nothing it depends on has: the rendered file contains
 * plaintext secrets, and those are identical before and after. Signalling would cause a
 * re-render of byte-identical output, which is noise at best and a reload of a working estate at
 * worst.
 *
 * THE DUMP IS THE ROLLBACK. It is taken inside the SAME transaction that reads the rows, so a
 * rotation landing between the dump and the write cannot be silently reverted by a restore — if
 * one lands, this transaction fails and nothing is written. It holds only the rows this run would
 * change, because a rollback should not touch anything else.
 */
import {
  NAS_SECRET_PURPOSE,
  isV1Ref,
  openV1Ref,
  sealNasSecret,
  SECRET_REF_PREFIX,
} from '../crypto.js';
import { UAM_SECRET_PURPOSE, sealUamSecret } from '../internal/portal.js';
import type { DbTransaction } from '@ecloud/db';

export interface ResealCounts {
  /** Live rows with a non-null ref, i.e. everything a re-seal could consider. */
  readonly nas_rows: number;
  readonly nas_v1: number;
  readonly nas_v2: number;
  readonly portal_rows: number;
  readonly portal_v1: number;
  readonly portal_v2: number;
}

export interface ResealDump {
  readonly taken_at: string;
  readonly nas: readonly { id: string; secret_ref: string; secret_version: number }[];
  readonly captive_portals: readonly {
    id: string;
    uam_secret_ref: string;
    uam_secret_version: number;
  }[];
}

export interface ResealResult {
  readonly counts: ResealCounts;
  readonly dump: ResealDump;
  readonly nas_updated: number;
  readonly portals_updated: number;
}

interface NasRow {
  id: string;
  organization_id: string;
  secret_ref: string;
  secret_version: number;
}

interface PortalRow {
  id: string;
  organization_id: string;
  uam_secret_ref: string;
  uam_secret_version: number;
}

async function readRows(
  trx: DbTransaction,
): Promise<{ nas: NasRow[]; portals: PortalRow[] }> {
  const nasRows = await trx
    .selectFrom('nas_clients')
    .select(['id', 'organization_id', 'secret_ref', 'secret_version'])
    .where('deleted_at', 'is', null)
    .orderBy('id')
    .execute();
  // captive_portals has no deleted_at, so every row is live; the ref is nullable there.
  const portalRows = await trx
    .selectFrom('captive_portals')
    .select(['id', 'organization_id', 'uam_secret_ref', 'uam_secret_version'])
    .orderBy('id')
    .execute();
  return {
    nas: nasRows
      .filter((r) => typeof r.secret_ref === 'string' && r.secret_ref !== '')
      .map((r) => ({
        id: String(r.id),
        organization_id: String(r.organization_id),
        secret_ref: String(r.secret_ref),
        secret_version: Number(r.secret_version),
      })),
    portals: portalRows
      .filter((r) => typeof r.uam_secret_ref === 'string' && r.uam_secret_ref !== '')
      .map((r) => ({
        id: String(r.id),
        organization_id: String(r.organization_id),
        uam_secret_ref: String(r.uam_secret_ref),
        uam_secret_version: Number(r.uam_secret_version),
      })),
  };
}

/**
 * Count what a run would do and capture the rollback dump. Reads only — safe to call against
 * production, and what `--dry-run` reports.
 *
 * A ref that is neither v1 nor v2 (the `env:` and `secret://` shapes some fixtures write, which
 * no production code can open) is counted in `*_rows` but in neither `*_v1` nor `*_v2`, so a
 * mismatch between the totals is visible in the output rather than silently skipped.
 */
export async function planReseal(trx: DbTransaction): Promise<{
  counts: ResealCounts;
  dump: ResealDump;
  nas: NasRow[];
  portals: PortalRow[];
}> {
  const { nas, portals } = await readRows(trx);
  const nasV1 = nas.filter((r) => isV1Ref(r.secret_ref));
  const portalV1 = portals.filter((r) => isV1Ref(r.uam_secret_ref));
  const v2 = (ref: string): boolean => ref.startsWith(`${SECRET_REF_PREFIX}v2.`);
  return {
    counts: {
      nas_rows: nas.length,
      nas_v1: nasV1.length,
      nas_v2: nas.filter((r) => v2(r.secret_ref)).length,
      portal_rows: portals.length,
      portal_v1: portalV1.length,
      portal_v2: portals.filter((r) => v2(r.uam_secret_ref)).length,
    },
    // Only the rows a run would change. Taken here, inside the caller's transaction.
    dump: {
      taken_at: new Date().toISOString(),
      nas: nasV1.map((r) => ({
        id: r.id,
        secret_ref: r.secret_ref,
        secret_version: r.secret_version,
      })),
      captive_portals: portalV1.map((r) => ({
        id: r.id,
        uam_secret_ref: r.uam_secret_ref,
        uam_secret_version: r.uam_secret_version,
      })),
    },
    nas: nasV1,
    portals: portalV1,
  };
}

/**
 * Open each v1 ref and write it back sealed to its own row at the SAME version.
 *
 * One UPDATE per row rather than a bulk statement: each ciphertext is bound to one row id, so
 * there is nothing to batch, and a per-row statement means a single unopenable ref names itself
 * in the failure instead of taking the whole run down anonymously. The caller's transaction still
 * makes the run all-or-nothing.
 */
export async function applyReseal(
  trx: DbTransaction,
  dataEncryptionKey: string,
): Promise<ResealResult> {
  const { counts, dump, nas, portals } = await planReseal(trx);

  let nasUpdated = 0;
  for (const row of nas) {
    const body = row.secret_ref.slice(SECRET_REF_PREFIX.length);
    const plaintext = openV1Ref(dataEncryptionKey, body, NAS_SECRET_PURPOSE);
    await trx
      .updateTable('nas_clients')
      .set({
        secret_ref: sealNasSecret(dataEncryptionKey, plaintext, {
          organizationId: row.organization_id,
          nasId: row.id,
          secretVersion: row.secret_version,
        }),
        // Written explicitly and unchanged, so the statement says "the version is part of what
        // this ciphertext is bound to" rather than leaving a reader to infer it.
        secret_version: row.secret_version,
      })
      .where('id', '=', row.id)
      .execute();
    nasUpdated += 1;
  }

  let portalsUpdated = 0;
  for (const row of portals) {
    const body = row.uam_secret_ref.slice(SECRET_REF_PREFIX.length);
    const plaintext = openV1Ref(dataEncryptionKey, body, UAM_SECRET_PURPOSE);
    await trx
      .updateTable('captive_portals')
      .set({
        uam_secret_ref: sealUamSecret(dataEncryptionKey, plaintext, {
          organizationId: row.organization_id,
          portalId: row.id,
          secretVersion: row.uam_secret_version,
        }),
        uam_secret_version: row.uam_secret_version,
      })
      .where('id', '=', row.id)
      .execute();
    portalsUpdated += 1;
  }

  return { counts, dump, nas_updated: nasUpdated, portals_updated: portalsUpdated };
}

/**
 * Put the dumped refs back. The rollback, and deliberately dumb: it writes exactly what it was
 * given, with no re-derivation, because a rollback that has to be correct about cryptography is
 * not a rollback.
 */
export async function restoreReseal(
  trx: DbTransaction,
  dump: ResealDump,
): Promise<{ nas_restored: number; portals_restored: number }> {
  let nas = 0;
  for (const row of dump.nas) {
    await trx
      .updateTable('nas_clients')
      .set({ secret_ref: row.secret_ref, secret_version: row.secret_version })
      .where('id', '=', row.id)
      .execute();
    nas += 1;
  }
  let portals = 0;
  for (const row of dump.captive_portals) {
    await trx
      .updateTable('captive_portals')
      .set({ uam_secret_ref: row.uam_secret_ref, uam_secret_version: row.uam_secret_version })
      .where('id', '=', row.id)
      .execute();
    portals += 1;
  }
  return { nas_restored: nas, portals_restored: portals };
}
