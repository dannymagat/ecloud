# Documentation sweep — read everything tonight, produce the apply plan

Owner instruction (2026-10-15 21:40 +04, via Hermes acting for the owner): **every markdown file
in this repository (plus the EZEControl UAM hand-off docs) is read end-to-end tonight, by
multiple agents in parallel, and the result is a plan to apply.** Nothing is applied tonight.

## What "read and plan to apply" means

For every file in `INVENTORY.md`:

1. **Read the whole file** (not grep, not the first screen). Files over 60 KB are read in
   chunks; say so in the report.
2. **Extract every claim that should be true of the system**: a requirement, a decision, an
   architecture statement, a procedure, a config value, a test that "exists", a security
   control, an open question with an answer elsewhere.
3. **Check each claim against reality** — the repository at `feature/universal-aaa` HEAD and,
   read-only, the pilot on vps-local (`ssh vps-local`, `ecloud-compose ps/logs`, SQL
   `SELECT` only). Evidence as `path:line`, a command and its output, or a DECISIONS id.
4. **Classify each claim** with exactly one verdict:

   | Verdict | Meaning |
   |---|---|
   | `IMPLEMENTED` | true in code/deployment, evidence cited |
   | `PARTIAL` | some of it exists; say what is missing |
   | `MISSING` | documented, not built — **apply candidate** |
   | `STALE-DOC` | the code/deployment is right, the document is wrong — **doc fix candidate** |
   | `SUPERSEDED` | overridden by a later DECISIONS row (cite the D-number) |
   | `OUT-OF-SCOPE` | EZEControl / controller / firmware work (D-058) — list, do not plan |
   | `NEEDS-OWNER` | cannot be decided by an agent; phrase the question in one line |

5. **Write the lane report** `docs/doc-sweep/lane-<N>-<name>.md`: a per-file checklist
   (`- [x] path — n claims, verdict counts`) followed by one findings table per file
   (`claim | verdict | evidence | apply item?`). Every file in the lane gets a line even
   when it has nothing to apply.

The Orchestrator then merges the four lane reports into **`docs/doc-sweep/APPLY_PLAN.md`**:
a single prioritised backlog, one row per apply item — `id | item | source doc §` |
`lane/owner | size (S/M/L) | risk | depends on | needs owner? | proposed order`. Doc fixes
(`STALE-DOC`) go in a second table. `NEEDS-OWNER` questions go in a third, for the owner to
answer in the morning before anything is applied.

## Lanes

Assignments follow the existing lanes; file lists are in `INVENTORY.md`.

| Lane | Scope | Worker | Files / size |
|---|---|---|---|
| 1 | Governance, status, ops, deployment, dev/test docs, VPS change lists | Orchestrator sub-agent | 27 files, 375 KB |
| 2 | AAA, RADIUS, network, WireGuard, vendors, NAS pending/adoption, secrets, FreeRADIUS, EZEControl UAM hand-off | EZECLOUD | 35 files, 735 KB |
| 3 | Captive portal, policy engine / bandwidth, admin UI, multitenancy, database design, storage, e2e | EZECLOUD1 | 18 files, 386 KB |
| 4 | API architecture, security architecture, security review P10, phase-2 validation | Orchestrator sub-agent | 4 files, 343 KB |

Lane 2 is the largest; `MULTI_VENDOR_INTEGRATION_PLAN.md` (159 KB) alone may be split to a
second EZECLOUD sub-agent. Hermes can take Lane 1 or Lane 4 if the Orchestrator asks
("Hermes takes lane N").

## Rules for tonight

- **Read-only on production.** No deploy, no migration, no restart, no AP or controller
  change, no DNS/Cloudflare change, no secret rotation. `SELECT` only on the database.
- **No code changes tonight.** The output is the plan; the owner approves it in the morning.
  The only files written are under `docs/doc-sweep/`.
- **`DECISIONS.md` is authoritative** over every older document. When a doc and a decision
  disagree, the verdict is `SUPERSEDED`, not `MISSING`.
- **EZEControl is paused (D-058).** Its hand-off docs are read as inputs; anything requiring
  a controller/firmware/EZEControl-UI change is `OUT-OF-SCOPE`. Items that need an
  EZECLOUD-side change are in scope.
- **Never print a secret.** No password, token, API key, shared secret or connection string
  in any report — reference the file or env name only.
- **Excluded from the sweep:** `.remember/` (session notes), `node_modules`, `.worktrees`,
  `dist`. `.claude-to-hermes.md` and `.hermes-coordination.md` are included (Lane 1).
- **Coverage is checked mechanically**: Hermes diffs the checklists against `INVENTORY.md`.
  A file without a line in a lane report is not done.

## Timeline (local, +04)

- 22:00 — lanes dispatched, each worker confirms its file list
- 01:00 — lane reports complete (`lane-1..4-*.md`)
- 02:00 — Orchestrator merges `APPLY_PLAN.md`, posts a one-screen summary in its pane
- Morning — owner answers `NEEDS-OWNER`, approves the order; apply work starts under the
  normal gates (A2+A9 for enforcement, A3+A2+A9 for AAA, A6 for migrations, A8 for security)
