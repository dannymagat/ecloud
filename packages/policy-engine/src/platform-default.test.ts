/**
 * Migration 043: the platform-default layer, and — more importantly — the three independent
 * reasons it cannot grant anything today.
 *
 * NAS_PENDING_ADOPTION_REQUIREMENTS.md (owner, 2026-10-14 13:44) §5 defines a NAS whose policy
 * is missing or unavailable as Pending with new authorization DENIED under the reason code
 * NO_POLICY, and §8 forbids any default acceptance that bypasses that. That document arrived
 * after the fallback was asked for and contradicts it, so the granting half is paused pending
 * the owner's decision.
 *
 * These tests therefore pin the SAFE behaviour: absent a platform default, resolution still
 * rejects with `no_policy` exactly as before. They also cover the layer itself, because the
 * provenance and enumeration work is wanted whichever way the owner decides — the Pending model
 * needs precisely this kind of visibility.
 */
import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy as resolve, LAYERS } from './resolve.js';
import { policy, workedExampleInput } from './resolve.fixture.js';

/** No candidates and no organization default: the Pending shape of §5. */
function unassigned(overrides: Parameters<typeof workedExampleInput>[0] = {}) {
  return workedExampleInput({
    candidates: [],
    default_policy: null,
    active_sessions: [],
    usage: {},
    ...overrides,
  });
}

describe('without a platform default (the shipped behaviour)', () => {
  it('still rejects with no_policy, which is what §5 requires', () => {
    const r = resolve(unassigned());
    expect(r.decision).toBe('reject');
    expect(r.reasonCode).toBe('no_policy');
  });

  it('reports platform_default false, so nothing downstream records a fallback that did not happen', () => {
    expect(resolve(unassigned()).platform_default).toBe(false);
  });

  it('an explicit null is the same as absent: no accidental fallback from a loader returning null', () => {
    const r = resolve(unassigned({ platform_default: null }));
    expect(r.decision).toBe('reject');
    expect(r.reasonCode).toBe('no_policy');
  });
});

describe('with a platform default supplied (paused: nothing supplies one today)', () => {
  const fallback = policy('platform-default', {
    scope_type: 'site',
    download_rate_kbps: 10_000,
    upload_rate_kbps: 10_000,
    session_timeout_s: 86_400,
  });

  it('answers where there was no answer', () => {
    const r = resolve(unassigned({ platform_default: fallback }));
    expect(r.decision).toBe('accept');
    expect(r.effective.fields.download_rate_kbps).toBe(10_000);
  });

  it('is marked in the result, not silently indistinguishable from a chosen policy', () => {
    expect(resolve(unassigned({ platform_default: fallback })).platform_default).toBe(true);
  });

  it('names itself in the provenance rather than posing as an organization default', () => {
    const r = resolve(unassigned({ platform_default: fallback }));
    expect(r.effective.winner?.layer_name).toBe('platform_default');
    expect(r.effective.winner?.target_type).toBe('platform_default');
    expect(r.effective.provenance.download_rate_kbps?.layer_name).toBe('platform_default');
  });

  it('is the lowest layer there is, below the organization default', () => {
    expect(LAYERS.platform_default).toBeGreaterThan(LAYERS.organization_default);
  });

  it('never outranks anything an operator chose', () => {
    // A real organization default exists, so the fallback must not be reached at all.
    const chosen = policy('org-default', {
      scope_type: 'site',
      is_default: true,
      download_rate_kbps: 2000,
    });
    const r = resolve(
      unassigned({ default_policy: chosen, platform_default: fallback }),
    );
    expect(r.decision).toBe('accept');
    expect(r.effective.fields.download_rate_kbps).toBe(2000);
    expect(r.platform_default).toBe(false);
    expect(r.effective.winner?.layer_name).toBe('organization_default');
  });

  it('appears in the trace as an included candidate, so a reader can see why access was granted', () => {
    const r = resolve(unassigned({ platform_default: fallback }));
    const entry = r.trace.find((t) => t.step === 'candidate' && t.layer_name === 'platform_default');
    expect(entry).toBeDefined();
  });
});
