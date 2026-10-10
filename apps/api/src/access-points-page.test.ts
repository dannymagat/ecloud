/**
 * Access Points page (D-045) pure parts: setup progress, NAS vendor derivation, the MikroTik
 * installation script (never a secret, placeholders stop the script, safe filename) and the
 * PUBLIC_SUPPORT_EMAIL configuration.
 */
import { ConfigError } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_PLACEHOLDER,
  SECRET_PLACEHOLDER,
  mikrotikScriptFilename,
  renderMikrotikScript,
  type MikrotikScriptInput,
} from './mikrotik-script.js';
import { nasVendor, setupProgress } from './routes/access-points-page.js';
import { loadApiConfig } from './config.js';
import { testConfig } from './test-support/deps.js';

describe('setup progress', () => {
  it('counts the five steps in order', () => {
    const none = setupProgress({
      nasCount: 0,
      nasWithSecret: 0,
      accessPoints: 0,
      nasWithActivity: 0,
      acceptedLogins: false,
    });
    expect(none.completed).toBe(0);
    expect(none.total).toBe(5);
    expect(none.steps.map((s) => s.key)).toEqual([
      'nas_added',
      'radius_secret',
      'ap_registered',
      'radius_seen',
      'guest_login',
    ]);
    const some = setupProgress({
      nasCount: 1,
      nasWithSecret: 1,
      accessPoints: 2,
      nasWithActivity: 0,
      acceptedLogins: false,
    });
    expect(some.completed).toBe(3);
    expect(some.steps.filter((s) => s.done).map((s) => s.label)).toEqual([
      'NAS added',
      'RADIUS secret configured',
      'AP MAC registered',
    ]);
  });
});

describe('nasVendor', () => {
  it('prefers the vendor chosen in the wizard', () => {
    expect(
      nasVendor({ vendor_key: 'teltonika', adapter_key: 'coovachilli-uam', adapter_config: {} }),
    ).toEqual({ vendor_key: 'teltonika', vendor_name: 'Teltonika' });
  });
  it('derives the vendor from the adapter and post-back profile', () => {
    expect(
      nasVendor({ vendor_key: null, adapter_key: 'mikrotik-hotspot', adapter_config: {} }),
    ).toMatchObject({ vendor_key: 'mikrotik' });
    expect(
      nasVendor({
        vendor_key: null,
        adapter_key: 'external-portal-postback',
        adapter_config: { profile: 'aruba-ecp' },
      }),
    ).toMatchObject({ vendor_key: 'aruba' });
    // the generic profile is shared by the long tail: "Any vendor", never a guessed brand
    expect(
      nasVendor({
        vendor_key: null,
        adapter_key: 'external-portal-postback',
        adapter_config: { profile: 'postback-generic' },
      }),
    ).toMatchObject({ vendor_key: 'generic-portal' });
    expect(nasVendor({ vendor_key: null, adapter_key: null, adapter_config: {} })).toBeNull();
  });
});

const SECRET = 'Zx9-very-secret-radius-value-0123456789abcd'; // check-no-secrets: allow (test fixture)

function input(over: Partial<MikrotikScriptInput> = {}): MikrotikScriptInput {
  return {
    nas: {
      id: '0b9f5c1e-1111-4222-8333-944445555666',
      name: 'Lobby router',
      nasIp: '10.20.30.40',
      nasIdentifier: 'lobby-gw',
      coaPort: null,
    },
    radiusAddress: '192.0.2.53',
    authPort: 1812,
    acctPort: 1813,
    portalOrigin: 'https://portal.example.test',
    generatedAt: new Date('2026-10-10T08:00:00Z'),
    ...over,
  };
}

describe('MikroTik installation script', () => {
  it('renders the RADIUS entry, incoming, hotspot profile and walled garden', () => {
    const text = renderMikrotikScript(input());
    expect(text).toContain(
      '/radius add service=hotspot address=$radiusAddress secret=$radiusSecret authentication-port=1812 accounting-port=1813 src-address=10.20.30.40 comment="ECLOUD"',
    );
    expect(text).toContain(':local radiusAddress "192.0.2.53"');
    expect(text).toContain('/radius incoming set accept=yes port=1700');
    expect(text).toContain('use-radius=yes radius-accounting=yes');
    expect(text).toContain('/ip hotspot walled-garden add dst-host="portal.example.test"');
    expect(text).toContain('/system identity set name="lobby-gw"');
    expect(text).toContain('login.html');
    expect(text).toContain('https://portal.example.test/hotspot/mikrotik/');
  });

  it('never embeds a secret: the placeholder must be pasted and the script refuses it', () => {
    const text = renderMikrotikScript(input());
    expect(text).not.toContain(SECRET);
    expect(text).toContain(`:local radiusSecret "${SECRET_PLACEHOLDER}"`);
    expect(text).toContain(`:if ($radiusSecret = "${SECRET_PLACEHOLDER}") do={ :error`);
    expect(text).not.toMatch(/secret=(?!\$radiusSecret)/);
  });

  it('keeps unknown or unsafe values as placeholders', () => {
    const text = renderMikrotikScript(
      input({
        radiusAddress: null,
        nas: {
          id: '0b9f5c1e-1111-4222-8333-944445555666',
          name: 'evil"\n/system reset-configuration',
          nasIp: '10.0.0.1',
          nasIdentifier: 'bad"; /system reboot',
          coaPort: 3799,
        },
      }),
    );
    expect(text).toContain(`:local radiusAddress "${ADDRESS_PLACEHOLDER}"`);
    expect(text).not.toMatch(/^\/system identity set/m);
    expect(text).not.toContain('/system reboot');
    expect(text).not.toMatch(/^\/system reset-configuration/m);
    expect(text).toContain('/radius incoming set accept=yes port=3799');
  });

  it('quotes the portal host and keeps unusual hosts / Unicode line breaks out of the script', () => {
    const ok = renderMikrotikScript(input());
    expect(ok).toContain('dst-host="portal.example.test"');
    const odd = renderMikrotikScript(
      input({
        portalOrigin: 'https://a$(/system reboot).example.test',
        nas: { ...input().nas, name: 'x\u2028/system reset-configuration' },
      }),
    );
    expect(odd).not.toMatch(/^\/ip hotspot walled-garden add/m);
    expect(odd).not.toMatch(/^\/system reset-configuration/m);
    expect(odd).not.toMatch(/[\u2028\u2029]/u);
  });

  it('builds a safe attachment filename', () => {
    expect(mikrotikScriptFilename('Lobby Router #1', 'abc')).toBe(
      'ecloud-mikrotik-lobby-router-1.rsc',
    );
    expect(mikrotikScriptFilename('"; rm -rf /', '0b9f5c1e-1111')).toBe(
      'ecloud-mikrotik-rm-rf.rsc',
    );
    expect(mikrotikScriptFilename('日本', '0b9f5c1e-1111')).toBe('ecloud-mikrotik-0b9f5c1e.rsc');
  });
});

describe('PUBLIC_SUPPORT_EMAIL', () => {
  it('is optional: unset or empty hides the link', () => {
    expect(testConfig().supportEmail).toBeNull();
    expect(testConfig({ PUBLIC_SUPPORT_EMAIL: '' }).supportEmail).toBeNull();
  });
  it('accepts an e-mail address', () => {
    expect(testConfig({ PUBLIC_SUPPORT_EMAIL: 'support@example.test' }).supportEmail).toBe(
      'support@example.test',
    );
  });
  it('rejects anything else, naming the variable only', () => {
    let error: unknown;
    try {
      testConfig({ PUBLIC_SUPPORT_EMAIL: 'javascript:alert(1)' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems.join('\n');
    expect(problems).toContain('PUBLIC_SUPPORT_EMAIL');
    expect(problems).not.toContain('javascript');
  });
});

describe('ADMIN_MFA_MODE (D-046)', () => {
  const env = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    KV_DRIVER: 'memory',
    PUBLIC_ADMIN_ORIGIN: 'https://admin.example.test',
    INTERNAL_API_TOKEN: 'x'.repeat(32),
    DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
    DATABASE_URL_PLATFORM: 'postgres://nobody:nothing@127.0.0.1:1/none',
  };
  it('defaults to off in production code; the test harness pins required', () => {
    expect(loadApiConfig(env).adminMfaMode).toBe('off');
    expect(testConfig().adminMfaMode).toBe('required');
    expect(loadApiConfig({ ...env, ADMIN_MFA_MODE: 'required' }).adminMfaMode).toBe('required');
  });
  it('rejects any other value', () => {
    expect(() => loadApiConfig({ ...env, ADMIN_MFA_MODE: 'optional' })).toThrow(ConfigError);
  });
});
