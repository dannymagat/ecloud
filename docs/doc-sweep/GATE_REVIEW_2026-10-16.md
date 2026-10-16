# Gate review — pilot NAS CoA/MA enablement + secret floor 12 (2026-10-16)

Gate codes (AGENTS.md:9,12,27,30): A2 "Network & Enforcement Agent... Verifies RADIUS, CoA/Disconnect... Must never invent vendor capabilities." A3 "AAA / RADIUS Agent... Requires verified NAS capabilities before using VSAs or CoA." A8 "Security Agent... reviews TLS, secrets, authentication, authorization... RADIUS secrets... hardening." A9 "QA / Integration Agent... Independently verifies that policy intent becomes actual network behavior." Cross-review rule (AGENTS.md:38): "AAA changes: A3 + A2 + A9 review."

## Change 1 — pilot NAS row (require_message_authenticator / coa_supported / coa_port) + worker ECLOUD_COA_ENABLED

Approved by D-066 (DECISIONS.md:85): require_message_authenticator=true on this exact NAS, coa_supported/coa_port set, ECLOUD_COA_ENABLED=true, "AP1832 runs the b07ce354 radcli fix." D-061 (DECISIONS.md:80) covers the secret-fetch path the dispatcher uses.

### A3 (AAA/RADIUS)
- `require_message_authenticator=yes` is rendered verbatim per-client (apps/api/src/radius-clients/render.ts:93); FreeRADIUS global default already matches (infra/freeradius/raddb/clients.conf:24-25). note.
- Risk if the AP does not send Message-Authenticator: FreeRADIUS silently drops the Access-Request (no reply) — confirmed by owner memory "radcli-no-message-authenticator" and by SECURITY_ARCHITECTURE.md:18 (T4). D-066 asserts AP1832 already carries the b07ce354 fix, but that claim is not re-verified by this change set — should-fix: confirm the fielded firmware version on the specific pilot AP before/after flipping the flag, not just the release name.
- `coa_port=3799` plus `coa_supported=true`: the dispatcher does not re-check `coa_supported` itself (apps/worker/src/coa/dispatcher.ts:200-230 has no such gate) — the gate lives upstream in `operationAvailability` (apps/api/src/accounting-views.ts:356, apps/worker/src/jobs/quota.ts:114), which refuses only on `=== false`. Pre-existing: `coa_supported = NULL` is NOT refused by that gate either, so other NAS rows left NULL already pass once ECLOUD_COA_ENABLED is global-true. Setting this row's value to explicit `true` closes the ambiguity correctly for THIS NAS, but is a note that the NULL-passes-through behavior is a latent fleet-wide gap, not introduced here.
- Dispatch target resolution for this row: `nas_ip` + `coa_port ?? adapterDefaultPort ?? defaultCoaPort` (apps/worker/src/coa/dispatcher.ts:155-156) — with coa_port=3799 explicit, this is deterministic, no change needed.
- Verdict: PASS (conditional on confirming the AP's radcli build before go-live — should-fix, not blocker).

### A2 (Network/Enforcement)
- No DAS listener on the AP would show as a **timeout**, not a crash or hang: `sendDynamicAuthorization` runs with `timeoutS`/`retries`, and on exhausted retries the action is marked `timeout` (final) without closing the session (apps/worker/src/coa/dispatcher.ts: outcome.result 'timeout' branch, isFinal). note — safe failure mode.
- The D-065 device test (a real Disconnect against AP1832) is still outstanding per DECISIONS.md:84 ("NOT run today... Reopen when the owner is next at the AP"); this change turns the dispatcher live (ECLOUD_COA_ENABLED=true) before that device test has ever passed on real hardware. should-fix: flag explicitly that enabling the worker precedes the one and only hardware proof point — matches A2's "must never invent vendor capabilities" charter; the capability is approved by the owner (D-066) but not yet device-verified.
- Verdict: PASS with the above called out as a known, owner-accepted gap (not a blocker — D-066 explicitly approves running ahead of the device test).

### A9 (QA/Integration)
- `reload-radius.sh` restarts FreeRADIUS for the WHOLE clients.conf (infra/vps-local/scripts/reload-radius.sh:12-20, "FreeRADIUS reads clients only at start-up") — this one-row change causes a brief outage for every NAS, not just the pilot row. note — expected per the script's own documentation, just worth stating in the runbook step.
- Rollback is a straight data revert: require_message_authenticator=false, coa_supported=NULL, coa_port=NULL, then re-run reload-radius.sh, then ECLOUD_COA_ENABLED=false (or drop the compose override) and redeploy the worker. No migration, no secret rotation involved. note.
- Audit trail: the generic PATCH handler in `crudRoutes` writes one `audit_logs` row per mutation inside the same transaction, with full before/after row snapshots (apps/api/src/routes/crud.ts:369-375). `writeAudit`/`auditSnapshot` strips `secret_ref` and other secret-bearing keys (apps/api/src/audit.ts:11-24,30-40) — require_message_authenticator/coa_supported/coa_port are NOT secret keys, so both old and new values land in `audit_logs.before/after` in clear. PASS.
- Verdict: PASS.

## Change 2 — commit bb7cc82: secret floor 16→12, D-051 carve-out removed (D-071)

Owner ruled the floor itself (D-071, DECISIONS.md:90); reviewed implementation only, per instruction.

### A8 (Security)
- `SECRET_RE` floor is 12 in the one place that matters, `apps/api/src/radius-clients/render.ts:65`, and `apps/api/src/internal/radius-client-lookup.ts:95` now tests `SECRET_RE` directly (dropped `isAcceptableSecret`) — renderer and dynamic lookup agree exactly. PASS.
- Alphabet unchanged: `/^[A-Za-z0-9._~+/=-]{12,128}$/` — only the `{16,128}` → `{12,128}` quantifier changed, no new characters, no injection surface change (apps/api/src/radius-clients/render.ts:65, diff confirms). PASS.
- Meraki path still refuses the public fleet default explicitly: `!SECRET_RE.test(e.secret) || e.secret === FLEET_DEFAULT_RADIUS_SECRET` (apps/api/src/radius-clients/meraki.ts:147, carried from the pre-change exact-match check, now standalone rather than inside `isAcceptableSecret`). PASS.
- Stale "16" reference NOT touched by this commit: `docs/SECURITY_REVIEW_P10.md:118` still states the allow-list as `{16,128}` — should-fix, update to 12.
- `docs/doc-sweep/lane-2-aaa-network.md:227,256` also still say 16-char floor / D-050/D-051 framing — these are dated doc-sweep finding snapshots (historical analysis, not live spec), so lower priority, but should-fix if that file is ever read as current truth.
- No OpenAPI/admin-UI copy references a specific secret length (`apps/web/src`, `apps/api/src/openapi*` grep empty) — nothing stale there. note.
- Secret logging: `render.ts` comment and `RENDERED_HEADER` both state secrets are "never logged/printed" by design; no `console.log`/logger call touches `entry.secret` in the changed files (render.ts, meraki.ts, radius-client-lookup.ts) — only `SkippedNas{id, reason}` is ever surfaced, never the secret value. PASS.
- `radius-clients-cli.ts:75` downgrades the fleet-default message from WARNING to NOTICE per D-071(2) — consistent with the owner's reinstated acceptance of the public default; not a regression. note.
- Verdict: PASS.

## Skipped / not checked
- Did not run or execute any tests (`radius-clients.test.ts`, `meraki.test.ts`) — relied on the commit message's own claim ("eleven characters refused, twelve accepted") and code reading only.
- Did not check UAM-secret-specific code paths beyond grep (D-071 point 5 says the floor applies there too; no dedicated UAM length validator exists yet per the commit message, "the bootstrap seals what it is given").
- Did not verify the live/actual fielded firmware build on the physical AP1832 pilot device (no host access permitted for this review).
- Did not check `infra/vps-local/compose/compose.vps-local.yaml` diff content itself beyond the commit message summary (D-066/LCL-APP-7); not re-read in full.
- Did not check `docs/doc-sweep/APPLY_PLAN.md` or other doc-sweep lane files beyond the one stale-16 grep hit already reported.
- No live host, DB, or FreeRADIUS instance was touched; this is a static code/doc review only.
