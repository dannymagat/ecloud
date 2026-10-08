/**
 * Shared fixtures for the L4 simulator scenarios (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3).
 * Every value is a documented-parameter fixture or an obvious test value; nothing comes from a
 * device capture. Simulator results prove ECLOUD code behaviour, not hardware compatibility.
 */
import {
  getVendorAdapter,
  type BrokerCredential,
  type HotspotContext,
  type NasLookup,
  type ParsedRedirect,
  type RegisteredNas,
  type VendorAdapter,
} from '@ecloud/adapters';
import {
  PolicyIntentSchema,
  resolveEffectivePolicy,
  type DegradationMode,
  type EffectivePolicy,
  type ResolutionInput,
  type TranslationContext,
} from '@ecloud/policy-engine';
import {
  SIM_UAM_SECRET,
  buildUamRedirect,
  type SimAdapterKey,
  type UamFlavour,
  type UamRedirect,
  type UamRedirectInput,
} from '@ecloud/testing';

export const NOW = new Date('2026-10-08T06:00:00Z');
export const ORG_A = '01900000-0000-7000-8000-00000000000a';
export const ORG_B = '01900000-0000-7000-8000-00000000000b';
export const SITE_A = '01900000-0000-7000-8000-0000000000a1';
export const PORTAL = 'https://portal.ecloud.ezelink.ai';

export interface SimTarget {
  readonly adapterKey: SimAdapterKey;
  readonly flavour: UamFlavour;
  readonly uamServer: string;
  readonly adapter: VendorAdapter;
  readonly nas: RegisteredNas;
}

function target(adapterKey: SimAdapterKey, flavour: UamFlavour, path: string): SimTarget {
  const uamServer = `${PORTAL}${path}`;
  return {
    adapterKey,
    flavour,
    uamServer,
    adapter: getVendorAdapter(adapterKey),
    nas: {
      id: `sim-nas-${adapterKey}`,
      organizationId: ORG_A,
      siteId: SITE_A,
      identifier: `sim-nas-${adapterKey}`,
      adapterKey,
      controllerId: null,
      deploymentMode: adapterKey === 'coovachilli-uam' ? 'gateway' : 'native',
      uamServerUrl: uamServer,
      uamSecret: SIM_UAM_SECRET,
    },
  };
}

export const TARGETS: readonly SimTarget[] = [
  target('openwifi-uspot-uam', 'uspot-tip', '/uam/uspot/'),
  target('coovachilli-uam', 'coovachilli', '/uam/chilli/'),
];

export const CHALLENGE = '0123456789abcdef0123456789abcdef';
export const CLIENT_MAC_WIRE = 'AA-BB-CC-DD-EE-01';
export const CLIENT_MAC = 'aa:bb:cc:dd:ee:01';

/** Documented parameters only (CP §3.2 / §4). */
export function redirectInput(
  t: SimTarget,
  over: Partial<UamRedirectInput> = {},
): UamRedirectInput {
  return {
    uamServer: t.uamServer,
    uamSecret: t.nas.uamSecret,
    res: 'notyet',
    uamip: '10.1.0.1',
    uamport: '3990',
    challenge: CHALLENGE,
    mac: CLIENT_MAC_WIRE,
    ip: '10.1.0.23',
    called: '00-11-22-33-44-55',
    nasid: t.nas.identifier ?? '',
    ssid: 'Guest',
    sessionid: '5f3c2a1b0d9e8f70',
    userurl: 'http://example.com/start?a=1&b=2',
    ...over,
  };
}

export function redirect(t: SimTarget, over: Partial<UamRedirectInput> = {}): UamRedirect {
  return buildUamRedirect(redirectInput(t, over), t.flavour);
}

/** In-memory lookup: the NAS registry the portal would resolve (plus explicit replay set). */
export function memoryLookup(
  nasList: readonly RegisteredNas[],
  opts: { expectedOrganizationId?: string | null; consumed?: Set<string>; now?: Date } = {},
): NasLookup {
  return {
    findNas: ({ nasid, called }) =>
      Promise.resolve(
        nasList.find((n) => n.identifier !== null && n.identifier === nasid) ??
          nasList.find((n) => called !== null && n.identifier === called) ??
          null,
      ),
    expectedOrganizationId: opts.expectedOrganizationId ?? null,
    isReplay: (k) =>
      Promise.resolve(
        opts.consumed?.has(`${k.nasId}|${String(k.sessionId)}|${k.challenge}|${k.clientMac}`) ??
          false,
      ),
    now: () => opts.now ?? NOW,
  };
}

export function replayKey(
  nasId: string,
  sessionId: string,
  challenge: string,
  mac: string,
): string {
  return `${nasId}|${sessionId}|${challenge}|${mac}`;
}

export function parse(t: SimTarget, url: string): ParsedRedirect {
  const p = t.adapter.parseRedirect({ url, method: 'GET' });
  if ('unsupported' in p) throw new Error(p.reason);
  return p;
}

export async function validContext(t: SimTarget, url = redirect(t).url): Promise<HotspotContext> {
  const v = await t.adapter.validateContext(parse(t, url), memoryLookup([t.nas]));
  if (!v.ok) throw new Error(`${v.reason}: ${v.detail}`);
  return v.context;
}

export function credential(t: SimTarget, over: Partial<BrokerCredential> = {}): BrokerCredential {
  return {
    username: 'pc-sim-0001',
    password: 'pc-pass-01',
    expiresAt: new Date(NOW.getTime() + 90_000),
    boundNasId: t.nas.id,
    boundClientMac: CLIENT_MAC,
    ...over,
  };
}

/** Resolves one site-level policy (same shape as the L2 vendor tests). */
export function effectiveFor(
  fields: Record<string, unknown>,
  critical: readonly string[] = [],
): { effective: EffectivePolicy; tctx: (d?: DegradationMode) => TranslationContext } {
  const policy = PolicyIntentSchema.parse({
    id: 'pol-sim',
    organization_id: ORG_A,
    name: 'Simulator policy',
    scope_type: 'site',
    status: 'active',
    version: 1,
    ...(critical.length > 0 ? { critical_fields: critical } : {}),
    ...fields,
  });
  const input: ResolutionInput = {
    now: NOW,
    timeZone: 'UTC',
    organization_id: ORG_A,
    site_id: SITE_A,
    subject: { kind: 'user', user_id: 'user-sim' },
    client_device_id: null,
    mac: CLIENT_MAC,
    group_ids: [],
    candidates: [
      {
        assignment: {
          id: 'as-sim',
          policy_id: 'pol-sim',
          target_type: 'site',
          user_group_id: null,
          site_id: SITE_A,
          effective_from: new Date('2026-01-01T00:00:00Z'),
          effective_until: null,
          priority: 100,
        },
        policy,
      },
    ],
    usage: {},
    active_sessions: [],
    tenant: { min_session_s: 300 },
  };
  const r = resolveEffectivePolicy(input);
  return {
    effective: r.effective,
    tctx: (degradation) => ({
      sessionId: '01900000-0000-7000-8000-0000000000c1',
      now: NOW,
      clip: r.clip,
      controls: r.controls,
      interimIntervalS: 300,
      nasAcctIntervalUnset: true,
      ...(degradation ? { degradation } : {}),
    }),
  };
}
