/**
 * Mapping of `adapter_types.key` (DB, migration 011: `openwifi_ucentral`, `uspot`,
 * `coovachilli`, `generic_radius`) to the policy-engine adapter keys (D-012). The DB keys
 * predate the five-adapter split, so the mapping is explicit and conservative:
 *  - `coovachilli` → `coovachilli-uam` (one adapter for that NAS family);
 *  - `uspot` → `uspot-upstream-uam` ("OpenWrt uspot captive portal", the upstream package);
 *  - `openwifi_ucentral` is AMBIGUOUS (`openwifi-hostapd-radius` for 802.1X/MAC-auth SSIDs vs
 *    `openwifi-uspot-uam` for captive SSIDs) and `generic_radius` has no adapter: both map to
 *    null and the AAA path emits no policy attributes for them (only Auth-Type + Class) instead
 *    of guessing a capability set.
 * A future DB key spelled like an engine key with `_` (e.g. `coovachilli_uam`) maps directly.
 */
import { isAdapterKey, type AdapterKey } from '@ecloud/adapters';

export const DB_ADAPTER_TYPE_MAP: Readonly<Record<string, AdapterKey | null>> = Object.freeze({
  coovachilli: 'coovachilli-uam',
  uspot: 'uspot-upstream-uam',
  openwifi_ucentral: null,
  generic_radius: null,
});

export function engineAdapterFor(adapterTypeKey: string): AdapterKey | null {
  if (adapterTypeKey in DB_ADAPTER_TYPE_MAP) return DB_ADAPTER_TYPE_MAP[adapterTypeKey] ?? null;
  const hyphenated = adapterTypeKey.replaceAll('_', '-');
  return isAdapterKey(hyphenated) ? hyphenated : null;
}
