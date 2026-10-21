/**
 * GET /internal/nas/:id/secret  (D-056, option B)
 *
 * The worker that sends CoA / Disconnect never holds DATA_ENCRYPTION_KEY (its config refuses the
 * key on purpose), so it cannot open the sealed `nas_clients.secret_ref` it needs to sign a
 * Disconnect-Request. Instead it asks this endpoint, per dispatch, for the opened secret of ONE
 * NAS by id. The key stays in the api.
 *
 * Deliberate shape (stated in the D-056 commit so the owner can revisit it):
 *  - guarded by ITS OWN token, INTERNAL_SECRET_TOKEN (owner ruling 2026-10-15 19:57, D-061), and
 *    by nothing else: the shared INTERNAL_API_TOKEN is refused here, so a leak of the shared token
 *    cannot yield plaintext RADIUS secrets; the route is registered ahead of the shared guard;
 *  - one id in, one secret out, never a list: a token leak must not become a fleet dump;
 *  - no audit row per fetch (dispatches are frequent); failures are logged without the secret;
 *  - same production rule as the dynamic client lookup: refused on a cleartext internal listener
 *    unless INTERNAL_CLEARTEXT_ACK=1 accepts the risk on a private network;
 *  - 404 without a body for unknown, inactive, deleted or unopenable rows (no enumeration).
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { AppDeps } from '../context.js';
import { openNasSecret } from '../crypto.js';
import { withPlatform, type Db } from '@ecloud/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface NasSecretById {
  id: string;
  secret: string;
}

/** The opened secret of an active, live NAS, or null (unknown, inactive, deleted, unopenable). */
export async function lookupNasSecretById(
  dbPlatform: Db,
  dataEncryptionKey: string,
  id: string,
): Promise<NasSecretById | null> {
  const row = await withPlatform(
    dbPlatform,
    { reason: 'coa:nas-secret', actorType: 'system' },
    async (trx) =>
      trx
        .selectFrom('nas_clients as n')
        .innerJoin('organizations as o', 'o.id', 'n.organization_id')
        .select(['n.id', 'n.organization_id', 'n.secret_ref', 'n.secret_version'])
        .where('n.id', '=', id)
        .where('n.status', '=', 'active')
        .where('n.deleted_at', 'is', null)
        .where('o.deleted_at', 'is', null)
        .executeTakeFirst(),
  );
  if (row === undefined) return null;
  try {
    return {
      id: String(row.id),
      secret: openNasSecret(dataEncryptionKey, String(row.secret_ref), {
        organizationId: String(row.organization_id),
        nasId: String(row.id),
        secretVersion: Number(row.secret_version),
      }),
    };
  } catch {
    return null;
  }
}

export interface NasSecretOptions {
  /** Seam for tests: the database lookup. */
  lookup?: (id: string) => Promise<NasSecretById | null>;
}

/** Constant-time equality over the UTF-8 bytes; unequal lengths still do one comparison. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const same = ba.length === bb.length && timingSafeEqual(ba, bb);
  if (ba.length !== bb.length) timingSafeEqual(bb, bb);
  return same;
}

export const INTERNAL_SECRET_TOKEN_HEADER = 'X-Internal-Secret-Token';

export function nasSecretHandler(deps: AppDeps, options: NasSecretOptions = {}): RequestHandler {
  const lookup =
    options.lookup ??
    ((id: string) => lookupNasSecretById(deps.dbPlatform, deps.config.dataEncryptionKey, id));
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const expected = deps.config.internalSecretToken;
    if (expected === null) {
      req.log.error('nas secret lookup refused: INTERNAL_SECRET_TOKEN is not configured (D-061)');
      res.status(503).end();
      return;
    }
    if (!safeEqual(req.get(INTERNAL_SECRET_TOKEN_HEADER) ?? '', expected)) {
      res.status(401).end();
      return;
    }
    if (
      deps.config.base.isProduction &&
      deps.config.internalTls === null &&
      !deps.config.internalCleartextAck
    ) {
      req.log.error(
        'nas secret lookup refused: the internal listener is not TLS (set INTERNAL_TLS_CERT_FILE / INTERNAL_TLS_KEY_FILE, or INTERNAL_CLEARTEXT_ACK=1 on a private network)',
      );
      res.status(503).end();
      return;
    }
    const id = String(req.params['id'] ?? '')
      .trim()
      .toLowerCase();
    if (!UUID_RE.test(id)) {
      res.status(404).end();
      return;
    }
    let found: NasSecretById | null;
    try {
      found = await lookup(id);
    } catch (error) {
      req.log.error({ err: error, nasId: id }, 'nas secret lookup failed');
      res.status(503).end();
      return;
    }
    if (found === null) {
      res.status(404).end();
      return;
    }
    res.status(200).json({ id: found.id, secret: found.secret, request_id: randomUUID() });
  };
}
