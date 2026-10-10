# Contract: FreeRADIUS -> ECLOUD `/internal/aaa/authorize` and `/internal/aaa/post-auth`

Status: M6 part 1 (infra/freeradius). Producer: FreeRADIUS 3.2.10 `rlm_rest` as configured in
`infra/freeradius/raddb/mods-available/rest`, `sites-enabled/ecloud`, `policy.d/ecloud`.
Consumer: the ECLOUD api internal listener (`INTERNAL_PORT`, `apps/api`). Design source:
`AAA_ARCHITECTURE.md` §2.1, §4.1, §4.2. Everything marked VERIFIED below was observed on the
dev container with a stub API on 2026-10-07 (`infra/freeradius/README.md` "Smoke verification");
the rest is the required behaviour of the API.

The same copy of this contract lives in `infra/freeradius/README.md`; keep both identical.

## 1. Transport

| Item | Value |
|---|---|
| Method / URL | `POST {ECLOUD_INTERNAL_URL}/internal/aaa/authorize` and `POST {ECLOUD_INTERNAL_URL}/internal/aaa/post-auth` |
| Headers sent (VERIFIED) | `Content-Type: application/json`, `Accept: application/json`, `User-Agent: FreeRADIUS 3.2.10`, `X-FreeRADIUS-Section: authorize` or `post-auth`, `X-FreeRADIUS-Server: ecloud`, `X-Internal-Token: <INTERNAL_API_TOKEN>` |
| Authentication | The API MUST compare `X-Internal-Token` with `INTERNAL_API_TOKEN` (constant-time) and answer `401` without a body when it does not match (FreeRADIUS treats that as a reject; see §4). Production additionally reaches the listener only on the compose network / via TLS (`tls {}` in `mods-available/rest`). The token must not contain `%`, `"` or `\` (it is embedded in an xlat string). |
| Timeouts | authorize: connect 1.0 s, request 1.5 s; post-auth: connect 1.0 s, request 1.0 s. Slower answers are a `fail` (§4). Pool: max 8 connections per FreeRADIUS instance. |
| Retries | None from FreeRADIUS. The NAS retransmits the Access-Request (typically 3-5 s); FreeRADIUS de-duplicates only while the first request is still being processed. The API SHOULD therefore be idempotent for the same (`ECLOUD-Packet-Src-IP-Address`, `Acct-Session-Id`, `Calling-Station-Id`, `User-Name`) within a few seconds (single-use portal credentials must not be consumed twice by a retransmit). |

## 2. Request body (both endpoints)

`body = json`: one JSON object keyed by RADIUS attribute name; every value is
`{"type": "<freeradius type>", "value": [ ...one entry per occurrence... ]}` (VERIFIED). Examples
captured from the dev container:

```json
{
  "User-Name":            {"type": "string",  "value": ["pc-PLACEHOLDER"]},
  "User-Password":        {"type": "string",  "value": ["PLACEHOLDER_PASSWORD"]},
  "NAS-IP-Address":       {"type": "ipaddr",  "value": ["192.0.2.10"]},
  "NAS-Identifier":       {"type": "string",  "value": ["lab-ap-01"]},
  "NAS-Port-Type":        {"type": "integer", "value": ["Wireless-802.11"]},
  "Service-Type":         {"type": "integer", "value": ["Login-User"]},
  "Calling-Station-Id":   {"type": "string",  "value": ["AA-BB-CC-DD-EE-FF"]},
  "Called-Station-Id":    {"type": "string",  "value": ["00-11-22-33-44-55"]},
  "Called-Station-SSID":  {"type": "string",  "value": ["lab-uam"]},
  "Called-Station-MAC":   {"type": "octets",  "value": ["\u0000\u0011\"3DU"]},
  "Acct-Session-Id":      {"type": "string",  "value": ["5f3e1a2b00000001"]},
  "Framed-IP-Address":    {"type": "ipaddr",  "value": ["10.0.0.23"]},
  "WISPr-Logoff-URL":     {"type": "string",  "value": ["http://10.0.0.1:3990/logoff"]},
  "Message-Authenticator":{"type": "octets",  "value": ["<16 raw bytes>"]},
  "ECLOUD-Packet-Src-IP-Address": {"type": "string",  "value": ["172.19.0.1"]},
  "ECLOUD-Packet-Src-Port":       {"type": "integer", "value": [44916]},
  "ECLOUD-Packet-Dst-Port":       {"type": "integer", "value": [1812]},
  "ECLOUD-Client-Shortname":      {"type": "string",  "value": ["ecloud-dev"]}
}
```

Encoding rules (VERIFIED on 3.2.10):

- `integer` attributes with a named VALUE are sent as the **name** (`"Login-User"`, `"Call-Check"`,
  `"Wireless-802.11"`); integers without a name as JSON numbers (`44916`). Parse both.
- `octets` attributes are sent as the **raw bytes inside a JSON string** (not hex). Treat them as
  binary (latin-1) and do not depend on them; the only ones of interest are presence checks
  (`Message-Authenticator`, `CHAP-Password`).
- Attributes the NAS did not send are absent (no `null`s). Unknown VSAs (e.g. the TIP vendor
  0x0000e608 TLV) are forwarded under FreeRADIUS's generated name; their layout is
  REQUIRES DEVICE TEST (DT-03) and MUST be ignored until then.
- Any other attribute the NAS sends is forwarded too; the API reads what it needs and ignores the rest.

### 2.1 Fields the API uses (authorize)

| JSON key | Produced by | Use in ECLOUD (AAA §4.1) |
|---|---|---|
| `ECLOUD-Packet-Src-IP-Address` (string) | server, `policy.d/ecloud` | **primary** NAS/tenant resolution (`nas_clients` by source IP, MULTITENANCY §3.3 A). Dev: the Docker bridge gateway `172.19.0.1` for host-originated packets. |
| `ECLOUD-Client-Shortname` (string) | `clients.conf` `shortname` | secondary NAS key once production clients are rendered (renderer will set it to the `nas_clients` id). Dev: `ecloud-dev`. |
| `NAS-Identifier`, `NAS-IP-Address`, `NAS-Port-Type`, `NAS-Port-Id` | NAS | logging and same-tenant consistency checks only: NAS-supplied, **never** used to select a NAS or tenant (`NAS-IP-Address` also differs from the source behind NAT) |
| `ECLOUD-Packet-Dst-Port` (1812) | server | listener telemetry |
| `User-Name` | NAS | identity: portal credential (`pc-...`), MAC, voucher, subscriber username |
| `User-Password` (cleartext, PAP) | NAS (decrypted by FreeRADIUS) | **never log, never persist.** Needed only when ECLOUD verifies itself (Argon2 subscriber password, voucher HMAC, MAC password) and answers `Auth-Type = Accept`. For broker credentials ECLOUD returns `Cleartext-Password` instead and lets `rlm_pap` compare. |
| `CHAP-Password`, `CHAP-Challenge` (octets) | NAS | presence means CHAP: ECLOUD can only return `Cleartext-Password` (broker credential / reversible voucher) and `Auth-Type = CHAP`; otherwise reject with `Reply-Message`. |
| `Calling-Station-Id` | `rewrite_calling_station_id` | client MAC, normalised `AA-BB-CC-DD-EE-FF` (binding, MAC-auth, concurrency) |
| `Called-Station-Id`, `Called-Station-SSID`, `Called-Station-MAC` | `rewrite_called_station_id` | when the NAS sent `mac:ssid` (TIP uspot) the id is reduced to the MAC and the SSID is split out; CoovaChilli sends only the MAC (no `Called-Station-SSID`) |
| `Service-Type` | NAS | `Call-Check` => MAC authentication (uspot `mac-auth`); `Login-User`/`Framed-User` otherwise. Cycle A: on a `generic-radius-8021x` NAS a `User-Name` that is exactly the `Calling-Station-Id` MAC (password absent or the same MAC) is MAC authentication without `Call-Check` |
| `ECLOUD-EAP-Inner` (string, `ttls`), `ECLOUD-Outer-User-Name` (string) | server, `sites-available/ecloud-inner` only (Cycle A, opt-in 802.1X) | marks an EAP-TTLS **inner** request: `User-Name` / `User-Password` are the inner identity; NAS facts and `ECLOUD-Packet-*` are re-copied from the outer packet. Accepted only for 802.1X adapters (`generic-radius-8021x`, `openwifi-hostapd-radius`); never MAC auth, never a portal credential. The outer server deletes both attributes from every packet. |
| `Acct-Session-Id`, `Framed-IP-Address` | NAS | correlation with the UAM `sessionid` and the portal binding (CAPTIVE_PORTAL §3.4) |
| `Message-Authenticator` (presence) | NAS | per-NAS BlastRADIUS posture telemetry (`nas_clients.require_message_authenticator`) |
| `WISPr-*`, `ChilliSpot-*` request VSAs | NAS | adapter fingerprinting (uspot vs CoovaChilli) |

Not present in this milestone: `Stripped-User-Name` / `Realm` (no realm splitting on the wire,
AAA §7; an inner identity `user@realm` is matched as the whole username), `Chargeable-User-Identity`
unless the NAS sends it. EAP (Cycle A): the outer request with `EAP-Message` is never posted to
`/authorize` (anonymous outer identity); with `RADIUS_EAP_ENABLED` unset FreeRADIUS rejects it
locally, otherwise ECLOUD decides on the inner request (`ECLOUD-EAP-Inner`). The `/post-auth` body
drops `EAP-Message`.

## 3. Response to `/internal/aaa/authorize`

`200 OK`, `Content-Type: application/json`, body = rlm_rest **JSON policy**: an object whose keys are
`<list>:<Attribute>` and whose values are objects `{"value": [...], "op": ":=", "do_xlat": false}`.

```json
{
  "control:Auth-Type":          {"value": ["PAP"],  "op": ":=", "do_xlat": false},
  "control:Cleartext-Password": {"value": ["<portal credential>"], "op": ":=", "do_xlat": false},

  "reply:Session-Timeout":            {"value": [3600],       "op": ":=", "do_xlat": false},
  "reply:Idle-Timeout":               {"value": [600],        "op": ":=", "do_xlat": false},
  "reply:Acct-Interim-Interval":      {"value": [300],        "op": ":=", "do_xlat": false},
  "reply:WISPr-Bandwidth-Max-Down":   {"value": [20000000],   "op": ":=", "do_xlat": false},
  "reply:WISPr-Bandwidth-Max-Up":     {"value": [5000000],    "op": ":=", "do_xlat": false},
  "reply:ChilliSpot-Max-Total-Octets":    {"value": [2147483648], "op": ":=", "do_xlat": false},
  "reply:ChilliSpot-Max-Total-Gigawords": {"value": [1],          "op": ":=", "do_xlat": false},
  "reply:Class":        {"value": ["ai:<32 lowercase hex digits of the session UUID>"], "op": ":=", "do_xlat": false},
  "reply:Reply-Message":{"value": ["Welcome"], "op": ":=", "do_xlat": false}
}
```

Rules:

1. **Object form with `"do_xlat": false` is mandatory for every attribute.** On FreeRADIUS 3.2.10 the
   section-level `do_xlat = no` in `mods-available/rest` is NOT honoured (VERIFIED: a string-form
   `"reply:Reply-Message": "Welcome %{User-Name}"` came back expanded as `Welcome pc-PLACEHOLDER`;
   the object form with `do_xlat:false` stayed literal). Without it any `%{...}` in a value -- e.g.
   a username echoed back -- is executed by the server. The section item becomes effective on 3.2.11+.
2. `control:Auth-Type` MUST be one of `PAP`, `CHAP`, `MS-CHAP` (FreeRADIUS verifies against
   `control:Cleartext-Password`, which is then REQUIRED) or `Accept` (no local check; ECLOUD already
   verified). A `200` without `control:Auth-Type` is rejected by FreeRADIUS ("No Auth-Type found").
3. Reply attributes are emitted **per NAS adapter** (AAA §4.3). Attribute names available on the
   server: all standard RFC attributes, `WISPr-*` (vendor 14122), `ChilliSpot-*` (vendor 14559
   incl. ECLOUD's additions `ChilliSpot-Max-{Input,Output,Total}-Gigawords` 21-23,
   `ChilliSpot-Session-State` 15, `ChilliSpot-VLAN-Id` 24), `Tunnel-*`. **`CoovaChilli-*` names do not
   exist**: use the `ChilliSpot-*` spelling for CoovaChilli as well (same vendor id and numbers on the wire).
   An unknown attribute name makes FreeRADIUS skip that attribute and log an error; it does not fail the request.
4. Integer values: JSON numbers or VALUE names (`"Call-Check"`). Strings: plain. Octets (`Class`):
   either a `"0x..."` hex string or a plain string whose bytes are used verbatim (both VERIFIED).
   Multi-valued attributes: several entries in `value` with `"op": "+="`.
5. `reply:Class` convention: the **ASCII string** `ai:` followed by the 32 lowercase hex digits of the
   ECLOUD session UUID (35 bytes; on the wire `0x61693a` + 64 hex digits). The stock `acct_unique`
   policy recognises exactly this shape (`^0x61693a([0-9a-f]{32}|[0-9a-f]{64})$`) and keys accounting on
   `md5(<32 hex digits>,<Acct-Session-Id>)`, so the NAS echoing `Class` gives a stable `acctuniqueid`
   even if `NAS-IP-Address` changes (AAA §5.2). **Do not send the 16 raw UUID bytes**: the policy's
   `%{string:...}` xlat stops at the first NUL byte, so any UUID containing `0x00` (about 5 % of
   them) would collapse to `md5("")` and collide (VERIFIED with an all-zero Class: `acctuniqueid =
   d41d8cd9...`). If the API omits `Class`, FreeRADIUS generates an `ai:`-prefixed one itself.
6. `Session-Timeout` SHOULD be capped at the policy refresh interval while CoA is unsupported (AAA §6, Q4).
7. The API MUST NOT return `User-Password` or any `control:` item other than `Auth-Type`,
   `Cleartext-Password` (or `NT-Password` for a future PEAP tenant).

## 4. HTTP status -> RADIUS outcome (VERIFIED on the dev container)

| API answers | rlm_rest code | FreeRADIUS result | When ECLOUD uses it |
|---|---|---|---|
| `200` + policy | `updated` | Access-Accept after the chosen `Auth-Type` succeeds; Access-Reject (without the welcome `Reply-Message`) if the local PAP/CHAP check fails | accept |
| `401` (+ optional policy with `reply:Reply-Message`) | `reject` | Access-Reject; the body is applied, so `Reply-Message` reaches NASes that show it (CoovaChilli `reply=`) | policy rejections: unknown identity, quota, concurrency, schedule, validity, tenant mismatch, bad token |
| `403` | `userlock` | Access-Reject | blocked device/subscriber (optional; `401` is equivalent) |
| `404` / `410` | `notfound` | Access-Reject | not used |
| `204` | `ok` | Access-Reject ("No Auth-Type found") | **do not use for authorize** |
| `5xx`, timeout (1.5 s), connection refused | `fail` | Access-Reject with `Reply-Message = "AAA backend unavailable"`; **no fail-open**; `/post-auth` is not called | outage |

The API MUST NOT send `3xx`; redirects are not followed.

## 5. `/internal/aaa/post-auth` (outcome notification)

Called once per Access-Request after the decision, except when the backend was unavailable. Body:
the request list of §2 with the credentials removed (`User-Password`, `CHAP-*`, `MS-CHAP*` --
VERIFIED absent) plus:

| JSON key | Value |
|---|---|
| `ECLOUD-Auth-Result` | `"accept"` or `"reject"` -- the final RADIUS outcome |
| `ECLOUD-Decision` | what the authorize call produced: `"accept"` (200 applied), `"reject"` (401/403/404), never `"unavailable"` here |
| `ECLOUD-Reply-Class` | the `Class` actually sent, as `"0x..."` hex string (ECLOUD's own or the FreeRADIUS fallback) |
| `ECLOUD-Reply-Message` | the `Reply-Message` sent, if any |
| `Module-Failure-Message` | present when a FreeRADIUS module failed, e.g. `pap: Cleartext password does not match "known good" password` (local credential mismatch after a `200`) |

Expected answer: `204 No Content`. Any status, body or error is ignored by FreeRADIUS (VERIFIED:
the decision never changes). The API uses it to write `auth_events` and to release/confirm the
single-use portal credential. Budget: 1.0 s.

## 6. Example exchange (dev)

```
NAS -> FreeRADIUS  Access-Request User-Name=pc-..., User-Password=..., Calling-Station-Id=aa:bb:..., Called-Station-Id=00-11-...:lab-uam, Acct-Session-Id=...
FreeRADIUS -> API  POST /internal/aaa/authorize  (headers §1, body §2)
API -> FreeRADIUS  200 {"control:Auth-Type":{"value":["PAP"],"op":":=","do_xlat":false}, "control:Cleartext-Password":{...}, "reply:Class":{...}, ...}
FreeRADIUS         rlm_pap compares User-Password with Cleartext-Password
FreeRADIUS -> API  POST /internal/aaa/post-auth {..., "ECLOUD-Auth-Result":{"type":"string","value":["accept"]}, "ECLOUD-Decision":{"type":"string","value":["accept"]}, "ECLOUD-Reply-Class":{"type":"string","value":["0x61693a30313939..."]}}
API -> FreeRADIUS  204
FreeRADIUS -> NAS  Access-Accept Session-Timeout, Idle-Timeout, Acct-Interim-Interval, WISPr-*, ChilliSpot-*, Class, Message-Authenticator
```
