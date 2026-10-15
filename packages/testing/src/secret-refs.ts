/**
 * Well-formed sealed-secret placeholders for fixtures that never open the secret.
 *
 * WHY THIS FILE EXISTS. Fixtures across 22 files wrote `secret_ref` values shaped
 * `env:ECLOUD_…`, `secret://test/…` and `enc:placeholder`. No production code parses any of
 * those schemes — there is no reader for them at all — so those rows held references that nothing
 * could ever resolve. It never surfaced because no test opened them, which is its own small
 * finding: the column accepted anything, so nothing had to be true about it.
 *
 * That blocked the tightening migration of the v1→v2 re-seal, which narrows `secret_ref` to the
 * `enc:v2.` format now that production holds no v1 rows. These constants are the sweep: the same
 * "this fixture does not care about the secret" intent, in a shape the constraint accepts.
 *
 * THEY CANNOT BE OPENED, DELIBERATELY. Each is a real AES-256-GCM envelope sealed with a throwaway
 * key under a throwaway purpose, so the segment count and lengths are correct by construction
 * rather than by someone counting base64 characters — but no key in any environment derives to
 * the one that sealed it. A fixture that needs an OPENABLE secret must seal its own with the
 * suite's `DATA_ENCRYPTION_KEY` and the row's own binding; see
 * `apps/api/src/reseal/secrets.integration.test.ts` for that shape. Using one of these where the
 * code under test opens the secret will fail, and should.
 */

/**
 * `nas_clients.secret_ref` for a NAS whose secret is never read.
 *
 * The renderer reports such a row as skipped ("cannot be opened with DATA_ENCRYPTION_KEY"), which
 * is the correct and visible outcome — the same one the old `enc:placeholder` produced, except the
 * format constraint now accepts it.
 */
export const PLACEHOLDER_NAS_SECRET_REF =
  'enc:v2.NIgxFWZapMIr0AcS.iLEDldSdy8JI5Zw.jVPVL_7QOYsay77jD_JHuw';

/**
 * `captive_portals.uam_secret_ref` for a portal whose UAM secret is never read. A distinct value
 * from the NAS one, so a fixture that accidentally crosses the two columns produces a mismatch
 * rather than a coincidence that passes.
 */
export const PLACEHOLDER_UAM_SECRET_REF =
  'enc:v2.mZqSmOwicopvHM_d.SvDgySxCgUj-z0_G34ny.4CKrjhdIgnZPK1l9UqfNdw';
