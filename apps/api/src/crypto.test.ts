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
import { UAM_SECRET_COLUMN, UAM_SECRET_PURPOSE, openUamSecret } from './internal/portal.js';
import type { AppDeps } from './context.js';

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
    expect(openBoundSecretRef(nasEnvelope(), nasRef, nasAt(ROW_A))).toBe(
      SECRET,
    );

    const uamBinding: SealBinding = {
      organizationId: ORG_A,
      rowId: ROW_A,
      column: UAM_SECRET_COLUMN,
      secretVersion: 1,
    };
    const uamRef = sealBoundSecretRef(uamEnvelope(), SECRET, uamBinding);
    expect(openBoundSecretRef(uamEnvelope(), uamRef, uamBinding)).toBe(SECRET);
  });

  it('refuses a ciphertext moved to another row (§7.2)', () => {
    const ref = sealNasSecret(KEY, SECRET, {
      organizationId: ORG_A,
      nasId: ROW_A,
      secretVersion: 1,
    });
    expect(() =>
      openNasSecret(KEY, ref, {
        organizationId: ORG_A,
        nasId: ROW_B,
        secretVersion: 1,
      }),
    ).toThrow();
  });

  it('refuses a ciphertext moved to another tenant, same row id (§7.3)', () => {
    // The row id alone is not the identity. A restored backup or a copied row keeps the id.
    const ref = sealNasSecret(KEY, SECRET, {
      organizationId: ORG_A,
      nasId: ROW_A,
      secretVersion: 1,
    });
    expect(() =>
      openNasSecret(KEY, ref, {
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
    expect(() => openNasSecret(KEY, uamRef, {
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
      openBoundSecretRef(nasEnvelope(), sameKeyOtherColumn, nasAt(ROW_A)),
    ).toThrow();
  });

  it('refuses a pre-rotation ciphertext replayed at the new version (§7.5)', () => {
    // This is the case AAD over identity alone does NOT catch, and the reason secret_version is
    // a column with a trigger: a row's identity is unchanged by a rotation.
    const old = sealNasSecret(KEY, SECRET, {
      organizationId: ORG_A,
      nasId: ROW_A,
      secretVersion: 1,
    });
    expect(() =>
      openNasSecret(KEY, old, {
        organizationId: ORG_A,
        nasId: ROW_A,
        secretVersion: 2,
      }),
    ).toThrow();
  });

  it('rejects a ref with a trailing segment, in both envelope versions', () => {
    // The format must be canonical, or two distinct strings open to one plaintext: the trailing
    // bytes are outside the GCM authentication, so the tag cannot notice them. Harmless on its
    // own — an attacker who can append to secret_ref already has write access — but it would make
    // the re-seal's "is this row v2 yet?" and any dedupe silently wrong. Raised in review.
    const v2 = sealBoundSecretRef(nasEnvelope(), SECRET, nasAt(ROW_A));
    expect(() => openBoundSecretRef(nasEnvelope(), `${v2}.junk`, nasAt(ROW_A))).toThrow(
      /unsupported envelope format/,
    );
    const v1 = sealSecretRef(new Envelope(KEY, 'ecloud:nas:secret:v1'), SECRET);
    expect(() =>
      openNasSecret(KEY, `${v1}.junk`, {
        organizationId: ORG_A,
        nasId: ROW_A,
        secretVersion: 1,
      }),
    ).toThrow(/unsupported envelope format/);
    // The canonical forms still open, so this is a tightening and not a format change.
    expect(openBoundSecretRef(nasEnvelope(), v2, nasAt(ROW_A))).toBe(SECRET);
    expect(
      openNasSecret(KEY, v1, { organizationId: ORG_A, nasId: ROW_A, secretVersion: 1 }),
    ).toBe(SECRET);
  });

  it('keeps the NAS and UAM purpose labels distinct (§7.6)', () => {
    // Reads like a tautology and is the single test that would have caught S-1: the entire
    // defect was two differently-named constants holding the same string.
    expect(NAS_SECRET_PURPOSE).not.toBe(UAM_SECRET_PURPOSE);
    expect(NAS_SECRET_COLUMN).not.toBe(UAM_SECRET_COLUMN);
  });

  it('opens a v1 ref sealed by the OLD code, under the literal old label (§7.7)', () => {
    // THE TEST THAT WAS MISSING, and the reason it was missing is the lesson. The previous
    // version of this test sealed its "v1" fixture with the envelope under test — carrying the
    // NEW purpose label — so it proved only that this code can read its own output. It passed
    // while production could not open a single real row: the Orchestrator's renderer reported
    // `DATA_ENCRYPTION_KEY opens none of the 1 sealed NAS secrets (wrong key?)` against vps-local
    // at 11:40Z with an unchanged key.
    //
    // The label is written out as a LITERAL here, not taken from LEGACY_SECRET_PURPOSE. A fixture
    // that reads the constant follows the constant, which is exactly how the first version of
    // this test managed to agree with the bug.
    const sealedByOldCode = sealSecretRef(new Envelope(KEY, 'ecloud:nas:secret:v1'), SECRET);
    expect(sealedByOldCode).toMatch(/^enc:v1\./);
    expect(
      openNasSecret(KEY, sealedByOldCode, {
        organizationId: ORG_A,
        nasId: ROW_A,
        secretVersion: 1,
      }),
    ).toBe(SECRET);

    // The same ciphertext through the v2 envelope is the failure that reached production: right
    // key material, wrong derived key, because the purpose is the HKDF info parameter.
    expect(() => nasEnvelope().decrypt(sealedByOldCode.slice('enc:'.length))).toThrow();

    // A v1 ref carries no AAD, so it opens under ANY binding while the transition stands. That is
    // the cost of the window, stated here rather than discovered during the re-seal.
    expect(
      openNasSecret(KEY, sealedByOldCode, {
        organizationId: ORG_B,
        nasId: ROW_B,
        secretVersion: 9,
      }),
    ).toBe(SECRET);
  });

  it('also opens a v1 ref sealed under the NEW label, the 11:05-11:40Z window (§7.7b)', () => {
    // Part one moved the label but had not yet converted the NAS seal sites, so a NAS created or
    // rotated while it was live holds a v1-FORMAT ref sealed under the ':v2' LABEL. Neither the
    // old image nor a legacy-only fix can open it, so the v1 path tries both labels.
    const sealedInTheWindow = sealSecretRef(nasEnvelope(), SECRET);
    expect(sealedInTheWindow).toMatch(/^enc:v1\./);
    expect(
      openNasSecret(KEY, sealedInTheWindow, {
        organizationId: ORG_A,
        nasId: ROW_A,
        secretVersion: 1,
      }),
    ).toBe(SECRET);
  });

  it('opens a UAM v1 ref sealed under the old label too (§7.7d)', () => {
    // The Orchestrator asked whether the UAM reader had the same fault as the NAS one. It did,
    // and worse in one respect: UAM_SECRET_PURPOSE moved from 'ecloud:nas:secret:v1' to
    // 'ecloud:uam:secret:v2', so BOTH segments changed and every existing uam_secret_ref became
    // unopenable the moment part one deployed. The portal login that worked at 09:47Z on the old
    // image would have failed from 11:05Z.
    //
    // The old label is the NAS one, written out literally, because that collision IS finding S-1:
    // the two secrets were sealed under one string.
    const deps = {
      config: { dataEncryptionKey: KEY },
      logger: { warn: () => {} },
    } as unknown as AppDeps;
    const sealedByOldCode = sealSecretRef(new Envelope(KEY, 'ecloud:nas:secret:v1'), SECRET);
    const binding = { organizationId: ORG_A, portalId: ROW_A, secretVersion: 1 };
    expect(openUamSecret(deps, sealedByOldCode, binding)).toBe(SECRET);

    // A v2 ref sealed under the current label still opens, so the transition is additive.
    const current = sealBoundSecretRef(uamEnvelope(), SECRET, {
      organizationId: ORG_A,
      rowId: ROW_A,
      column: UAM_SECRET_COLUMN,
      secretVersion: 1,
    });
    expect(openUamSecret(deps, current, binding)).toBe(SECRET);

    // And the reader still returns null rather than throwing for an unopenable value, which the
    // portal path depends on — but it now LOGS the difference, because "no UAM secret" and
    // "secret present and unopenable" sent the 11:05Z investigation in the wrong direction.
    const warnings: unknown[] = [];
    const loud = {
      config: { dataEncryptionKey: KEY },
      logger: { warn: (o: unknown) => warnings.push(o) },
    } as unknown as AppDeps;
    expect(openUamSecret(loud, 'enc:v1.not-a-real-ciphertext', binding)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ event: 'uam_secret_unopenable', envelopeVersion: 'v1' });
    // No secret material in the log line, which is the constraint that makes it safe to emit.
    expect(JSON.stringify(warnings[0])).not.toContain(SECRET);
    expect(JSON.stringify(warnings[0])).not.toContain('not-a-real-ciphertext');

    // An ABSENT secret is not an error and must stay silent, or the log fills with normal state.
    expect(openUamSecret(loud, null, binding)).toBeNull();
    expect(openUamSecret(loud, '', binding)).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('refuses a v1 ref through openBoundSecretRef rather than using the wrong key (§7.7c)', () => {
    // `allowV1` took a boolean when the real question was WHICH KEY to derive, and no boolean can
    // answer that. The flag is gone; a v1 ref must go through the column helper, which holds the
    // key and can derive either label.
    const v1 = sealSecretRef(new Envelope(KEY, 'ecloud:nas:secret:v1'), SECRET);
    expect(() => openBoundSecretRef(nasEnvelope(), v1, nasAt(ROW_A))).toThrow(
      /must be opened through the column helper/,
    );
  });
});
