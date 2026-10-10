/**
 * Reads the NAS allow-list for the FreeRADIUS renderer through the platform (BYPASSRLS) role
 * and resolves each sealed `secret_ref` (`enc:v1...`, NAS_SECRET_PURPOSE envelope of the data
 * key, apps/api/src/crypto.ts). The selection mirrors `resolveNas()` in internal/aaa.ts (active,
 * not soft-deleted) and additionally drops NAS rows of soft-deleted organizations.
 *
 * A secret that cannot be opened (unknown scheme, tampered ciphertext) skips that row only; a
 * key that opens none of the sealed secrets fails the whole render (previous file kept).
 */
import { withPlatform, type Db } from '@ecloud/db';
import { Envelope, NAS_SECRET_PURPOSE, SECRET_REF_PREFIX, openSecretRef } from '../crypto.js';
import { RadiusClientsRenderError, type NasClientEntry, type SkippedNas } from './render.js';

export interface NasClientRow {
  id: string;
  nasIp: string;
  secretRef: string;
  requireMessageAuthenticator: boolean;
}

export interface LoadNasOptions {
  /**
   * Restrict to these organizations. Integration tests only (the shared test database holds
   * other suites' rows with placeholder secrets); the CLI always renders every tenant.
   */
  organizationIds?: readonly string[];
}

export async function loadNasClientRows(
  dbPlatform: Db,
  options: LoadNasOptions = {},
): Promise<NasClientRow[]> {
  const rows = await withPlatform(
    dbPlatform,
    { reason: 'radius:clients:render', actorType: 'system' },
    async (trx) => {
      let query = trx
        .selectFrom('nas_clients as n')
        .innerJoin('organizations as o', 'o.id', 'n.organization_id')
        .select(['n.id', 'n.nas_ip', 'n.secret_ref', 'n.require_message_authenticator'])
        .where('n.status', '=', 'active')
        .where('n.deleted_at', 'is', null)
        .where('o.deleted_at', 'is', null)
        // Cycle E: Meraki NAS have no source address; they get per-NAS listeners (meraki.ts).
        .where('n.nas_ip', 'is not', null);
      if (options.organizationIds !== undefined) {
        if (options.organizationIds.length === 0) return [];
        query = query.where('n.organization_id', 'in', [...options.organizationIds]);
      }
      return query.orderBy('n.id').execute();
    },
  );
  return rows.map((row) => ({
    id: String(row.id),
    nasIp: String(row.nas_ip),
    secretRef: String(row.secret_ref),
    requireMessageAuthenticator: row.require_message_authenticator !== false,
  }));
}

export interface ResolvedNas {
  entries: NasClientEntry[];
  skipped: SkippedNas[];
}

/**
 * Opens every sealed secret. A row whose ref cannot be opened is skipped (reported by id). If
 * NOT ONE `enc:` ref opens, the key itself is wrong (rotated / mismatched DATA_ENCRYPTION_KEY):
 * that is a global failure, nothing may be written.
 */
export function resolveNasSecrets(
  rows: readonly NasClientRow[],
  dataEncryptionKey: string,
): ResolvedNas {
  const envelope = new Envelope(dataEncryptionKey, NAS_SECRET_PURPOSE);
  const entries: NasClientEntry[] = [];
  const skipped: SkippedNas[] = [];
  let sealed = 0;
  let opened = 0;
  for (const row of rows) {
    const isSealed = row.secretRef.startsWith(SECRET_REF_PREFIX);
    if (isSealed) sealed += 1;
    let secret: string;
    try {
      secret = openSecretRef(envelope, row.secretRef);
    } catch {
      skipped.push({
        id: row.id,
        reason: isSealed
          ? 'secret_ref cannot be opened with DATA_ENCRYPTION_KEY'
          : 'secret_ref scheme is not supported',
      });
      continue;
    }
    opened += 1;
    entries.push({
      id: row.id,
      nasIp: row.nasIp,
      secret,
      requireMessageAuthenticator: row.requireMessageAuthenticator,
    });
  }
  if (sealed > 0 && opened === 0) {
    throw new RadiusClientsRenderError(
      `DATA_ENCRYPTION_KEY opens none of the ${String(sealed)} sealed NAS secrets (wrong key?)`,
    );
  }
  return { entries, skipped };
}
