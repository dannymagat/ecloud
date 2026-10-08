/**
 * P7-B AC2: uCentral rate-limit fragment export (openwifi-config). Export/preview only,
 * schema-validated against the vendored ezecontroller copy of ucentral.full.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PolicyIntentSchema,
  resolveEffectivePolicy,
  type EnforcementPlan,
  type ResolutionInput,
} from '@ecloud/policy-engine';
import { getAdapter } from '../registry.js';
import {
  FRAGMENT_WARNINGS,
  UCENTRAL_SCHEMA_SOURCE,
  exportRateLimitFragment,
  isFragmentExport,
  validateUcentralConfig,
} from './ucentral-fragment.js';

const NOW = new Date('2026-10-06T06:00:00Z');
const HERE = import.meta.dirname;

function plan(
  fields: { down?: number | null; up?: number | null; idle?: number | null },
  targetType: 'site' | 'user_group' = 'site',
  ssid = 'lab-uam',
): EnforcementPlan {
  const policy = PolicyIntentSchema.parse({
    id: 'pol-site',
    organization_id: 'org-1',
    name: 'Site cap',
    scope_type: targetType === 'site' ? 'site' : 'group',
    status: 'active',
    version: 1,
    download_rate_kbps: fields.down ?? null,
    upload_rate_kbps: fields.up ?? null,
    idle_timeout_s: fields.idle ?? null,
  });
  const input: ResolutionInput = {
    now: NOW,
    timeZone: 'UTC',
    organization_id: 'org-1',
    site_id: 'site-1',
    subject: { kind: 'user', user_id: 'user-1' },
    client_device_id: null,
    mac: null,
    group_ids: ['grp-1'],
    candidates: [
      {
        assignment: {
          id: 'as-1',
          policy_id: 'pol-site',
          target_type: targetType,
          user_group_id: targetType === 'user_group' ? 'grp-1' : null,
          site_id: targetType === 'site' ? 'site-1' : null,
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
  return getAdapter('openwifi-config').translate(r.effective, {
    now: NOW,
    clip: r.clip,
    controls: r.controls,
    ssidRef: ssid,
  });
}

describe('exportRateLimitFragment (openwifi-config, export/preview only)', () => {
  it('site-scoped 20 000 / 5 000 kbit/s → egress 20 / ingress 5 Mbit/s, schema-valid, not device-enforced', () => {
    const out = exportRateLimitFragment(plan({ down: 20_000, up: 5_000, idle: 600 }), 'lab-uam');
    expect(isFragmentExport(out)).toBe(true);
    if (!isFragmentExport(out)) return;
    expect(out.fragment).toEqual({
      interfaces: [
        { ssids: [{ name: 'lab-uam', 'rate-limit': { 'egress-rate': 20, 'ingress-rate': 5 } }] },
      ],
    });
    expect(out.mode).toBe('export_preview_only');
    expect(out.validation).toMatchObject({
      valid: true,
      schemaId: 'https://openwrt.org/ucentral.schema.json',
      schemaSha256: UCENTRAL_SCHEMA_SOURCE.sha256,
      errors: [],
    });
    // Source-verified only (no DT-02 lab result): never presented as device-enforced (V12).
    expect(out.deviceEnforced).toBe(false);
    expect(
      out.changes.map((c) => [c.field, c.value, c.status, c.evidenceLevel, c.deviceEnforced]),
    ).toEqual([
      ['download_rate_kbps', 20, 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', false],
      ['upload_rate_kbps', 5, 'VERIFIED_SUPPORTED', 'VERIFIED_FROM_SOURCE', false],
    ]);
    // max-inactivity is a config change but not a rate limit: reported, not exported.
    expect(out.omitted).toEqual([
      {
        field: 'idle_timeout_s',
        path: 'interfaces[].ssids[lab-uam].max-inactivity',
        reason: 'not a rate limit: outside the rate-limit export (P7-B scope)',
      },
    ]);
    expect(out.warnings).toBe(FRAGMENT_WARNINGS);
    expect(out.warnings.join(' ')).toMatch(/did not push/);
    expect(out.warnings.join(' ')).toMatch(/REQUIRES DEVICE TEST/);
  });

  it('rounds kbit/s up to whole Mbit/s and exports a single direction when only one is set', () => {
    const out = exportRateLimitFragment(plan({ down: 1_500 }), 'lab-uam');
    expect(isFragmentExport(out) && out.fragment.interfaces[0].ssids[0]['rate-limit']).toEqual({
      'egress-rate': 2,
    });
  });

  it('refuses a group-scoped rate (per-SSID cap would hit every station): granularity_mismatch', () => {
    const out = exportRateLimitFragment(plan({ down: 20_000, up: 5_000 }, 'user_group'), 'lab-uam');
    expect(isFragmentExport(out)).toBe(false);
    expect(out).toMatchObject({ unsupported: true });
    expect(out.omitted.map((o) => [o.field, o.reason.split(':')[0]])).toEqual([
      ['download_rate_kbps', 'granularity_mismatch'],
      ['upload_rate_kbps', 'granularity_mismatch'],
    ]);
  });

  it('refuses sub-Mbit rates and plans without any rate', () => {
    const sub = exportRateLimitFragment(plan({ down: 500 }), 'lab-uam');
    expect(isFragmentExport(sub)).toBe(false);
    expect(sub.omitted[0]?.reason).toMatch(/^unsupported: sub-Mbit/);
    const none = exportRateLimitFragment(plan({ idle: 600 }), 'lab-uam');
    expect(none).toMatchObject({ unsupported: true });
  });

  it('refuses foreign plans and an SSID mismatch', () => {
    const foreign = { ...plan({ down: 20_000 }), adapter: 'coovachilli-uam' } as EnforcementPlan;
    expect(exportRateLimitFragment(foreign, 'lab-uam')).toMatchObject({ unsupported: true });
    expect(exportRateLimitFragment(plan({ down: 20_000 }), 'other-ssid')).toMatchObject({
      unsupported: true,
      reason: 'plan was translated for SSID "lab-uam", not "other-ssid"',
    });
  });

  it('an SSID name the uCentral schema rejects (> 32 chars) yields no fragment', () => {
    const long = 'x'.repeat(33);
    const out = exportRateLimitFragment(plan({ down: 20_000 }, 'site', long), long);
    expect(out).toMatchObject({ unsupported: true });
    expect(isFragmentExport(out) ? '' : out.reason).toMatch(/schema validation.*ssids\/0\/name/);
  });
});

describe('validateUcentralConfig (vendored ucentral.full.json, ajv 8)', () => {
  it('accepts integer rates and rejects strings / fractions', () => {
    const ok = validateUcentralConfig({
      interfaces: [
        { ssids: [{ name: 's', 'rate-limit': { 'ingress-rate': 5, 'egress-rate': 10 } }] },
      ],
    });
    expect(ok.valid).toBe(true);
    const bad = validateUcentralConfig({
      interfaces: [
        { ssids: [{ name: 's', 'rate-limit': { 'ingress-rate': 5.5, 'egress-rate': '10' } }] },
      ],
    });
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e) => e.path)).toEqual([
      '/interfaces/0/ssids/0/rate-limit/ingress-rate',
      '/interfaces/0/ssids/0/rate-limit/egress-rate',
    ]);
  });

  it('the vendored schema is the unmodified byte copy recorded in UCENTRAL_SCHEMA_SOURCE', () => {
    const bytes = readFileSync(join(HERE, 'schema', 'ucentral.full.json'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(UCENTRAL_SCHEMA_SOURCE.sha256);
  });

  const upstream = resolve(
    process.env.ECLOUD_EZECONTROLLER_DIR ?? resolve(HERE, '../../../../../ezecontroller'),
    'src/schemas/ucentral.full.json',
  );
  it.skipIf(!existsSync(upstream))(
    'matches the local ezecontroller copy when it is checked out next to this repository',
    () => {
      const digest = createHash('sha256').update(readFileSync(upstream)).digest('hex');
      expect(digest).toBe(UCENTRAL_SCHEMA_SOURCE.sha256);
    },
  );

  it('the export module has no network path (no push to any controller)', () => {
    const src = readFileSync(join(HERE, 'ucentral-fragment.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(|node:https?|node:net|node:dgram|axios|undici/);
  });
});
