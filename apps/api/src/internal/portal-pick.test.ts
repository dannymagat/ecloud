/**
 * Resolution of the portal that serves a NAS (`pickPortal`), including the migration-041
 * platform-default fallback.
 *
 * The case that matters most here is ambiguity. `pickPortal` used to answer a nullable row, so
 * "nothing is configured" and "two configured portals match" were the same answer, and the caller
 * created an anonymous click-through fallback for both. A site with two pinned portals — the
 * misconfiguration the code deliberately refuses — therefore failed OPEN. The three-way result
 * exists to keep those apart, so these tests assert the discriminator and not just non-null.
 */
import { describe, expect, it } from 'vitest';
import { pickPortal } from './portal.js';
import type { PortalRow } from './portal-row.js';

function row(over: Partial<PortalRow> & { id: string }): PortalRow {
  return {
    name: 'Portal',
    site_id: 'site-1',
    auth_methods: ['click_through'],
    theme_id: null,
    terms_version: null,
    redirect_url: null,
    uam_secret_ref: null,
    adapter_config: {},
    status: 'active',
    published_version_id: 'v1',
    is_platform_default: false,
    ...over,
  };
}

const NAS = 'nas-1';

describe('pickPortal', () => {
  it('prefers the portal pinned to this NAS over an unpinned one', () => {
    const pinned = row({ id: 'pinned', adapter_config: { nas_client_id: NAS } });
    const picked = pickPortal([pinned, row({ id: 'unpinned' })], NAS);
    expect(picked).toEqual({ kind: 'configured', row: pinned });
  });

  it('takes the only unpinned portal when none is pinned to this NAS', () => {
    const only = row({ id: 'only' });
    expect(pickPortal([only], NAS)).toEqual({ kind: 'configured', row: only });
  });

  it('ignores a portal pinned to a different NAS', () => {
    const other = row({ id: 'other', adapter_config: { nas_client_id: 'nas-2' } });
    const mine = row({ id: 'mine' });
    expect(pickPortal([other, mine], NAS)).toEqual({ kind: 'configured', row: mine });
  });

  it('reports ambiguity rather than nothing when two portals are pinned to this NAS', () => {
    const picked = pickPortal(
      [
        row({ id: 'a', adapter_config: { nas_client_id: NAS } }),
        row({ id: 'b', adapter_config: { nas_client_id: NAS } }),
      ],
      NAS,
    );
    // Not `none`: `none` would let the caller create an anonymous fallback for a site whose
    // operator configured two portals, which is failing open on a misconfiguration.
    expect(picked).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('reports ambiguity for two unpinned portals', () => {
    const picked = pickPortal([row({ id: 'a' }), row({ id: 'b' })], NAS);
    expect(picked).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('reports none for a site with no portal at all, which is what may create a fallback', () => {
    expect(pickPortal([], NAS)).toEqual({ kind: 'none' });
  });

  it('never counts a platform default as a configured candidate', () => {
    // The whole point: one real portal plus a fallback row must resolve to the real portal, not
    // to ambiguity. Counting the fallback would take a working site offline.
    const real = row({ id: 'real' });
    const fallback = row({ id: 'fallback', is_platform_default: true });
    expect(pickPortal([real, fallback], NAS)).toEqual({ kind: 'configured', row: real });
  });

  it('prefers a configured portal pinned elsewhere? no — falls back only when nothing is configured', () => {
    const fallback = row({ id: 'fallback', is_platform_default: true });
    const elsewhere = row({ id: 'elsewhere', adapter_config: { nas_client_id: 'nas-2' } });
    // The configured portal belongs to another NAS, so for this NAS nothing is configured and
    // the existing fallback serves it.
    expect(pickPortal([elsewhere, fallback], NAS)).toEqual({ kind: 'fallback', row: fallback });
  });

  it('reports an existing platform default as `fallback`, never as `configured`', () => {
    const fallback = row({ id: 'fallback', is_platform_default: true });
    expect(pickPortal([fallback], NAS)).toEqual({ kind: 'fallback', row: fallback });
  });

  it('still refuses when configured portals are ambiguous and a fallback exists', () => {
    const picked = pickPortal(
      [
        row({ id: 'a' }),
        row({ id: 'b' }),
        row({ id: 'fallback', is_platform_default: true }),
      ],
      NAS,
    );
    expect(picked).toEqual({ kind: 'ambiguous', count: 2 });
  });
});

describe('the fallback outcome is not mistakable for a configured portal', () => {
  it('uses a distinct kind, so a caller cannot use one where it meant the other', () => {
    const fallback = row({ id: 'fallback', is_platform_default: true });
    const picked = pickPortal([fallback], NAS);
    // The point of the separate kind: while a fallback came back as a bare `found`, every new
    // caller inherited the "serve it without checking for a disabled configured portal" bug by
    // default. Three call sites did exactly that.
    expect(picked.kind).toBe('fallback');
    expect(picked.kind).not.toBe('configured');
  });
});
