/**
 * Dynamic FreeRADIUS client lookup (AAA_IMPLEMENTATION_PLAN.md Phase 2A).
 *
 * FreeRADIUS 3.2 reads `clients.conf` only at start-up — SIGHUP re-reads modules but not
 * clients (verified on this image, infra/freeradius/raddb/clients.conf:20). The supported way
 * to admit a NAS without restarting is the `dynamic-clients` virtual server: when a packet
 * arrives from an unknown address inside a declared dynamic network, FreeRADIUS runs a fake,
 * empty request through that server carrying only `Packet-Src-IP-Address`, and the server must
 * put the client definition into the control list. This endpoint is what `rlm_rest` calls from
 * there.
 *
 * Note the plan's own description ("a `client_map` subsection of rlm_rest") does not exist in
 * FreeRADIUS 3.2; this is the mechanism the shipped `sites-available/dynamic-clients` documents.
 *
 * SECURITY — this is the only endpoint that returns a NAS shared secret, so:
 *   - It serves nothing unless the FreeRADIUS -> API leg is TLS in production
 *     (HERMES_AAA_AUDIT.md F-002). Serving `User-Password` over a cleartext leg is already
 *     acknowledged; serving every NAS secret over it is not, so this fails closed instead.
 *   - An unknown, inactive, soft-deleted or undecryptable NAS answers 404 with no body, which
 *     FreeRADIUS treats as "no dynamic client" and silently discards the packet. The reply never
 *     distinguishes those cases, so the endpoint cannot be used to enumerate registered NAS.
 *   - The secret is validated against the same alphabet the renderer enforces, so a value that
 *     could break out of the generated configuration is refused rather than returned.
 *   - The secret is never logged, and never appears in a response that is not a 200.
 */
import { withPlatform, type Db } from '@ecloud/db';
import { isIP } from 'node:net';
import type { Request, RequestHandler, Response } from 'express';
import type { AppDeps } from '../context.js';
import { openNasSecret } from '../crypto.js';
import { ANY_IP_ADAPTERS, ANY_IP_SHORTNAME } from '@ecloud/shared';
import { FLEET_DEFAULT_RADIUS_SECRET, SECRET_RE } from '../radius-clients/render.js';

/** `rlm_rest` JSON: one attribute per key, `control:` targets the control list. */
export interface DynamicClientReply {
  'control:FreeRADIUS-Client-IP-Address': string;
  'control:FreeRADIUS-Client-Secret': string;
  'control:FreeRADIUS-Client-Shortname': string;
  /** FreeRADIUS rejects `auto` here: the value must be literally `yes` or `no`. */
  'control:FreeRADIUS-Client-Require-MA': 'yes' | 'no';
  'control:FreeRADIUS-Client-NAS-Type': string;
}

export interface NasSecretLookup {
  id: string;
  nasIp: string;
  secret: string;
  requireMessageAuthenticator: boolean;
}

/**
 * The NAS registered at `ip`, with its secret opened, or null when there is none to serve.
 * Mirrors the renderer's selection (`radius-clients/load.ts`): active, not soft-deleted, and
 * not belonging to a soft-deleted organization.
 */
export async function lookupNasByAddress(
  dbPlatform: Db,
  dataEncryptionKey: string,
  ip: string,
): Promise<NasSecretLookup | null> {
  const row = await withPlatform(
    dbPlatform,
    { reason: 'radius:clients:dynamic-lookup', actorType: 'system' },
    async (trx) =>
      trx
        .selectFrom('nas_clients as n')
        .innerJoin('organizations as o', 'o.id', 'n.organization_id')
        .select([
          'n.id',
          'n.organization_id',
          'n.nas_ip',
          'n.secret_ref',
          'n.secret_version',
          'n.require_message_authenticator',
        ])
        .where('n.status', '=', 'active')
        .where('n.deleted_at', 'is', null)
        .where('o.deleted_at', 'is', null)
        .where('n.nas_ip', '=', ip)
        .executeTakeFirst(),
  );
  if (row === undefined) return lookupAnyIpClient(dbPlatform, ip);

  let secret: string;
  try {
    secret = openNasSecret(dataEncryptionKey, String(row.secret_ref), {
      organizationId: String(row.organization_id),
      nasId: String(row.id),
      secretVersion: Number(row.secret_version),
    });
  } catch {
    // Tampered, sealed under another key, or — task 10 — bound to a different row: skip this
    // NAS exactly as the renderer does.
    return null;
  }
  // Same rule as the rendered file (SECRET_RE, floor 12 per D-071): a secret that cannot be
  // expressed safely is not served. (The Meraki cloud path additionally refuses the public fleet
  // default; see radius-clients/meraki.ts.)
  if (!SECRET_RE.test(secret)) return null;

  return {
    id: String(row.id),
    nasIp: String(row.nas_ip),
    secret,
    requireMessageAuthenticator: row.require_message_authenticator !== false,
  };
}

/**
 * GET /internal/radius/client?ip=<address>
 *
 * 200 with the control attributes when a NAS is registered at that address; 404 with no body in
 * every other case (unknown, inactive, deleted, undecryptable, bad address), so the answer
 * leaks nothing about which addresses are registered.
 */
/**
 * D-086 "any NAS IP": an unknown source address is admitted when at least one live any-IP NAS
 * exists (nas_ip NULL, EZELINK adapter). The client gets the static fleet secret (D-085) and the
 * shortname `anyip`; the NAS row is chosen per request by NAS-Identifier (aaa.ts resolveNas).
 * Message-Authenticator is required only when every any-IP row requires it: a fleet AP on a
 * firmware older than the radcli fix sends none.
 */
async function lookupAnyIpClient(dbPlatform: Db, ip: string): Promise<NasSecretLookup | null> {
  const rows = await withPlatform(
    dbPlatform,
    { reason: 'radius:clients:dynamic-lookup', actorType: 'system' },
    (trx) =>
      trx
        .selectFrom('nas_clients as n')
        .innerJoin('organizations as o', 'o.id', 'n.organization_id')
        .select(['n.require_message_authenticator'])
        .where('n.status', '=', 'active')
        .where('n.deleted_at', 'is', null)
        .where('o.deleted_at', 'is', null)
        .where('n.nas_ip', 'is', null)
        .where('n.adapter_key', 'in', [...ANY_IP_ADAPTERS])
        .limit(50)
        .execute(),
  );
  if (rows.length === 0) return null;
  return {
    id: ANY_IP_SHORTNAME,
    nasIp: ip,
    secret: FLEET_DEFAULT_RADIUS_SECRET,
    requireMessageAuthenticator: rows.every((r) => r.require_message_authenticator !== false),
  };
}

export interface DynamicClientOptions {
  /** Seam for tests: the database lookup, so the guards can be exercised without a database. */
  lookup?: (ip: string) => Promise<NasSecretLookup | null>;
}

export function dynamicClientHandler(
  deps: AppDeps,
  options: DynamicClientOptions = {},
): RequestHandler {
  const lookup =
    options.lookup ??
    ((ip: string) => lookupNasByAddress(deps.dbPlatform, deps.config.dataEncryptionKey, ip));
  return async (req: Request, res: Response) => {
    // Fail closed: never hand NAS secrets to a cleartext leg in production (F-002).
    if (deps.config.base.isProduction && deps.config.internalTls === null) {
      req.log.error(
        'dynamic client lookup refused: the internal listener is not TLS (set INTERNAL_TLS_CERT_FILE / INTERNAL_TLS_KEY_FILE)',
      );
      res.status(503).end();
      return;
    }

    const raw = req.query['ip'];
    const ip = typeof raw === 'string' ? raw.trim() : '';
    if (ip === '' || isIP(ip) === 0) {
      res.status(404).end();
      return;
    }

    let found: NasSecretLookup | null;
    try {
      found = await lookup(ip);
    } catch (error) {
      // A database failure must not admit a client: answer as "no dynamic client".
      req.log.error({ err: error }, 'dynamic client lookup failed');
      res.status(503).end();
      return;
    }
    if (found === null) {
      res.status(404).end();
      return;
    }

    const reply: DynamicClientReply = {
      'control:FreeRADIUS-Client-IP-Address': found.nasIp,
      'control:FreeRADIUS-Client-Secret': found.secret,
      'control:FreeRADIUS-Client-Shortname': found.id,
      'control:FreeRADIUS-Client-Require-MA': found.requireMessageAuthenticator ? 'yes' : 'no',
      'control:FreeRADIUS-Client-NAS-Type': 'other',
    };
    res.status(200).json(reply);
  };
}
