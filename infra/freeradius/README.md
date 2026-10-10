# infra/freeradius -- ECLOUD FreeRADIUS 3.2.10 front-end

FreeRADIUS is a **protocol front-end only** (`AAA_ARCHITECTURE.md` §0): it authenticates the NAS
(shared secret), normalises attributes, asks ECLOUD for every authorization decision over HTTP
(`rlm_rest`), and writes raw accounting rows into PostgreSQL (`rlm_sql`, insert-only). No
subscriber data, policy or secret lives in this directory.

```
infra/freeradius/
  Dockerfile                 FROM freeradius/freeradius-server:3.2.10 + overlay, non-root, healthcheck
  docker-entrypoint.sh       resolves *_FILE secrets into env, validates required vars, execs the image entrypoint
  healthcheck.sh             Status-Server probe against 127.0.0.1:18121 (secret from env or file)
  raddb/                     ONLY the files that differ from the image defaults (/etc/freeradius)
    sites-enabled/ecloud       virtual server: auth 1812 / acct 1813, authorize -> rest, accounting -> sql
    sites-available/ecloud-inner  EAP-TTLS inner server (opt-in, linked by the entrypoint, §7)
    mods-available/eap         ECLOUD EAP module: TTLS/PAP only, certs from RADIUS_EAP_CERT_DIR (opt-in)
    sites-enabled/status       Status-Server listener on 127.0.0.1:18121 (health)
    mods-available/rest        rlm_rest -> ${ECLOUD_INTERNAL_URL}/internal/aaa/{authorize,post-auth}
    mods-available/sql         rlm_sql_postgresql -> radius.radacct_raw (role ecloud_radius)
    mods-config/sql/main/postgresql/queries.conf   per-status-type INSERT ... ON CONFLICT DO NOTHING (no UPDATE)
    policy.d/ecloud            ecloud_request_context, ecloud_rest_headers, ecloud_post_auth_context
    clients.conf               only `$INCLUDE clients.d/`
    clients.d/dev.conf         the single dev client (hidden in production by the rendered-clients volume)
    dictionary, dictionary.ecloud   ChilliSpot Gigawords 21-23 etc., ECLOUD-* internal attributes
  test/                      radclient attribute files for the A9 lab tests (placeholders only)
```

## 1. How the container maps to AAA_ARCHITECTURE.md

| Design item | Where | Status |
|---|---|---|
| §0/§4 `rlm_rest` authorize -> `POST /internal/aaa/authorize`, `control:Auth-Type` chosen by ECLOUD | `sites-enabled/ecloud` `authorize { ... rest ... }`, `mods-available/rest` | done, verified with a stub API (§5 below) |
| §2.1 pipeline `filter_username`, `rewrite_calling_station_id`, `rewrite_called_station_id`, `Message-Authenticator := 0x00` in every reply | `sites-enabled/ecloud` | done (stock policies from the image) |
| §2.2/§2.6 PAP / CHAP / MS-CHAP against `control:Cleartext-Password`; `Accept` when ECLOUD verified itself | `authenticate { Auth-Type PAP/CHAP/MS-CHAP }` | done |
| §2.4 802.1X EAP-TTLS (inner PAP), inner-tunnel | `mods-available/eap`, `sites-available/ecloud-inner`, outer `sites-enabled/ecloud` `-eap` | **Cycle A, opt-in** (`RADIUS_EAP_ENABLED=1` + mounted certificate, §7). Stock `eap` module / `inner-tunnel` site stay removed. PEAP-MSCHAPv2 is not offered (ECLOUD stores Argon2id only). Default: every `EAP-Message` is rejected without asking ECLOUD |
| §3 clients rendered from `nas_clients`; one secret per NAS; `read_clients` later | `clients.conf` → `$INCLUDE clients.d/`; dev: `clients.d/dev.conf`; production: `ecloud-nas.conf` rendered by `node apps/api/dist/radius-clients-cli.js` (api image) into a volume mounted read-only over `clients.d/` | done (F-P10-07, docs/SECURITY_REVIEW_P10.md §4.3). FreeRADIUS 3.2 reads clients only at start-up (SIGHUP reloads modules, not clients; verified) → re-render + `docker compose restart freeradius` |
| §4.2 HTTP code mapping, no fail-open | `authorize` block: `fail/invalid -> reject "AAA backend unavailable"`, `401/403/404 -> reject` | done, verified |
| §4.3 dictionary gap: ChilliSpot Gigawords 21-23 | `dictionary.ecloud` (+ Session-State 15, VLAN-Id 24) | done; `CoovaChilli-*` aliases intentionally NOT defined (see file header) |
| §5 `rlm_sql` insert-only into `radius.radacct_raw`, idempotency on retransmit, Gigawords folded, `Event-Timestamp` else receive time | `mods-available/sql`, `queries.conf` | done, verified against `packages/db/migrations/009_radius_schema.sql` |
| §5.2 `acct_unique` on `Class` (ASCII `ai:` + 32 hex chars, see contract §3 rule 5), `insert_acct_class` fallback | `preacct { acct_unique }`, `post-auth` | done |
| §6 Dynamic authorization originates from the worker; **no 3799 listener** | -- | as designed (test files for the lab in `test/`) |
| §8 BlastRADIUS: global `require_message_authenticator = yes`, `limit_proxy_state = auto` (image defaults) repeated per client | `clients.conf`, `sites-enabled/status` | done |
| §8 logging without secrets: `log { auth = no ... }` stays at image defaults; logs to stdout | `CMD ["freeradius","-l","stdout"]` | done. Never run `-X` in production: the debug config dump prints client secrets and the token. |
| §9 image `freeradius/freeradius-server:3.2.10`, Status-Server 18121 on loopback, pools max 8, secrets from files | `Dockerfile`, `healthcheck.sh`, `docker-entrypoint.sh` | done |
| §9 `radiusd -C` validation before swap | `Dockerfile` RUN step (placeholder values) | done at build; `docker compose exec freeradius freeradius -XC -l stdout` at runtime |

## 2. Dev vs production

| | Dev stack (`infra/compose/docker-compose.dev.yml`) | Production (pilot VPS, DEPLOYMENT_ARCHITECTURE.md §2) |
|---|---|---|
| Listening address inside the container | `RADIUS_LISTEN_IP=0.0.0.0` | `*` (default) |
| Published ports | `127.0.0.1:1812-1813/udp` only | `${RADIUS_BIND_IP}:1812-1813/udp` = WireGuard hub `100.100.0.1` (tunnel-only, D-032); optional RadSec 2083 later; never 3799 |
| Clients | `clients.d/dev.conf`: one `client ecloud_dev` from `RADIUS_DEV_CLIENT_CIDR` (default `172.16.0.0/12`: compose network + Docker gateway, which is the source of host-published packets -- verified `172.19.0.1`) with `RADIUS_DEV_CLIENT_SECRET` | `clients.d/ecloud-nas.conf` rendered from `nas_clients` by the `radius-clients` one-shot (api image, 0640 `1000:101`) into a volume mounted read-only (`nocopy`) over `/etc/freeradius/clients.d`; `RADIUS_CLIENTS_RENDERED=1` makes the entrypoint skip the dev variables and refuse to start if `dev.conf` is visible or the rendered file is missing/empty |
| ECLOUD API | `ECLOUD_INTERNAL_URL=http://host.docker.internal:3001` (api runs on the host, `INTERNAL_PORT`) | api container on the compose network (`http://api:3001`) or `https://` with the CA pinned in `mods-available/rest` `tls {}` |
| Secrets | plain env with obviously-fake defaults (`ecloud_dev_*`) | `RADIUS_SQL_PASSWORD_FILE`, `RADIUS_STATUS_SECRET_FILE`, `INTERNAL_API_TOKEN_FILE` (Compose `secrets:` -> `/run/secrets/...`), resolved by `docker-entrypoint.sh`; the healthcheck uses `radclient -S <file>` |
| PostgreSQL role | `ecloud_radius` / `RADIUS_SQL_PASSWORD` -- **not yet created by the dev init** (see §6) | `ecloud_radius`, INSERT-only on `radius.radacct_raw` (`packages/db/migrations/010`) |
| Logging | stdout (`docker compose logs freeradius`) | stdout -> Docker json-file (rotation per DEPLOYMENT §2.3) |
| Resources | none | `deploy.resources.limits` 192 MiB / 0.5 vCPU (DEPLOYMENT §2.2) |

Environment variables read by the container (all set by the compose file with dev defaults; names
also in `.env.example`):

| Variable | Purpose |
|---|---|
| `RADIUS_LISTEN_IP` | `listen { ipaddr }` inside the container (`*`) |
| `RADIUS_DEV_CLIENT_CIDR`, `RADIUS_DEV_CLIENT_SECRET` | the single dev client (not needed when `RADIUS_CLIENTS_RENDERED=1`) |
| `RADIUS_STATUS_SECRET` / `_FILE` | Status-Server client on 127.0.0.1:18121 |
| `RADIUS_SQL_HOST`, `RADIUS_SQL_PORT`, `RADIUS_SQL_DB`, `RADIUS_SQL_USER`, `RADIUS_SQL_PASSWORD` / `_FILE` | `rlm_sql`; `RADIUS_SQL_DB` may be a libpq conninfo string (`dbname=... sslmode=verify-full ...`) |
| `ECLOUD_INTERNAL_URL`, `INTERNAL_API_TOKEN` / `_FILE` | `rlm_rest` base URL and `X-Internal-Token` (token must not contain `%`, `"`, `\`) |

Undefined `$ENV{...}` expands to an empty string in FreeRADIUS, so the entrypoint fails fast and names
the missing variable (never its value).

## 3. Running and testing

```bash
npm run dev:stack                                   # postgres, redis, freeradius (build on first run)
dc() { docker compose --project-directory . -f infra/compose/docker-compose.dev.yml "$@"; }
dc logs freeradius                                  # "... Info: Ready to process requests"
dc exec -T freeradius freeradius -XC -l stdout | tail -1      # "Configuration appears to be OK"

# Status-Server (health)
echo "Message-Authenticator = 0x00" | dc exec -T freeradius radclient -x 127.0.0.1:18121 status '<RADIUS_STATUS_SECRET>'
#   -> Received Access-Accept ...

# Access-Request. The dev client CIDR covers the container itself, so inside the container use its
# own address; from the host use 127.0.0.1:1812 (source seen by the server: the Docker gateway).
dc exec -T freeradius sh -c 'radclient -x $(hostname -i):1812 auth "$RADIUS_DEV_CLIENT_SECRET"' \
  < infra/freeradius/test/access-request-uspot-uam-pap.txt
#   api not running  -> Access-Reject, Reply-Message = "AAA backend unavailable",
#                        log: "rlm_rest (rest): Connection failed: 7 - Couldn't connect to server"
#   api running      -> Access-Accept with the adapter's reply attributes

# radtest equivalent (radtest is in the image too):
dc exec -T freeradius sh -c 'radtest -x pc-PLACEHOLDER PLACEHOLDER_PASSWORD $(hostname -i):1812 0 "$RADIUS_DEV_CLIENT_SECRET"'

# Accounting
dc exec -T freeradius sh -c 'radclient -x $(hostname -i):1813 acct "$RADIUS_DEV_CLIENT_SECRET"' \
  < infra/freeradius/test/acct-start.txt
```

More attribute files (MAC-auth, Interim with Gigawords, Stop, Accounting-On, Disconnect/CoA to the NAS)
and their DT-case mapping: `test/README.md`.

### `do_xlat` on 3.2.10 (important for the API)

`mods-available/rest` sets `do_xlat = no` per section as documented for the 3.2.x branch, but
**3.2.10 ignores it**: a string-form response value `"Welcome %{User-Name}"` was expanded by the
server, while the object form `{"value": [...], "do_xlat": false}` stayed literal. The API MUST use
the object form with `"do_xlat": false` for every attribute (contract §3 rule 1).

## 4. Dictionary decisions

- `ChilliSpot-Max-{Input,Output,Total}-Gigawords` 21/22/23 are taken from uspot's radcli dictionary
  (`files/etc/radcli/dictionary.chillispot`, Phase 2 cache) and match CoovaChilli's
  `doc/dictionary.coovachilli`; `ChilliSpot-Session-State` 15 and `ChilliSpot-VLAN-Id` 24 come from the
  CoovaChilli file. FreeRADIUS 3.x cannot alias names and a duplicate `VENDOR` number changes how vendor
  14559 is *decoded*, so no `CoovaChilli-*` names exist; adapters use `ChilliSpot-*` for both NAS types.
- TIP vendor `0x0000e608` request TLV: **REQUIRES DEVICE TEST, not defined** (DT-03 dumps the bytes).
- `ECLOUD-*` attributes 3000-3009 are internal (never on the wire) and only exist so rlm_rest can post
  server-side facts (`ECLOUD-Packet-Src-IP-Address`, `ECLOUD-Client-Shortname`, outcome fields;
  3008/3009 `ECLOUD-EAP-Inner` / `ECLOUD-Outer-User-Name`, set only by `ecloud-inner`).
- MikroTik (Cycle A): `Mikrotik-Rate-Limit` (vendor 14988, attr 8, string) needs **no** ECLOUD
  addition: the stock `/usr/share/freeradius/dictionary` already has `$INCLUDE dictionary.mikrotik`
  (verified in `freeradius/freeradius-server:3.2.10`, line 261). The aaa-contract suite proves a
  `reply:Mikrotik-Rate-Limit = "2M/10M"` from the API reaches the Access-Accept.

## 5. Smoke verification performed (2026-10-07, Docker Desktop, image 3.2.10)

| Check | Result |
|---|---|
| `docker compose ... build freeradius` incl. `freeradius -C` with placeholders | OK, `Loaded virtual server status / ecloud` |
| `up -d freeradius`, `logs` | `Ready to process requests`; `docker inspect` health `healthy` |
| `radclient 127.0.0.1:18121 status` inside the container | `Received Access-Accept` |
| Access-Request with no API | `Access-Reject`, `Reply-Message = "AAA backend unavailable"`; log `rlm_rest (rest): Connection failed: 7 - Couldn't connect to server`; `freeradius -XC` -> `Configuration appears to be OK` |
| Access-Request from the macOS host to `127.0.0.1:1812` (signed PAP) with a stub API | `Access-Accept`; the server saw source `172.19.0.1` (compose gateway) -> covered by the dev CIDR |
| Stub API returning `200` PAP policy | `Access-Accept` with `Session-Timeout, Idle-Timeout, Acct-Interim-Interval, WISPr-*, ChilliSpot-Max-Total-Octets, ChilliSpot-Max-Total-Gigawords, Class, Reply-Message`; `/post-auth` called with `ECLOUD-Auth-Result=accept`, no `User-Password` |
| Stub `401` with `Reply-Message` | `Access-Reject`, `Reply-Message = "quota exhausted"`, `/post-auth` result `reject` |
| Stub `500` | `Access-Reject`, `Reply-Message = "AAA backend unavailable"`, no `/post-auth` call |
| Wrong PAP credential after a `200` | `Access-Reject` without the welcome text; `/post-auth` carries `Module-Failure-Message = pap: Cleartext password does not match "known good" password` |
| Accounting before the table exists | no Accounting-Response (NAS would retransmit); log shows the PostgreSQL connection attempt (`rlm_sql_postgresql: Connection failed ... password authentication failed for user "ecloud_radius"` while the role was missing) -- the module loads and serves auth regardless (`pool { start = 0 }`) |
| Accounting with `radius.radacct_raw` created from migration 009 (temporary dev role) | Start, Interim, Interim retransmit, Stop, Accounting-On -> 4 rows (duplicate collapsed by `uq_radacct_raw_packet`), output octets folded `(1 << 32) + n`, `UPDATE` as `ecloud_radius` denied; schema and role dropped again afterwards |
| M8 (2026-10-07, cloud dev container, distro FreeRADIUS 3.2.5 with this raddb, PostgreSQL 16 migrated to 014; the 3.2.10 image is exercised by the CI `radius-contract` job) | `freeradius -C` OK; Accounting Start -> `Accounting-Response`; identical retransmit -> `Accounting-Response` (was: none) and still one row; row has `nasipaddress = 192.0.2.10` (packet attribute) and `packet_src_ip = 127.0.0.1` (authenticated source) |

## 6. Open items / dependencies

1. **`ecloud_radius` role is not provisioned in the dev stack.** `packages/db/migrations/010` only grants
   if the role exists and migrations run as `ecloud_platform` (NOCREATEROLE), so the role must come from
   `infra/compose/postgres-init/01_roles.sql` (dev) / the deployment (prod). Until then accounting INSERTs
   fail (auth is unaffected). Proposed addition to `01_roles.sql` (A6/A5 to confirm):
   `CREATE ROLE ecloud_radius LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'radius_password';`
   with `\getenv radius_password RADIUS_SQL_PASSWORD` and `GRANT CONNECT ON DATABASE :"DBNAME" TO ecloud_radius;`.
2. ~~`radius.radacct_raw` has no column for the UDP source address.~~ Done (M8): migration 014 adds
   `packet_src_ip`, written by `queries.conf` from `Packet-Src-IP(v6)-Address`; the drainer resolves the
   NAS / tenant from it only. `nasipaddress` / `nasidentifier` stay NAS-supplied display fields.
3. RadSec listeners, `read_clients`, `radius.radpostauth_raw` and the `linelog` audit lines are outside
   this milestone. 802.1X: opt-in since Cycle A (§7); the production EAP certificate / CA is
   **REQUIRES_CLARIFICATION**.
4. `-X` must never be used in production (config dump includes secrets); use
   `radmin debug condition` per AAA §9.

## 7. 802.1X / EAP-TTLS (Cycle A, D-044) -- opt-in

| Item | Value |
|---|---|
| Enable | `RADIUS_EAP_ENABLED=1`; the entrypoint then links `mods-available/eap` and `sites-available/ecloud-inner` (and unlinks them otherwise, also after a restart). The container starts as **root only for this step**: `mods-enabled/` stays root-owned, and the entrypoint drops to `freerad` (`setpriv --reuid/--regid freerad --init-groups --no-new-privs --bounding-set=-all`) before `freeradius` starts; verified: radiusd runs as uid 101 with no effective capabilities. Certificate readability is checked as `freerad` |
| Certificates | mounted read-only at `RADIUS_EAP_CERT_DIR` (default `/etc/freeradius/eap-certs`): `server.pem`, `server.key`, `ca.pem`; optional `RADIUS_EAP_KEY_PASSWORD` / `_FILE`. Missing / unreadable files stop the container with a message naming the file. **Never in the image or the repository.** Production certificate / CA: **REQUIRES_CLARIFICATION**. Dev: `bash scripts/dev-eap-certs.sh` (throw-away CA + server cert under `var/freeradius-eap-certs/`, 30 days, CA key discarded) |
| Methods | EAP-TTLS with inner PAP only (TLS 1.2). The image's stock test certificates in `/etc/freeradius/certs` are expired (2026-08-02) and root-only, so they are not usable and not used |
| Decision | inner request -> the same `rest` authorize call, with `ECLOUD-EAP-Inner = ttls`, `ECLOUD-Outer-User-Name`; `Calling-Station-Id`, `Called-Station-Id`, `NAS-Identifier`, `NAS-IP-Address`, `NAS-Port-Id`, `Acct-Session-Id` are deleted from the tunnel and re-copied from the outer packet (a supplicant cannot spoof them); `ECLOUD-Packet-*` / `ECLOUD-Client-Shortname` come from the outer packet |
| Reply | inner reply promoted to the outer Access-Accept via `outer.session-state` (Session-Timeout, Tunnel-*, Class, ...); outer post-auth notifies `/internal/aaa/post-auth` with `ECLOUD-Reply-Class` |
| Build check | the Dockerfile runs `freeradius -C` twice: default config, and with EAP linked + a throw-away self-signed cert created and deleted in the same `RUN` |

Verified locally 2026-10-10 (not in CI; `eapol_test` is not in the image): a throw-away container
`ubuntu:24.04` + `eapoltest` ran EAP-TTLS/PAP (`identity=alice`, `anonymous_identity=anonymous`,
`-M 02:11:22:33:44:55`) against this image with `RADIUS_EAP_ENABLED=1` and a dev certificate:
`EAP-SUCCESS`; the AAA stub received exactly one `/authorize` for the inner identity with
`Calling-Station-Id = 02-11-22-33-44-55`, `ECLOUD-EAP-Inner = ttls`, `ECLOUD-Outer-User-Name =
anonymous`, and the outer Access-Accept carried `Session-Timeout`, `Tunnel-Type`,
`Tunnel-Medium-Type`, `Tunnel-Private-Group-Id` and `Class`. Device behaviour of any vendor NAS
remains REQUIRES_DEVICE_TEST.

---

# Appendix: contract (identical copy of docs/contracts/aaa-authorize.md)


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
