/**
 * NAS → engine adapter (DECISIONS.md D-035, migration 015): `nas_clients.adapter_key` holds the
 * @ecloud/adapters key, so there is no alias table. `openwifi-config` is SSID configuration,
 * never a RADIUS client (same list as the DB CHECK `ck_nas_clients_adapter_key`). NULL (legacy
 * rows migration 015 could not map) or any other value → no adapter → no Disconnect / CoA.
 */
import { getAdapter, isAdapterKey, type NasAdapter } from '@ecloud/adapters';

export const NAS_ADAPTER_KEYS: readonly string[] = Object.freeze([
  'openwifi-hostapd-radius',
  'openwifi-uspot-uam',
  'uspot-upstream-uam',
  'coovachilli-uam',
]);

export function resolveAdapter(adapterKey: string | null): NasAdapter | null {
  if (adapterKey === null || !NAS_ADAPTER_KEYS.includes(adapterKey)) return null;
  return isAdapterKey(adapterKey) ? getAdapter(adapterKey) : null;
}
