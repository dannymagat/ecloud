import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTAL_TEMPLATE,
  NO_PORTAL_CAPABILITIES,
  PORTAL_METHOD_KEYS,
  PORTAL_METHODS,
  PORTAL_TEMPLATES,
  isLegacyPortalMethod,
  isPortalMethodKey,
  isPortalTemplateKey,
  methodAvailability,
  offeredMethods,
  portalMethod,
  portalTemplate,
  type PortalCapabilities,
} from './portal-methods.js';
import { PORTAL_LOGIN_METHODS } from './portal-theme.js';

const ALL: PortalCapabilities = Object.freeze({
  mailer: true,
  sms_provider: true,
  identity_provider: true,
  pms_adapter: true,
  payment_provider: true,
});

describe('portal method registry', () => {
  it('registers exactly the declared keys, once each', () => {
    expect(PORTAL_METHODS.map((m) => m.key)).toEqual([...PORTAL_METHOD_KEYS]);
    expect(new Set(PORTAL_METHOD_KEYS).size).toBe(PORTAL_METHOD_KEYS.length);
  });

  it('gives every method with a guest page a distinct route segment', () => {
    const pages = PORTAL_METHODS.map((m) => m.page).filter((p): p is string => p !== null);
    expect(new Set(pages).size).toBe(pages.length);
    // Only `mac` has no page: it is decided before the browser reaches one.
    expect(PORTAL_METHODS.filter((m) => m.page === null).map((m) => m.key)).toEqual(['mac']);
  });

  it('keeps the three pre-registry methods marked legacy and still recognised', () => {
    for (const key of PORTAL_LOGIN_METHODS) {
      expect(portalMethod(key)?.legacy).toBe(true);
      expect(isLegacyPortalMethod(key)).toBe(true);
    }
    expect(isLegacyPortalMethod('email_otp')).toBe(false);
  });

  it('does not claim verified identity for terms, forms, vouchers or payment', () => {
    for (const key of ['click_through', 'registration', 'voucher', 'paid', 'sponsor', 'mac']) {
      expect(portalMethod(key)?.verifiesIdentity).toBe(false);
    }
    for (const key of ['password', 'email_otp', 'sms_otp', 'social', 'sso', 'hotel']) {
      expect(portalMethod(key)?.verifiesIdentity).toBe(true);
    }
  });

  it('recognises only registered keys', () => {
    expect(isPortalMethodKey('voucher')).toBe(true);
    expect(isPortalMethodKey('wishful')).toBe(false);
    expect(portalMethod('wishful')).toBeNull();
  });
});

describe('method availability', () => {
  it('reports every unmet dependency, and nothing when all are met', () => {
    expect(methodAvailability('email_otp', NO_PORTAL_CAPABILITIES)).toEqual({
      available: false,
      missing: ['mailer'],
    });
    expect(methodAvailability('email_otp', ALL)).toEqual({ available: true });
    expect(methodAvailability('paid', NO_PORTAL_CAPABILITIES)).toEqual({
      available: false,
      missing: ['payment_provider'],
    });
  });

  it('treats dependency-free methods as always available', () => {
    for (const key of ['click_through', 'password', 'voucher', 'registration']) {
      expect(methodAvailability(key, NO_PORTAL_CAPABILITIES)).toEqual({ available: true });
    }
  });

  it('refuses an unknown method rather than defaulting it available', () => {
    expect(methodAvailability('wishful', ALL)).toEqual({ available: false, missing: [] });
  });
});

describe('offered methods', () => {
  it('puts explicitly ordered methods first, then the rest in registry order', () => {
    const offered = offeredMethods(
      ['password', 'voucher', 'click_through'],
      ['voucher'],
      NO_PORTAL_CAPABILITIES,
    );
    expect(offered.map((m) => m.key)).toEqual(['voucher', 'click_through', 'password']);
  });

  it('hides a method whose dependency is unmet and keeps the rest', () => {
    const offered = offeredMethods(['click_through', 'email_otp'], [], NO_PORTAL_CAPABILITIES);
    expect(offered.map((m) => m.key)).toEqual(['click_through']);
    expect(offeredMethods(['click_through', 'email_otp'], [], ALL).map((m) => m.key)).toEqual([
      'click_through',
      'email_otp',
    ]);
  });

  it('ignores ordering entries for methods that are not enabled', () => {
    const offered = offeredMethods(['voucher'], ['password', 'voucher'], ALL);
    expect(offered.map((m) => m.key)).toEqual(['voucher']);
  });

  it('drops a method that has no guest page', () => {
    expect(offeredMethods(['mac', 'voucher'], [], ALL).map((m) => m.key)).toEqual(['voucher']);
  });

  it('returns nothing when no method is enabled', () => {
    expect(offeredMethods([], [], ALL)).toEqual([]);
  });
});

describe('templates', () => {
  it('declares all six templates, with Branded Multi-Login as the default', () => {
    expect(PORTAL_TEMPLATES).toHaveLength(6);
    expect(portalTemplate(DEFAULT_PORTAL_TEMPLATE)?.key).toBe('branded_multi_login');
    expect(isPortalTemplateKey('quick_connect')).toBe(true);
    expect(isPortalTemplateKey('nope')).toBe(false);
  });

  it('names only registered methods in every template', () => {
    for (const template of PORTAL_TEMPLATES) {
      for (const key of [...template.suggestedMethods, ...template.defaultMethods]) {
        expect(portalMethod(key), `${template.key}/${key}`).not.toBeNull();
      }
    }
  });

  it('never enables a dependency-bearing method by default (§3)', () => {
    for (const template of PORTAL_TEMPLATES) {
      for (const key of template.defaultMethods) {
        expect(portalMethod(key)?.requires, `${template.key}/${key}`).toEqual([]);
      }
    }
  });

  it('starts Hotel and Resident with no method, because a room number alone must not grant access', () => {
    expect(portalTemplate('hotel_resident')?.defaultMethods).toEqual([]);
  });
});
