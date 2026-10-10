/**
 * `VendorAdapter` wrappers for the engine adapters (plan §6.1, §6.3): the five first-party ones
 * and the vendor-neutral `generic-radius-8021x` (Cycle A, D-044). Each
 * wrapper delegates to the unchanged engine object (`vendor.engine === getAdapter(key)`); the
 * engine's translation, reply attributes and Disconnect output are passed through by reference.
 * Operations the plan marks unsupported return an explicit `Unsupported` with a reason.
 */
import { canonicalUnicastMac, type EvidenceRef } from '@ecloud/shared';
import type { AdapterKey, EffectivePolicy, TranslationContext } from '@ecloud/policy-engine';
import { getAdapter } from '../registry.js';
import { COMPATIBILITY_ROWS } from '../registry/compatibility.js';
import { deriveCells, presentCells } from '../registry/derive.js';
import { DT_RESULTS } from '../registry/dt-results.js';
import type { CompatibilityRow, DeploymentMode } from '../registry/types.js';
import type { NasAdapter, SessionRef, Unsupported } from '../types.js';
import { counterWrap32Quirks, normalizeAccounting, normalizeMacAddress } from './accounting.js';
import type {
  AuthorizationHandoff,
  AuthorizationPlan,
  AuthorizationStrategy,
  BrokerCredential,
  CapabilityReport,
  ContextValidation,
  HandoffSecrets,
  HealthReport,
  HotspotContext,
  NasLookup,
  ParsedRedirect,
  SetupStep,
  SiteSignals,
  VendorAdapter,
} from './types.js';
import {
  encodeUamPapPassword,
  isPrivateIpv4,
  isUamPort,
  safeUserUrl,
  splitUamQuery,
  uamResult,
  verifyUamSignature,
} from './uam.js';

/** Registry vendor of the vendor-neutral 802.1X / MAC-auth adapter (registry/vendors.ts). */
export const GENERIC_RADIUS_VENDOR_KEY = 'generic-radius';

/** Portal host per CAPTIVE_PORTAL_ARCHITECTURE.md §7.4 (not live until the D-031 gate). */
export const PORTAL_ORIGIN = 'https://portal.ezecloud.ezelink.ai';

interface FirstPartySpec {
  readonly key: AdapterKey;
  readonly vendorKey: string;
  /** UAM flavour, or null for adapters without a portal (plan §6.3). */
  readonly uam: { readonly path: string; readonly requireSecret: true } | null;
  readonly defaultDeployment: DeploymentMode;
  readonly radius: boolean;
  readonly setup: (site: {
    readonly siteId: string;
    readonly nasId: string;
  }) => readonly SetupStep[];
}

const unsupported = (reason: string): Unsupported => ({ unsupported: true, reason });

const UAM_REQUIRED = ['uamip', 'uamport', 'challenge', 'mac'] as const;

const WG_STALE_S = 180;
const DEFAULT_INTERIM_S = 600;

// ------------------------------------------------------------------------------------------
// Setup guides (data-only; placeholders for every secret)
// ------------------------------------------------------------------------------------------

const CP74: EvidenceRef = { kind: 'doc-section', ref: 'CAPTIVE_PORTAL_ARCHITECTURE.md §7.4' };
const NI73: EvidenceRef = { kind: 'doc-section', ref: 'NETWORK_INTEGRATION.md §7.3' };

function step(
  id: string,
  title: string,
  setting: string,
  value: string,
  refs: readonly EvidenceRef[] = [CP74],
): SetupStep {
  return { id, title, setting, value, evidenceRefs: refs };
}

function uspotSetup(nasId: string): readonly SetupStep[] {
  return [
    step('auth-mode', 'Captive portal mode', 'captive.auth-mode', 'uam'),
    step(
      'uam-server',
      'Portal URL (no query string)',
      'captive.uam-server',
      `${PORTAL_ORIGIN}/uam/uspot/`,
    ),
    step('uam-port', 'UAM port', 'captive.uam-port', '3990'),
    step(
      'uam-secret',
      'UAM secret (required for uspot NAS, SECURITY §5.2)',
      'captive.uam-secret',
      '<UAM_SECRET>',
    ),
    step('nasid', 'NAS identifier = ECLOUD NAS id', 'captive.nasid', nasId),
    step(
      'auth-server',
      'RADIUS authentication server',
      'captive.auth-server',
      '<ECLOUD_RADIUS_ADDRESS>',
    ),
    step('auth-secret', 'RADIUS secret', 'captive.auth-secret', '<RADIUS_SECRET>'),
    step(
      'acct-server',
      'RADIUS accounting server',
      'captive.acct-server',
      '<ECLOUD_RADIUS_ADDRESS>',
    ),
    step('acct-port', 'Accounting port (schema default is 1812)', 'captive.acct-port', '1813'),
    step('acct-secret', 'RADIUS accounting secret', 'captive.acct-secret', '<RADIUS_SECRET>'),
    step(
      'acct-interval',
      'Leave unset so RADIUS Acct-Interim-Interval rules (NAS value overrides RADIUS)',
      'captive.acct-interval',
      '<UNSET>',
    ),
    step(
      'final-redirect-url',
      'Report success back to the portal',
      'captive.final-redirect-url',
      'uam',
    ),
    step(
      'walled-garden-fqdn',
      'Walled garden (wildcards are not rendered)',
      'captive.walled-garden-fqdn',
      'portal.ezecloud.ezelink.ai,<IDP_HOSTS>',
    ),
  ];
}

const F9: EvidenceRef = {
  kind: 'doc-section',
  ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.1, §5 (generic-radius-8021x)',
};
const AAA24: EvidenceRef = { kind: 'doc-section', ref: 'AAA_ARCHITECTURE.md §2.4 (802.1X / EAP)' };

/**
 * Vendor-neutral 802.1X / MAC-auth guide (Cycle A). Menu names differ per vendor, so `setting`
 * names the RADIUS concept, not a vendor UI path; every secret is a placeholder.
 */
function genericRadiusSetup(): readonly SetupStep[] {
  return [
    step(
      'radius-auth',
      'RADIUS authentication server (802.1X / MAC authentication)',
      'RADIUS auth server {address, port, shared secret}',
      '<ECLOUD_RADIUS_ADDRESS>, 1812, <RADIUS_SECRET>',
      [F9],
    ),
    step(
      'radius-acct',
      'RADIUS accounting server (Start / Interim-Update / Stop)',
      'RADIUS accounting server {address, port, shared secret}',
      '<ECLOUD_RADIUS_ADDRESS>, 1813, <RADIUS_SECRET>',
      [F9],
    ),
    step(
      'nas-source',
      'Send RADIUS from the address registered as the NAS IP (ECLOUD identifies the NAS by packet source)',
      'RADIUS source interface / NAS-IP',
      '<REGISTERED_NAS_IP>',
      [F9],
    ),
    step(
      'nas-identifier',
      'NAS-Identifier: leave unset or use the value registered in ECLOUD (a different value is rejected)',
      'NAS-Identifier',
      '<REGISTERED_NAS_IDENTIFIER>',
      [F9],
    ),
    step(
      'message-authenticator',
      'Message-Authenticator on every Access-Request (BlastRADIUS mitigation)',
      'Message-Authenticator',
      'enabled',
      [F9],
    ),
    step(
      'interim',
      'Accounting interim interval',
      'Acct-Interim-Interval / accounting update interval',
      '<INTERIM_SECONDS>',
      [F9],
    ),
    step(
      'eap-method',
      'WPA2/WPA3-Enterprise EAP method: EAP-TTLS with inner PAP (ECLOUD stores only one-way password hashes, so PEAP-MSCHAPv2 cannot be verified)',
      'EAP method / inner method',
      'EAP-TTLS / PAP',
      [F9, AAA24],
    ),
    step(
      'eap-ca',
      'Client trust: the CA that signed the ECLOUD RADIUS server certificate (production certificate REQUIRES_CLARIFICATION)',
      'Server certificate validation / CA',
      '<ECLOUD_RADIUS_CA_CERT>',
      [F9, AAA24],
    ),
    step(
      'mac-auth',
      'MAC authentication (MAB): User-Name = client MAC; enable "MAC auth" on the client device in ECLOUD',
      'MAC authentication username format',
      '<CLIENT_MAC> (any of aa:bb:cc:dd:ee:ff, AA-BB-CC-DD-EE-FF, aabbccddeeff)',
      [F9],
    ),
    step(
      'das',
      'Dynamic authorization (Disconnect: REQUIRES_DEVICE_TEST, D-006); port = the NAS CoA port registered in ECLOUD',
      'RADIUS dynamic authorization / CoA {client, port, secret}',
      '<ECLOUD_COA_SOURCE>, <DAS_PORT>, <RADIUS_SECRET>',
      [F9],
    ),
  ];
}

const SPECS: readonly FirstPartySpec[] = [
  {
    key: 'openwifi-hostapd-radius',
    vendorKey: 'ezelink',
    uam: null,
    defaultDeployment: 'native',
    radius: true,
    setup: () => [
      step(
        'radius-auth',
        'RADIUS authentication',
        'ssids[].radius.authentication{host,port,secret}',
        '<ECLOUD_RADIUS_ADDRESS>, 1812, <RADIUS_SECRET>',
        [NI73],
      ),
      step(
        'radius-acct',
        'RADIUS accounting',
        'ssids[].radius.accounting{host,port,secret,interval}',
        '<ECLOUD_RADIUS_ADDRESS>, 1813, <RADIUS_SECRET>, 60-600',
        [NI73],
      ),
      step(
        'radius-das',
        'Dynamic authorization (Disconnect: REQUIRES_DEVICE_TEST, D-006)',
        'ssids[].radius.dynamic-authorization{host,port,secret}',
        '<ECLOUD_COA_SOURCE>, <DAS_PORT>, <DAE_SECRET>',
        [NI73],
      ),
    ],
  },
  {
    key: 'openwifi-uspot-uam',
    vendorKey: 'ezelink',
    uam: { path: '/uam/uspot/', requireSecret: true },
    defaultDeployment: 'native',
    radius: true,
    setup: (site) => uspotSetup(site.nasId),
  },
  {
    key: 'uspot-upstream-uam',
    vendorKey: 'openwrt',
    uam: { path: '/uam/uspot/', requireSecret: true },
    defaultDeployment: 'native',
    radius: true,
    setup: (site) => uspotSetup(site.nasId),
  },
  {
    key: 'coovachilli-uam',
    vendorKey: 'coova',
    uam: { path: '/uam/chilli/', requireSecret: true },
    defaultDeployment: 'gateway',
    radius: true,
    setup: (site) => [
      step('uamserver', 'Portal URL', 'uamserver', `${PORTAL_ORIGIN}/uam/chilli/`),
      step('uamsecret', 'UAM secret', 'uamsecret', '<UAM_SECRET>'),
      step('radiusnasid', 'NAS identifier = ECLOUD NAS id', 'radiusnasid', site.nasId),
      step('nasmac', 'NAS MAC', 'nasmac', '<GATEWAY_MAC>'),
      step('radiusserver1', 'RADIUS server', 'radiusserver1', '<ECLOUD_RADIUS_ADDRESS>'),
      step('radiussecret', 'RADIUS secret', 'radiussecret', '<RADIUS_SECRET>'),
      step(
        'coaport',
        'CoA/Disconnect port (Disconnect stays REQUIRES_DEVICE_TEST, D-006)',
        'coaport',
        '3799',
      ),
      step('uamallowed', 'Walled garden', 'uamallowed', 'portal.ezecloud.ezelink.ai,<IDP_HOSTS>'),
      step('uamdomain', 'Wildcard IdP domains', 'uamdomain', '<IDP_DOMAINS>'),
      step(
        'definteriminterval',
        'Default interim interval',
        'definteriminterval',
        '<INTERIM_SECONDS>',
      ),
    ],
  },
  {
    key: 'openwifi-config',
    vendorKey: 'ezelink',
    uam: null,
    defaultDeployment: 'native',
    radius: false,
    // Config-only: ECLOUD pushes per-SSID keys through the EZE controller; nothing to set by hand.
    setup: () => [],
  },
  {
    // Cycle A (D-044): any vendor's 802.1X / MAC-auth SSID; no portal (plan §6.3).
    key: 'generic-radius-8021x',
    vendorKey: GENERIC_RADIUS_VENDOR_KEY,
    uam: null,
    defaultDeployment: 'native',
    radius: true,
    setup: () => genericRadiusSetup(),
  },
];

// ------------------------------------------------------------------------------------------
// Wrapper
// ------------------------------------------------------------------------------------------

function rowsFor(key: AdapterKey): CompatibilityRow[] {
  return COMPATIBILITY_ROWS.filter((r) => r.adapterKey === key);
}

function gatewaySuggestion(engine: NasAdapter, fields: readonly string[]): string | null {
  if (fields.length === 0 || engine.key === 'coovachilli-uam') return null;
  const candidate = COMPATIBILITY_ROWS.find(
    (r) =>
      r.lifecycle !== 'planned' &&
      r.lifecycle !== 'researched' &&
      r.deploymentModes.includes('gateway') &&
      fields.every((f) =>
        presentCells(r.capabilities).some(
          (c) => c.capability === f && c.status === 'VERIFIED_SUPPORTED',
        ),
      ),
  );
  return candidate?.key ?? null;
}

function createFirstPartyVendorAdapter(spec: FirstPartySpec): VendorAdapter {
  const engine = getAdapter(spec.key);
  const strategies: readonly AuthorizationStrategy[] = spec.uam ? ['browser-form'] : [];

  const authorizeSession = (
    ctx: HotspotContext,
    credential: BrokerCredential,
    secrets?: HandoffSecrets,
  ): AuthorizationHandoff | Unsupported => {
    if (!spec.uam) return unsupported(`${spec.key} has no captive portal (plan §6.3)`);
    if (ctx.nas.adapterKey !== spec.key)
      return unsupported(`context NAS uses adapter ${String(ctx.nas.adapterKey)}, not ${spec.key}`);
    if (credential.boundNasId !== ctx.nas.id || credential.boundClientMac !== ctx.clientMac)
      return unsupported('credential is not bound to this NAS and client (SECURITY §5.6)');
    if (credential.expiresAt.getTime() <= ctx.receivedAt.getTime())
      return unsupported('credential expired before the hand-off (single-use, TTL 90 s)');
    const f = ctx.vendorOpaque.fields;
    const uamip = f.uamip ?? '';
    const uamport = f.uamport;
    const challenge = f.challenge ?? '';
    if (!isPrivateIpv4(uamip) || !isUamPort(uamport))
      return unsupported('uamip/uamport missing or not a private LAN address (CP §7.3)');
    const secret = secrets?.uamSecret ?? null;
    if (secret === null || secret.length === 0)
      return unsupported(
        'UAM secret required to encode the password (SECURITY §5.2; cleartext PAP refused)',
      );
    let password: string;
    try {
      password = encodeUamPapPassword(credential.password, challenge, secret);
    } catch (e) {
      return unsupported(`cannot encode UAM password: ${(e as Error).message}`);
    }
    const fields: Record<string, string> = { username: credential.username, password };
    const userurl = safeUserUrl(f.userurl, uamip);
    if (userurl !== null) fields.userurl = userurl;
    const query = new URLSearchParams(fields).toString();
    return {
      strategy: 'browser-form',
      browser: {
        method: 'GET-302',
        url: `http://${uamip}:${String(uamport)}/logon?${query}`,
        fields,
      },
      state: 'pending',
    };
  };

  const wrapper: VendorAdapter = {
    key: spec.key,
    vendorKey: spec.vendorKey,
    engine,
    strategies,

    discoverCapabilities(ctx): CapabilityReport {
      const rows = rowsFor(spec.key);
      const row =
        ctx.modelKey !== undefined || ctx.firmware !== undefined
          ? rows.find(
              (r) =>
                (ctx.modelKey === undefined || r.hardwareModel === ctx.modelKey) &&
                (ctx.firmware === undefined || r.firmware === ctx.firmware),
            )
          : undefined;
      const capabilities =
        row?.capabilities ??
        deriveCells(engine.capabilities(), {
          rowKey: `${spec.key}:engine`,
          sourceVersionMatchesDevice: null,
          deviceFirmware: 'UNKNOWN',
          dtResults: DT_RESULTS,
        });
      return {
        adapterKey: spec.key,
        vendorKey: row?.vendorKey ?? spec.vendorKey,
        rowKey: row?.key ?? null,
        lifecycle: row?.lifecycle ?? null,
        sourceVersionMatchesDevice: row?.sourceVersionMatchesDevice ?? null,
        cells: presentCells(capabilities),
      };
    },

    parseRedirect(req): ParsedRedirect | Unsupported {
      if (!spec.uam) return unsupported(`${spec.key} has no captive portal redirect (plan §6.3)`);
      if (req.method.toUpperCase() !== 'GET') return unsupported('UAM redirects are GET requests');
      const q = req.url.indexOf('?');
      const hash = req.url.indexOf('#', q < 0 ? 0 : q);
      const rawQuery = q < 0 ? '' : req.url.slice(q + 1, hash < 0 ? undefined : hash);
      const split = splitUamQuery(rawQuery);
      return {
        vendorKey: spec.vendorKey,
        params: split.params,
        rawQuery,
        signature:
          split.md !== null ? { kind: 'uam-md5', value: split.md } : { kind: 'none', value: null },
        result: uamResult(split.params.res),
      };
    },

    async validateContext(parsed, lookup: NasLookup): Promise<ContextValidation> {
      if (!spec.uam)
        return { ok: false, reason: 'malformed', detail: `${spec.key} has no captive portal` };
      const split = splitUamQuery(parsed.rawQuery);
      if (split.duplicates.length > 0)
        return {
          ok: false,
          reason: 'malformed',
          detail: `duplicate parameter(s): ${split.duplicates.join(', ')}`,
        };
      const p = split.params;
      const missing = UAM_REQUIRED.filter((k) => !p[k]);
      if (missing.length > 0 || (!p.nasid && !p.called))
        return {
          ok: false,
          reason: 'malformed',
          detail: `missing UAM parameter(s): ${[...missing, ...(!p.nasid && !p.called ? ['nasid|called'] : [])].join(', ')}`,
        };
      const clientMac = normalizeMacAddress(p.mac);
      if (clientMac === null)
        return { ok: false, reason: 'malformed', detail: 'client MAC is not a MAC address' };

      const nas = await lookup.findNas({
        nasid: p.nasid ?? null,
        called: p.called ?? null,
        apMac: canonicalUnicastMac(p.called),
      });
      if (!nas)
        return { ok: false, reason: 'unknown_nas', detail: 'no registered NAS for this redirect' };
      if (nas.adapterKey !== spec.key)
        return {
          ok: false,
          reason: 'unknown_nas',
          detail: `NAS is registered for adapter ${String(nas.adapterKey)}`,
        };
      if (lookup.expectedOrganizationId === undefined)
        return {
          ok: false,
          reason: 'tenant_mismatch',
          detail: 'caller did not state the expected organization (fail closed)',
        };
      if (
        lookup.expectedOrganizationId !== null &&
        lookup.expectedOrganizationId !== nas.organizationId
      )
        return {
          ok: false,
          reason: 'tenant_mismatch',
          detail: 'NAS belongs to another organization',
        };

      if (spec.uam.requireSecret && (nas.uamSecret === null || nas.uamSecret.length === 0))
        return {
          ok: false,
          reason: 'bad_signature',
          detail: 'NAS has no UAM secret; unsigned redirects are refused (SECURITY §5.2)',
        };
      if (nas.uamSecret !== null && nas.uamSecret.length > 0) {
        if (nas.uamServerUrl === null)
          return {
            ok: false,
            reason: 'malformed',
            detail: 'NAS has a UAM secret but no registered uam-server URL',
          };
        if (!verifyUamSignature(parsed, nas.uamServerUrl, nas.uamSecret))
          return { ok: false, reason: 'bad_signature', detail: '`md` missing or does not match' };
      }
      if (!isPrivateIpv4(p.uamip ?? '') || !isUamPort(p.uamport))
        return {
          ok: false,
          reason: 'private_address_required',
          detail: 'uamip must be an RFC 1918 / RFC 6598 address',
        };

      // Fail closed: without a replay check the redirect cannot be shown to be fresh.
      if (typeof lookup.isReplay !== 'function')
        return {
          ok: false,
          reason: 'replayed',
          detail: 'no replay check configured (fail closed)',
        };
      if (
        await lookup.isReplay({
          nasId: nas.id,
          sessionId: p.sessionid ?? null,
          challenge: p.challenge ?? '',
          clientMac,
        })
      )
        return { ok: false, reason: 'replayed', detail: 'redirect already consumed' };

      const fields: Record<string, string> = { ...split.params };
      return {
        ok: true,
        context: {
          organizationId: nas.organizationId,
          siteId: nas.siteId,
          vendorKey: spec.vendorKey,
          controllerId: nas.controllerId,
          nas: { id: nas.id, identifier: nas.identifier, adapterKey: nas.adapterKey },
          apMac: normalizeMacAddress(p.called),
          clientMac,
          ssid: p.ssid ?? null,
          clientIp: p.ip ?? null,
          nasSessionId: p.sessionid ?? null,
          policyRef: null,
          deploymentMode: nas.deploymentMode,
          vendorOpaque: { raw: parsed.rawQuery, fields },
          receivedAt: lookup.now ? lookup.now() : new Date(),
        },
      };
    },

    buildAuthorization(
      ctx: HotspotContext,
      identity: BrokerCredential,
      effective: EffectivePolicy,
      tctx: TranslationContext,
      secrets?: HandoffSecrets,
    ): AuthorizationPlan | Unsupported {
      const handoff = authorizeSession(ctx, identity, secrets);
      if ('unsupported' in handoff) return handoff;
      const enforcement = engine.translate(effective, tctx);
      const replyAttributes = engine.buildReplyAttributes(enforcement);
      return {
        enforcement,
        replyAttributes,
        handoff,
        gatewaySuggestion: gatewaySuggestion(
          engine,
          enforcement.unenforceable.map((u) => u.field),
        ),
      };
    },

    authorizeSession,

    revokeSession(session: SessionRef) {
      // Status stays what the engine declares (REQUIRES_DEVICE_TEST, D-006).
      return engine.buildDisconnect(session);
    },

    normalizeAccounting(row) {
      return normalizeAccounting(row);
    },

    // 32-bit octet counters without Gigawords (engine `capabilities().octetWidth`, PHASE2_VALIDATION V-054):
    // today only openwifi-uspot-uam. Report-only; device wrap behaviour is REQUIRES_DEVICE_TEST.
    ...(engine.capabilities().octetWidth === 32 ? { accountingQuirks: counterWrap32Quirks() } : {}),

    buildSetupGuide(site) {
      return spec.setup(site);
    },

    healthCheck(signals: SiteSignals): HealthReport {
      const age = (d: Date | null | undefined): number | null =>
        d ? (signals.now.getTime() - d.getTime()) / 1000 : null;
      const out: HealthReport['signals'][number][] = [];
      if (spec.radius) {
        out.push({
          name: 'radius-access-request',
          state: signals.lastAccessRequestAt ? 'ok' : 'missing',
          lastSeenAt: signals.lastAccessRequestAt,
        });
        const interim = signals.interimIntervalS ?? DEFAULT_INTERIM_S;
        const accAge = age(signals.lastAccountingAt);
        out.push({
          name: 'radius-accounting',
          state: accAge === null ? 'missing' : accAge > 3 * interim ? 'stale' : 'ok',
          lastSeenAt: signals.lastAccountingAt,
        });
      }
      if (signals.lastWireguardHandshakeAt === undefined) {
        out.push({ name: 'wireguard-handshake', state: 'unknown', lastSeenAt: null });
      } else {
        const wgAge = age(signals.lastWireguardHandshakeAt);
        out.push({
          name: 'wireguard-handshake',
          state: wgAge === null ? 'missing' : wgAge > WG_STALE_S ? 'stale' : 'ok',
          lastSeenAt: signals.lastWireguardHandshakeAt,
        });
      }
      return { signals: out };
    },
  };
  return wrapper;
}

const VENDOR_ADAPTERS: Readonly<Record<AdapterKey, VendorAdapter>> = Object.freeze(
  Object.fromEntries(SPECS.map((s) => [s.key, createFirstPartyVendorAdapter(s)])) as Record<
    AdapterKey,
    VendorAdapter
  >,
);

/** First-party vendor adapter by engine key; throws on an unknown key. */
export function getVendorAdapter(key: string): VendorAdapter {
  const v = (VENDOR_ADAPTERS as Record<string, VendorAdapter | undefined>)[key];
  if (!v) throw new Error(`unknown vendor adapter: ${key}`);
  return v;
}

export function listVendorAdapters(): VendorAdapter[] {
  return SPECS.map((s) => VENDOR_ADAPTERS[s.key]);
}
