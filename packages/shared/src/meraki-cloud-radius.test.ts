import { describe, expect, it } from 'vitest';
import {
  MERAKI_CLOUD_RADIUS_DISABLED,
  isMerakiSourceAddress,
  MerakiSettingsError,
  canonicalMerakiSourceCidr,
  merakiCloudRadiusState,
  merakiListenersRenderable,
  merakiPortPairs,
  parseMerakiCloudRadiusSettings,
} from './meraki-cloud-radius.js';

// RFC 5737 documentation ranges are refused on purpose, so public test values come from
// ordinary unicast space. They are NOT Meraki addresses (Meraki publishes none; see module doc).
const PUBLIC_A = '64.1.2.0/24';
const PUBLIC_B = '64.9.0.0/16';

describe('Meraki cloud RADIUS platform setting (Cycle E, D-044)', () => {
  it('is OFF by default with nothing configured', () => {
    const s = parseMerakiCloudRadiusSettings({});
    expect(s).toEqual({
      enabled: false,
      sourceCidrs: [],
      portRange: null,
      maxNasPerOrg: 50,
      allowRelaxedMessageAuthenticator: false,
    });
    expect(merakiCloudRadiusState(s)).toBe('disabled');
    expect(merakiListenersRenderable(s)).toBe(false);
    expect(MERAKI_CLOUD_RADIUS_DISABLED.enabled).toBe(false);
  });

  it('parses the flag, canonical CIDRs and the port range', () => {
    const s = parseMerakiCloudRadiusSettings({
      MERAKI_CLOUD_RADIUS_ENABLED: 'true',
      MERAKI_RADIUS_SOURCE_CIDRS: ` ${PUBLIC_B},${PUBLIC_A}, ${PUBLIC_A} `,
      MERAKI_RADIUS_PORT_RANGE: '21000-21003',
    });
    expect(s.enabled).toBe(true);
    expect(s.sourceCidrs).toEqual([PUBLIC_A, PUBLIC_B]);
    expect(s.portRange).toEqual({ min: 21000, max: 21003 });
    expect(merakiCloudRadiusState(s)).toBe('enabled');
    expect(merakiListenersRenderable(s)).toBe(true);
    expect(merakiPortPairs({ min: 21000, max: 21003 })).toEqual([
      { auth: 21000, acct: 21001 },
      { auth: 21002, acct: 21003 },
    ]);
  });

  it('reports an enabled but incomplete setting honestly', () => {
    expect(
      merakiCloudRadiusState(parseMerakiCloudRadiusSettings({ MERAKI_CLOUD_RADIUS_ENABLED: '1' })),
    ).toBe('enabled_missing_source_cidrs');
    expect(
      merakiCloudRadiusState(
        parseMerakiCloudRadiusSettings({
          MERAKI_CLOUD_RADIUS_ENABLED: '1',
          MERAKI_RADIUS_SOURCE_CIDRS: PUBLIC_A,
        }),
      ),
    ).toBe('enabled_missing_port_range');
  });

  it('refuses private, too-wide, host-bit, IPv6 and malformed source ranges', () => {
    for (const bad of [
      '10.0.0.0/8',
      '192.168.1.0/24',
      '127.0.0.0/16',
      '100.64.0.0/16',
      '64.0.0.0/8',
      '64.1.2.3/24',
      '064.1.2.0/24',
      '2001:db8::/32',
      '64.1.2.0',
      '64.1.2.0/33',
      '203.0.113.0/24',
    ]) {
      expect(canonicalMerakiSourceCidr(bad), bad).toBeNull();
    }
    expect(canonicalMerakiSourceCidr('64.1.2.4/32')).toBe('64.1.2.4/32');
    expect(() =>
      parseMerakiCloudRadiusSettings({ MERAKI_RADIUS_SOURCE_CIDRS: '10.0.0.0/8' }),
    ).toThrow(MerakiSettingsError);
  });

  it('refuses bad flags and port ranges, naming only the variable', () => {
    const cases: Record<string, string>[] = [
      { MERAKI_CLOUD_RADIUS_ENABLED: 'yes' },
      { MERAKI_RADIUS_PORT_RANGE: '21001-21004' },
      { MERAKI_RADIUS_PORT_RANGE: '1000-1003' },
      { MERAKI_RADIUS_PORT_RANGE: '1800-1900' },
      { MERAKI_RADIUS_PORT_RANGE: '21000-21000' },
      { MERAKI_RADIUS_PORT_RANGE: '20000-40000' },
      { MERAKI_RADIUS_PORT_RANGE: 'x' },
    ];
    for (const env of cases) {
      try {
        parseMerakiCloudRadiusSettings(env);
        expect.fail(`accepted ${JSON.stringify(env)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MerakiSettingsError);
        const [name] = Object.keys(env);
        expect((error as Error).message).toContain(String(name));
      }
    }
  });

  it('parses the per-org cap and the relaxed Message-Authenticator flag (review F6 / F7)', () => {
    const s = parseMerakiCloudRadiusSettings({
      MERAKI_MAX_NAS_PER_ORG: '7',
      MERAKI_ALLOW_RELAXED_MSGAUTH: 'true',
    });
    expect([s.maxNasPerOrg, s.allowRelaxedMessageAuthenticator]).toEqual([7, true]);
    for (const bad of ['0', '10001', 'x', '-1']) {
      expect(() => parseMerakiCloudRadiusSettings({ MERAKI_MAX_NAS_PER_ORG: bad })).toThrow(
        /MERAKI_MAX_NAS_PER_ORG/,
      );
    }
    expect(() => parseMerakiCloudRadiusSettings({ MERAKI_ALLOW_RELAXED_MSGAUTH: 'maybe' })).toThrow(
      /MERAKI_ALLOW_RELAXED_MSGAUTH/,
    );
  });

  it('recognises an address inside the Meraki source ranges (review F2)', () => {
    const s = parseMerakiCloudRadiusSettings({ MERAKI_RADIUS_SOURCE_CIDRS: PUBLIC_A });
    expect(isMerakiSourceAddress(s, '64.1.2.77')).toBe(true);
    expect(isMerakiSourceAddress(s, '64.1.2.77/32')).toBe(true);
    expect(isMerakiSourceAddress(s, '64.1.3.1')).toBe(false);
    expect(isMerakiSourceAddress(s, '2001:db8::1')).toBe(false);
  });
});
