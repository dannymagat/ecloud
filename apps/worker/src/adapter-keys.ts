/**
 * `nas_clients.adapter_type_key` references `adapter_types.key`, seeded by migration 011 with
 * DATABASE_DESIGN.md keys (`openwifi_ucentral`, `uspot`, `coovachilli`, `generic_radius`),
 * while @ecloud/adapters uses POLICY_ENGINE.md keys. Until the catalogues are reconciled
 * (Phase 3 report), only unambiguous aliases are mapped:
 *   coovachilli        → coovachilli-uam
 *   openwifi_ucentral  → openwifi-hostapd-radius   (011 names it "OpenWiFi / uCentral (hostapd)")
 * `uspot` (TIP fork vs upstream) and `generic_radius` stay unmapped: no adapter → no Disconnect.
 */
import { getAdapter, isAdapterKey, type NasAdapter } from '@ecloud/adapters';

export const DB_ADAPTER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  coovachilli: 'coovachilli-uam',
  openwifi_ucentral: 'openwifi-hostapd-radius',
});

export function resolveAdapter(adapterTypeKey: string): NasAdapter | null {
  const key = DB_ADAPTER_ALIASES[adapterTypeKey] ?? adapterTypeKey;
  return isAdapterKey(key) ? getAdapter(key) : null;
}
