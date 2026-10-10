/**
 * Global-unique slots held by tenant rows (Cycle A review M2). Several identities are unique
 * across ALL organizations among live rows: `nas_clients.nas_ip` (uq_nas_clients_ip),
 * `nas_access_points.mac` (uq_nas_access_points_mac), `network_devices.serial` / `.mac`. When a
 * site or an organization is soft-deleted its rows must be soft-deleted too, otherwise the slots
 * stay taken forever by a tenant that no longer exists (and, for AP MACs, a squatter could keep a
 * MAC by deleting their site).
 *
 * Suspension (site `suspended` / organization `suspended`) is reversible and does NOT release
 * slots: every lookup already fails closed on a non-active site / organization.
 * `wireguard_peers` (public key / tunnel IP) have no soft delete and are out of scope here.
 */
import type { DbTransaction } from '@ecloud/db';
import { sql } from 'kysely';

export interface ReleasedSlots {
  accessPoints: number;
  nasClients: number;
  networkDevices: number;
}

/**
 * Soft-deletes the access points, NAS clients and network devices of an organization (or of one
 * site of it). Works in a tenant transaction (RLS) or a platform transaction.
 */
export async function releaseGlobalSlots(
  trx: DbTransaction,
  scope: { readonly organizationId: string; readonly siteId?: string },
  now: Date = new Date(),
): Promise<ReleasedSlots> {
  const site = scope.siteId === undefined ? sql`` : sql`AND site_id = ${scope.siteId}`;
  const run = async (table: string): Promise<number> => {
    const res = await sql`
      UPDATE ${sql.table(table)} SET deleted_at = ${now}
       WHERE organization_id = ${scope.organizationId} ${site} AND deleted_at IS NULL
    `.execute(trx);
    return Number(res.numAffectedRows ?? 0);
  };
  // APs first (they also follow their NAS), then NAS, then devices.
  const accessPoints = await run('nas_access_points');
  const nasClients = await run('nas_clients');
  const networkDevices = await run('network_devices');
  return { accessPoints, nasClients, networkDevices };
}
