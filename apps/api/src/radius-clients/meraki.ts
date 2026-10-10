/**
 * FreeRADIUS listeners for Cisco Meraki cloud-sourced RADIUS (multi-vendor Cycle E, D-044;
 * SECURITY_ARCHITECTURE.md §3.5; migration 032).
 *
 * The Meraki Cloud sends every customer's splash RADIUS from the same shared public ranges, and
 * FreeRADIUS chooses a client (and so a shared secret) by source address. One global client would
 * give every ECLOUD tenant the same secret. Instead each Meraki NAS gets its OWN listener pair
 * whose private client list holds the Meraki ranges with THAT NAS's secret and shortname:
 *
 *   clients meraki_<uuid-hex> {
 *     client meraki-<uuid>-<n> {            one per MERAKI_RADIUS_SOURCE_CIDRS entry
 *       ipaddr = <cidr>
 *       secret = '<this NAS's secret>'
 *       shortname = <uuid>                  = nas_clients.id; AAA resolves the NAS by it ONLY
 *       nas_type = other
 *       require_message_authenticator = yes|no
 *       limit_proxy_state = auto|yes
 *     }
 *   }
 *   listen { type = auth  ipaddr = $ENV{RADIUS_LISTEN_IP}  port = <auth>  clients = meraki_<hex>  virtual_server = ecloud }
 *   listen { type = acct  ... port = <auth + 1> ... }
 *
 * Rendered ONLY when MERAKI_CLOUD_RADIUS_ENABLED is true AND source ranges and a port range are
 * configured; otherwise the file holds only a comment (no listener, no client). Values are
 * validated against strict allow-lists (ids, ports, CIDRs, secrets), never escaped.
 */
import { withPlatform, type Db } from '@ecloud/db';
import {
  canonicalMerakiSourceCidr,
  merakiCloudRadiusState,
  merakiListenersRenderable,
  type MerakiCloudRadiusSettings,
} from '@ecloud/shared';
import { Envelope, NAS_SECRET_PURPOSE, SECRET_REF_PREFIX, openSecretRef } from '../crypto.js';
import { SECRET_RE, SECRET_RULE, type SkippedNas } from './render.js';
import type { LoadNasOptions } from './load.js';

export const MERAKI_ADAPTER = 'meraki-splash';
export const DEFAULT_MERAKI_RADIUS_FILE = '/var/lib/ecloud/radius-meraki/ecloud-meraki.conf';

export const MERAKI_RENDERED_HEADER =
  '# ECLOUD rendered FreeRADIUS Meraki cloud listeners (apps/api radius-clients). DO NOT EDIT:\n' +
  '# regenerated from nas_clients (adapter meraki-splash); contains shared secrets (0640).\n';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MerakiNasEntry {
  id: string;
  secret: string;
  requireMessageAuthenticator: boolean;
  authPort: number | null;
  acctPort: number | null;
}

export interface MerakiRenderOutput {
  content: string;
  state: ReturnType<typeof merakiCloudRadiusState>;
  rendered: MerakiNasEntry[];
  skipped: SkippedNas[];
}

function disabledContent(state: string): string {
  return `${MERAKI_RENDERED_HEADER}#\n# Meraki cloud RADIUS state: ${state}. No listener and no client is rendered.\n`;
}

function validPort(p: number | null, settings: MerakiCloudRadiusSettings): p is number {
  const r = settings.portRange;
  return p !== null && Number.isInteger(p) && r !== null && p >= r.min && p <= r.max;
}

function listenerBlock(
  entry: MerakiNasEntry,
  cidrs: readonly string[],
  allowRelaxed: boolean,
): string {
  const hex = entry.id.replace(/-/g, '');
  // Review F7: Message-Authenticator is forced unless MERAKI_ALLOW_RELAXED_MSGAUTH=true.
  const ma = entry.requireMessageAuthenticator || !allowRelaxed;
  const clients = cidrs
    .map((cidr, i) =>
      [
        `\tclient meraki-${entry.id}-${String(i + 1)} {`,
        `\t\tipaddr = ${cidr}`,
        `\t\tsecret = '${entry.secret}'`,
        `\t\tshortname = ${entry.id}`,
        '\t\tnas_type = other',
        `\t\trequire_message_authenticator = ${ma ? 'yes' : 'no'}`,
        `\t\tlimit_proxy_state = ${ma ? 'auto' : 'yes'}`,
        '\t}',
      ].join('\n'),
    )
    .join('\n');
  const listen = (type: 'auth' | 'acct', port: number) =>
    [
      'listen {',
      `\ttype = ${type}`,
      '\tipaddr = $ENV{RADIUS_LISTEN_IP}',
      `\tport = ${String(port)}`,
      `\tclients = meraki_${hex}`,
      '\tvirtual_server = ecloud',
      '}',
    ].join('\n');
  return [
    `# NAS ${entry.id}`,
    `clients meraki_${hex} {`,
    clients,
    '}',
    listen('auth', entry.authPort as number),
    listen('acct', entry.acctPort as number),
  ].join('\n');
}

/**
 * Renders the Meraki listener file. Never throws for per-row problems (they are skipped and
 * reported by id + rule); a disabled / incomplete platform setting yields a comment-only file.
 */
export function renderMerakiListeners(
  entries: readonly MerakiNasEntry[],
  settings: MerakiCloudRadiusSettings,
  priorSkipped: readonly SkippedNas[] = [],
): MerakiRenderOutput {
  const state = merakiCloudRadiusState(settings);
  if (!merakiListenersRenderable(settings)) {
    return { content: disabledContent(state), state, rendered: [], skipped: [...priorSkipped] };
  }
  // Defence in depth: the settings parser already canonicalised them.
  const cidrs = settings.sourceCidrs.filter((c) => canonicalMerakiSourceCidr(c) === c);
  const skipped: SkippedNas[] = [...priorSkipped];
  const seen = new Set<string>();
  const usedPorts = new Set<number>();
  const kept: MerakiNasEntry[] = [];
  for (const e of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!UUID_RE.test(e.id) || seen.has(e.id)) {
      skipped.push({
        id: UUID_RE.test(e.id) ? e.id : '(invalid-id)',
        reason: 'invalid or duplicate id',
      });
      continue;
    }
    seen.add(e.id);
    if (!SECRET_RE.test(e.secret)) {
      skipped.push({ id: e.id, reason: SECRET_RULE });
      continue;
    }
    if (
      !validPort(e.authPort, settings) ||
      !validPort(e.acctPort, settings) ||
      e.authPort % 2 !== 0 ||
      e.acctPort !== e.authPort + 1
    ) {
      skipped.push({
        id: e.id,
        reason: 'listener ports missing or outside MERAKI_RADIUS_PORT_RANGE',
      });
      continue;
    }
    if (usedPorts.has(e.authPort) || usedPorts.has(e.acctPort)) {
      skipped.push({ id: e.id, reason: 'listener port shared with another NAS' });
      continue;
    }
    usedPorts.add(e.authPort);
    usedPorts.add(e.acctPort);
    kept.push(e);
  }
  skipped.sort((a, b) => a.id.localeCompare(b.id));
  if (kept.length === 0 || cidrs.length === 0) {
    return {
      content: `${disabledContent(state)}# (no Meraki NAS with a valid listener)\n`,
      state,
      rendered: [],
      skipped,
    };
  }
  return {
    content: `${MERAKI_RENDERED_HEADER}\n${kept.map((e) => listenerBlock(e, cidrs, settings.allowRelaxedMessageAuthenticator)).join('\n\n')}\n`,
    state,
    rendered: kept,
    skipped,
  };
}

/** Live, active Meraki NAS rows of live organizations, secrets opened (skip on failure). */
export async function loadMerakiEntries(
  dbPlatform: Db,
  dataEncryptionKey: string,
  options: LoadNasOptions = {},
): Promise<{ entries: MerakiNasEntry[]; skipped: SkippedNas[] }> {
  const rows = await withPlatform(
    dbPlatform,
    { reason: 'radius:clients:render', actorType: 'system' },
    async (trx) => {
      let query = trx
        .selectFrom('nas_clients as n')
        .innerJoin('organizations as o', 'o.id', 'n.organization_id')
        .select([
          'n.id',
          'n.secret_ref',
          'n.require_message_authenticator',
          'n.cloud_radius_auth_port',
          'n.cloud_radius_acct_port',
        ])
        .where('n.adapter_key', '=', MERAKI_ADAPTER)
        .where('n.status', '=', 'active')
        .where('n.deleted_at', 'is', null)
        .where('o.deleted_at', 'is', null);
      if (options.organizationIds !== undefined) {
        if (options.organizationIds.length === 0) return [];
        query = query.where('n.organization_id', 'in', [...options.organizationIds]);
      }
      return query.orderBy('n.id').execute();
    },
  );
  const envelope = new Envelope(dataEncryptionKey, NAS_SECRET_PURPOSE);
  const entries: MerakiNasEntry[] = [];
  const skipped: SkippedNas[] = [];
  for (const row of rows) {
    const ref = String(row.secret_ref);
    let secret: string;
    try {
      secret = openSecretRef(envelope, ref);
    } catch {
      skipped.push({
        id: String(row.id),
        reason: ref.startsWith(SECRET_REF_PREFIX)
          ? 'secret_ref cannot be opened with DATA_ENCRYPTION_KEY'
          : 'secret_ref scheme is not supported',
      });
      continue;
    }
    entries.push({
      id: String(row.id),
      secret,
      requireMessageAuthenticator: row.require_message_authenticator !== false,
      authPort: row.cloud_radius_auth_port === null ? null : Number(row.cloud_radius_auth_port),
      acctPort: row.cloud_radius_acct_port === null ? null : Number(row.cloud_radius_acct_port),
    });
  }
  return { entries, skipped };
}
