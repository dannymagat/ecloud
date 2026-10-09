/**
 * FreeRADIUS `clients.conf` renderer (docs/SECURITY_REVIEW_P10.md F-P10-07, AAA_ARCHITECTURE.md
 * §3). One `client` block per valid active `nas_clients` row:
 *
 *   client nas-<uuid> {
 *     ipaddr    = <nas_ip>/32 (or /128)   exact unicast host, canonical text form
 *     secret    = '<secret>'             single-quoted = literal in FreeRADIUS 3 (no expansion)
 *     shortname = <uuid>                 = nas_clients.id; the API resolves the NAS by it
 *     nas_type  = other
 *     require_message_authenticator = yes|no   nas_clients.require_message_authenticator
 *     limit_proxy_state = auto|yes             `yes` whenever Message-Authenticator is not required
 *   }
 *
 * Nothing tenant-identifying (names, NAS-Identifier, org) is written. Every value is validated
 * against a strict allow-list instead of being escaped, so no input can close the block, open a
 * new one, start a comment or trigger `${...}` / `$INCLUDE` processing.
 *
 * Per-row problems (bad address, bad secret, address shared by several rows) SKIP that row and
 * are reported by id and rule (never the secret): one broken NAS must not freeze every other
 * NAS change (F-P10-07 review). Zero valid clients is a whole-render failure: the caller keeps
 * the previous file.
 */
import { NAS_ADDRESS_RULE, canonicalNasAddress } from '@ecloud/shared';

export interface NasClientEntry {
  /** nas_clients.id (UUID). */
  id: string;
  /** nas_clients.nas_ip as returned by PostgreSQL (`inet` text form). */
  nasIp: string;
  /** Resolved shared secret (plaintext, never logged). */
  secret: string;
  requireMessageAuthenticator: boolean;
}

/** A row left out of the rendered file: id (or a fixed marker) and the violated rule only. */
export interface SkippedNas {
  id: string;
  reason: string;
}

export interface RenderOutput {
  content: string;
  rendered: NasClientEntry[];
  skipped: SkippedNas[];
}

export class RadiusClientsRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RadiusClientsRenderError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Marker used instead of an id that is not a UUID (never echo arbitrary text). */
export const INVALID_ID_MARKER = '(invalid-id)';

/**
 * Shared-secret alphabet: base64 / base64url and a few unreserved symbols. The API generates
 * 43-char base64url secrets (`randomToken(32)`); quotes, backslash, `$`, braces, `#`, whitespace
 * and control characters are rejected outright. Length 16..128 (FreeRADIUS clients.conf asks for
 * at least 16, RADIUS tooling and most NAS UIs cap at 128).
 */
export const SECRET_RE = /^[A-Za-z0-9._~+/=-]{16,128}$/;

export const SECRET_RULE = 'shared secret must be 16-128 characters of [A-Za-z0-9._~+/=-]';

export const RENDERED_HEADER =
  '# ECLOUD rendered FreeRADIUS clients (apps/api radius-clients). DO NOT EDIT: regenerated\n' +
  '# from nas_clients; contains shared secrets (keep 0640, never commit, never print).\n';

function block(entry: NasClientEntry, address: string, prefix: number): string {
  const ma = entry.requireMessageAuthenticator;
  return [
    `client nas-${entry.id} {`,
    `\tipaddr = ${address}/${String(prefix)}`,
    `\tsecret = '${entry.secret}'`,
    `\tshortname = ${entry.id}`,
    '\tnas_type = other',
    `\trequire_message_authenticator = ${ma ? 'yes' : 'no'}`,
    // radiusd.conf.in: when Message-Authenticator is not required, limit_proxy_state = yes
    // is the remaining BlastRADIUS mitigation (SECURITY_ARCHITECTURE.md §4.2).
    `\tlimit_proxy_state = ${ma ? 'auto' : 'yes'}`,
    '}',
  ].join('\n');
}

/**
 * Renders the valid entries, sorted by id (an unchanged NAS table yields a byte-identical file,
 * so no restart is needed). `priorSkipped` (e.g. undecryptable secrets) is merged into the
 * result. Throws `RadiusClientsRenderError` when no valid client remains.
 */
export function renderClientsConf(
  entries: readonly NasClientEntry[],
  priorSkipped: readonly SkippedNas[] = [],
): RenderOutput {
  const skipped: SkippedNas[] = [...priorSkipped];
  const valid: { entry: NasClientEntry; address: string; prefix: number }[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (!UUID_RE.test(entry.id) || seenIds.has(entry.id)) {
      skipped.push({
        id: UUID_RE.test(entry.id) ? entry.id : INVALID_ID_MARKER,
        reason: UUID_RE.test(entry.id) ? 'duplicate id' : 'id is not a lowercase UUID',
      });
      continue;
    }
    seenIds.add(entry.id);
    const host = canonicalNasAddress(entry.nasIp);
    if (host === null) {
      skipped.push({ id: entry.id, reason: `nas_ip ${NAS_ADDRESS_RULE}` });
      continue;
    }
    if (!SECRET_RE.test(entry.secret)) {
      skipped.push({ id: entry.id, reason: SECRET_RULE });
      continue;
    }
    valid.push({ entry, address: host.address, prefix: host.family === 4 ? 32 : 128 });
  }

  // Two rows with the same canonical address would shadow each other (FreeRADIUS matches the
  // source IP); neither can be trusted to be the real NAS, so both are left out.
  const byAddress = new Map<string, number>();
  for (const v of valid) byAddress.set(v.address, (byAddress.get(v.address) ?? 0) + 1);
  const kept = valid.filter((v) => {
    if ((byAddress.get(v.address) ?? 0) > 1) {
      skipped.push({ id: v.entry.id, reason: 'nas_ip is shared with another NAS' });
      return false;
    }
    return true;
  });

  skipped.sort((a, b) => a.id.localeCompare(b.id));
  if (kept.length === 0) {
    throw new RadiusClientsRenderError(
      skipped.length === 0
        ? 'no active NAS clients: refusing to render an empty client list'
        : `no valid NAS client (${String(skipped.length)} skipped): refusing to render an empty client list`,
    );
  }
  kept.sort((a, b) => a.entry.id.localeCompare(b.entry.id));
  return {
    content: `${RENDERED_HEADER}\n${kept.map((v) => block(v.entry, v.address, v.prefix)).join('\n\n')}\n`,
    rendered: kept.map((v) => v.entry),
    skipped,
  };
}

/** Count of clients rendered without Message-Authenticator enforcement (for the run summary). */
export function relaxedClientCount(entries: readonly NasClientEntry[]): number {
  return entries.filter((e) => !e.requireMessageAuthenticator).length;
}
