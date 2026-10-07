# @ecloud/policy-engine

Pure TypeScript implementation of `POLICY_ENGINE.md` (Phase 3, M4). No database, no HTTP: the
engine takes plain inputs and returns plain outputs so `apps/api` and `apps/worker` can call it and
tests can pin `now`.

| Module            | Spec   | What it does                                                                                                                                                                                                     |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent.ts`       | §1     | `PolicyIntentSchema` (zod) / `PolicyIntent` — the `policies` columns plus the joined schedule; `validatePolicy()` implements the 11 rules of §1.3 with `{path, rule, code}` issues and warnings.                  |
| `schedule.ts`     | §1, §2 | Weekly windows in an IANA zone on `Intl.DateTimeFormat` only: `isInWindow`, `nextBoundary`, `nextLocalMidnight`, `nextLocalMonthStart` (DST and overnight windows covered by tests).                           |
| `resolve.ts`      | §2     | `resolveEffectivePolicy(input)`: candidate filter + ordering (`assignment.priority, policy.priority, layer, effective_from desc, id`), single-winner field fall-through, schedule/quota/concurrency/validity, trace, snapshot hash. |
| `translate.ts`    | §4     | `translate(effective, adapter, ctx)` → `EnforcementPlan`: unit conversions, Session-Timeout derivation, degradation modes, attribute gating by adapter declaration (D-028).                                        |
| `simulate.ts`     | §6.4   | `simulate()` = resolve once + translate per adapter; returns the per-field enforceability table for the admin preview.                                                                                           |
| `capabilities.ts` | §3     | `AdapterCapabilities` data contract (concrete records live in `@ecloud/adapters`).                                                                                                                                |
| `snapshot.ts`     | §2.9   | Canonical JSON (bigint → string) and SHA-256 `policy_version` hash.                                                                                                                                              |

## Units and types

Rates kbit/s, sizes bytes (SI), durations seconds, instants `Date`. Quota columns are PostgreSQL
`bigint`, so the engine carries them as native `bigint`; the schema accepts `bigint | safe integer |
decimal string` and `canonicalJson()` writes decimal strings.

## Attribute gating

`translate()` never emits a RADIUS attribute unless the adapter's `attributes[name].status` is
`VERIFIED_SUPPORTED`. With `context.includeDeviceTestAttributes = true` (lab use) attributes marked
`REQUIRES_DEVICE_TEST` are emitted too and carry `experimental: true`; they are still listed under
`unenforceable[]` so no UI can show them as device-enforced.

## Degradation modes (§4.2)

`fallback_ecloud_side` (default), `allow_and_flag`, `strict_reject`. A policy's `critical_fields`
force a reject for those fields regardless of mode. `overflow_clamped` never causes a reject.

## Tests

`npm test -- --project policy-engine`. Fixtures: `resolve.fixture.ts` (the §1.2 / §4.3 example),
`adapters.fixture.ts` (synthetic adapters — not device claims).
