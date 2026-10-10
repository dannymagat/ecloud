/**
 * NAS → engine adapter (DECISIONS.md D-035, migration 015): every `nas_clients` row carries the
 * @ecloud/adapters key in `adapter_key`; there is no alias table any more. `openwifi-config`
 * configures SSIDs through the EZE controller and is never a RADIUS client, so it is not a valid
 * NAS adapter (the DB CHECK `ck_nas_clients_adapter_key` holds the same list). A NULL key exists
 * only on legacy rows migration 015 could not map unambiguously: such a NAS gets no policy
 * attributes (Auth-Type + Class only) and no Disconnect.
 */
import { getAdapter, isAdapterKey, type NasAdapter } from '@ecloud/adapters';

export const NAS_ADAPTER_KEYS = [
  'openwifi-hostapd-radius',
  'openwifi-uspot-uam',
  'uspot-upstream-uam',
  'coovachilli-uam',
  // Cycle A (D-044, migration 028): vendor-neutral 802.1X / MAC-auth NAS.
  'generic-radius-8021x',
] as const;

export type NasAdapterKey = (typeof NAS_ADAPTER_KEYS)[number];

export function isNasAdapterKey(value: unknown): value is NasAdapterKey {
  return typeof value === 'string' && (NAS_ADAPTER_KEYS as readonly string[]).includes(value);
}

/** The engine adapter of a NAS row, or null when the row has no (valid) adapter key. */
export function nasAdapter(adapterKey: string | null): NasAdapter | null {
  return isNasAdapterKey(adapterKey) && isAdapterKey(adapterKey) ? getAdapter(adapterKey) : null;
}
