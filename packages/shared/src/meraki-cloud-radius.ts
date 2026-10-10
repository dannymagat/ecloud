/**
 * Platform setting for Cisco Meraki cloud-sourced RADIUS (multi-vendor Cycle E, DECISIONS.md
 * D-044; SECURITY_ARCHITECTURE.md §3.5). Parsed identically by the API, the worker and the
 * FreeRADIUS clients renderer, so the three never disagree about the state.
 *
 *   MERAKI_CLOUD_RADIUS_ENABLED   true|false|1|0, default **false**. While false: Meraki NAS can be
 *                                 registered, but no Meraki listener / client is rendered, the
 *                                 AAA endpoint refuses Meraki NAS requests, the worker sends no
 *                                 Meraki Disconnect and the setup guide warns that RADIUS from the
 *                                 Meraki Cloud is not reachable. The LAN-only pilot (D-043) does
 *                                 not allow the public RADIUS exposure this needs.
 *   MERAKI_RADIUS_SOURCE_CIDRS    comma-separated IPv4 CIDRs the Meraki Cloud sends RADIUS from.
 *                                 Meraki publishes no fixed list: the ranges are shown per
 *                                 organization in Dashboard "Help > Firewall info" and "may change
 *                                 over time" (Meraki doc "Configuring RADIUS Authentication with a
 *                                 Sign-On Splash Page"). Empty = nothing is rendered (fail closed).
 *                                 REQUIRES_CLARIFICATION: the authoritative list for the ECLOUD
 *                                 deployment, and how its changes are tracked.
 *   MERAKI_RADIUS_PORT_RANGE      `min-max` UDP range for the per-NAS listener pairs (auth = even
 *                                 port, acct = auth + 1). An ECLOUD deployment choice, not a
 *                                 Meraki fact; no default (REQUIRES_CLARIFICATION). Unset = no
 *                                 port is allocated to new Meraki NAS.
 *   MERAKI_MAX_NAS_PER_ORG        live Meraki NAS per organization (default 50, 1..10000): each
 *                                 one opens a public listener pair (review F6).
 *   MERAKI_ALLOW_RELAXED_MSGAUTH  true|false, default **false**: while false every Meraki NAS
 *                                 requires Message-Authenticator (BlastRADIUS), whatever its row
 *                                 says (review F7).
 *
 * Pure string parsing; no I/O. Error messages name variables, never values.
 */
import { BlockList, isIPv4 } from 'node:net';

export interface MerakiPortRange {
  readonly min: number;
  readonly max: number;
}

export interface MerakiCloudRadiusSettings {
  /** MERAKI_CLOUD_RADIUS_ENABLED (default false). */
  readonly enabled: boolean;
  /** Canonical `a.b.c.d/len` CIDRs (network address, host bits zero), sorted, de-duplicated. */
  readonly sourceCidrs: readonly string[];
  /** Listener port range, or null when not configured. */
  readonly portRange: MerakiPortRange | null;
  /** MERAKI_MAX_NAS_PER_ORG (default 50). */
  readonly maxNasPerOrg: number;
  /** MERAKI_ALLOW_RELAXED_MSGAUTH (default false). */
  readonly allowRelaxedMessageAuthenticator: boolean;
}

export const MERAKI_DEFAULT_MAX_NAS_PER_ORG = 50;

export const MERAKI_CLOUD_RADIUS_DISABLED: MerakiCloudRadiusSettings = Object.freeze({
  enabled: false,
  sourceCidrs: Object.freeze([]),
  portRange: null,
  maxNasPerOrg: 50,
  allowRelaxedMessageAuthenticator: false,
});

/** Meraki documents Disconnect-Request only on UDP 3799 (Meraki doc "CoA Disconnect for Splash Sign-on"). */
export const MERAKI_DAS_PORT = 3799;

/** Smallest accepted source prefix: a /8 would admit far more than one cloud provider. */
export const MERAKI_MIN_PREFIX = 16;
/** Upper bound of listener pairs per range (keeps the rendered file and firewall rule bounded). */
export const MERAKI_MAX_PORT_PAIRS = 4096;

/** Ranges that can never be a Meraki Cloud source (private, loopback, link-local, reserved...). */
const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  NOT_PUBLIC.addSubnet(net, bits, 'ipv4');
}

export class MerakiSettingsError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('; '));
    this.name = 'MerakiSettingsError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => String(Math.floor(value / 2 ** shift) % 256)).join('.');
}

/**
 * Strict IPv4 CIDR: dotted quad without leading zeros, prefix MERAKI_MIN_PREFIX..32, host bits
 * zero, publicly routable. Returns the canonical text or null. IPv6 is refused (Meraki IPv6
 * RADIUS sources are not documented: REQUIRES_CLARIFICATION).
 */
export function canonicalMerakiSourceCidr(raw: string): string | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(raw.trim());
  if (m === null) return null;
  const [, ip, len] = m as unknown as [string, string, string];
  if (!isIPv4(ip) || ip.split('.').some((o) => o.length > 1 && o.startsWith('0'))) return null;
  const prefix = Number(len);
  if (!Number.isInteger(prefix) || prefix < MERAKI_MIN_PREFIX || prefix > 32) return null;
  const value = ipv4ToInt(ip);
  const size = 2 ** (32 - prefix);
  if (value % size !== 0) return null;
  // Every address of the block must be public: check both ends against the blocked ranges.
  if (NOT_PUBLIC.check(ip, 'ipv4') || NOT_PUBLIC.check(intToIpv4(value + size - 1), 'ipv4')) {
    return null;
  }
  return `${ip}/${String(prefix)}`;
}

const TRUE = new Set(['true', '1']);
const FALSE = new Set(['false', '0', '']);

/** Parses the three variables; throws MerakiSettingsError naming the variables at fault. */
export function parseMerakiCloudRadiusSettings(
  env: Readonly<Record<string, string | undefined>>,
): MerakiCloudRadiusSettings {
  const problems: string[] = [];
  const flag = (name: string): boolean => {
    const raw = (env[name] ?? '').trim().toLowerCase();
    if (TRUE.has(raw)) return true;
    if (!FALSE.has(raw)) problems.push(`${name}: must be true, false, 1 or 0`);
    return false;
  };
  const enabled = flag('MERAKI_CLOUD_RADIUS_ENABLED');
  const allowRelaxedMessageAuthenticator = flag('MERAKI_ALLOW_RELAXED_MSGAUTH');
  let maxNasPerOrg = MERAKI_DEFAULT_MAX_NAS_PER_ORG;
  const rawMax = (env.MERAKI_MAX_NAS_PER_ORG ?? '').trim();
  if (rawMax !== '') {
    maxNasPerOrg = /^\d{1,5}$/.test(rawMax) ? Number(rawMax) : NaN;
    if (!Number.isInteger(maxNasPerOrg) || maxNasPerOrg < 1 || maxNasPerOrg > 10_000) {
      problems.push('MERAKI_MAX_NAS_PER_ORG: must be an integer 1..10000');
    }
  }

  const cidrs = new Set<string>();
  const rawCidrs = (env.MERAKI_RADIUS_SOURCE_CIDRS ?? '').trim();
  if (rawCidrs !== '') {
    for (const item of rawCidrs.split(',')) {
      if (item.trim() === '') continue;
      const canonical = canonicalMerakiSourceCidr(item);
      if (canonical === null) {
        problems.push(
          `MERAKI_RADIUS_SOURCE_CIDRS: every entry must be a public IPv4 network a.b.c.d/${String(MERAKI_MIN_PREFIX)}..32 with host bits zero`,
        );
        break;
      }
      cidrs.add(canonical);
    }
  }

  let portRange: MerakiPortRange | null = null;
  const rawRange = (env.MERAKI_RADIUS_PORT_RANGE ?? '').trim();
  if (rawRange !== '') {
    const m = /^(\d{1,5})-(\d{1,5})$/.exec(rawRange);
    const min = m === null ? NaN : Number(m[1]);
    const max = m === null ? NaN : Number(m[2]);
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 1024 ||
      max > 65535 ||
      min % 2 !== 0 ||
      max < min + 1 ||
      (max - min + 1) / 2 > MERAKI_MAX_PORT_PAIRS
    ) {
      problems.push(
        `MERAKI_RADIUS_PORT_RANGE: must be "min-max" with an even min >= 1024, max <= 65535, at least one pair and at most ${String(MERAKI_MAX_PORT_PAIRS)} pairs`,
      );
    } else if (min <= 1813 && max >= 1812) {
      problems.push('MERAKI_RADIUS_PORT_RANGE: must not overlap the standard listeners 1812/1813');
    } else {
      portRange = { min, max };
    }
  }

  if (problems.length > 0) throw new MerakiSettingsError(problems);
  return Object.freeze({
    enabled,
    sourceCidrs: Object.freeze([...cidrs].sort()),
    portRange: portRange === null ? null : Object.freeze(portRange),
    maxNasPerOrg,
    allowRelaxedMessageAuthenticator,
  });
}

/** Operational state shown to administrators (never claims reachability ECLOUD cannot observe). */
export type MerakiCloudRadiusState =
  'disabled' | 'enabled_missing_source_cidrs' | 'enabled_missing_port_range' | 'enabled';

export function merakiCloudRadiusState(s: MerakiCloudRadiusSettings): MerakiCloudRadiusState {
  if (!s.enabled) return 'disabled';
  if (s.sourceCidrs.length === 0) return 'enabled_missing_source_cidrs';
  if (s.portRange === null) return 'enabled_missing_port_range';
  return 'enabled';
}

/** True when listeners can actually be rendered (flag on AND sources AND a port range). */
export function merakiListenersRenderable(s: MerakiCloudRadiusSettings): boolean {
  return merakiCloudRadiusState(s) === 'enabled';
}

/** Auth/acct port pairs of a range, in order (auth even, acct = auth + 1). */
export function merakiPortPairs(range: MerakiPortRange): { auth: number; acct: number }[] {
  const pairs: { auth: number; acct: number }[] = [];
  for (let p = range.min; p + 1 <= range.max; p += 2) pairs.push({ auth: p, acct: p + 1 });
  return pairs;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [net, len] = cidr.split('/') as [string, string];
  const size = 2 ** (32 - Number(len));
  const start = ipv4ToInt(net);
  const value = ipv4ToInt(ip);
  return value >= start && value < start + size;
}

/**
 * True when `ip` (a NAS source address) lies inside one of the configured Meraki Cloud ranges
 * (review F2: such an address is shared by every Meraki customer and must never identify a
 * tenant's NAS). IPv6 addresses are never inside (only IPv4 ranges are accepted).
 */
export function isMerakiSourceAddress(s: MerakiCloudRadiusSettings, ip: string): boolean {
  const host = ip.replace(/\/32$/, '');
  if (!isIPv4(host)) return false;
  return s.sourceCidrs.some((c) => ipv4InCidr(host, c));
}
