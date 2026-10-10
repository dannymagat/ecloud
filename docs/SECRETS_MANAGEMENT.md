# Secrets management and rotation runbook (P10-A)

Status: tooling **implemented and tested locally**; nothing has been generated for, copied to or
applied on the VPS (D-031). Sources: SECURITY_ARCHITECTURE.md §9 (pilot stage: 0600 files →
Compose `secrets:` → `/run/secrets/<name>`, `sops` + `age` copy in a private ops repository),
§6.11 (no secrets in images, env or logs), DEPLOYMENT_ARCHITECTURE.md §4.2, D-033.

## 1. Contract

| Rule | How it is enforced |
|---|---|
| No secret in git | `.gitignore` (`.env*`, `var/`, `/secrets/`); `scripts/check-no-secrets.sh` in CI; `generate.sh` refuses any output path inside the repository that is not git-ignored |
| No secret in images | `.dockerignore` excludes `.env*`, `**/secrets`, `*.pem`, `*.key`; Dockerfiles take no secret `ARG`/`ENV` |
| No secret in `docker inspect` / process env | every secret-bearing variable can be given as `<NAME>_FILE=/run/secrets/<name>` (`packages/shared/src/config.ts` `SECRET_FILE_VARIABLES`, `resolveSecretFiles`); the pilot Compose file uses only the `_FILE` form |
| No secret in logs | pino redaction (`packages/shared/src/logger.ts`, extended in P10-A: peppers, MFA tokens/recovery codes, API/private/preshared keys, `User-Password`, `CHAP-Password`); config errors name variables, never values or paths |
| Strong values in production | api/portal refuse dev defaults and values < 32 characters when `NODE_ENV=production`; `validate.sh` checks every file before it is sealed or installed |

`<NAME>_FILE` is accepted for: `DATABASE_URL`, `DATABASE_URL_PLATFORM`, `REDIS_URL`,
`INTERNAL_API_TOKEN`, `INTERNAL_API_TOKEN_PREVIOUS`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`MFA_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY`, `VOUCHER_PEPPER`, `PORTAL_STATE_SECRET`,
`VENDOR_API_SECRET_KEY` (multi-vendor Cycle D, worker only, §4). Setting
both forms, an unreadable file or an empty file stops the process with a `ConfigError`.
FreeRADIUS has its own `*_FILE` resolution (`infra/freeradius/docker-entrypoint.sh`).

## 2. Tooling (`scripts/secrets/`)

| File | Purpose |
|---|---|
| `secrets.manifest` | names, minimum length, kind, consumers and runbook section of the 11 primary secrets (names only) |
| `generate.sh <env> [--out DIR] [--rotate NAME]…` | creates missing secrets (48-byte base64url tokens or 40-char alphanumeric passwords) in `var/secrets/<env>/` (dir 0700, files 0600, no trailing newline); never overwrites unless `--rotate`; re-renders the derived files `database_url`, `database_url_platform`, `redis_url`, `redis_conf`; prints no value |
| `validate.sh <dir>` | modes/owner, presence, length, whitespace, dev/placeholder markers, ≥ 12 distinct characters, no value reused between secrets, derived strings embed the current passwords |
| `seal.sh <dir> <out.enc.yaml>` | validates, then encrypts the primary secrets with `sops` for the age recipients (`SOPS_AGE_RECIPIENTS` or a `.sops.yaml`, template `.sops.yaml.example`); plaintext only ever exists inside the 0700 directory |
| `unseal.sh <in.enc.yaml> <dir> <env>` | decrypts back into a 0700/0600 directory, re-renders derived files, validates |
| `selftest.sh` | generate → validate → idempotent re-run → rotation touches only the rotated secret → negative cases (mode 644, dir 755, dev default, short, reused, missing) → refusal to write into a committable path; runs in CI (`secrets` job) |

Verified locally (2026-10-09): `selftest.sh` OK; a full `seal.sh` → `unseal.sh` round trip with
real `sops 3.9.4` + `age 1.2.1` in a throw-away `alpine:3.22` container (values identical after
the round trip). Neither tool is installed on the workstation or the VPS today.

### Layout per environment

```
ops repository (private, NOT this repo)          host (after D-031 approval)
  .sops.yaml            (age public keys)          /opt/ecloud/secrets/         root:10001 0750
  secrets/pilot.enc.yaml (sops/age)  --unseal-->     <name>                      root:10001 0440
                                                    (gid 10001 = ecloud-secrets; every container
                                                     that needs a file gets it via group_add/user)
```

Why `root:10001 0440` and not 0600: Compose file-based secrets (non-Swarm) are bind mounts, the
container sees the host owner and mode, and the apps run as `node` (uid 1000), FreeRADIUS as
`freerad` (101), Redis as 999. A shared group keeps one ownership rule for all files. The
`db-roles` one-shot runs as `0:10001` with no capabilities. Validated locally with
`infra/vps/compose/compose.pilot.yaml` (postgres + db-roles + redis; Docker Desktop on macOS does
not enforce bind-mount ownership like Linux, so the 0440/gid model itself is **not** verified
until the first host run).

Host install (part of the approved change, never before):
```
sudo groupadd --system --gid 10001 ecloud-secrets
sudo install -d -o root -g 10001 -m 0750 /opt/ecloud/secrets
SOPS_AGE_KEY_FILE=<operator key> bash scripts/secrets/unseal.sh pilot.enc.yaml /root/ecloud-secrets pilot
sudo install -o root -g 10001 -m 0440 /root/ecloud-secrets/* /opt/ecloud/secrets/ && sudo shred -u /root/ecloud-secrets/*
```

## 3. Rotation runbook

General order for every item: (1) `generate.sh <env> --out <dir> --rotate <name>`;
(2) `validate.sh`; (3) `seal.sh` and commit the encrypted file to the ops repository;
(4) install the changed files on the host; (5) recreate exactly the consumers listed;
(6) verify; (7) audit note in the change log. Never print a value; never paste one into a ticket.

| # | Secret | Consumers | Procedure | Impact |
|---|---|---|---|---|
| R1 | `internal_api_token` (`INTERNAL_API_TOKEN`) | api (verifies), portal + freeradius (send) | **Zero-downtime window (P10-A):** put the OLD value into a new secret file `internal_api_token_previous` and set `INTERNAL_API_TOKEN_PREVIOUS_FILE` on the api only; rotate `internal_api_token`; `docker compose up -d --force-recreate api`; then recreate `portal` and `freeradius` (they send the new token); verify `radclient` Status-Server + a portal login; remove `INTERNAL_API_TOKEN_PREVIOUS_FILE`, recreate api, delete the previous file | none with the window. Without it FreeRADIUS gets 401 → Access-Reject (fail closed) for the seconds between recreations |
| R2 | NAS RADIUS secrets (`nas_clients.secret_ref`), UAM secrets (`captive_portals.uam_secret_ref`), controller credentials | NAS devices, FreeRADIUS clients, portal hand-off | API, never files: `POST /api/v1/orgs/{orgId}/nas/{id}/rotate-secret` (`nas:secret:rotate`), `POST …/captive-portals/{id}/rotate-uam-secret` (`captive_portal:secret:rotate`), `POST …/controllers/{id}/rotate-credential`; each returns the new value once, is audited and refused while impersonating (D-027). Configure the device with the new value. `radius_status_secret` (healthcheck client only): rotate file, recreate `freeradius` | per NAS until the device is updated (no dual-secret window yet — finding F-P10-06); production `clients.conf` rendering does not exist yet (F-P10-07) |
| R3 | `portal_state_secret` | portal | rotate, recreate `portal` | in-flight portal flows and CSRF tokens (≤ 15 min) become invalid; subscribers restart from the captive-portal redirect |
| R4 | `mfa_encryption_key` | api (TOTP secret envelope) | **No key ring yet (F-P10-04): do not rotate in place** — every enrolled TOTP secret would become undecryptable. Scheduled rotation is not supported. On suspected exposure: platform super admin resets MFA of every administrator (`POST /api/v1/platform/administrators/{id}/mfa/reset`, D-038: revokes sessions, forces re-enrolment), then rotate, recreate api; administrators re-enrol at next login | all administrators re-enrol TOTP |
| R5 | `data_encryption_key` | api (NAS/UAM/controller `secret_ref` envelopes) | **No key ring yet (F-P10-04): do not rotate in place** — every sealed secret becomes undecryptable. On suspected exposure the sealed device secrets must be treated as exposed anyway: rotate the key, recreate api, then rotate every NAS secret, UAM secret and controller credential through R2 and reconfigure the devices | device AAA fails per NAS until reconfigured |
| R6 | `voucher_pepper` | api (voucher `code_hash` HMAC) | rotate only on exposure; unused vouchers cannot be re-hashed (codes are not stored) → cancel and re-issue open voucher batches after the switch | outstanding vouchers stop working |
| R7 | `ecloud_app_password`, `ecloud_platform_password`, `radius_sql_password`, `redis_password` (+ derived URLs / `redis_conf`) | postgres roles, api, portal, worker, migrate, freeradius, redis | rotate (derived files re-render automatically); `docker compose up db-roles` (re-applies `ALTER ROLE … PASSWORD` from the files, `infra/vps/compose/db-roles.sql`); recreate the consumers (`api portal worker freeradius`); Redis: recreate `redis` together with its clients (BullMQ reconnects; jobs persist in AOF). `postgres_password` (superuser) is only read at first initdb: rotate the file, then `ALTER ROLE ecloud PASSWORD` once via `psql` inside the container | seconds per service; brief queue pause for Redis |
| R8 | Admin sessions | api | Sessions are opaque 256-bit tokens stored as SHA-256 (`admin_sessions.token_hash`); there is **no session signing key** to rotate. Mass invalidation (suspected cookie theft): `UPDATE admin_sessions SET revoked_at = now() WHERE revoked_at IS NULL;` as the platform role, audited in the change log; per account: disable + `mfa/reset` (D-038) | everyone logs in again |
| R9 | age keys (backup + ops) | operators | add the new recipient, re-seal (`seal.sh`), keep the old private key offline for old backups (SECURITY_ARCHITECTURE §9: 2 years) | none |

Cadence (SECURITY_ARCHITECTURE §9): database passwords 180 days, RADIUS/UAM per NAS yearly or on
exposure, everything else on exposure or staff change. Record each rotation (date, secret name,
operator, reason — never the value).

## 4. Derived vendor-API key for the worker (multi-vendor Cycle D, review F4)

The worker's `controllers.inventory` job opens sealed controller-API credentials
(`vendor_api_credentials.secret_ref`, purpose `ecloud:vendor-api:secret:v1`). It must **not**
receive the master `data_encryption_key` (which also opens NAS / UAM secrets). It gets only the
purpose key:

```
vapi1.<base64url(HKDF-SHA-256(data_encryption_key, salt = empty, info = ecloud:vendor-api:secret:v1, 32 bytes))>
```

Derive it at deploy time, from inside the 0700 secrets directory, never on the command line:

```
DATA_ENCRYPTION_KEY_FILE=var/secrets/pilot/data_encryption_key \
  node packages/vendor-api/dist/cli.js derive-key vendor-api > var/secrets/pilot/vendor_api_secret_key
chmod 0600 var/secrets/pilot/vendor_api_secret_key
```

The CLI reads the master key only from `DATA_ENCRYPTION_KEY` / `DATA_ENCRYPTION_KEY_FILE`, refuses
any extra argument, and prints the derived value without a newline. Mount it into the worker only
(`VENDOR_API_SECRET_KEY_FILE=/run/secrets/vendor_api_secret_key`). The worker refuses to run the
inventory when `DATA_ENCRYPTION_KEY[_FILE]` is present in its environment or when the value is not
a `vapi1.` key (`skipped: master_key_present | invalid_vendor_api_key`). Rotation: rotating
`data_encryption_key` (R5) changes the derived key; re-derive and restart the worker in the same
change. The file is derived, so it is listed as a comment in `secrets.manifest` (not generated by
`generate.sh`, not part of `validate.sh`'s reuse check). Outbound inventory is additionally off
unless `WORKER_CONTROLLER_INVENTORY_ENABLED=true`.
