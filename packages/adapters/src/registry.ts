import { ADAPTER_KEYS, type AdapterCapabilities, type AdapterKey } from '@ecloud/policy-engine';
import { adapter as ezecloudUam } from './adapters/ezecloud-uam.js';
import { adapter as externalPortalPostback } from './adapters/external-portal-postback.js';
import { adapter as genericRadius8021x } from './adapters/generic-radius-8021x.js';
import { adapter as merakiSplash } from './adapters/meraki-splash.js';
import { adapter as mikrotikHotspot } from './adapters/mikrotik-hotspot.js';
import { adapter as openwifiConfig } from './adapters/openwifi-config.js';
import { adapter as openwifiHostapdRadius } from './adapters/openwifi-hostapd-radius.js';
import { adapter as ezeapUam } from './adapters/ezeap-uam.js';
import { adapter as uspotUpstreamUam } from './adapters/uspot-upstream-uam.js';
import type { NasAdapter } from './types.js';

const REGISTRY: Readonly<Record<AdapterKey, NasAdapter>> = Object.freeze({
  'openwifi-hostapd-radius': openwifiHostapdRadius,
  'ezeap-uam': ezeapUam,
  'uspot-upstream-uam': uspotUpstreamUam,
  'ezecloud-uam': ezecloudUam,
  'openwifi-config': openwifiConfig,
  'generic-radius-8021x': genericRadius8021x,
  'mikrotik-hotspot': mikrotikHotspot,
  'external-portal-postback': externalPortalPostback,
  'meraki-splash': merakiSplash,
});

/**
 * Former spellings of renamed adapter keys (migration 050, owner ruling 2026-10-16). Data at
 * rest was rewritten by the migration; this table only forgives the old spelling on an
 * inbound value (an API body from an old client, a config file, a controller export).
 */
export const LEGACY_ADAPTER_KEYS: Readonly<Record<string, AdapterKey>> = Object.freeze({
  'openwifi-uspot-uam': 'ezeap-uam',
  'coovachilli-uam': 'ezecloud-uam',
});

/** The current key for `value`: itself when current, the renamed key for a legacy spelling. */
export function normalizeAdapterKey(value: string): string {
  return LEGACY_ADAPTER_KEYS[value] ?? value;
}

export function isAdapterKey(value: unknown): value is AdapterKey {
  return typeof value === 'string' && (ADAPTER_KEYS as readonly string[]).includes(value);
}

/** Adapter by `adapter_types.key`; throws on an unknown key (translation_error, §7.3). */
export function getAdapter(type: string): NasAdapter {
  if (!isAdapterKey(type)) throw new Error(`unknown adapter type: ${type}`);
  return REGISTRY[type];
}

export function listAdapters(): NasAdapter[] {
  return ADAPTER_KEYS.map((key) => REGISTRY[key]);
}

export function listCapabilities(): AdapterCapabilities[] {
  return listAdapters().map((a) => a.capabilities());
}
