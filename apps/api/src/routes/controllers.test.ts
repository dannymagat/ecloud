import { ValidationError } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import {
  normalizeControllerBaseUrl,
  resolveDeploymentMode,
  serializeController,
} from './controllers.js';

describe('controller base_url (plan §8.2)', () => {
  it('accepts https URLs per kind and normalises them', () => {
    expect(normalizeControllerBaseUrl('https://CNMAESTRO.example.com', 'cloud')).toBe(
      'https://cnmaestro.example.com/',
    );
    expect(normalizeControllerBaseUrl('https://10.0.0.5:8443/api', 'on_premises')).toBe(
      'https://10.0.0.5:8443/api',
    );
    expect(normalizeControllerBaseUrl('https://100.100.1.2/', 'embedded')).toBe(
      'https://100.100.1.2/',
    );
    expect(normalizeControllerBaseUrl('https://[fd00::2]/', 'embedded')).toBe('https://[fd00::2]/');
  });

  it.each([
    ['cloud', 'http://a.example.com'],
    ['cloud', 'https://10.0.0.5'],
    ['cloud', 'https://192.168.1.1'],
    ['cloud', 'https://a.localhost'],
    ['cloud', 'https://u:p@a.example.com'],
    ['on_premises', 'https://u@10.0.0.5'],
    ['on_premises', 'https://10.0.0.5/#x'],
    ['on_premises', 'https://127.0.0.1'],
    ['on_premises', 'https://169.254.169.254'],
    ['embedded', 'https://[::1]/'],
    ['embedded', 'https://[fe80::1]/'],
    ['on_premises', 'not a url'],
    ['on_premises', `https://a.example/${'x'.repeat(2100)}`],
    // review F1 / F2
    ['cloud', 'https://localhost./'],
    ['on_premises', 'https://localhost./'],
    ['embedded', 'https://ctrl.localhost../'],
    ['embedded', 'https://[::127.0.0.1]/'],
    ['on_premises', 'https://[::a00:5]/'],
    ['cloud', 'https://[::8.8.8.8]/'],
  ] as const)('refuses %s %s', (kind, url) => {
    expect(() => normalizeControllerBaseUrl(url, kind)).toThrow();
  });

  it('never serialises the sealed credential', () => {
    const out = serializeController({ id: 'x', credential_secret_ref: 'enc:v1.a.b.c' });
    expect(out).toEqual({ id: 'x', has_credential: true });
    expect(serializeController({ id: 'y', credential_secret_ref: null })).toEqual({
      id: 'y',
      has_credential: false,
    });
  });
});

describe('NAS deployment mode (registry-derived)', () => {
  it('defaults per adapter and refuses modes the registry does not list', () => {
    expect(resolveDeploymentMode('coovachilli-uam', undefined)).toBe('gateway');
    expect(resolveDeploymentMode('openwifi-uspot-uam', undefined)).toBe('native');
    expect(resolveDeploymentMode('openwifi-hostapd-radius', 'native')).toBe('native');
    expect(() => resolveDeploymentMode('openwifi-uspot-uam', 'gateway')).toThrow(ValidationError);
  });
});
