/**
 * Cycle D review F1: controller-inventory trust is tied to the exact controller configuration
 * that produced it. Whenever the controller URL / kind / vendor, its API credential (set, rotate,
 * TLS pin, remove) or a NAS's controller changes, inventory candidate markers and
 * inventory-sourced verification are dropped (RADIUS-observed verification is untouched).
 * Runs inside the caller's tenant transaction.
 */
import type { DbTransaction } from '@ecloud/db';

export async function resetControllerInventoryTrust(
  trx: DbTransaction,
  controllerId: string,
): Promise<number> {
  const managed = trx
    .selectFrom('nas_clients')
    .select('id')
    .where('controller_id', '=', controllerId);
  const verified = await trx
    .updateTable('nas_access_points')
    .set({ verified_at: null, verification_source: null })
    .where('verification_source', '=', 'controller-inventory')
    .where((eb) =>
      eb.or([eb('inventory_controller_id', '=', controllerId), eb('nas_client_id', 'in', managed)]),
    )
    .executeTakeFirst();
  await trx
    .updateTable('nas_access_points')
    .set({ inventory_seen_at: null, inventory_controller_id: null })
    .where('inventory_controller_id', '=', controllerId)
    .execute();
  return Number(verified.numUpdatedRows);
}

/** A NAS moved to another (or no) controller: its APs lose inventory-based trust. */
export async function resetNasInventoryTrust(trx: DbTransaction, nasId: string): Promise<void> {
  await trx
    .updateTable('nas_access_points')
    .set({ verified_at: null, verification_source: null })
    .where('nas_client_id', '=', nasId)
    .where('verification_source', '=', 'controller-inventory')
    .execute();
  await trx
    .updateTable('nas_access_points')
    .set({ inventory_seen_at: null, inventory_controller_id: null })
    .where('nas_client_id', '=', nasId)
    .where('inventory_controller_id', 'is not', null)
    .execute();
}
