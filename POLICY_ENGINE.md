# ECLOUD Policy Engine (Phase 2, A5b — design only, nothing deployed)

> **Owner amendments 2026-10-07 (D-022, D-028).** (1) Canonical specificity order is `temporary > client_device > user > voucher_batch > user_group > site > organization default`; field-level fall-through semantics in this document are retained. (2) All policy types in §1 are modelled from the start; enforcement is staged in this order: up/down rate, session timeout, idle timeout, validity/expiry, vouchers; then quotas, concurrency, schedules, VLAN, burst/advanced. (3) Every adapter reports each policy field with exactly one of `VERIFIED_SUPPORTED`, `REQUIRES_DEVICE_TEST`, `UNSUPPORTED`, `ECLOUD_SIDE_ONLY` (this supersedes the label vocabulary used in the capability table below; mapping: VERIFIED → VERIFIED_SUPPORTED, REQUIRES DEVICE TEST / UNKNOWN → REQUIRES_DEVICE_TEST, UNSUPPORTED → UNSUPPORTED, ECLOUD-side → ECLOUD_SIDE_ONLY). A field is never shown as device-enforced unless its status is VERIFIED_SUPPORTED. (4) Permission keys use `resource:action` (D-021).


Status: PROPOSED unless a row carries another label. Evidence labels follow BRIEF.md rule 3:
**VERIFIED FROM EXISTING CODE** / **VERIFIED FROM OFFICIAL DOCUMENTATION** / **PROPOSED** / **UNKNOWN** / **REQUIRES DEVICE TEST**.
Every device/NAS claim below is inherited from A2 (`NETWORK_INTEGRATION.md`) or A4 (`CAPTIVE_PORTAL_ARCHITECTURE.md`) and cites the section it comes from; this document adds no new vendor facts. RADIUS packet mechanics (dictionaries, FreeRADIUS modules, `rlm_rest`/SQL wiring) are owned by A3 — see `AAA_ARCHITECTURE.md`. Tables are the A6 ones in `DATABASE_DESIGN.md §3.4–3.5` (`schedules`, `policies`, `policy_assignments`, `policy_translations`, `sessions`, `usage_counters`, `session_actions`, `auth_events`, `nas_clients`, `adapter_types`).

Design principle (BRIEF rule 4, A2 §7.1): **the core stores policy intent; adapters translate intent into verified device mechanisms; anything an adapter cannot express is surfaced, never silently dropped.**

---

## 0. Headline decisions (for the owner, all PROPOSED)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Merge semantics | **Single winner, field-level fall-through** (not "most restrictive") | Explainable ("this phone got 2 Mbit/s because policy X v3 won"); allows temporary *boost* policies; aligns with A6 §3.4 "take the first". Site-wide hard ceilings belong on the SSID `rate-limit` (device-side, always applies) not in the merge. |
| D2 | Specificity order | `temporary > client_device > user > voucher_batch > user_group > site > org default` | Matches A6 §3.4 (`client_device > user > voucher_batch > group > site`). The brief suggested `user > client-device`; see Open Question Q1. |
| D3 | Quota on NAS without octet attributes | Session-Timeout sized to **worst-case drain time**, floor 300 s, plus ECLOUD accounting watcher | Bounds overshoot without claiming any unverified device feature. |
| D4 | Concurrency breach | Default **reject new** (`max_concurrent_*`); `disconnect_oldest` selectable per policy only once Disconnect is VERIFIED on that adapter | Disconnect end-to-end is REQUIRES DEVICE TEST on every adapter (A2 §5, A4 §3.5). |
| D5 | Unenforceable field | Default **fallback-to-ECLOUD-side if a watcher exists, else allow-and-flag**; tenant may set `strict` → reject | Keeps Wi-Fi working on day one while the enforceability preview (A7) shows the gaps. |
| D6 | Quota reset clock | Daily at 00:00 **site timezone** (A6 §5), monthly on calendar day 1 site TZ; per-tenant `billing_anchor_day` later | Site TZ is already the schedule TZ; one clock per site. |
| D7 | DB unavailable on authorize | **Fail-closed** for unknown subjects; **cached-allow** (Redis snapshot ≤15 min old) for subjects authorized recently | A NAS retransmits anyway; a stale-but-known answer beats a timeout. |

---

## 1. Policy intent model (PROPOSED, aligned with A6 `policies`)

### 1.1 Canonical fields and units

All sizes are **bytes (decimal, SI)**: `1 GB = 1 000 000 000 bytes`. All rates are **kbit/s** (`1 Mbit/s = 1000 kbit/s`). All durations are **seconds**. All instants are `timestamptz`; schedules are wall-clock in the **site timezone** (`schedules.timezone`, A6).

| Field (A6 column) | Type / unit | Meaning | Enforceable today? |
|---|---|---|---|
| `download_rate_kbps` | int ≥ 1, NULL = inherit | Per-client ceiling, AP→client ("down" = NAS egress to the station) | Captive adapters: VERIFIED (A4 §3.4, `WISPr-Bandwidth-Max-Down` bit/s or `ChilliSpot-Bandwidth-Max-Down` kbit/s). hostapd (802.1X/MAC-auth): UNKNOWN → REQUIRES DEVICE TEST (A2 §2). SSID-level: VERIFIED but whole-SSID only (A2 §1, Mbit/s integers). |
| `upload_rate_kbps` | int ≥ 1, NULL = inherit | Per-client ceiling, client→AP | same |
| `burst_download_kbps`, `burst_upload_kbps` | int, NULL | **Burst rate**: peak rate allowed while a burst allowance lasts | **UNSUPPORTED on all current adapters.** A2 §2: no schema key; `ratelimit` uses fixed `burst 2k` (VERIFIED DOCS, absence). A4 §7.5: not expressible via RADIUS for uspot/CoovaChilli. Stored for future adapters; translation always lists it under `unenforceable[]`. |
| `burst_duration_s` | int, NULL | How long the burst rate may be sustained (the engine derives burst *size* = `burst_rate × duration / 8` bytes when a future adapter wants a bucket size) | UNSUPPORTED (same) |
| `quota_daily_bytes` | bigint, NULL | Max bytes (in+out) per site-local day | ECLOUD-side counter (A6 `usage_counters`) + per-session octet attribute sized to remaining, where the adapter supports it (A4 §7.5) |
| `quota_monthly_bytes` | bigint, NULL | Max bytes per site-local calendar month | same |
| `quota_total_bytes` | bigint, NULL | Lifetime / voucher total | same |
| `session_timeout_s` | int ≥ 60, NULL | Max duration of one session | Captive adapters VERIFIED (`Session-Timeout`, A4 §3.4); hostapd REQUIRES DEVICE TEST (A2 §2) |
| `idle_timeout_s` | int ≥ 60, NULL | Disconnect after inactivity | Captive adapters VERIFIED (`Idle-Timeout`); hostapd: per-SSID `max-inactivity` only (A2 §2) |
| `max_concurrent_sessions` | int ≥ 1, NULL | Active sessions per subject (user or voucher) | ECLOUD-side only (A2 §2 "not a device feature") |
| `max_devices` (brief: `max_concurrent_devices`) | int ≥ 1, NULL | Distinct MACs with an active session per subject | ECLOUD-side only |
| `valid_from`, `valid_until` | timestamptz, NULL | Absolute validity window of the *policy* | ECLOUD-side (reject outside; `Session-Timeout` clipped to `valid_until`) |
| voucher validity | `voucher_batches.valid_from/valid_until` (absolute) **and/or** `duration_s` (counted from first use → `vouchers.expires_at`) | A6 §3.4; both may be set, the earlier end wins | ECLOUD-side (clip `Session-Timeout`) |
| `schedule_id` | FK `schedules` | Weekly windows `{days:[1..7], start:"HH:MM", end:"HH:MM"}` in `schedules.timezone`; `end < start` = crosses midnight | ECLOUD-side (deny out-of-window; `Session-Timeout` clipped to window end) |
| `vlan_id` | int 1–4094, NULL | Dynamic VLAN for the client | hostapd: renderer VERIFIED, attribute honouring REQUIRES DEVICE TEST (A2 §2, §7.2). uspot: UNSUPPORTED (A4 §3.4 "VLAN attrs: no"). CoovaChilli `CoovaChilli-VLAN-Id`: REQUIRES DEVICE TEST (A4 §7.5). |
| `scope_type` | `user` / `group` / `site` / `temporary` | Where the policy is intended to be attached (A6 CHECK). The *actual* attachment is `policy_assignments.target_type` (`user`, `user_group`, `site`, `client_device`, `voucher_batch`). | — |
| `priority` | int, default 100, **lower wins** | Explicit tie-breaker across assignments (A6: `policy_assignments.priority ASC, policies.priority ASC`) | — |
| `status` | `draft` / `active` / `retired` | Only `active` participates in resolution | — |
| `is_default` | bool, one per org | Org default (lowest layer) | — |
| temporary policy / expiry | `policy_assignments.effective_from/effective_until` | "Temporary" = an assignment with `effective_until` set (A6 §3.4); engine treats `scope_type='temporary'` **or** a bounded assignment on a user/device as the top layer | ECLOUD-side |
| `version` | int | Bumped on every edit of an `active` policy (see §6) | — |

`enabled` in the brief = `status = 'active'` AND assignment window contains `now()`.

### 1.2 JSON example (API representation of one `policies` row + its schedule)

```json
{
  "id": "0f3b9b4e-7b2d-4a6b-9d1e-2b7f8a1c5e10",
  "organization_id": "4a1e…",
  "site_id": null,
  "name": "Staff 20/5 daily 1GB",
  "scope_type": "group",
  "status": "active",
  "version": 3,
  "priority": 100,
  "is_default": false,
  "download_rate_kbps": 20000,
  "upload_rate_kbps": 5000,
  "burst_download_kbps": null,
  "burst_upload_kbps": null,
  "burst_duration_s": null,
  "quota_daily_bytes": 1000000000,
  "quota_monthly_bytes": null,
  "quota_total_bytes": null,
  "session_timeout_s": null,
  "idle_timeout_s": 600,
  "max_concurrent_sessions": null,
  "max_devices": 2,
  "valid_from": null,
  "valid_until": null,
  "vlan_id": null,
  "schedule": {
    "id": "c2d1…",
    "name": "Office hours",
    "timezone": "Asia/Dubai",
    "rules": [ { "days": [1,2,3,4,5], "start": "09:00", "end": "18:00" } ]
  }
}
```

`Asia/Dubai` is an illustrative IANA zone, not a verified site value.

### 1.3 Validation rules (enforced in the API layer; DB CHECKs where A6 already has them)

1. Rates: `download_rate_kbps`, `upload_rate_kbps` ≥ 1 when set (A6 `ck_policies_rates_positive`); upper bound 4 294 967 kbit/s so `WISPr-Bandwidth-Max-*` (32-bit bit/s) cannot overflow.
2. Burst: `burst_*_kbps` must be ≥ the corresponding base rate; `burst_duration_s` required when either burst rate is set. Saving a burst value is allowed but the API response carries `warnings: ["burst is UNSUPPORTED on all current adapters"]`.
3. Quotas: positive bigint; `quota_daily_bytes ≤ quota_monthly_bytes ≤ quota_total_bytes` when more than one is set.
4. Timeouts: `session_timeout_s ≥ 60`, `idle_timeout_s ≥ 60` (CoovaChilli ignores interim < 60 s per A4 §6; the same floor is applied to all timers for safety).
5. `max_concurrent_sessions ≥ max_devices` when both set (a device holds at least one session).
6. `valid_until > valid_from`; a policy with `valid_until < now()` cannot be set `active`.
7. Schedule rules: `days ⊆ {1..7}`, `HH:MM` 24 h, `start ≠ end`; `timezone` must be a valid IANA name.
8. `vlan_id` 1–4094 (A6 CHECK). Saving `vlan_id` on a policy whose assignments target a NAS whose adapter has `vlan = UNSUPPORTED` returns a warning (preview, §3).
9. `is_default` → `scope_type` must be `site` or `group`-less org default; exactly one per org (A6 unique index).
10. `scope_type = 'temporary'` requires every assignment to carry `effective_until`.
11. Editing an `active` policy creates a new `version`; `retired` policies are immutable.

---

## 2. Policy resolution algorithm

### 2.1 Inputs (`ResolutionContext`)

| Input | Source |
|---|---|
| `tenant` (`organization_id`), `site_id`, `nas_client` (+ `adapter_type_key`, `coa_port`, `coa_supported`) | Resolved by AAA from NAS-IP / NAS-Identifier (MULTITENANCY §3.3, A6 `nas_clients`) |
| `called_station_id` (SSID), `nas_port_type` | Access-Request (format per adapter: uspot T `nasmac:ssid`, U/Coova `nasmac` — A4 §3.4) |
| `subject` = `user` \| `voucher` (bound user) \| `client_device` (MAC-auth) | AAA identity step (`AAA_ARCHITECTURE.md`) |
| `group_ids[]` | `users` ↔ `user_groups` membership |
| `client_device_id`, `mac` | `Calling-Station-Id` → `client_devices` (per tenant, A6) |
| `now_site` | `now()` converted to `sites.timezone` |
| `usage` | `usage_counters` rows `(subject_type, subject_id, period_type, period_start)` for `daily`/`monthly`/`total` |
| `active_sessions[]` | `sessions WHERE status='active' AND (user_id=… OR client_device_id=…)` (A6 index `idx_sessions_active_user`) |
| `trigger` | `authorize` \| `coa` \| `preview` \| `config_push` (A6 `policy_translations.trigger`) |

### 2.2 Candidate collection and ordering (PROPOSED, consistent with A6 §3.4)

```
candidates = policy_assignments
  WHERE organization_id = ctx.tenant
    AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now())
    AND policy.status = 'active'
    AND (policy.valid_from IS NULL OR policy.valid_from <= now())
    AND (policy.valid_until IS NULL OR policy.valid_until > now())
    AND target matches ctx:
          target_type='client_device' AND client_device_id = ctx.client_device_id
       OR target_type='user'          AND user_id         = ctx.user_id
       OR target_type='voucher_batch' AND voucher_batch_id = ctx.voucher.batch_id
       OR target_type='user_group'    AND user_group_id   IN ctx.group_ids
       OR target_type='site'          AND site_id         = ctx.site_id
  PLUS the org default policy (policies.is_default) as a synthetic lowest layer.

layer(a) = 0 if a.effective_until IS NOT NULL AND a.target_type IN ('client_device','user')   -- temporary boost/penalty
         = 1 client_device | 2 user | 3 voucher_batch | 4 user_group | 5 site | 6 org_default

ORDER BY a.priority ASC, policy.priority ASC, layer ASC, a.effective_from DESC, a.id ASC
```

Determinism: the final `a.id ASC` makes ties total; two engines with the same DB snapshot produce the same list. "Most recent wins" (`effective_from DESC`) is only reached when priorities and layers tie.

### 2.3 Merge semantics (D1): single winner, field-level fall-through

```
effective = {}
for a in ordered_candidates:          # highest precedence first
    for f in POLICY_FIELDS:
        if effective[f] is UNSET and a.policy[f] is not NULL:
            effective[f] = a.policy[f]; provenance[f] = (a.policy_id, a.policy.version, a.id)
effective.schedule = first non-NULL schedule in the same walk
```

Why not "most restrictive"? (1) It cannot express a temporary *boost* (a 50 Mbit/s weekend boost would lose to the 20 Mbit/s group cap). (2) It cannot be explained with one `policy_id/version` on the session, which A6 `sessions.policy_id/policy_version` and `policy_translations.input_snapshot` assume. (3) Site-wide ceilings that must never be exceeded are a *device* concern: emit them as SSID `rate-limit` via `openwifi-config` (VERIFIED, A2 §1), where they cap every station regardless of RADIUS. Whether a per-client RADIUS rate above the SSID ceiling is clamped by the ceiling is **REQUIRES DEVICE TEST** (A2 §11 item 1).

`provenance` is stored as part of the `input_snapshot` so "why did this phone get X" is answerable per field.

### 2.4 Schedule evaluation

```
if effective.schedule:
    win = window_containing(effective.schedule.rules, now_site)   # handles end<start (overnight)
    if win is None:
        # out-of-window
        if tenant.out_of_window_policy_id: re-run merge with that policy forced on top (e.g. "after-hours 1 Mbit/s")
        else: decision = REJECT(reason='schedule')          # grace: accept if within tenant.schedule_grace_s (default 0) before start
    else:
        clip.session_timeout_s = min(clip.session_timeout_s, seconds_until(win.end, now_site) + tenant.schedule_grace_s)
```

Grace (`schedule_grace_s`, default 0, max 900) exists because `Session-Timeout` and the schedule-end disconnect job both fire at the boundary; a few minutes of overlap is operator-friendlier than a hard cut mid-page.

### 2.5 Quota evaluation

```
remaining = +inf
for (period, limit) in [('daily', quota_daily_bytes), ('monthly', quota_monthly_bytes), ('total', quota_total_bytes)]:
    if limit: used = usage[period].bytes_in + usage[period].bytes_out
              if used >= limit: decision = REJECT(reason='quota_'+period)
              remaining = min(remaining, limit - used)
remaining_minus_active = remaining - sum(estimated_unreported_bytes(s) for s in active_sessions)  # see §5.1
clip.octets = remaining_minus_active if finite
```

Translation (§4) turns `clip.octets` into `ChilliSpot-/CoovaChilli-Max-Total-Octets(+Gigawords)` where the adapter has `quota`, and/or into a `Session-Timeout` bound:

`drain_time_s = ceil(remaining_bytes × 8 / ((download_rate_kbps + upload_rate_kbps) × 1000))`, floored at `tenant.min_session_s` (default 300) — the shortest time in which the client *could* exhaust the quota at full rate. It is a safety bound, not an estimate; the accounting watcher (§5) remains the real enforcer. Where no rate is set, `drain_time_s` is not computed and the watcher alone enforces.

Reset: `period_start` for `daily` = site-local date; `monthly` = site-local first of month (D6). A session straddling midnight keeps its emitted octet limit (sized to yesterday's remaining); the watcher re-evaluates against the new period after the first interim of the new day and, where Disconnect is unavailable, simply lets `Session-Timeout` (clipped to ≤ seconds-to-midnight when a daily quota exists, PROPOSED) force a re-auth at the reset boundary.

### 2.6 Concurrency

```
sessions_user   = active_sessions where user_id == subject
devices_user    = distinct mac over sessions_user
if max_concurrent_sessions and len(sessions_user) >= max_concurrent_sessions: breach('sessions')
if max_devices and ctx.mac not in devices_user and len(devices_user) >= max_devices: breach('devices')

on breach:
    mode = effective.concurrency_mode or tenant.default_concurrency_mode     # 'reject' (default) | 'disconnect_oldest'
    if mode == 'disconnect_oldest' and adapter(oldest.nas).disconnect in VERIFIED_LEVELS:
        enqueue session_actions(action='disconnect', session_id=oldest.id); ACCEPT (the new session)
    else: REJECT(reason='concurrency')
```

Stale sessions (`status='stale'`, A6 §5) are not counted. Because the TIP-fork uspot kick path emits **no Acct-Stop** (A4 §3.5, VERIFIED in source, confirm on device), the engine must mark the old session `stopped` itself after a Disconnect-ACK, otherwise the count never drops.

### 2.7 Pseudocode (authorize path)

```
function resolve(ctx) -> Decision:
    cands     = collect_candidates(ctx)                       # §2.2 (one SQL, indexes per A6 §4)
    eff, prov = merge(cands)                                  # §2.3
    clip      = {session_timeout_s: eff.session_timeout_s, octets: +inf}
    if eff.valid_until:  clip.session_timeout_s = min(clip.session_timeout_s, until(eff.valid_until))
    if ctx.voucher:      clip.session_timeout_s = min(clip.session_timeout_s, until(ctx.voucher.expires_at), until(batch.valid_until))
    d = evaluate_schedule(eff, ctx, clip)      ; if d.reject: return d
    d = evaluate_quota(eff, ctx, clip)         ; if d.reject: return d
    d = evaluate_concurrency(eff, ctx)         ; if d.reject: return d
    return ACCEPT(effective=eff, provenance=prov, clip=clip)

function authorize(ctx):
    decision = resolve(ctx)
    if decision.reject: record auth_events(result='reject', reason); return Reject
    plan = translate(decision.effective, adapter(ctx.nas), {ctx, clip})       # §4
    if plan.unenforceable and degradation(ctx.tenant, plan) == 'reject': return Reject(reason='unenforceable:'+fields)
    session = sessions.insert(status='active', policy_id, policy_version, …)   # A3 may do this on Acct-Start instead; coordinate
    policy_translations.insert(trigger='authorize', input_snapshot={effective, provenance, clip, usage, active_sessions_count},
                               emitted=plan.radiusReplyAttributes + plan.configPushChanges, unsupported=plan.unenforceable)
    schedule ecloud_side_controls(plan, session)                                # §5
    return Accept(plan.radiusReplyAttributes)
```

### 2.8 Flowchart

```mermaid
flowchart TD
  A[Access-Request via AAA] --> B[Resolve tenant / site / NAS / adapter]
  B --> C[Identify subject: user / voucher / MAC device]
  C --> D[Collect active assignments<br/>client_device, user, voucher_batch, groups, site + org default]
  D --> E[Order: assignment.priority, policy.priority, layer, effective_from desc, id]
  E --> F[Merge: single winner, field fall-through -> effective + provenance]
  F --> G{Schedule window<br/>at site TZ?}
  G -- out, no after-hours policy --> R1[REJECT schedule]
  G -- out, after-hours policy --> F
  G -- in --> H[Clip Session-Timeout to window end, validity, voucher expiry]
  H --> I{Quota remaining > 0<br/>daily / monthly / total?}
  I -- no --> R2[REJECT quota]
  I -- yes --> J[remaining bytes -> octet limit / drain-time bound]
  J --> K{Concurrency within<br/>max_sessions / max_devices?}
  K -- breach, mode=reject --> R3[REJECT concurrency]
  K -- breach, disconnect_oldest and Disconnect VERIFIED --> L[enqueue Disconnect oldest]
  K -- ok --> M
  L --> M[translate effective, adapter, ctx -> EnforcementPlan]
  M --> N{unenforceable[] and tenant strict?}
  N -- yes --> R4[REJECT unenforceable]
  N -- no --> O[Store snapshot in policy_translations + sessions.policy_version]
  O --> P[Arm ECLOUD-side controls: timers, quota watcher]
  P --> Q[Access-Accept with radiusReplyAttributes]
```

### 2.9 Determinism, idempotency, snapshot

- **Deterministic:** pure function of `(DB snapshot, now)`; the only non-determinism is `now`, which is passed in explicitly (so A9 tests and the dry-run endpoint can pin it).
- **Idempotent:** NAS retransmissions of the same Access-Request (same `Acct-Session-Id`/`Calling-Station-Id` within `tenant.dedup_window_s`, default 10 s) return the cached decision from Redis instead of re-resolving — otherwise a retransmit could count the first attempt as an "active session" and trip concurrency.
- **Snapshot:** the resolved intent (`effective`, `provenance`, `clip`, counters used) is written to `policy_translations.input_snapshot` (A6) and `sessions.policy_id/policy_version`; later policy edits never rewrite a live session's snapshot — they produce a new translation row with `trigger='coa'` or take effect at the next authorize (§5.3).

---

## 3. Capability model (`AdapterCapabilities`)

Each NAS adapter declares a static capability record. A6 `adapter_types.capabilities jsonb` stores it; `verification_status` and `evidence_url` carry the label. Levels: `VERIFIED_CODE`, `VERIFIED_DOCS`, `REQUIRES_DEVICE_TEST`, `UNKNOWN`, `UNSUPPORTED`. The translation layer (§4) treats only `VERIFIED_*` as enforceable by the device; `REQUIRES_DEVICE_TEST` fields are emitted **and** flagged (`unenforceable[].reason = 'requires_device_test'`) so the A7 preview shows amber, not green. A device-test pass flips the level without code changes.

```ts
interface AdapterCapabilities {
  key: 'openwifi-hostapd-radius' | 'openwifi-uspot-uam' | 'uspot-upstream-uam' | 'coovachilli-uam' | 'openwifi-config';
  portal_type: 'none-8021x-macauth' | 'uam-chillispot' | 'uam-chillispot+capport' | 'uam-chillispot+wispr+json' | 'config-only';
  granularity: 'per-client' | 'per-ssid';
  rate_limit:       { level: Level; unit: 'bps' | 'kbps' | 'mbps-int'; attrs: string[]; direction_note?: string };
  burst:            { level: Level };
  quota:            { level: Level; kinds: ('total'|'in'|'out')[]; width: 32 | 64 /* 64 = Octets+Gigawords */ ; attrs: string[] };
  session_timeout:  { level: Level; attr?: string };
  idle_timeout:     { level: Level; attr?: string };
  interim_interval: { level: Level; attr?: string; nas_local_overrides: boolean };
  vlan:             { level: Level; attrs: string[] };
  disconnect:       { level: Level; target: 'hostapd-das' | 'uspot-das' | 'coaport' | 'none'; identify_by: string[]; acct_stop_emitted: boolean | 'unknown' };
  coa_change:       { level: Level; changeable: string[] };
  mac_auth:         { level: Level; username_rule?: string };
  accounting:       { level: Level; kinds: ('start'|'interim'|'stop'|'on'|'off')[] };
}
type Level = 'VERIFIED_CODE' | 'VERIFIED_DOCS' | 'REQUIRES_DEVICE_TEST' | 'UNKNOWN' | 'UNSUPPORTED';
```

### 3.1 Capability table (source of the A7 enforceability preview)

Adapter keys follow A2 §7.2/7.3 (`openwifi-radius` split here into its two client classes) and A4 §7.4 (`uspot-uam`, `coovachilli-uam`). Labels are copied from the cited A2/A4 rows.

| Capability | `openwifi-hostapd-radius` (802.1X / MAC-auth on EZEAP) | `openwifi-uspot-uam` (TIP fork, EZEAP) | `uspot-upstream-uam` (f00b4r0) | `coovachilli-uam` (EZE gateway) | `openwifi-config` (uCentral push via EZE controller) |
|---|---|---|---|---|---|
| granularity | per-client | per-client | per-client | per-client | **per-SSID** (every station of the SSID gets the same ceiling — A2 §1 VERIFIED CODE+DOCS) |
| rate_limit | **UNKNOWN → REQUIRES DEVICE TEST** — no handler in renderer/hostapd options; `ratelimit client_set` has no caller outside uspot (A2 §2) | **VERIFIED DOCS** `WISPr-Bandwidth-Max-Down/Up` bit/s; `ChilliSpot-Bandwidth-Max-Down/Up` kbit/s (×1000) → `ubus ratelimit client_set` (A2 §2 uspot.uc l.179-204; A4 §3.4). Dictionary presence on device REQUIRES DEVICE TEST (A2 §7.2) | **VERIFIED DOCS** same attrs (A4 §3.4) | **VERIFIED DOCS** `WISPr-Bandwidth-Max-*`, `CoovaChilli-Bandwidth-Max-*` kbit/s (A4 §4, §6) | **VERIFIED CODE+DOCS** `ssids[].rate-limit.{ingress-rate,egress-rate}` integer Mbit/s, 0 = off (A2 §1, §7.3) |
| burst | UNSUPPORTED | UNSUPPORTED (A2 §2: no schema key, `ratelimit` fixed `burst 2k`, VERIFIED DOCS absence) | UNSUPPORTED (A4 §7.5) | UNSUPPORTED via RADIUS (A4 §7.5) | UNSUPPORTED (A2 §2) |
| quota | UNSUPPORTED (nothing verified; A2 §7.2 "—") | **VERIFIED DOCS** `ChilliSpot-Max-Total-Octets` only, **32-bit (< 4 GiB)**; terminates when `ul+dl ≥ max`, Stop cause 5 (A2 §2; A4 §3.4) | **VERIFIED DOCS** `ChilliSpot-Max-{Input,Output,Total}-Octets` + `-Gigawords` (A4 §3.4) | **VERIFIED DOCS** `CoovaChilli-Max-{Input,Output,Total}-Octets` + `-Gigawords` (A4 §4) | UNSUPPORTED |
| session_timeout | REQUIRES DEVICE TEST (`Session-Timeout` honouring by hostapd not verified — A2 §2) | **VERIFIED DOCS** `Session-Timeout` (A4 §3.4) | VERIFIED DOCS | **VERIFIED DOCS** `Session-Timeout`, also `WISPr-Session-Terminate-Time` (A4 §6) | per-SSID NAS default only: `captive.session-timeout` (A4 §2) |
| idle_timeout | per-SSID `max-inactivity` via config only (A2 §2); RADIUS `Idle-Timeout`: UNKNOWN | **VERIFIED DOCS** `Idle-Timeout` (A4 §3.4) | VERIFIED DOCS | VERIFIED DOCS | per-SSID `max-inactivity` / `captive.idle-timeout` (default 600) VERIFIED CODE |
| interim_interval | from config `radius.accounting.interval` 60–600 (A2 §2 VERIFIED CODE); RADIUS `Acct-Interim-Interval` effect: UNKNOWN | **VERIFIED DOCS** honoured **only if NAS `acct-interval` unset** (A4 §3.4; A2 §7.2). Whether the renderer injects default 600 when unset: REQUIRES DEVICE TEST (A4 §10 item 5) | same precedence (A4 §3.4) | **VERIFIED DOCS** honoured if ≥ 60 (A4 §6) | VERIFIED CODE (`captive.acct-interval`, `radius.accounting.interval`) |
| vlan | renderer sets `dynamic_vlan=1` VERIFIED CODE; `Tunnel-Type=VLAN`, `Tunnel-Medium-Type=IEEE-802`, `Tunnel-Private-Group-Id` **REQUIRES DEVICE TEST** (A2 §2, §7.2) | UNSUPPORTED (A4 §3.4 "VLAN attrs: no") | UNSUPPORTED | `CoovaChilli-VLAN-Id` REQUIRES DEVICE TEST (A4 §7.5) | static per-SSID VLAN / `vlan-awareness` VERIFIED CODE (A2 §2) — not per client |
| disconnect | target `hostapd-das` (`ssid.radius.dynamic-authorization{host,port,secret}` → `dae_*`, firewall `Allow-CoA`) config VERIFIED CODE+DOCS; packet handling **REQUIRES DEVICE TEST** (A2 §5) | target `hostapd-das`: hostapd `coa` ubus notify → uspot `client_kick`; **no Acct-Stop on this path** (A4 §3.5 VERIFIED source; hostapd.c side of hook on 25.12 build UNKNOWN) → **REQUIRES DEVICE TEST** | own DAS UDP 3799, identifies by `User-Name`, `Calling-Station-Id`, `Acct-Session-Id`, … but **not configurable via uCentral** (no `das_secret` key) → UNKNOWN / REQUIRES DEVICE TEST (A4 §3.5, A2 §5) | `coaport` (default 0 = disabled); **`User-Name` mandatory**, `Acct-Session-Id` optional; cause Admin-Reset; source must be a configured RADIUS server (A4 §4 VERIFIED DOCS; gateway test still due) | none. Last-resort PROPOSED fallback: push `access-control-list` deny for the MAC (keys VERIFIED CODE) — re-applies hostapd/uspot and **resets portal sessions** (A2 §5 VERIFIED DOCS side effect) |
| coa_change | UNKNOWN → REQUIRES DEVICE TEST (A2 §5) | **UNSUPPORTED** — CoA attribute changes not applied; re-auth is the only way to change a live rate (A4 §7.4) | `Session-Timeout`, `Idle-Timeout`, `Acct-Interim-Interval` only; NAKs on VSAs → REQUIRES DEVICE TEST (A4 §3.5) | **VERIFIED DOCS** CoA re-applies timeouts / bandwidth / quota / `CoovaChilli-Session-State` (A4 §4) | re-push `configure` = config change; side effect: portal sessions reset (A2 §5) |
| mac_auth | `mac-filter: true` renderer VERIFIED CODE; username/password format REQUIRES DEVICE TEST (A2 §11 item 7) | **VERIFIED** `User-Name = MAC(+mac_suffix)`, `User-Password = mac_passwd \|\| MAC`, `Service-Type = Call-Check` (A4 §3.6) | same (A4 §3.6) | **VERIFIED DOCS** `macauth`, `macpasswd` default `password`, `macsuffix` (A4 §4) | keys `mac-filter`, `captive.mac-auth`, `mac-format` VERIFIED CODE (A2 §7.3) |
| accounting | 802.1X Start/Interim/Stop VERIFIED CODE (A2 §2) | Start/Interim/Stop + Accounting-On/Off, polls 10 s, only when `acct_server`+`acct_secret` set (A4 §3.4 VERIFIED) | Start/Interim/Stop/On/Off (A4 §6) | Start/Interim/Stop (A4 §6) | n/a (telemetry via state report `captive{}` — A4 §3.6) |
| portal_type | none (802.1X / MAC-auth) | `uam-chillispot` (A4 §0) | `uam-chillispot+capport` (RFC 8908, A4 §3.6) | `uam-chillispot+wispr+json` (A4 §4) | config-only |

Which uspot code base EZEAP ships is itself REQUIRES DEVICE TEST (A4 §0 item 1); until then `openwifi-uspot-uam` is the assumed adapter and `uspot-upstream-uam` is kept for the upstream case.

---

## 4. Translation layer

```ts
translate(effective: EffectivePolicy, adapter: AdapterCapabilities, ctx: TranslationContext): EnforcementPlan

interface EnforcementPlan {
  radiusReplyAttributes: { name: string; value: string | number; label: Level }[];
  ecloudSideControls:    { kind: 'session_timer' | 'schedule_end' | 'quota_watcher' | 'concurrency' | 'validity_end' | 'temp_policy_expiry'; at?: string; params?: object }[];
  configPushChanges:     { path: string; value: unknown; scope: 'ssid'; label: Level }[];   // optional, openwifi-config only
  unenforceable:         { field: string; reason: 'unsupported' | 'requires_device_test' | 'unknown' | 'granularity_mismatch' | 'overflow_clamped'; detail?: string }[];
  degradation:           'allow' | 'allow_and_flag' | 'fallback_ecloud_side' | 'reject';
}
```

### 4.1 Unit conversions and rounding (PROPOSED)

| Intent → target | Formula | Rounding / clamp |
|---|---|---|
| `*_rate_kbps` → `WISPr-Bandwidth-Max-Down/Up` (bit/s, A4 §3.4) | `kbps × 1000` | integer; clamp to `4 294 967 295` (32-bit RADIUS integer) → `overflow_clamped` |
| `*_rate_kbps` → `ChilliSpot-/CoovaChilli-Bandwidth-Max-Down/Up` (kbit/s, A4 §3.4) | `kbps` | as is. Emit **one** family per adapter (`adapter.rate_limit.attrs[0]`, default WISPr); emitting both is avoided because the order in which uspot applies them is not verified |
| `*_rate_kbps` → `rate-limit.egress-rate` (download) / `ingress-rate` (upload), Mbit/s int (A2 §7.3) | `ceil(kbps / 1000)` | **round up** so the device never under-delivers the promised rate; `< 1000 kbps` cannot be expressed → `unenforceable(reason='unsupported', detail='sub-Mbit')` (A2 §7.3). Direction mapping ingress=client upload / egress=client download is per A2 §7.3; end-to-end direction REQUIRES DEVICE TEST (A2 §11 item 2) |
| `remaining_bytes` → `ChilliSpot-Max-Total-Octets` on TIP fork (32-bit, A4 §3.4) | `min(remaining, 4 294 967 295)` | if clamped → `overflow_clamped`; ECLOUD watcher covers the remainder and the session is re-sized at next auth |
| `remaining_bytes` → `…-Max-Total-Octets` + `…-Max-Total-Gigawords` (upstream uspot / CoovaChilli) | `Octets = remaining mod 2^32`, `Gigawords = floor(remaining / 2^32)` | none |
| time bounds → `Session-Timeout` | `min(policy.session_timeout_s, until(window_end)+grace, until(valid_until), until(voucher expiry), drain_time_s)` | integer seconds, floor `tenant.min_session_s` (300) unless the bound is a hard validity end (then exact, min 60) |
| `idle_timeout_s` → `Idle-Timeout` | as is | min 60 |
| `tenant.interim_interval_s` → `Acct-Interim-Interval` | as is | min 60 (CoovaChilli ignores < 60, A4 §6); flagged `requires_device_test` on uspot when the NAS `acct-interval` may be set (A4 §10 item 5) |
| `vlan_id` → `Tunnel-Type=VLAN(13)`, `Tunnel-Medium-Type=IEEE-802(6)`, `Tunnel-Private-Group-Id="<vlan_id>"` | RFC 3580 triplet, as A2 §7.2 lists | label REQUIRES DEVICE TEST |
| session correlation → `Class` | `ecloud:<session uuid>` | copied into accounting by all three captive NAS types (A4 §3.4, §4 VERIFIED) |

### 4.2 Degradation policy when a field is unenforceable (D5)

Per-tenant setting `policy_degradation`:

| Mode | Behaviour | Use |
|---|---|---|
| `reject` | Access-Reject with reason `unenforceable:<fields>`; `auth_events.reason` set | Regulated sites where e.g. VLAN isolation is a security control |
| `allow_and_flag` | Accept with whatever the adapter can do; `policy_translations.unsupported` lists the rest; `policy.unenforceable` event; A7 shows amber | Default for `burst`, `vlan` on captive adapters |
| `fallback_ecloud_side` | Same as above **plus** arm an ECLOUD-side control: quota → accounting watcher (+ Session-Timeout drain bound); schedule/validity → timers; rate → SSID `rate-limit` push **only** when the winning policy is site-scoped (granularity match) | **Recommended default** |

Field-level override: a policy may mark fields `critical: ["vlan_id"]`, which forces `reject` for those fields regardless of tenant mode.

### 4.3 Worked example

Effective policy (from §1.2): 20 000 / 5 000 kbit/s, `quota_daily_bytes = 1 000 000 000`, `max_devices = 2`, `idle_timeout_s = 600`, schedule Mon–Fri 09:00–18:00 site TZ. Context: Tuesday 10:00:00 site time; `usage_counters(daily)` = 300 000 000 bytes used → remaining 700 000 000; user has 1 active session on another MAC (so this second device is allowed); `tenant.interim_interval_s = 300`; `tenant.min_session_s = 300`.

Common ECLOUD-side controls (every adapter): `concurrency` (checked pre-accept; count 1 → 2 ≤ max_devices), `schedule_end at 18:00:00 site TZ`, `quota_watcher {limit: 700000000, period: daily}`, `session_timer` mirror of the emitted `Session-Timeout`.

**(a) `openwifi-uspot-uam` (TIP fork)**

```
radiusReplyAttributes:
  WISPr-Bandwidth-Max-Down   = 20000000      # bit/s                       VERIFIED_DOCS (A4 §3.4)
  WISPr-Bandwidth-Max-Up     = 5000000       # bit/s                       VERIFIED_DOCS
  Session-Timeout            = 28800         # 10:00 → 18:00               VERIFIED_DOCS
  Idle-Timeout               = 600                                            VERIFIED_DOCS
  Acct-Interim-Interval      = 300           # only if NAS acct-interval unset  VERIFIED_DOCS (precedence) / REQUIRES_DEVICE_TEST (renderer default)
  ChilliSpot-Max-Total-Octets= 700000000     # < 2^32, no clamp            VERIFIED_DOCS (32-bit)
  Class                      = "ecloud:<session-uuid>"                       VERIFIED_DOCS
unenforceable: []            # burst/vlan not set in this policy
configPushChanges: []
degradation: fallback_ecloud_side
```
(Alternative `ChilliSpot-Bandwidth-Max-Down = 20000`, `-Up = 5000` kbit/s if the tenant prefers the ChilliSpot family — not emitted together.)
Drain-time bound: `700e6×8 / 25e6 = 224 s` → floored to 300 s, but it is **not applied** here because the adapter has a verified octet limit; the octet attribute is the primary mechanism.

**(b) `uspot-upstream-uam`** — identical to (a) plus `ChilliSpot-Max-Total-Gigawords = 0`; `Acct-Interim-Interval` and timeouts could later be changed by CoA (REQUIRES DEVICE TEST), so `ecloudSideControls` adds `coa_capable: ['Session-Timeout','Idle-Timeout','Acct-Interim-Interval']` for §5.3.

**(c) `coovachilli-uam`**

```
WISPr-Bandwidth-Max-Down = 20000000, WISPr-Bandwidth-Max-Up = 5000000       VERIFIED_DOCS (A4 §4)
Session-Timeout = 28800, Idle-Timeout = 600, Acct-Interim-Interval = 300    VERIFIED_DOCS
CoovaChilli-Max-Total-Octets = 700000000, CoovaChilli-Max-Total-Gigawords = 0   VERIFIED_DOCS
Class = "ecloud:<session-uuid>"
```
`coa_change` VERIFIED → quota top-ups or rate changes mid-session go out as CoA (`User-Name` + `Acct-Session-Id`, A4 §4).

**(d) `openwifi-hostapd-radius` (802.1X / MAC-auth)**

```
radiusReplyAttributes:
  Session-Timeout = 300        # min(28800, drain 224 s → floor 300)      REQUIRES_DEVICE_TEST (A2 §2)
  Class           = "ecloud:<session-uuid>"
unenforceable:
  download_rate_kbps / upload_rate_kbps   reason=unknown            detail="no verified per-client rate attribute for hostapd (A2 §2)"
  quota_daily_bytes                       reason=unsupported        detail="no octet attribute; bounded by Session-Timeout drain time + accounting watcher"
  idle_timeout_s                          reason=unknown            detail="per-SSID max-inactivity only (A2 §2)"
configPushChanges: []        # policy is group-scoped → SSID rate-limit would hit every station: granularity_mismatch
degradation: fallback_ecloud_side
```
Overshoot bound for the watcher on this adapter: `rate × interim = 25 Mbit/s × 300 s ≈ 937 MB` worst case per interim interval; lowering `radius.accounting.interval` to 60 (schema min, A2 §2) reduces it to ≈ 187 MB. Whether hostapd re-authenticates seamlessly at `Session-Timeout` is REQUIRES DEVICE TEST; the 300 s floor is deliberately conservative to avoid auth storms.

**(e) `openwifi-config`** (only meaningful if the winning policy were **site**-scoped)

```
configPushChanges:
  interfaces[].ssids[<ssid>].rate-limit.egress-rate  = 20   # Mbit/s, ceil(20000/1000)   VERIFIED_CODE+DOCS (A2 §1)
  interfaces[].ssids[<ssid>].rate-limit.ingress-rate = 5                                 VERIFIED_CODE+DOCS
unenforceable: quota_daily_bytes, max_devices, schedule, idle_timeout_s (per-client)  reason=granularity_mismatch / unsupported
```
For the group-scoped policy of this example the adapter returns everything as `granularity_mismatch`. Note the push re-applies hostapd/uspot and **resets portal sessions** (A2 §5 VERIFIED DOCS), so the engine batches config pushes outside the schedule window where possible.

---

## 5. Runtime enforcement loop (ECLOUD-side controls)

### 5.1 Accounting-driven counters

Interim/Stop records (A3 ingests; A6 §5 defines the delta-based `usage_counters` update, monotonic octets, `last_record_id` watermark). The engine subscribes to `session.updated` and runs:

```
on session.updated(s):
    eff = snapshot(s).effective ; usage = usage_counters(subject, periods)
    for period in quota periods set: if used(period) >= limit(period): breach(s, 'quota_'+period)
    elif used(period) >= 0.9*limit: emit quota.warning once per period
    if eff.max_* and count(active sessions of subject) > limit: breach(s, 'concurrency')      # late-detected (e.g. racing auths)
```

`estimated_unreported_bytes(s)` (used in §2.5) `= min(rate_bps/8 × seconds_since(last_interim_at), limit)` — conservative, so a second device never gets a quota the first device may already be consuming.

### 5.2 Breach handling per adapter

| Event | Adapter `disconnect` VERIFIED (future state) | `disconnect` REQUIRES DEVICE TEST / UNKNOWN (today) |
|---|---|---|
| quota exhausted | `session_actions(action='disconnect')` → AAA sends Disconnect-Request to the adapter's target (hostapd DAS / `coaport`, see §3.1; mechanics in `AAA_ARCHITECTURE.md`); on ACK mark session `stopped(terminate_cause='quota')` **ourselves** when `acct_stop_emitted=false` (TIP uspot kick path, A4 §3.5) | rely on the emitted octet limit (captive adapters, NAS terminates with Stop cause 5 — A4 §3.4) or on the drain-time `Session-Timeout` (hostapd); **deny the next Access-Request** (`REJECT quota`) |
| schedule window end | Disconnect at `window_end + grace` | `Session-Timeout` already clipped to window end; deny re-auth while out of window |
| validity / voucher expiry | Disconnect | `Session-Timeout` clipped; deny re-auth |
| temporary policy expiry (`effective_until`) | re-resolve; if the result is *more* restrictive: CoA where `coa_change` covers the field (CoovaChilli; upstream uspot timeouts only), else Disconnect so the client re-auths into the new policy | re-resolve; mark session `policy_stale=true`; applies at next auth; A7 shows "pending re-auth" |
| concurrency breach on new auth | `disconnect_oldest` if configured | `reject` (D4) |

Every `session_actions` row records `status pending → sent → ack | nak | timeout | unsupported` (A6) so the UI can show whether the device actually acted. CoA/Disconnect reachability requires the hub→site route over WireGuard or a public DAS port; without a tunnel, a NAS behind NAT is unreachable (WIREGUARD_ARCHITECTURE §4.3–4.4).

### 5.3 Policy edit → propagation

| Adapter | On `policy.changed` affecting active sessions |
|---|---|
| `coovachilli-uam` | CoA-Request with the full re-translated attribute set (CoA re-applies `config_radius_session` — A4 §4 VERIFIED DOCS); `policy_translations(trigger='coa')` |
| `uspot-upstream-uam` | CoA for `Session-Timeout`/`Idle-Timeout`/`Acct-Interim-Interval` only (A4 §3.5, REQUIRES DEVICE TEST); rate/quota changes need Disconnect + re-auth, and uspot's own DAS is not configurable via uCentral → effectively "at next re-auth" today |
| `openwifi-uspot-uam` (TIP) | **No CoA changes applied** (A4 §7.4). If the change tightens rate/quota and `disconnect` is verified → Disconnect so the client re-logs in (portal round trip); otherwise at next re-auth. Loosening changes always wait for the next auth. |
| `openwifi-hostapd-radius` | CoA UNKNOWN (A2 §5). Disconnect (REQUIRES DEVICE TEST) → 802.1X re-auth; else at next auth / `Session-Timeout` |
| `openwifi-config` | Re-render SSID fragment → EZE controller `configure` push (VERIFIED, A2 §5, `ap_apply.ts`); batch and schedule because it resets portal sessions |

Default for all: **never** silently rewrite a live session's snapshot; create a new `policy_translations` row and (where it happened) a `session_actions` row.

### 5.4 Session lifecycle state diagram

```mermaid
stateDiagram-v2
  [*] --> Authorizing : Access-Request (device → AAA → engine)
  Authorizing --> Rejected : schedule / quota / concurrency / strict-unenforceable
  Authorizing --> Authorized : Access-Accept + EnforcementPlan (ECLOUD stores snapshot, arms timers)
  Authorized --> Active : Acct-Start (device)  [or portal res=success]
  Authorized --> Stale : no Acct-Start within 2×interim (ECLOUD job)
  Active --> Active : Acct-Interim (device) → counters delta (ECLOUD)
  Active --> QuotaWarn : used ≥ 90 % (ECLOUD) → quota.warning
  QuotaWarn --> Active : period reset at site midnight (ECLOUD)
  QuotaWarn --> Disconnecting : used ≥ 100 % and adapter.disconnect VERIFIED (ECLOUD → Disconnect-Request)
  QuotaWarn --> Expired : NAS octet limit / Session-Timeout fires (device, Stop cause 5)
  Active --> Expired : Session-Timeout / Idle-Timeout (device)
  Active --> Disconnecting : schedule end / temp policy expiry / disconnect_oldest / operator (ECLOUD)
  Disconnecting --> Stopped : Disconnect-ACK; ECLOUD closes session itself if no Acct-Stop (TIP uspot path)
  Disconnecting --> Active : NAK / timeout → session_actions.status, fall back to deny-at-re-auth
  Expired --> Stopped : Acct-Stop (device) → final counters (ECLOUD)
  Active --> Stale : interim missing > 3×interval (ECLOUD job)
  Stale --> Stopped : Accounting-Off for NAS or late Acct-Stop
  Stopped --> [*]
```

Device responsibilities (all VERIFIED per adapter in §3.1 unless flagged): admit/deny, apply rate ceiling, count octets, enforce `Session-Timeout`/`Idle-Timeout`/octet limit, send accounting, act on Disconnect (REQUIRES DEVICE TEST). ECLOUD responsibilities: resolution, snapshot, counters, period resets, concurrency, schedule/validity timers, Disconnect/CoA issuance, closing sessions whose kick path yields no Acct-Stop, audit.

---

## 6. Inheritance, boosts, versioning, audit, dry-run

### 6.1 Org / site / group defaults and inheritance

Layers (§2.2) **are** the inheritance chain: org default (`is_default`) → site assignment → group assignment → voucher batch → user → client device → temporary. A NULL field falls through to the next layer, so a site can set only `vlan_id` and `idle_timeout_s`, a group only rates, and the org default only quotas. The dry-run endpoint returns the per-field `provenance` so operators see the chain.

### 6.2 Temporary "boost" (or penalty) policies

A boost is a `policies` row (`scope_type='temporary'`) plus an assignment on the user or client device with `effective_until` set. It wins layer 0 regardless of other layers' values (D1 makes this possible). Expiry handling is §5.2. Operators get a one-click "boost for 2 h" that creates both rows and an `audit_logs` entry; the engine emits `policy.changed` with `cause='temporary_expired'` when it lapses.

### 6.3 Versioning and audit

- Editing an `active` policy increments `policies.version` (A6). The previous field values are stored in `audit_logs` (`actor_type`, `actor_id`, `before`, `after`, `request_id`) — what changed, who, when.
- `sessions.policy_version` + `policy_translations.input_snapshot/emitted/unsupported` tie every session to the exact version and emitted attributes; `policy_translations` is append-only (A6 PK `(id, created_at)`, policy FK `SET NULL` keeps the log after deletion).
- Retiring a policy with active assignments is refused unless `force=true`; the engine then re-resolves affected sessions (§5.3).

### 6.4 Simulation / dry-run endpoint

`POST /internal/policy/simulate` (PROPOSED; also exposed to operators as `POST /api/v1/orgs/{org}/policy-simulations`):

```json
{ "user_id": "…", "client_device_mac": "aa:bb:cc:dd:ee:ff", "nas_client_id": "…", "called_station_id": "…",
  "at": "2026-10-07T06:00:00Z", "assume_usage": {"daily": 300000000}, "assume_active_sessions": 1 }
→
{ "decision": "accept", "effective": {…}, "provenance": {"download_rate_kbps": {"policy_id":"…","version":3,"assignment_id":"…"}},
  "clip": {"session_timeout_s": 28800, "octets": 700000000},
  "plan": { "radiusReplyAttributes": [...], "ecloudSideControls": [...], "configPushChanges": [], "unenforceable": [...] },
  "capabilities_used": "openwifi-uspot-uam@<adapter_version>" }
```

`at`, `assume_usage`, `assume_active_sessions` make the run reproducible for A9 fixtures. The simulation writes `policy_translations(trigger='preview')` only when `persist=true`.

---

## 7. Performance and failure modes

### 7.1 Latency budget (authorize path)

- NAS-side RADIUS client timeout/retransmit on EZEAP (hostapd, uspot radcli) and on CoovaChilli: **UNKNOWN → REQUIRES DEVICE TEST** (not captured by A2/A4). The "3–5 s typical" figure in the brief is treated as an **assumption (PROPOSED)**, not a vendor fact.
- FreeRADIUS side, VERIFIED FROM OFFICIAL DOCUMENTATION (`raddb/proxy.conf`, v3.2.x, github.com/FreeRADIUS/freeradius-server): `response_window = 20`, `zombie_period = 40`, `revive_interval = 120`; CoA retransmission `irt = 2`, `mrt = 16`, `mrc = 5`, `mrd = 30` (seconds / count). These bound how long a Disconnect/CoA attempt may stay `pending` in `session_actions` (≤ 30 s).
- **Target (PROPOSED):** `/internal/aaa/authorize` p50 < 30 ms, p95 < 100 ms, hard deadline 800 ms after which the engine returns the cached/fail-mode answer (§7.3) so AAA still replies well inside any plausible NAS retransmit interval.

Budget split (p95): tenant/NAS lookup 5 ms (Redis) · subject + groups 10 ms (Redis, DB fallback) · candidates query 20 ms (single SQL on A6 indexes) · counters + active sessions 15 ms (Redis hash per subject, DB fallback) · merge + translate < 5 ms (pure CPU) · snapshot write 20 ms **asynchronous** (outbox, not on the reply path).

### 7.2 Caching (Redis)

| Key | Content | TTL / invalidation |
|---|---|---|
| `pol:cands:{org}:{subject_type}:{subject_id}` | ordered candidate list with policy bodies | 300 s; invalidated by `policy.changed`, assignment change, group membership change |
| `pol:eff:{org}:{subject}:{nas}:{window_id}` | effective policy + provenance | until next schedule boundary or 300 s |
| `usage:{subject}:{period}:{start}` | bytes_in/out, updated on every interim | 36 h (daily) / 40 d (monthly); authoritative copy is `usage_counters` |
| `sess:active:{org}:{subject}` | set of active session ids + macs | updated on start/stop/stale |
| `authz:dedup:{nas}:{acct_session_id}` | last decision (for NAS retransmits, §2.9) | 10 s |

Consistency with accounting lag: counters in Redis lag the device by one interim interval; the engine already compensates with `estimated_unreported_bytes` (§5.1). Nightly reconciliation (A6 §5) overwrites counters; the engine never trusts Redis over a fresher `usage_counters.reconciled_at`.

### 7.3 Failure modes (D7)

| Failure | Behaviour |
|---|---|
| Postgres unreachable, Redis has `pol:eff` for the subject (< 15 min old) | **cached-allow**: reply from cache, flag `auth_events.reason='cached_allow'`, emit `policy.degraded` |
| Postgres unreachable, no cache (unknown subject / first auth) | **fail-closed** (Access-Reject) — a tenant may opt into `fail_open_policy_id` (e.g. 1 Mbit/s, 30 min) accepting the abuse risk |
| Redis unreachable | DB-only path; latency target relaxed to p95 < 400 ms; alerts |
| Translation error (bug / unknown adapter key) | Reject with `reason='translation_error'`; never emit a partial attribute set |
| Disconnect timeout (mrd 30 s) | `session_actions.status='timeout'`, keep session `active`, deny at next auth |

---

## 8. Interfaces (PROPOSED — names to be reconciled with A3's `AAA_ARCHITECTURE.md`)

### 8.1 Internal HTTP API (AAA → engine)

| Endpoint | Purpose |
|---|---|
| `POST /internal/aaa/authorize` | body: resolved tenant/NAS/subject/request attrs → `{decision, reply_attributes[], session_id, plan_id}`; idempotent on `(nas_client_id, acct_session_id)` |
| `POST /internal/aaa/accounting` | body: normalised Start/Interim/Stop/On/Off → updates `sessions`, counters, runs §5.1; returns `{actions[]}` the AAA should issue (e.g. Disconnect) |
| `POST /internal/policy/simulate` | §6.4 |
| `POST /internal/policy/{id}/propagate` | re-translate active sessions after an edit (§5.3) |
| `GET  /internal/adapters/{key}/capabilities` | `AdapterCapabilities` for A7 preview |

### 8.2 Events (outbox → bus/webhooks)

`session.started`, `session.updated` (counters), `session.stopped` (`terminate_cause`), `quota.warning` (90 %), `quota.exceeded`, `policy.changed` (`policy_id`, `version`, `diff`, `actor`), `policy.unenforceable` (per authorize when `unenforceable[]` non-empty), `policy.degraded` (cached-allow / fail-open used), `session.action` (`disconnect`/`coa_update` status transitions).

### 8.3 Adapter plugin interface (TypeScript, ≤ 40 lines)

```ts
export interface NasAdapter {
  readonly key: AdapterCapabilities['key'];
  readonly version: string;                       // stored in policy_translations.adapter_version
  capabilities(): AdapterCapabilities;             // static, labelled (section 3)

  /** Intent → device plan. Pure; must not touch the network. */
  translate(effective: EffectivePolicy, ctx: TranslationContext): EnforcementPlan;

  /** Build (not send) an RFC 5176 Disconnect for this NAS type; AAA sends it. */
  buildDisconnect(session: SessionRef): DisconnectRequest | Unsupported;

  /** Build a CoA carrying only attributes the adapter's `coa_change.changeable` covers. */
  buildCoa(session: SessionRef, plan: EnforcementPlan): CoaRequest | Unsupported;

  /** Normalise NAS-specific request fields (Called-Station-Id format, MAC-auth username rule). */
  parseRequest(raw: RadiusAttributes): ParsedRequest;

  /** Optional: SSID/device config fragment for site-scoped intent (openwifi-config only). */
  renderConfig?(effective: EffectivePolicy, target: SsidRef): ConfigFragment | Unsupported;
}

export interface TranslationContext {
  tenantId: string; nas: NasClientRef; sessionId: string; now: Date;
  clip: { sessionTimeoutS?: number; octets?: bigint };
  preferredRateAttrFamily?: 'wispr' | 'chillispot';
  interimIntervalS?: number;
  degradation: 'reject' | 'allow_and_flag' | 'fallback_ecloud_side';
}

export type Unsupported = { unsupported: true; reason: string };
```

---

## 9. Evidence index, open questions, device tests

### 9.1 Evidence index

| Claim used here | Source |
|---|---|
| Per-SSID `rate-limit` Mbit/s integers, per-station HTB ceiling, bridge & NAT | A2 `NETWORK_INTEGRATION.md` §1, §2, §7.3 (VERIFIED CODE+DOCS) |
| uspot honours WISPr bps / ChilliSpot kbps, `Session-Timeout`, `Idle-Timeout`, `Acct-Interim-Interval` (NAS local wins), `ChilliSpot-Max-Total-Octets` 32-bit (T) / +Input/Output/Gigawords (U), `Class`; VLAN attrs not honoured | A4 `CAPTIVE_PORTAL_ARCHITECTURE.md` §3.4 (VERIFIED DOCS) |
| TIP uspot: no own DAS; hostapd `coa` ubus → `client_kick`, no Acct-Stop; CoA changes not applied | A4 §3.5, §7.4 (VERIFIED source; REQUIRES DEVICE TEST) |
| Upstream uspot DAS 3799; CoA timeouts/interim only; not configurable via uCentral | A4 §3.5; A2 §5 |
| CoovaChilli: `coaport`, `User-Name` mandatory, CoA re-applies timeouts/bandwidth/quota; Max-*-Octets+Gigawords; interim ≥ 60 | A4 §4, §6 (VERIFIED DOCS) |
| hostapd per-client rate: no handler found; `Session-Timeout` honouring unverified; `max-inactivity` per SSID | A2 §2 (UNKNOWN / REQUIRES DEVICE TEST) |
| Burst: no schema key, `ratelimit` fixed `burst 2k` | A2 §2 (VERIFIED DOCS, absence) |
| Concurrency not a device feature | A2 §2 (PROPOSED) |
| Dynamic VLAN: `dynamic_vlan=1` rendered; Tunnel-* attrs unverified | A2 §2, §7.2 |
| `configure` push re-applies hostapd/uspot and resets portal sessions | A2 §5 (VERIFIED DOCS) |
| CoA/Disconnect reachability needs tunnel or public DAS port | `WIREGUARD_ARCHITECTURE.md` §4.3–4.4 |
| Tables and A6 precedence rule | `DATABASE_DESIGN.md` §3.4, §3.5, §4, §5 |
| Tenant → site → group/user → device hierarchy; RADIUS → tenant resolution | `MULTITENANCY.md` §1, §3.3 |
| FreeRADIUS timing defaults | `raddb/proxy.conf` v3.2.x (VERIFIED FROM OFFICIAL DOCUMENTATION) |

### 9.2 Open questions for the owner

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | Specificity order: A6 says `client_device > user`; the brief says `user > client-device`. Which? (A device-level "block this phone" argues for device > user.) | A6 order (D2) |
| Q2 | Merge semantics: single-winner fall-through (D1) vs most-restrictive. Accept that site-wide ceilings are expressed as SSID `rate-limit` instead? | D1 |
| Q3 | Quota reset clock: site TZ midnight / calendar month (D6), or tenant billing anchor day? | D6 |
| Q4 | Concurrency default `reject` vs `disconnect_oldest` once Disconnect is verified; should `max_devices` count 802.1X and captive devices together? | `reject`, counted together |
| Q5 | Degradation default `fallback_ecloud_side` (D5) — acceptable that a 20 Mbit/s plan on an 802.1X SSID is initially not rate-limited at all (hostapd path UNKNOWN)? | D5, with A7 amber warning |
| Q6 | `min_session_s` floor (300 s) for drain-time Session-Timeout — acceptable re-auth cadence for 802.1X clients? | 300 s |
| Q7 | Fail-mode: fail-closed + cached-allow (D7) vs tenant `fail_open_policy_id`? | D7 |
| Q8 | Preferred rate attribute family per tenant (WISPr bit/s default vs ChilliSpot kbit/s)? | WISPr |
| Q9 | Should `burst_*` be hidden from the UI until an adapter supports it, or shown as "stored, not enforced"? | shown with warning (A7) |
| Q10 | Who inserts the `sessions` row — engine at authorize (this doc) or A3 on Acct-Start? | engine inserts `authorized`, A3 confirms on Start |

### 9.3 Items requiring a real device test (engine-relevant subset; full lists in A2 §11, A4 §10)

1. hostapd (802.1X/MAC-auth): is any per-client rate attribute honoured? Is `Session-Timeout` honoured and does re-auth happen seamlessly? Is `Idle-Timeout` honoured?
2. uspot TIP fork: WISPr vs ChilliSpot family precedence when both present; direction mapping up→ingress/down→egress; `ChilliSpot-Max-Total-Octets` termination + Terminate-Cause; behaviour when the value is `4294967295`.
3. `Acct-Interim-Interval`: does the renderer inject `acct-interval` 600 when unset (which would override RADIUS)?
4. Disconnect via hostapd DAS: identification attributes (`Calling-Station-Id`, `User-Name`, `NAS-Identifier`), ACK/NAK, whether an Acct-Stop follows for uspot-gated and for 802.1X clients, reachability over the WireGuard path in NAT mode.
5. CoA-Request to hostapd: any attribute applied?
6. Dynamic VLAN: `Tunnel-*` triplet accepted; VLAN pre-existence requirements (`vlan-awareness`).
7. Interaction between SSID `rate-limit` ceiling and a higher per-client RADIUS rate (which wins?).
8. Effect of a `configure` re-push on existing uspot sessions and ratelimit state (confirms the batching rule in §5.3).
9. Which uspot code base ships on EZEAP (decides between adapters (a) and (b)).
10. CoovaChilli on the EZE gateway: `coaport` enabled? Source-IP check vs ECLOUD's WireGuard address; CoA re-apply of bandwidth/quota confirmed live.

---

## 10. Implementation notes (Phase 3, A5b — `@ecloud/policy-engine`, `@ecloud/adapters`)

Status: implemented locally (M4), nothing deployed. The code follows §1–§4, §6.4 and §8.3; the items below are the deviations and refinements made while implementing. Every device claim keeps its Phase 2 label; the four-state enum of amendment (3) is applied verbatim.

| # | Topic | Spec | Implementation | Why |
|---|---|---|---|---|
| I1 | Capability type location | §3 `AdapterCapabilities` described alongside the adapters | Type lives in `@ecloud/policy-engine` (`capabilities.ts`); `@ecloud/adapters` depends on the engine and re-exports it | Avoids a package cycle: `translate()` needs the type, the adapters need `translate()` |
| I2 | Capability levels | §3 `Level = VERIFIED_CODE \| VERIFIED_DOCS \| REQUIRES_DEVICE_TEST \| UNKNOWN \| UNSUPPORTED` | Only the owner's four states (D-028) are used, per field (`fields`) **and** per RADIUS attribute (`attributes`) | Amendment (3); the per-attribute map lets `translate()` refuse any attribute not VERIFIED_SUPPORTED |
| I3 | Emission of unverified attributes | §3: REQUIRES DEVICE TEST fields "are emitted and flagged" | **Not emitted** by default; emitted with `experimental: true` only when `TranslationContext.includeDeviceTestAttributes === true` (lab). Still flagged `requires_device_test` | Phase 3 brief: never emit what the adapter does not mark VERIFIED_SUPPORTED. Consequence for §4.3 (d): `openwifi-hostapd-radius` emits **no** attributes in production mode; `Session-Timeout = 300` + `Class` (+ `Idle-Timeout`, `Acct-Interim-Interval`) appear only in lab mode |
| I4 | Unenforceable reasons | `unsupported \| requires_device_test \| unknown \| granularity_mismatch \| overflow_clamped` | `unknown` merged into `requires_device_test` (mapping of amendment 3); added `attribute_not_declared` | One vocabulary per state |
| I5 | Degradation names | §4.2 `reject \| allow_and_flag \| fallback_ecloud_side` | `strict_reject \| allow_and_flag \| fallback_ecloud_side` (default `fallback_ecloud_side`) | Brief naming; `overflow_clamped` never triggers a reject; `critical_fields` force one |
| I6 | Reason codes | §2 `schedule`, `quota_<period>`, `concurrency` | `no_policy`, `voucher_expired`, `voucher_not_yet_valid`, `schedule`, `quota_daily\|monthly\|total`, `concurrency_sessions`, `concurrency_devices`; `translate()` adds `unenforceable:<fields>` | Finer codes for `auth_events.reason` |
| I7 | Organization default layer | §2.2 "synthetic lowest layer" | Synthetic assignment with `priority = Number.MAX_SAFE_INTEGER` so it is last even against assignments with large explicit priorities | Otherwise the default could outrank a low-priority site assignment |
| I8 | Out-of-window policy | §2.4 "re-run merge with that policy forced on top" | Forced candidate at layer −1; the original schedule is not re-evaluated; `Session-Timeout` is clipped to the next window **start** so the client re-auths into the regular policy | Avoids schedule loops |
| I9 | Quota estimate ≤ 0 | §2.5 `clip.octets = remaining_minus_active` | If remaining minus the §5.1 estimate is ≤ 0 the request is **rejected** (`quota_<period>`) instead of emitting `0` | `Max-*-Octets = 0` means "unlimited" on CoovaChilli; emitting it would be unsafe |
| I10 | Quota reset clip | §2.5 PROPOSED | `Session-Timeout` candidate `quota_reset` = seconds to site-local midnight (daily) / month start (monthly); tenant switch `clip_session_to_quota_reset` (default on) | Implements the PROPOSED behaviour with an off switch |
| I11 | `min_session_s` floor | §4.1 "floor unless hard validity end (then exact, min 60)" | Floor applies only to the drain-time candidate; policy / window / validity / voucher / reset candidates are exact with a 60 s minimum | Matches the intent of §4.1; a 90 s schedule remainder must not become 300 s |
| I12 | Drain-time bound | §2.5 / §4.3 (d) | Applied only when the adapter has no VERIFIED octet attribute **and** degradation is `fallback_ecloud_side` | §4.3 (a): "not applied here because the adapter has a verified octet limit" |
| I13 | `openwifi-config` site scope | §4.2 "only when the winning policy is site-scoped" | `site` **or** organization-default provenance counts as site-wide; `captive.session-timeout` is pushed only when `ctx.ssidIsCaptive === true`; `max-inactivity` for `idle_timeout_s` | The org default applies to every station of every SSID; `captive.*` keys are invalid on non-captive SSIDs |
| I14 | `openwifi-config` per-client fields | §4.3 (e) | `max_concurrent_sessions`, `max_devices`, `valid_*`, `voucher_validity`, `schedule_id` declared `UNSUPPORTED` (not `ECLOUD_SIDE_ONLY`) | A config-only adapter has no per-client decision point to enforce them |
| I15 | `openwifi-config` `vlan_id` | §3.1 "static per-SSID VLAN / vlan-awareness VERIFIED CODE — not per client" | `REQUIRES_DEVICE_TEST` | A2 §7.3 lists no uCentral key that maps a policy `vlan_id` to an SSID VLAN id; nothing to emit |
| I16 | `Class` on hostapd | §4.3 (d) emits `Class` | `REQUIRES_DEVICE_TEST` (AAA §4.3 labels the echo VERIFIED for uspot/chilli only) | No fabrication |
| I17 | CoovaChilli `coa_change` | §3.1 VERIFIED DOCS | `VERIFIED_SUPPORTED` with note "live gateway confirmation pending (§9.3 item 10)"; `disconnect` stays `REQUIRES_DEVICE_TEST` (D4) | Mapping rule VERIFIED → VERIFIED_SUPPORTED; D4 is explicit for Disconnect only |
| I18 | `NasAdapter` surface | §8.3 `parseRequest()` | Omitted (owned by AAA request normalisation); `buildReplyAttributes()` and `describeDisconnect()` added | Phase 3 scope |
| I19 | Rule 9 / 11 details | §1.3 | Rule 9: `is_default` ⇒ `scope_type ∈ {site, group}`, no `site_id`, one per org (`context.existingDefaultPolicyId`). Rule 11: active edit with changed enforcement columns requires `version > previous.version`; retired + any change ⇒ error | Testable without a DB |
| I20 | Bigint quotas | §1.1 `bigint` | Native `bigint` in the engine; schema accepts `bigint \| safe integer \| decimal string`; snapshots serialise decimal strings | PostgreSQL `bigint` exceeds 2^53; JSON has no bigint |
| I21 | `disconnect_oldest` | §2.6 | Disconnects the oldest **session** (not all sessions of the oldest device); requires `active_sessions[].disconnect_status === 'VERIFIED_SUPPORTED'` | Simplest safe behaviour until Disconnect is verified anywhere |

Verification (local): `npm run build`, `npm run lint`, `npm test -- --project policy-engine --project adapters` green; line coverage 98.98 % (`policy-engine`) / 98.43 % (`adapters`). Golden tests reproduce §4.3 (a)–(e) for all five adapters (`packages/adapters/src/golden.test.ts`).

### Orchestrator reconciliation (2026-10-07)
- I22. `coovachilli-uam.coaChange` and `openwifi-config.coaChange` were downgraded from VERIFIED_SUPPORTED to REQUIRES_DEVICE_TEST (owner rule D-006/D-034: dynamic policy modification is never verified before the real-device test, DT-15 and DT-02). `buildCoa()` still produces the request, labelled REQUIRES_DEVICE_TEST, and the dispatcher must be feature-flagged (see AAA_ARCHITECTURE.md implementation notes). A test now asserts that no adapter declares `coaChange` or `disconnect` as VERIFIED_SUPPORTED.

