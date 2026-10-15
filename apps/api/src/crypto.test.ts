/**
 * The v2 bound envelope (task 10; findings S-1 and S-2 of SECURITY_REVIEW_FLEET_DEFAULT.md,
 * test list in docs/AAA_SECRET_SEALING_V2_PROPOSAL.md §7).
 *
 * Every case below passes with the correct DATA_ENCRYPTION_KEY and an intact GCM tag. That is the
 * point: before the AAD, a sealed secret was a bearer token for any row in any tenant under the
 * same purpose, and nothing in the code or the tests said otherwise.
 */
import { describe, expect, it } from 'vitest';
import {
  Envelope,
  NAS_SECRET_COLUMN,
  NAS_SECRET_PURPOSE,
  openBoundSecretRef,
  openNasSecret,
  sealBoundSecretRef,
  sealNasSecret,
  sealSecretRef,
  type SealBinding,
} from './crypto.js';
import { UAM_SECRET_COLUMN, UAM_SECRET_PURPOSE } from './internal/portal.js';

const KEY = 'unit-test-data-encryption-key-0123456789'; // check-no-secrets: allow (test value)
const SECRET = 'Ab3_-xyzAb3_-xyzAb3_-xyzAb3_-xyzAb3_-xyzAb3'; // check-no-secrets: allow (test value)
const ORG_A = '5e9a1b7c-3d4e-4f50-8a1b-2c3d4e5f6071';
const ORG_B = '5e9a1b7c-3d4e-4f50-8a1b-2c3d4e5f6072';
const ROW_A = '0b6f3c2e-1d2a-4c5e-9f00-112233445566';
const ROW_B = '7c1d9e40-2a3b-4c5d-8e6f-778899aabbcc';

const nasEnvelope = () => new Envelope(KEY, NAS_SECRET_PURPOSE);
const uamEnvelope = () => new Envelope(KEY, UAM_SECRET_PURPOSE);

const nasAt = (rowId: string, org = ORG_A, secretVersion = 1): SealBinding => ({
  organizationId: org,
  rowId,
  column: NAS_SECRET_COLUMN,
  secretVersion,
});

describe('v2 bound envelope', () => {
  it('round trips under each of the two column bindings (§7.1)', () => {
    const nasRef = sealBoundSecretRef(nasEnvelope(), SECRET, nasAt(ROW_A));
    expect(nasRef).toMatch(/^enc:v2\./);
    expect(openBoundSecretRef(nasEnvelope(), nasRef, nasAt(ROW_A), { allowV1: false })).toBe(
      SECRET,
    );

    const uamBinding: SealBinding = {
      organizationId: ORG_A,
      rowId: ROW_A,
      column: UAM_SECRET_COLUMN,
      secretVersion: 1,
    };
    const uamRef = sealBoundSecretRef(uamEnvelope(), SECRET, uamBinding);
    expect(openBoundSecretRef(uamEnvelope(), uamRef, uamBinding, { allowV1: false })).toBe(SECRET);
  });

  it('refuses a ciphertext moved to another row (§7.2)', () => {
    const ref = sealNasSecret(nasEnvelope(), SECRET, {
      organizationId: ORG_A,
      nasId: ROW_A,
      secretVersion: 1,
    });
    expect(() =>
      openNasSecret(nasEnvelope(), ref, {
        organizationId: ORG_A,
        nasId: ROW_B,
        secretVersion: 1,
      }),
    ).toThrow();
  });

  it('refuses a ciphertext moved to another tenant, same row id (§7.3)', () => {
    // The row id alone is not the identity. A restored backup or a copied row keeps the id.
    const ref = sealNasSecret(nasEnvelope(), SECRET, {
      organizationId: ORG_A,
      nasId: ROW_A,
      secretVersion: 1,
    });
    expect(() =>
      openNasSecret(nasEnvelope(), ref, {
        organizationId: ORG_B,
        nasId: ROW_A,
        secretVersion: 1,
      }),
    ).toThrow();
  });

  it('refuses a UAM ciphertext opened as a NAS secret (§7.4, the S-1 regression)', () => {
    // This must fail for TWO independent reasons now: the purposes differ, so the HKDF-derived
    // keys differ, AND the column in the AAD differs. Before the fix both constants held
    // 'ecloud:nas:secret:v1' and there was no AAD, so this succeeded — a portal UAM secret
    // opened as a RADIUS shared secret, which is the whole of S-1 in one line.
    const uamRef = sealBoundSecretRef(uamEnvelope(), SECRET, {
      organizationId: ORG_A,
      rowId: ROW_A,
      column: UAM_SECRET_COLUMN,
      secretVersion: 1,
    });
    expect(() => openNasSecret(nasEnvelope(), uamRef, {
      organizationId: ORG_A,
      nasId: ROW_A,
      secretVersion: 1,
    })).toThrow();

    // And the narrower half on its own: same key, same row, only the column changed.
    const sameKeyOtherColumn = sealBoundSecretRef(nasEnvelope(), SECRET, {
      organizationId: ORG_A,
      rowId: ROW_A,
      column: UAM_SECRET_COLUMN,
      secretVersion: 1,
    });
    expect(() =>
      openBoundSecretRef(nasEnvelope(), sameKeyOtherColumn, nasAt(ROW_A), { allowV1: false }),
    ).toThrow();
  });

  it('refuses a pre-rotation ciphertext replayed at the new version (§7.5)', () => {
    // This is the case AAD over identity alone does NOT catch, and the reason secret_version is
    // a column with a trigger: a row's identity is unchanged by a rotation.
    const old = sealNasSecret(nasEnvelope(), SECRET, {
      organizationId: ORG_A,
      nasId: ROW_A,
      secretVersion: 1,
    });
    expect(() =>
      openNasSecret(nasEnvelope(), old, {
        organizationId: ORG_A,
        nasId: ROW_A,
        secretVersion: 2,
      }),
    ).toThrow();
  });

  it('keeps the NAS and UAM purpose labels distinct (§7.6)', () => {
    // Reads like a tautology and is the single test that would have caught S-1: the entire
    // defect was two differently-named constants holding the same string.
    expect(NAS_SECRET_PURPOSE).not.toBe(UAM_SECRET_PURPOSE);
    expect(NAS_SECRET_COLUMN).not.toBe(UAM_SECRET_COLUMN);
  });

  it('opens a v1 ref only while allowV1 is set (§7.7)', () => {
    // The transitional branch: the database holds both formats until the re-seal completes.
    const v1 = sealSecretRef(nasEnvelope(), SECRET);
    expect(v1).toMatch(/^enc:v1\./);
    expect(openBoundSecretRef(nasEnvelope(), v1, nasAt(ROW_A), { allowV1: true })).toBe(SECRET);
    expect(() =>
      openBoundSecretRef(nasEnvelope(), v1, nasAt(ROW_A), { allowV1: false }),
    ).toThrow(/v1 secret_ref is no longer accepted/);
    // A v1 ref carries no AAD, so it opens under ANY binding while the allowance stands. That is
    // the cost of the transition, stated here rather than discovered during the re-seal.
    expect(openBoundSecretRef(nasEnvelope(), v1, nasAt(ROW_B, ORG_B, 9), { allowV1: true })).toBe(
      SECRET,
    );
  });
});
