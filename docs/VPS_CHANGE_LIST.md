# VPS change list — DRAFT for owner approval (D-031)

**Status: DRAFT. Nothing below has been applied.** Prepared in Phase 10 cycle P10-A from
repository files only; no SSH session, no host command, no DNS/Caddy/EZEAP/controller action was
made. Host facts are from REMOTE_ENVIRONMENT.md (read-only discovery, 2026-10-07) and may have
drifted: step 0 re-checks them. Approval is per change id; each id can be approved, deferred or
rejected independently unless a dependency is listed.

Host: `vps` — OVH KVM, Ubuntu 24.04.4, 2 vCPU / 3.7 GiB / no swap, `ens3` 57.129.69.122/32
(DHCP) + 2001:41d0:701:1100::21c9/128, Docker CE 29.8.0, Caddy 2.11.4 native, ufw inactive,
no fail2ban, only accounts `root` + `ubuntu`. Production workload to protect: **q-mira.com**
(Caddy → 127.0.0.1:8088 `qmira-web`), plus the root cron `cf-dns-failover` (Q19, untouched).

## 0. Preconditions (no approval needed beyond D-031 access; PRE-3 includes taking the OVH snapshot; PRE-6 writes host files and is therefore approved together with VPS-FW-1)

| Id | Check | Why |
|---|---|---|
| PRE-1 | OVH KVM console login works (Q17) | recovery path if SSH or the firewall goes wrong |
| PRE-2 | second operator SSH key registered and tested (Q22) | `AllowUsers` / firewall changes must never depend on one key |
| PRE-3 | OVH snapshot of the VPS taken and listed | whole-host rollback |
| PRE-4 | re-run discovery: `ss -lntup`, `nft list ruleset`, `docker ps`, `cat /etc/caddy/Caddyfile`, `systemctl list-timers`, `df -h`, `free -m` | detect drift since 2026-10-07 |
| PRE-5 | baseline `curl -sI https://q-mira.com` and `https://www.q-mira.com` | verification reference for every step |
| PRE-6 | operator source addresses recorded on the host: `apply-nftables.sh admins <IPs>` (→ `/etc/nftables.d/zz-ecloud-admins.nft`, never committed) **and** the same addresses in fail2ban `ignoreip` (replace the `192.0.2.0/24` placeholder) | **required before VPS-FW-1 / VPS-FW-4** (F-P10R-4): allow-listed sources bypass the per-source SSH meter, which spoofed SYNs from a known operator address could otherwise exhaust, and are exempt from the 1-week `recidive` ban; `apply` refuses with an empty list unless `ECLOUD_NO_SSH_ALLOWLIST=1` |

## 1. Packages and reboot

| Id | Change | Commands (summary) | Verify | Rollback |
|---|---|---|---|---|
| PKG-1 | Install `nftables` (present), `fail2ban`, `wireguard-tools`, `sops` + `age` **not** on the host (secrets are unsealed on the operator machine / CI runner) | `apt-get install fail2ban wireguard-tools` | `dpkg -l` | `apt-get purge` |
| PKG-2 | Vendor upgrades already pending: docker-ce 29.8.2, containerd 2.3.6, compose 5.6.0, caddy 2.11.7 | `apt-get install --only-upgrade docker-ce containerd.io docker-compose-plugin caddy` | `docker version`, `caddy version`, q-mira 200 | apt pin previous versions (`apt-cache policy`) |
| PKG-3 | Reboot into the pending kernel 6.8.0-142 (since 2026-09-25); q-mira.com down for the reboot (~1 min) | maintenance window, `systemctl reboot` | `uname -r`, `modinfo wireguard`, q-mira 200, containers up | boot previous kernel from GRUB via KVM console |
| PKG-4 | 2 GiB swapfile, `vm.swappiness=10` (DEPLOYMENT_ARCHITECTURE §2.2) | `fallocate`, `mkswap`, fstab, sysctl drop-in | `swapon --show` | `swapoff`, remove fstab line |

## 2. SSH (SECURITY_ARCHITECTURE §2.2, F-38/F-39)

| Id | Change | File | Procedure | Rollback |
|---|---|---|---|---|
| VPS-SSH-1 | `PermitRootLogin no`, keys only, `AuthenticationMethods publickey`, `AllowUsers ubuntu` (+ D-024 deploy identity once created), `X11Forwarding no`, `AllowAgentForwarding no`, `AllowTcpForwarding local` (VS Code), `MaxAuthTries 3`, `LoginGraceTime 30`, `ClientAliveInterval 300`, `LogLevel VERBOSE` | `infra/vps/ssh/sshd_config.d/10-ecloud-hardening.conf` | `infra/vps/scripts/apply-sshd.sh apply` (`sshd -t`, `reload` keeps sessions, 10-min dead-man), new-terminal login, `confirm` | `apply-sshd.sh rollback` (or the dead-man fires) |

Locally validated: `sshd -t` and effective `sshd -T` on Ubuntu 24.04 OpenSSH 9.6p1, including a
later `50-cloud-init.conf` that tries to re-enable passwords and X11 (first value wins).

## 3. Firewall (SECURITY_ARCHITECTURE §2.3–2.5, D-032)

| Id | Change | File | Procedure | Rollback |
|---|---|---|---|---|
| VPS-FW-1 | `table inet ecloud`: input policy drop; lo, established, ICMP/ICMPv6, DHCPv4 renewals on `ens3`; **SSH first** (operator allow-list set, then per-source 6/min burst 10 — not the global limiter of the outline, which attackers could exhaust); 80/443 tcp, 443 udp (Caddy HTTP/3); 51820 udp; from `wg0` only udp 1812/1813 to 100.100.0.1; logged drop. Forward (priority −10): no `wg0`↔`wg0`, no `wg0`→`ens3`, no NEW `ens3`→`wg0`, MSS clamp | `infra/vps/nftables/ecloud.nft`, `nftables.conf` | `apply-nftables.sh stage` → `apply` (dead-man 10 min deletes **only** `table inet ecloud`) → new SSH session + q-mira check → `confirm` (persists via `/etc/nftables.conf` that includes `/etc/nftables.d/*.nft` and has **no `flush ruleset`**) | `apply-nftables.sh rollback` |
| VPS-FW-2 | DOCKER-USER: replies pass; `wg0` → only NEW udp 1812/1813 whose original destination is 100.100.0.1; everything else from `wg0` dropped (logged); every NEW connection from `ens3` into a container dropped; IPv6 parity | `infra/vps/nftables/docker-user.sh`, `ecloud-docker-user.service` | install unit, `systemctl enable --now ecloud-docker-user`; q-mira check (its publish is loopback, unaffected) | `docker-user.sh rollback`; disable unit |
| VPS-FW-3 | ufw stays **disabled** (its saved rules lack SSH 22 — lock-out hazard, REMOTE_ENVIRONMENT §4); optionally `apt purge ufw` | — | `ufw status` = inactive | — |
| VPS-FW-4 | fail2ban: `sshd` (5/10 min, 1 h, incremental to 1 w), `recidive`, `ecloud-admin` (10/15 min, 30 min), `ecloud-portal` (30/10 min, 15 min); bans via fail2ban's own nftables table; operator IPs in `ignoreip` | `infra/vps/fail2ban/` | install, edit `ignoreip` on the host, start `sshd` + `recidive` first; `ecloud-*` jails after VPS-APP-1 runs (they read journald by container name) | `systemctl disable --now fail2ban` |

Locally validated: `nft -c` on nftables 1.0.9 (Ubuntu 24.04) and 1.1.3; apply twice is
idempotent; a foreign NAT table (Docker stand-in) survives apply and rollback; DOCKER-USER
script idempotent; `fail2ban-regex` matches the api/portal events and nothing else. **Not
verifiable locally:** real packet paths through Docker's DNAT on the host, OVH edge behaviour
(Q17), DHCP renewal timing — covered by the dead-man procedure.

## 4. WireGuard (D-032, WIREGUARD_ARCHITECTURE.md)

| Id | Change | Notes |
|---|---|---|
| VPS-WG-1 | Host-native `wg0` hub 100.100.0.1/16 (systemd-networkd `.netdev`/`.network`), `ListenPort=51820`, key `/etc/systemd/network/wg0.key` root 0600 generated **on the host**, never in git/DB | subject to route/address collision check (D-032); no peers until a site is onboarded; peers per WIREGUARD_ARCHITECTURE (AllowedIPs /32, PSK) |
| VPS-WG-2 | `net.ipv4.ip_forward` stays 1 (Docker), IPv6 forwarding stays 0, `rp_filter=2` unchanged | forward isolation is VPS-FW-1 |
| VPS-WG-3 | Docker ordered after `wg0` is configured: `/etc/systemd/system/docker.service.d/10-ecloud-wg0.conf` (`Wants=`/`After=` `systemd-networkd-wait-online@wg0:no-carrier.service`), `daemon-reload` only | F-P10R-3: freeradius publishes `100.100.0.1:1812-1813/udp`, which cannot bind before `wg0` exists, so after a reboot it would fail to start. `Wants=` keeps Docker/q-mira.com starting even if `wg0` is broken (delayed by the wait-online timeout only). REQUIRES_HOST_TEST: confirm `networkctl status wg0` reaches the state. Rollback: delete the drop-in + `daemon-reload` |

Not authored as files in P10-A (WireGuard files belong to the WireGuard workstream); listed so
the owner sees the full set of host changes.

## 5. Docker networks, volumes, ports and containers

| Id | Change | File |
|---|---|---|
| VPS-APP-1 | Compose project `ecloud` in `/opt/ecloud` (D-030): `postgres:16-alpine` (digest-pinned, **no ports**, `max_connections=60`, 640 MiB), one-shot `db-roles` (idempotent roles + `ALTER ROLE … PASSWORD` from secret files), `redis:7-alpine` (requirepass from a secret file, no ports, AOF, 128 MiB), `migrate` (profile), `api` 127.0.0.1:3000, `portal` 127.0.0.1:3002, `worker` (no ports), `freeradius` on **100.100.0.1:1812-1813/udp only** (profile `radius`, blocked by F-P10-07); all app containers `read_only`, `cap_drop: ALL`, `no-new-privileges`, memory/cpu/pids limits (DEPLOYMENT_ARCHITECTURE §2.2), api/portal log to journald | `infra/vps/compose/compose.pilot.yaml`, `db-roles.sql` |
| VPS-APP-2 | Network `ecloud_internal` 172.28.0.0/16 with bridge name `br-ecloud` (Q16: verify no collision) | same |
| VPS-APP-3 | Volumes `pg_data`, `redis_data`, `storage_data` (D-026: local storage only for non-critical branding assets, included in backups) | same |
| VPS-APP-4 | Images built in CI for linux/amd64 (`images` job: Trivy gate + SBOM), pushed to the registry the owner chooses (open question), tagged `:<git-sha>`; base images pinned by digest (`infra/docker/Dockerfile`, `infra/freeradius/Dockerfile`) | `.github/workflows/ci.yml` |
| VPS-APP-5 | Secrets: group `ecloud-secrets` (gid 10001), `/opt/ecloud/secrets` root:10001 0750, files 0440, unsealed from the ops repository with `scripts/secrets/unseal.sh` | docs/SECRETS_MANAGEMENT.md |
| VPS-APP-6 | Docker daemon log rotation (`daemon.json`, restarts Docker → brief q-mira interruption) and journald cap | authored by cycle P10-B (logging drafts); applied in the same window as PKG-3 |
| VPS-APP-7 | Remove leftover `hello-world` containers and build cache (optional) | — |

Published ports after the change: 22/tcp, 80/tcp, 443/tcp+udp (Caddy), 51820/udp (wg0, host);
127.0.0.1: 2019 (Caddy admin, unchanged), 8088 (q-mira, unchanged), 3000 (api), 3002 (portal);
100.100.0.1: 1812–1813/udp (freeradius, once unblocked). Never: 3001 (api internal), 3003
(worker health), 5432, 6379, 3799.

## 6. Caddy (D-029, D-030)

| Id | Change | File | Procedure | Rollback |
|---|---|---|---|---|
| VPS-CADDY-1 | Append **one** line `import /etc/caddy/sites/*.caddy` to the live Caddyfile (q-mira block byte-for-byte unchanged); add `ezecloud.caddy`: `ezecloud.ezelink.ai` (SPA from `/opt/ecloud/admin`, CSP as admin-nginx.conf, `/api/*` → 127.0.0.1:3000), `api.ezecloud.ezelink.ai` (Bearer only: `Cookie` stripped, cookie-issuing auth paths 404, `Set-Cookie` removed), `portal.ezecloud.ezelink.ai` (→ 127.0.0.1:3002, access log without query strings); all: HSTS/nosniff/XFO defaults, `Server` removed, `/readyz` `/metrics` `/internal` → 404; access logs `/var/log/caddy/*.log` rolled 50 MB, Cookie/Authorization/X-Internal-Token removed | `infra/vps/caddy/sites/ezecloud.caddy` | `apply-caddy.sh apply`: backup → staged copy + import line → `caddy validate` → diff → `systemctl reload caddy` (never restart) → q-mira 200 | `apply-caddy.sh rollback <backup>` |

Locally validated with caddy 2.11.7 (`caddy validate`, `caddy fmt`) against a q-mira stand-in.
Precondition: DNS-1.

## 7. DNS (D-029, D-039) — owner action, not scripted, not authorised yet

| Id | Change |
|---|---|
| DNS-1 | `ezecloud.ezelink.ai`, `api.ezecloud.ezelink.ai`, `portal.ezecloud.ezelink.ai` A → 57.129.69.122 and AAAA → 2001:41d0:701:1100::21c9, **DNS-only** (not proxied; the portal needs real client IPs and RADIUS/WireGuard cannot be proxied). No change to q-mira.com or ezenoc records. |

## 8. PostgreSQL, Redis, FreeRADIUS specifics

| Id | Change |
|---|---|
| VPS-DB-1 | Roles `ecloud_app` (NOBYPASSRLS), `ecloud_platform` (BYPASSRLS, migrations/worker), `ecloud_radius` (INSERT-only via migration 010); `REVOKE ALL ON DATABASE ecloud FROM PUBLIC`; `password_encryption=scram-sha-256`; no published port; migrations via the `migrate` one-shot; seed via `node packages/db/dist/cli.js seed` (permission catalogue) |
| VPS-REDIS-1 | `requirepass` from secret file, `protected-mode yes`, `maxmemory 96mb`, `noeviction` (BullMQ must not lose jobs), AOF on |
| VPS-RADIUS-1 | **Blocked** until the `clients.conf` renderer exists (F-P10-07). Then: `require_message_authenticator = yes` per client (already in templates), tunnel-only bind, `RADIUS_CLIENTS_RENDERED=1`, never `-X` in production |

## 9. Backup (D-026) and monitoring

| Id | Change |
|---|---|
| VPS-BK-1 | Nightly encrypted `pg_dump -Fc` + config backup to off-host S3-compatible storage (never only on the VPS) — scripts, restore drill and RTO/RPO by cycle P10-B (`scripts/backup/`, docs/RESTORE_DRILL.md). The age **private** key stays offline; the host holds only the recipient public key |
| VPS-MON-1 | Prometheus-format `/metrics` on the internal listeners (P10-B) are scraped on the Docker network only; Caddy answers `/metrics` with 404 on every public vhost (VPS-CADDY-1, asserted by the behaviour check). **No Prometheus server is part of the pilot compose**: `infra/monitoring/prometheus.yml` is a draft whose `worker:3003` / `portal:3005` targets need `WORKER_HEALTH_HOST=0.0.0.0` and `PORTAL_METRICS_PORT` set first; the pilot alerting is uptime-kuma (health + backup push). Thresholds such as the 384 MiB api limit are hard-coded to the pilot limits |

## 10. Rollback summary

| Scope | Action | Time |
|---|---|---|
| one step | the step's `rollback` sub-command (none touches Docker's tables, q-mira's container or its Caddy block) | < 1 min |
| firewall lock-out | dead-man fires after 10 min; else KVM console → `nft delete table inet ecloud` | ≤ 10 min |
| SSH lock-out | dead-man removes the drop-in; else KVM console | ≤ 10 min |
| application | `IMAGE_TAG=<previous>` + `docker compose up -d` (expand/contract migrations); DB only via restore (P10-B drill) | minutes |
| whole host | restore the PRE-3 OVH snapshot | provider-dependent |

## 11. Open items for the owner

1. Approve/deny each id above (D-031). Proposed order: PRE-* → PKG-3/APP-6 window → VPS-SSH-1 →
   VPS-FW-1 → VPS-FW-2 → VPS-FW-4 → DNS-1 → VPS-CADDY-1 → VPS-WG-* → VPS-APP-* → VPS-BK-1.
   VPS-WG-* now precedes VPS-APP-* (F-P10R-3): `wg0` must exist before the `radius` profile is
   ever started, and VPS-WG-3 must be in place before the first reboot after VPS-APP-1.
2. Container registry and CI deploy identity (D-024) — not created by this change list.
3. Off-host backup target (Q18 / D-026).
4. SSH source allow-list: no longer optional; it is precondition PRE-6 (F-P10R-4). Addresses
   are added on the host, never committed.
