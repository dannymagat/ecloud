/**
 * Simulated identity broker + AAA decision for SIM-05 / SIM-06 (MULTI_VENDOR_INTEGRATION_PLAN.md
 * §8.3). The production broker (single-use portal credential, SECURITY_ARCHITECTURE.md §5.6,
 * D-018) and the portal replay store are Phase 6 components that do not exist yet, so this
 * harness models their documented rules; the NAS — and so the tenant — is resolved from the real
 * `nas_clients` table by the authenticated packet source, as `/internal/aaa/authorize` does
 * (`apps/api/src/internal/aaa.ts resolveNas`, SECURITY §3.2). It is a stand-in for the AAA
 * stub's decision, not ECLOUD's AAA implementation.
 */
import type { BrokerCredential, NasLookup, RegisteredNas } from '@ecloud/adapters';
import type { Db } from '@ecloud/db';
import { sql } from 'kysely';

export interface IssuedCredential extends BrokerCredential {
  readonly organizationId: string;
}

export interface AccessRequest {
  /** Authenticated UDP source of the Access-Request. */
  readonly packetSrcIp: string;
  readonly username: string;
  readonly password: string;
  /** Normalised `aa:bb:…`. */
  readonly callingStationId: string;
  readonly at: Date;
}

export type AaaDecision =
  | { readonly decision: 'accept'; readonly organizationId: string }
  | {
      readonly decision: 'reject';
      readonly reason:
        | 'unknown_nas'
        | 'bad_credentials'
        | 'consumed'
        | 'expired'
        | 'tenant_mismatch'
        | 'binding_mismatch';
    };

interface NasRow {
  id: string;
  organization_id: string;
  site_id: string;
  nas_identifier: string | null;
  adapter_key: string | null;
}

export async function nasByIp(db: Db, ip: string): Promise<NasRow | null> {
  const row = await db
    .selectFrom('nas_clients')
    .select(['id', 'organization_id', 'site_id', 'nas_identifier', 'adapter_key'])
    .where(sql<boolean>`nas_ip = ${ip}::inet`)
    .where('deleted_at', 'is', null)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return row ?? null;
}

export class SimBroker {
  private readonly issued = new Map<string, IssuedCredential & { consumed: boolean }>();
  /** Redirects whose flow already issued + consumed a credential (portal_flows stand-in). */
  readonly consumedRedirects = new Set<string>();

  constructor(private readonly db: Db) {}

  issue(c: IssuedCredential): IssuedCredential {
    this.issued.set(c.username, { ...c, consumed: false });
    return c;
  }

  /** Access-Request decision: NAS from the DB by packet source; single-use, TTL, binding. */
  async accessRequest(req: AccessRequest): Promise<AaaDecision> {
    const nas = await nasByIp(this.db, req.packetSrcIp);
    if (!nas) return { decision: 'reject', reason: 'unknown_nas' };
    const c = this.issued.get(req.username);
    if (!c || c.password !== req.password) return { decision: 'reject', reason: 'bad_credentials' };
    if (c.organizationId !== nas.organization_id)
      return { decision: 'reject', reason: 'tenant_mismatch' };
    if (c.boundNasId !== nas.id || c.boundClientMac !== req.callingStationId)
      return { decision: 'reject', reason: 'binding_mismatch' };
    if (c.consumed) return { decision: 'reject', reason: 'consumed' };
    if (c.expiresAt.getTime() <= req.at.getTime()) return { decision: 'reject', reason: 'expired' };
    c.consumed = true;
    return { decision: 'accept', organizationId: nas.organization_id };
  }
}

/** Portal-side NAS lookup over `nas_clients` (fail closed on an ambiguous identifier). */
export function dbNasLookup(
  db: Db,
  opts: {
    readonly expectedOrganizationId: string | null;
    readonly uam: (nas: NasRow) => { uamServerUrl: string; uamSecret: string } | null;
    readonly consumed: ReadonlySet<string>;
    readonly now: Date;
  },
): NasLookup {
  return {
    async findNas({ nasid }) {
      if (nasid === null) return null;
      const rows = await db
        .selectFrom('nas_clients')
        .select(['id', 'organization_id', 'site_id', 'nas_identifier', 'adapter_key'])
        .where('nas_identifier', '=', nasid)
        .where('deleted_at', 'is', null)
        .where('status', '=', 'active')
        .execute();
      // nas_identifier is not unique across tenants (idx_nas_clients_identifier): never guess.
      if (rows.length !== 1 || !rows[0]) return null;
      const n = rows[0];
      const uam = opts.uam(n);
      const nas: RegisteredNas = {
        id: n.id,
        organizationId: n.organization_id,
        siteId: n.site_id,
        identifier: n.nas_identifier,
        adapterKey: n.adapter_key,
        controllerId: null,
        deploymentMode: n.adapter_key === 'coovachilli-uam' ? 'gateway' : 'native',
        uamServerUrl: uam?.uamServerUrl ?? null,
        uamSecret: uam?.uamSecret ?? null,
      };
      return nas;
    },
    expectedOrganizationId: opts.expectedOrganizationId,
    isReplay: (k) =>
      Promise.resolve(
        opts.consumed.has(`${k.nasId}|${String(k.sessionId)}|${k.challenge}|${k.clientMac}`),
      ),
    now: () => opts.now,
  };
}
