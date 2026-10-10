import { describe, expect, it } from 'vitest';
import { COMPATIBILITY_ROWS } from '../registry/compatibility.js';
import type { CompatibilityRow } from '../registry/types.js';
import {
  GALLERY_ENTRIES,
  SECRET_PLACEHOLDERS,
  buildGalleryGuide,
  galleryStatus,
  getGalleryEntry,
  type GuideValues,
} from './gallery.js';
import { BUILTIN_POSTBACK_PROFILES, GENERIC_POSTBACK_PROFILE_KEY } from './postback/profiles.js';

// RFC 5737 / example values: test inputs, not deployment facts.
const VALUES: GuideValues = {
  portalOrigin: 'https://portal.example.test:8444',
  radiusAddress: '192.0.2.53',
  authPort: 11812,
  acctPort: 11813,
  coaPort: 3799,
  interimS: 300,
};

const NAS_ADAPTER_KEYS = [
  'openwifi-uspot-uam',
  'uspot-upstream-uam',
  'coovachilli-uam',
  'generic-radius-8021x',
  'mikrotik-hotspot',
  'external-portal-postback',
  'unifi-external-portal',
  'omada-api',
  'mist-guest-portal',
  'meraki-splash',
];

describe('Cycle F setup-guide gallery', () => {
  it('has unique keys, known adapters and profiles, and every built-in post-back profile', () => {
    const keys = GALLERY_ENTRIES.map((e) => e.vendorKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of GALLERY_ENTRIES) {
      expect(NAS_ADAPTER_KEYS, e.vendorKey).toContain(e.adapterKey);
      expect(e.profile !== null, e.vendorKey).toBe(e.adapterKey === 'external-portal-postback');
      expect(e.longTail, e.vendorKey).toBe(e.profile === GENERIC_POSTBACK_PROFILE_KEY);
    }
    const profiles = new Set(GALLERY_ENTRIES.map((e) => e.profile));
    for (const p of BUILTIN_POSTBACK_PROFILES) expect(profiles).toContain(p.key);
  });

  it('status: documented / generic today; tested only with lab evidence and a DT reference', () => {
    for (const e of GALLERY_ENTRIES) {
      expect(galleryStatus(e), e.vendorKey).toBe(e.longTail ? 'generic_profile' : 'documented');
    }
    const mikrotik = getGalleryEntry('mikrotik');
    expect(mikrotik).not.toBeNull();
    if (mikrotik === null) return;
    const row = COMPATIBILITY_ROWS.find((r) => r.vendorKey === 'mikrotik');
    expect(row).toBeDefined();
    if (row === undefined) return;
    const cell = {
      capability: 'x',
      status: 'VERIFIED_SUPPORTED' as const,
      evidenceLevel: 'LAB_VALIDATED' as const,
      evidenceRefs: [],
    };
    const withLab = (dtRefs: string[]): CompatibilityRow => ({
      ...row,
      capabilities: { ...row.capabilities, captivePortal: [{ ...cell, dtRefs }] },
    });
    expect(galleryStatus(mikrotik, [withLab(['DT-99'])])).toBe('tested_on_device');
    // lab evidence without a device-test reference is not enough (rule V12)
    expect(galleryStatus(mikrotik, [withLab([])])).toBe('documented');
  });

  it('fills portal origin, RADIUS address and ports; never fills a secret', () => {
    for (const e of GALLERY_ENTRIES) {
      const g = buildGalleryGuide(e, VALUES);
      expect(g.steps.length, e.vendorKey).toBeGreaterThan(0);
      const text = JSON.stringify(g);
      expect(text, e.vendorKey).not.toContain('portal.ezecloud.ezelink.ai');
      expect(g.walledGarden).toEqual(['portal.example.test:8444']);
      for (const s of g.steps) {
        const hasSecret = SECRET_PLACEHOLDERS.some((p) => s.value.includes(p));
        expect(s.secret, `${e.vendorKey}/${s.id}`).toBe(hasSecret);
      }
      if (g.radius !== null) {
        expect(text, e.vendorKey).not.toContain('<ECLOUD_RADIUS_ADDRESS>');
        expect(g.radius.address).toBe('192.0.2.53');
      }
    }
    const cambium = buildGalleryGuide(getGalleryEntry('cambium')!, VALUES);
    expect(cambium.portalUrl).toBe(
      'https://portal.example.test:8444/pb/cambium-hotspot/<NAS_IDENTIFIER>/',
    );
    expect(cambium.steps.find((s) => s.id === 'radius-acct')?.value).toBe(
      '192.0.2.53, 11813, <RADIUS_SECRET>',
    );
    // the portal URL appears once (at Guest Access > External Portal URL), noting the NAS id
    const urlSteps = cambium.steps.filter((s) => s.value === cambium.portalUrl);
    expect(urlSteps.map((s) => s.id)).toEqual(['cambium-external-url']);
    expect(urlSteps[0]?.title).toContain('NAS identifier');
    for (const e of GALLERY_ENTRIES.filter((x) => x.adapterKey === 'external-portal-postback')) {
      const g = buildGalleryGuide(e, VALUES);
      expect(
        g.steps.filter((s) => s.value === g.portalUrl),
        e.vendorKey,
      ).toHaveLength(1);
    }
    const mikrotik = buildGalleryGuide(getGalleryEntry('mikrotik')!, VALUES);
    expect(mikrotik.radius?.coaPort).toBe(1700);
    const unifi = buildGalleryGuide(getGalleryEntry('ubiquiti-unifi')!, VALUES);
    expect(unifi.radius).toBeNull();
    expect(unifi.steps.find((s) => s.id === 'unifi-api-key')?.secret).toBe(true);
  });

  it('keeps the RADIUS placeholder when no address is configured', () => {
    const g = buildGalleryGuide(getGalleryEntry('generic-8021x')!, {
      ...VALUES,
      radiusAddress: null,
    });
    expect(g.radius?.address).toBeNull();
    expect(JSON.stringify(g.steps)).toContain('<ECLOUD_RADIUS_ADDRESS>');
  });

  it('long-tail guides start with the captured-redirect step', () => {
    for (const e of GALLERY_ENTRIES.filter((x) => x.longTail)) {
      const g = buildGalleryGuide(e, VALUES);
      expect(g.steps[0]?.id, e.vendorKey).toBe('capture-redirect');
      expect(g.portalUrl).toContain('/pb/postback-generic/');
    }
  });
});
