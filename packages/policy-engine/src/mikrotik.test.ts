import { POLICY_FIELDS } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { captive32, untested } from './adapters.fixture.js';
import type { AdapterCapabilities } from './capabilities.js';
import { INTENT_COLUMNS } from './intent.js';
import {
  MIKROTIK_RATE_ATTRIBUTE,
  MIKROTIK_RATE_FAMILY,
  MIKROTIK_RATE_FIELD_DECLARATIONS,
  MIKROTIK_RATE_LIMIT_ATTRIBUTE,
  MikrotikRateError,
  formatMikrotikRate,
  renderMikrotikRateLimit,
} from './mikrotik.js';
import type { Clip, EffectivePolicy } from './resolve.js';
import { translate, type TranslationContext } from './translate.js';

describe('formatMikrotikRate', () => {
  it.each([
    [0, '0'],
    [1, '1k'],
    [512, '512k'],
    [999, '999k'],
    [1000, '1M'],
    [1500, '1500k'],
    [2000, '2M'],
    [10_000, '10M'],
    [1_000_000, '1000M'],
    [1_000_001, '1000001k'],
  ])('%d kbit/s -> %s', (kbps, expected) => {
    expect(formatMikrotikRate(kbps)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])('refuses %s', (kbps) => {
    expect(() => formatMikrotikRate(kbps)).toThrow(MikrotikRateError);
  });
});

describe('renderMikrotikRateLimit (rx = client upload, tx = client download)', () => {
  it('renders "upload/download" from the router point of view', () => {
    expect(renderMikrotikRateLimit({ downloadKbps: 10_000, uploadKbps: 2_000 })).toBe('2M/10M');
    expect(renderMikrotikRateLimit({ downloadKbps: 1_500, uploadKbps: 512 })).toBe('512k/1500k');
  });

  it('always renders both directions; an unset direction is 0 (never omitted)', () => {
    // A lone "rx" would cap the download at the upload rate (vendor doc).
    expect(renderMikrotikRateLimit({ downloadKbps: 8_000, uploadKbps: null })).toBe('0/8M');
    expect(renderMikrotikRateLimit({ downloadKbps: null, uploadKbps: 1_000 })).toBe('1M/0');
  });

  it('returns null when no rate is set (no attribute rather than "0/0")', () => {
    expect(renderMikrotikRateLimit({ downloadKbps: null, uploadKbps: null })).toBeNull();
  });

  it('renders burst, thresholds and time in the documented positional order', () => {
    expect(
      renderMikrotikRateLimit({
        downloadKbps: 4_000,
        uploadKbps: 1_000,
        burst: { downloadKbps: 8_000, uploadKbps: 2_000 },
      }),
    ).toBe('1M/4M 2M/8M');
    expect(
      renderMikrotikRateLimit({
        downloadKbps: 4_000,
        uploadKbps: 1_000,
        burst: {
          downloadKbps: 8_000,
          uploadKbps: 2_000,
          thresholdDownloadKbps: 3_000,
          thresholdUploadKbps: 750,
          timeS: 10,
        },
      }),
    ).toBe('1M/4M 2M/8M 750k/3M 10/10');
    // time without thresholds: threshold slot filled with the base rates (documented default)
    expect(
      renderMikrotikRateLimit({
        downloadKbps: 4_000,
        uploadKbps: 1_000,
        burst: { downloadKbps: 8_000, uploadKbps: 2_000, timeS: 8 },
      }),
    ).toBe('1M/4M 2M/8M 1M/4M 8/8');
  });

  it.each([
    [
      'burst without a base rate',
      { downloadKbps: null, uploadKbps: null, burst: { downloadKbps: 2, uploadKbps: 2 } },
    ],
    [
      'burst on an unlimited direction',
      { downloadKbps: 1_000, uploadKbps: null, burst: { downloadKbps: 2_000, uploadKbps: 2_000 } },
    ],
    [
      'burst not above the rate',
      { downloadKbps: 1_000, uploadKbps: 1_000, burst: { downloadKbps: 1_000, uploadKbps: 2_000 } },
    ],
    [
      'threshold above the rate',
      {
        downloadKbps: 1_000,
        uploadKbps: 1_000,
        burst: { downloadKbps: 2_000, uploadKbps: 2_000, thresholdDownloadKbps: 1_001 },
      },
    ],
    [
      'zero burst time',
      {
        downloadKbps: 1_000,
        uploadKbps: 1_000,
        burst: { downloadKbps: 2_000, uploadKbps: 2_000, timeS: 0 },
      },
    ],
    ['negative rate', { downloadKbps: -1, uploadKbps: 1 }],
    ['fractional rate', { downloadKbps: 1.25, uploadKbps: 1 }],
  ] as const)('refuses %s', (_label, input) => {
    expect(() => renderMikrotikRateLimit(input)).toThrow(MikrotikRateError);
  });
});

describe('MikroTik declarations (D-028 four-state)', () => {
  it('the attribute and the rate fields are DOCUMENTED / REQUIRES_DEVICE_TEST, never VERIFIED', () => {
    expect(MIKROTIK_RATE_ATTRIBUTE).toMatchObject({
      name: 'Mikrotik-Rate-Limit',
      status: 'REQUIRES_DEVICE_TEST',
      evidenceLevel: 'DOCUMENTED',
      vendor: 'Mikrotik',
    });
    expect(MIKROTIK_RATE_ATTRIBUTE.evidenceRefs?.some((r) => r.url?.includes('mikrotik'))).toBe(
      true,
    );
    const byField = Object.fromEntries(MIKROTIK_RATE_FIELD_DECLARATIONS.map((d) => [d.field, d]));
    expect(byField.download_rate_kbps?.status).toBe('REQUIRES_DEVICE_TEST');
    expect(byField.upload_rate_kbps?.status).toBe('REQUIRES_DEVICE_TEST');
    for (const f of ['burst_download_kbps', 'burst_upload_kbps', 'burst_duration_s'])
      expect(byField[f]?.status).toBe('UNSUPPORTED');
    for (const d of MIKROTIK_RATE_FIELD_DECLARATIONS) {
      expect(POLICY_FIELDS).toContain(d.field);
      expect(d.evidenceLevel).toBe('DOCUMENTED');
      expect(d.status).not.toBe('VERIFIED_SUPPORTED');
    }
    expect(MIKROTIK_RATE_FAMILY).toMatchObject({
      family: 'mikrotik',
      combined: MIKROTIK_RATE_LIMIT_ATTRIBUTE,
      vendor: 'Mikrotik',
    });
  });
});

// ------------------------------------------------------------------------------------------
// translate() with a combined (MikroTik) rate family — synthetic adapter, test only
// ------------------------------------------------------------------------------------------

const NOW = new Date('2026-10-10T06:00:00Z');
const clip: Clip = {
  policy_session_timeout_s: null,
  window_end_s: null,
  validity_end_s: null,
  voucher_end_s: null,
  quota_reset_s: null,
  remaining_octets: null,
  remaining_period: null,
  drain_time_s: null,
  min_session_s: 300,
};

function effective(fields: Partial<EffectivePolicy['fields']>): EffectivePolicy {
  const blank = Object.fromEntries(
    INTENT_COLUMNS.map((k) => [k, null]),
  ) as unknown as EffectivePolicy['fields'];
  return {
    fields: { ...blank, ...fields },
    schedule: null,
    provenance: {},
    winner: null,
    concurrency_mode: null,
    critical_fields: [],
  };
}

function mikrotikLike(
  rateStatus: 'REQUIRES_DEVICE_TEST' | 'VERIFIED_SUPPORTED',
): AdapterCapabilities {
  const attr = { ...MIKROTIK_RATE_ATTRIBUTE, status: rateStatus };
  return {
    ...untested,
    rateUnit: 'mikrotik-rate-string',
    rateFamilies: [MIKROTIK_RATE_FAMILY],
    fields: {
      ...untested.fields,
      download_rate_kbps: { ...untested.fields.download_rate_kbps, status: rateStatus },
      upload_rate_kbps: { ...untested.fields.upload_rate_kbps, status: rateStatus },
    },
    attributes: { ...untested.attributes, [MIKROTIK_RATE_LIMIT_ATTRIBUTE]: attr },
  };
}

const ctx = (extra: Partial<TranslationContext> = {}): TranslationContext => ({
  now: NOW,
  clip,
  ...extra,
});

describe('translate() with the mikrotik combined rate family', () => {
  it('REQUIRES_DEVICE_TEST: nothing emitted by default, both fields flagged', () => {
    const plan = translate(
      effective({ download_rate_kbps: 10_000, upload_rate_kbps: 2_000 }),
      mikrotikLike('REQUIRES_DEVICE_TEST'),
      ctx(),
    );
    expect(plan.radiusReplyAttributes.filter((a) => a.name === 'Mikrotik-Rate-Limit')).toEqual([]);
    const flagged = plan.unenforceable.filter((u) => u.reason === 'requires_device_test');
    expect(flagged.map((u) => u.field).sort()).toEqual(['download_rate_kbps', 'upload_rate_kbps']);
    const row = plan.fieldTable.find((f) => f.field === 'download_rate_kbps');
    expect(row?.deviceEnforced).toBe(false);
  });

  it('with includeDeviceTestAttributes: ONE experimental "rx/tx" attribute for both fields', () => {
    const plan = translate(
      effective({ download_rate_kbps: 10_000, upload_rate_kbps: 2_000 }),
      mikrotikLike('REQUIRES_DEVICE_TEST'),
      ctx({ includeDeviceTestAttributes: true }),
    );
    const rate = plan.radiusReplyAttributes.filter((a) => a.name === 'Mikrotik-Rate-Limit');
    expect(rate).toHaveLength(1);
    expect(rate[0]).toMatchObject({ value: '2M/10M', vendor: 'Mikrotik', experimental: true });
    for (const f of ['download_rate_kbps', 'upload_rate_kbps'] as const) {
      const row = plan.fieldTable.find((r) => r.field === f);
      expect(row?.attributes).toEqual(['Mikrotik-Rate-Limit']);
      expect(row?.deviceEnforced).toBe(false);
    }
  });

  it('a (hypothetical) verified declaration emits one attribute; only download set → "0/<down>"', () => {
    const plan = translate(
      effective({ download_rate_kbps: 1_500 }),
      mikrotikLike('VERIFIED_SUPPORTED'),
      ctx(),
    );
    expect(plan.radiusReplyAttributes.filter((a) => a.name === 'Mikrotik-Rate-Limit')).toEqual([
      expect.objectContaining({ value: '0/1500k', vendor: 'Mikrotik' }),
    ]);
    expect(plan.fieldTable.find((r) => r.field === 'upload_rate_kbps')?.set).toBe(false);
  });

  it('burst stays unenforced (engine has no burst, D-028 stage 10)', () => {
    const plan = translate(
      effective({ download_rate_kbps: 4_000, upload_rate_kbps: 1_000, burst_download_kbps: 8_000 }),
      mikrotikLike('VERIFIED_SUPPORTED'),
      ctx(),
    );
    expect(plan.radiusReplyAttributes.find((a) => a.name === 'Mikrotik-Rate-Limit')?.value).toBe(
      '1M/4M',
    );
    expect(plan.unenforceable.some((u) => u.field === 'burst_download_kbps')).toBe(true);
  });

  it('two-attribute families are unchanged (no combined path)', () => {
    const plan = translate(
      effective({ download_rate_kbps: 1_000, upload_rate_kbps: 500 }),
      captive32,
      ctx(),
    );
    expect(plan.radiusReplyAttributes.map((a) => a.name).sort()).toContain(
      'WISPr-Bandwidth-Max-Down',
    );
    expect(plan.radiusReplyAttributes.some((a) => a.name === 'Mikrotik-Rate-Limit')).toBe(false);
  });
});
