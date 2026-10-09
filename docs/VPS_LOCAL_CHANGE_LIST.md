# vps-local change list — LAN pilot (DRAFT, owner pre-approved 2026-10-09)

**Status: DRAFT. Claude has applied nothing.** The owner pre-approved this list on 2026-10-09
for a same-day LAN go-live. Each id is still run and confirmed one at a time, in the order in §2.
Every root step is a short `ssh -t vps-local 'sudo …'` command run **by the owner**. `-t` is
required because sudo asks for a password. Claude may run only read-only checks (no sudo). Each
script refuses to run without `ECLOUD_APPROVED_CHANGE=<id>` and root, using the shared guard
`infra/vps/scripts/common.sh`.

Host: `vps-local` = `ezeadmin@192.168.203.196:2234`. EZEOS v2.1 appliance (Oracle Linux 8, kernel
4.18), 8 CPU / 15.7 GB / 18 GB swap, `/data` 200 GB xfs. firewalld is active with zones LAN and
WAN. `bond1` (192.168.203.196/24, DHCP) sits in the WAN zone. SELinux is disabled.
**Must not be disturbed:** nginx + php-fpm on 80/443 (EZEOS UI), the :9090 UI, the listener on
22333, sshd on 2234, the system Redis on 127.0.0.1:6379, cloudflared and its metrics listener on
127.0.0.1:20241, chronyd, auditd, tuned, NetworkManager and rsyslog.

**Scope: LAN ONLY** (owner, 2026-10-09). Nothing is exposed to the Internet, and the Cloudflare
tunnel is not used or changed. Public exposure through the tunnel is out of scope for now.

**Already done by the owner (2026-10-09; verify read-only in LCL-PRE-3):** Docker is enabled with
data-root `/data/docker`, json-file log rotation 10m×3 and live-restore. The images
`ecloud-{api,worker,portal,admin,freeradius}:4a445f5` were loaded via `docker save` → scp →
`sudo docker load`.

## 1. Design in one screen

```
LAN client ──https──► 192.168.203.196:8443 ─┐  Docker DNAT (client IP preserved)
hotspot client ─https─► 192.168.203.196:8444 ┤──► ecloud-edge (nginx, TLS, ecloud-admin image)
                                             │       8443: admin SPA + /api/* → api:3000
                                             │       8444: captive portal   → portal:3002
AP 192.168.203.198 ─udp─► 192.168.203.196:1812/1813 ──► freeradius (profile radius; clients from radius-clients)
                     DOCKER-USER: 8443/8444 only from 192.168.203.0/24, 1812/1813 only from .198/32
api, portal, worker, postgres, redis: NOT published (Compose network ecloud_internal / br-ecloud)
```

| Topic | Decision | Why |
|---|---|---|
| Ports | **8443** = admin SPA + same-origin `/api` (HTTPS); **8444** = captive portal (HTTPS); RADIUS **1812/1813 udp**. All bound to `192.168.203.196` only | 80/443/9090/22333/2234/20241 are taken. Separate ports give separate origins, so the admin CSP and the portal headers never mix. Origin checks (`PUBLIC_ADMIN_ORIGIN`) stay exact. No integration-API origin is published on the LAN pilot (no integrations yet); a Bearer-only 8445 can be added later |
| Origins | `PUBLIC_ADMIN_ORIGIN=https://192.168.203.196:8443`, `PUBLIC_API_ORIGIN=https://192.168.203.196:8443`, `PUBLIC_PORTAL_ORIGIN=https://192.168.203.196:8444` (set by `compose.vps-local.yaml` for api, portal, worker and migrate) | `PUBLIC_API_ORIGIN` is not read by any code today; it is set for consistency |
| TLS | internal CA generated **on the host** (`make-lan-tls.sh`). The CA is ECDSA P-256, valid 10 years, **name-constrained** to IP 192.168.203.0/24 (DNS only `ecloud-lan.invalid`). Leaf cert: SAN `IP:192.168.203.196`, 397 days | `__Host-ecloud_sid` / Secure cookies need HTTPS; there is no public CA path for a LAN IP. Because of the name constraint, a browser that trusts this CA trusts it for nothing else |
| Client IP | The edge is the apps' only proxy hop. It **overwrites** `X-Forwarded-For` with `$remote_addr` (the real LAN client, preserved by DNAT) and sets `X-Forwarded-Proto: https`. `TRUST_PROXY_HOPS=1` / `PORTAL_TRUST_PROXY_HOPS=1` are unchanged | No `CF-Connecting-IP` handling and **no app code change** are needed |
| Edge | The `ecloud-admin:<tag>` image (nginx-unprivileged, uid 101, SPA built in) with its local-testing `conf.d` replaced by `infra/vps-local/edge/*`. read-only, `cap_drop: ALL`, 64 MB | One versioned artifact per release; rollback is by `IMAGE_TAG`. Replaces what Caddy did on the old VPS: CSP and security headers, `/readyz` `/metrics` `/internal` and dotfiles return 404, access log without query strings, `X-Powered-By` hidden |
| Cookies across ports | Browsers send cookies regardless of port. On 8444 the edge forwards **only** `__Host-pf` to the portal. The admin session cookie never reaches the portal | validated (test 4) |
| Firewall | **DOCKER-USER** chain (iptables-nft), not firewalld rich rules. **No firewalld change at all** | firewalld 0.9's forward chain starts with `ct status dnat accept`, so zone and rich rules never see a Docker-published port (verified on oraclelinux:8, test 6). Rich rules for 8443/1812 would be no-ops and give a false sense of safety |
| Deploy root | `/opt/ecloud` for config, scripts and secrets (small; same paths as the reviewed compose, backup and secrets files). State lives on `/data`: `/data/docker` (volumes), `/data/ecloud-backups` | `/data` holds the bulk. REQUIRES_CLARIFICATION: does an EZEOS firmware upgrade preserve `/opt` and `/etc`? If not, move `/opt/ecloud` to `/data/ecloud` |

## 2. Apply order for go-live today

**Go-live (G)** items are required today. **Same day (S)** items should follow on the same day.
**Later (L)** items are not needed for go-live.

1. LCL-PRE-1…7 (G): restore point, baseline, read-only checks, **DHCP reservation for
   192.168.203.196**. Docker is already enabled, so `apply-docker.sh stage` runs as a check only
   (LCL-PRE-7). LCL-DOCKER-4 (G): Docker ordered after network-online, so the binds to
   192.168.203.196 succeed at boot
2. LCL-FILES-1 (G): copy the bundle to `/opt/ecloud`, `ecloud.env` (set `IMAGE_TAG` to the rebuilt
   commit), and the `ecloud-compose` wrapper (create-admin.sh needs it)
3. LCL-IMG-1 (G): load and tag the rebuilt images, pull postgres and redis
4. LCL-FW-1 (G): firewall snapshot (read-only)
5. LCL-TLS-1 (G): CA and edge cert, plus one offline copy of the CA key. LCL-APP-1 (G): secrets
6. LCL-APP-2…4 (G): postgres/redis → migrate + seed → `up`. Then verify that the bridge exists:
   `ssh -t vps-local 'sudo docker network inspect ecloud_internal -f "{{index .Options \"com.docker.network.bridge.name\"}}"'`
   must print `br-ecloud`. Between `up` and step 7 the edge is reachable from any address that can
   reach 192.168.203.196, which in practice means the LAN; keep that window short
7. LCL-FW-2 (G): `config` → `apply` → test from a LAN client (8443 answers) and from a non-LAN
   source (must not answer; if no such source exists, check that the `ecloud-docker-drop` counter
   in `sudo iptables -vnL DOCKER-USER` stays 0 for LAN tests). Then run `confirm` **within 10
   minutes, from a separate long-lived ssh session** opened before `apply`
8. LCL-TLS-2 (G): the owner trusts the CA on the Mac. LCL-APP-5 (G): first admin. LCL-APP-6 (G):
   go-live verification
9. LCL-RADIUS-1 (G for the AP test): create the org/site and NAS 192.168.203.198 through the API →
   `ecc --profile radius run --rm radius-clients` → `ecc --profile radius up -d freeradius`. The
   renderer exits 1 and writes nothing while there are zero NAS, so this order is mandatory
10. LCL-BK-1…3 (S), **last**: git + age → install → deploy key + pinned host keys → **first run
    manually** (`systemctl start ecloud-backup.service`, check the journal and the `vps-local`
    branch) → only then `enable --now ecloud-backup.timer`
11. LCL-MON-1 (L), LCL-LOG-1 (L), and the items in §9

Run `check-host.sh baseline` (LCL-PRE-2) **before and after every step**. If the EZEOS UI stops
answering, roll that step back immediately.

## 3. Preconditions

| Id | Check | Command / how | Status |
|---|---|---|---|
| LCL-PRE-1 | Restore point for the appliance | owner's local backup/restore | **satisfied** (owner 2026-10-09) |
| LCL-PRE-2 | Baseline: EZEOS UI `https://127.0.0.1/` and `:9090` answer, and nginx, php-fpm, sshd, firewalld and cloudflared are active. Repeat after every step | after LCL-FILES-1: `ssh vps-local /opt/ecloud/infra/vps-local/scripts/check-host.sh baseline`. Before that, Claude can run read-only: `ssh vps-local "curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/ https://127.0.0.1:9090/"` | owner/Claude |
| LCL-PRE-3 | Read-only state: Docker settings, loaded images, LAN ports free, gid 10001 free, forwarding, routes | commands (a) below | expected: ports free, gid 10001 unused, no route in 172.28.0.0/16 |
| LCL-PRE-4 | sshd on 2234 already hardened? | command (b) below | read-only. No sshd change is part of this list: the appliance owns its sshd config |
| LCL-PRE-5 | DHCP reservation for 192.168.203.196 (bond1 is DHCP) | router setting (owner) | **REQUIRES_CLARIFICATION**. If the address changes, the edge cert, the origins, the Docker binds and the AP config all break. The binds also need the address present when Docker starts (`systemctl is-enabled NetworkManager-wait-online`) |
| LCL-PRE-6 | Docker interplay with the appliance | from LCL-PRE-3: FORWARD policy. Docker sets `DROP` when it had to enable `ip_forward` itself; it also registers a firewalld `docker` zone | REQUIRES_CLARIFICATION: does EZEOS route traffic between its LAN/WAN ports in this deployment? If yes and FORWARD is now DROP, appliance routing is affected (Docker was enabled already: check now) |
| LCL-PRE-7 | Docker host checks, as a check only (Docker is already enabled): `/data` xfs with ftype=1, `dockerd --validate`, ip_forward, FORWARD policy, route collisions | after LCL-FILES-1: `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-PRE-7 /opt/ecloud/infra/vps-local/scripts/apply-docker.sh stage'` (read-only; never run `config`/`enable` on this host now) | owner |
| LCL-DOCKER-4 | Docker waits for network-online (NetworkManager) so the 192.168.203.196 binds succeed at boot. Drop-in `infra/vps-local/systemd/docker.service.d/10-ecloud-network-online.conf` | `ssh -t vps-local 'sudo install -D -m 0644 /opt/ecloud/infra/vps-local/systemd/docker.service.d/10-ecloud-network-online.conf -t /etc/systemd/system/docker.service.d/'` · `ssh -t vps-local 'sudo systemctl daemon-reload'` (no restart needed; it takes effect at the next boot) · check `systemctl is-enabled NetworkManager-wait-online` | rollback: remove the file + `daemon-reload` |

Commands for LCL-PRE-3 (a) and LCL-PRE-4 (b), all read-only:

```
# (a)
ssh -t vps-local 'sudo docker info -f "{{.DockerRootDir}} live-restore={{.LiveRestoreEnabled}}"'
ssh -t vps-local 'sudo docker images | grep ecloud'
ssh vps-local 'ss -lntu | grep -E ":(8443|8444|1812|1813) "; getent group 10001; ip -4 route; sysctl net.ipv4.ip_forward'
ssh -t vps-local 'sudo iptables -S FORWARD | head -3; sudo firewall-cmd --get-active-zones'
# (b)
ssh -t vps-local 'sudo sshd -T | grep -Ei "^(permitrootlogin|passwordauthentication|x11forwarding|maxauthtries) "'
```

## 4. Change items

Notation: `S=/opt/ecloud/infra/vps-local/scripts` (paths are written out in each command).
`ecc` = `/opt/ecloud/bin/ecloud-compose` (compose wrapper with both files and `/opt/ecloud/ecloud.env`).

### 4.1 Files and images

| Id | G/S/L | Change | Owner commands | Verify | Rollback |
|---|---|---|---|---|---|
| LCL-FILES-1 | G | Copy the deploy bundle to `/opt/ecloud`: `infra/vps/compose` (reused unchanged), `infra/vps/scripts/common.sh`, `infra/vps-local`, `scripts/backup`. Install the compose wrapper and `ecloud.env` (no secrets) | Mac, in the repo: `COPYFILE_DISABLE=1 tar -czf /tmp/ecloud-infra.tgz infra/vps/compose infra/vps/scripts/common.sh infra/vps-local scripts/backup` · `scp /tmp/ecloud-infra.tgz vps-local:` · `ssh -t vps-local 'sudo mkdir -p /opt/ecloud/bin && sudo tar --no-same-owner -C /opt/ecloud -xzf ecloud-infra.tgz'` · `ssh -t vps-local 'sudo install -m 0755 /opt/ecloud/infra/vps-local/scripts/ecloud-compose /opt/ecloud/bin/'` · `ssh -t vps-local 'sudo install -m 0644 /opt/ecloud/infra/vps-local/compose/ecloud.env.example /opt/ecloud/ecloud.env'` | `ssh vps-local 'ls /opt/ecloud /opt/ecloud/bin; cat /opt/ecloud/ecloud.env'` (IMAGE_TAG = the rebuilt commit, ECLOUD_LAN_IP=192.168.203.196) | `ssh -t vps-local 'sudo rm -rf /opt/ecloud'` (before any secret or state exists) |
| LCL-IMG-1 | G | Images are **rebuilt after the F-P10-07 fix**; the tag is that new commit (`<tag>`, set as `IMAGE_TAG` in `/opt/ecloud/ecloud.env`; 4a445f5 is superseded). Transfer as below. The compose file expects `ghcr.io/dannymagat/ecloud-<name>:<tag>`; if the images were loaded as `ecloud-<name>:<tag>`, add the registry name as a tag (no pull, no push). Pull `postgres:16-alpine` and `redis:7-alpine` by the pinned digests (outbound HTTPS works) | `ssh -t vps-local 'for i in api worker portal admin freeradius; do sudo docker tag ecloud-$i:<tag> ghcr.io/dannymagat/ecloud-$i:<tag>; done'` · `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose pull postgres redis'` | `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose config --images'` and every listed image exists in `sudo docker images` | `sudo docker rmi <tag>` (tags only) |

Future releases follow the same transfer: build on the Mac with `docker buildx build --platform
linux/amd64 -f infra/docker/Dockerfile --target <api|worker|portal|admin> -t
ghcr.io/dannymagat/ecloud-<name>:<tag> .` (and `infra/freeradius/Dockerfile`), then `docker save
… | gzip > /tmp/ecloud-<tag>.tar.gz` → `scp` → `ssh -t vps-local 'sudo docker load -i
ecloud-<tag>.tar.gz'`. ezeadmin stays out of the `docker` group, which is root-equivalent. GHCR push
(D-024) is optional and later: it needs a token with `write:packages`, which does not exist on the
Mac today.

### 4.2 Secrets and TLS

| Id | G/S/L | Change | Owner commands | Verify | Rollback |
|---|---|---|---|---|---|
| LCL-APP-1 | G | Secrets as files: group `ecloud-secrets` gid 10001, `/opt/ecloud/secrets` root:10001 0750, files 0440 (docs/SECRETS_MANAGEMENT.md). Generated and sealed on the Mac, never on the host. Include `backup-recipients.txt` (age **public** key, see LCL-BK-1) | Mac: `bash scripts/secrets/generate.sh pilot` (→ `var/secrets/pilot`; seal with `seal.sh` into the ops repo) · `scp -rp var/secrets/pilot vps-local:ecloud-secrets` · `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-APP-1 /opt/ecloud/infra/vps-local/scripts/install-secrets.sh /home/ezeadmin/ecloud-secrets'` | the script prints modes/owners (root 10001 0440) and shreds the copy | `ssh -t vps-local 'sudo rm -rf /opt/ecloud/secrets'` (before LCL-APP-2; after it, the DB passwords are bound to the files) |
| LCL-TLS-1 | G | Internal CA (once) and edge certificate in `/opt/ecloud/tls`: `ca/ca.key` root 0600 (directory 0700), `ecloud-lan-ca.crt` 0444, `edge.crt` 0444, `edge.key` root:10001 0440 | `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-TLS-1 /opt/ecloud/infra/vps-local/scripts/make-lan-tls.sh ca'` (prints the CA SHA-256 fingerprint: note it) · offline copy of the CA key (it is **not** in the automatic backups): `ssh -t vps-local 'sudo install -m 0600 -o ezeadmin /opt/ecloud/tls/ca/ca.key /home/ezeadmin/ca.key'` · `scp vps-local:ca.key ~/ecloud-age/ca.key` · `ssh vps-local 'shred -u ca.key'`. On the Mac, encrypt it with age or keep it in the password manager. (Do not redirect `ssh -t … sudo cat` into a file: the pty would mix the sudo prompt and CRLFs into it.) · `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-TLS-1 /opt/ecloud/infra/vps-local/scripts/make-lan-tls.sh leaf 192.168.203.196'` | `ssh vps-local /opt/ecloud/infra/vps-local/scripts/make-lan-tls.sh show` | `ssh -t vps-local 'sudo rm -rf /opt/ecloud/tls'`. Renewal (yearly, `check-host.sh` warns at 30 days): re-run `leaf`, then `ecc restart edge`; the previous pair is kept as `*.prev` |
| LCL-TLS-2 | G | The owner trusts the CA on the Mac | `scp vps-local:/opt/ecloud/tls/ecloud-lan-ca.crt ~/Downloads/` · compare `openssl x509 -in ~/Downloads/ecloud-lan-ca.crt -noout -fingerprint -sha256` with the fingerprint from LCL-TLS-1 · `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/ecloud-lan-ca.crt` | after LCL-APP-4: `curl -sS -o /dev/null -w '%{http_code}\n' https://192.168.203.196:8443/` → 200 without `-k`; Safari/Chrome show no warning. Firefox uses its own store: set `security.enterprise_roots.enabled=true` or import the certificate in Firefox | `sudo security delete-certificate -c "ECLOUD LAN pilot CA (vps-local)" /Library/Keychains/System.keychain` |

### 4.3 Firewall (DOCKER-USER; firewalld is not modified)

| Id | G/S/L | Change | Owner commands | Verify | Rollback |
|---|---|---|---|---|---|
| LCL-FW-1 | G | Snapshot of firewalld, sysctl and FORWARD state (read-only, saved under `/root/ecloud-fw-snapshots`) | `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-FW-1 /opt/ecloud/infra/vps-local/scripts/apply-firewall.sh snapshot'` | file listed | — |
| LCL-FW-2 | G | DOCKER-USER policy: replies pass; NEW tcp 8443/8444 to 192.168.203.196 **only from 192.168.203.0/24**; NEW udp 1812/1813 **only from 192.168.203.198/32** (the lab AP); every other NEW connection into `br-ecloud` from outside is logged (`ecloud-docker-drop`) and dropped, WAN interfaces included. Settings are host-local in `/etc/ecloud/docker-user.env`. Persisted by `ecloud-docker-user.service` (PartOf docker) | `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-FW-2 /opt/ecloud/infra/vps-local/scripts/apply-firewall.sh config 192.168.203.196 192.168.203.0/24 192.168.203.198/32'` · `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-FW-2 /opt/ecloud/infra/vps-local/scripts/apply-firewall.sh apply'` (10-min dead-man resets the chain) · LCL-PRE-2 baseline + LAN and non-LAN tests · from a **separate long-lived session** within 10 min: `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-FW-2 /opt/ecloud/infra/vps-local/scripts/apply-firewall.sh confirm'` (refuses if the dead-man timer is no longer active) | `ssh -t vps-local 'sudo iptables -S DOCKER-USER; systemctl is-enabled ecloud-docker-user'` · `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-FW-1 /opt/ecloud/infra/vps-local/scripts/apply-firewall.sh check'` (only the `docker` zone may differ) · after LCL-APP-4: 8443 from a LAN client = 200 | `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-FW-2 /opt/ecloud/infra/vps-local/scripts/apply-firewall.sh rollback'` |

If hotspot clients sit behind the AP on a subnet other than 192.168.203.0/24, add that subnet to
the web CIDRs with `config … 192.168.203.0/24,<client-subnet> 192.168.203.198/32` and then run
`apply` + `confirm` again: **REQUIRES_CLARIFICATION**. Never use 0.0.0.0/0 or a WAN subnet; the
script refuses 0.0.0.0/0. Web and RADIUS CIDRs must be RFC1918 with prefix ≥ /8; the scripts refuse anything else. Boot ordering: `ecloud-docker-user.service` runs right after `docker.service`. With restart policies, containers can start a few seconds before the rules are re-applied, so a brief LAN-reachable window exists at boot. Closing it would mean creating DOCKER-USER before Docker starts (REQUIRES_HOST_TEST of Docker 26 behaviour), which is not done. SSH (INPUT) is not in this path, so these rules cannot lock out SSH. The
dead-man still guards against cutting off the LAN service. REQUIRES_HOST_TEST: a real packet
from a LAN client hits the DNAT and DOCKER-USER path, and `br-ecloud` lands in the firewalld
`docker` zone so containers can reach the outside (egress, and later CoA).

### 4.4 Application

| Id | G/S/L | Change | Owner commands | Verify | Rollback |
|---|---|---|---|---|---|
| LCL-APP-2 | G | Start postgres + redis (volumes in `/data/docker/volumes`, no ports) | `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose up -d postgres redis'` | `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose ps'`: both healthy | `ecc down` (volumes kept) or `ecc down -v` (destroys data, only before go-live) |
| LCL-APP-3 | G | Roles (the `db-roles` one-shot runs as a dependency), migrations, permission seed | `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose --profile migrate run --rm migrate'` · `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose --profile migrate run --rm migrate node packages/db/dist/cli.js seed'` | `… run --rm migrate node packages/db/dist/cli.js status` shows all applied | pre-go-live: `ecc down -v` and repeat. Afterwards: restore (docs/RESTORE_DRILL.md) |
| LCL-APP-4 | G | api, portal, worker and edge up (freeradius stays off: profile `radius`) | `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose up -d'` | `ecc ps`: all healthy · `ssh vps-local /opt/ecloud/infra/vps-local/scripts/check-host.sh ecloud` | `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose stop api portal worker edge'` |
| LCL-APP-5 | G | First platform super admin. The password is typed without echo and passed on stdin | `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-APP-5 /opt/ecloud/infra/vps-local/scripts/create-admin.sh <email>'` (email: REQUIRES_CLARIFICATION, owner's choice) | login at `https://192.168.203.196:8443/`, MFA enrolment | disable the account in the admin UI |
| LCL-APP-6 | G | Go-live verification from a LAN browser (Mac) | `https://192.168.203.196:8443/` (SPA, login) · `curl -sS https://192.168.203.196:8443/readyz` → 404 · `curl -sS https://192.168.203.196:8444/healthz` → 200 · EZEOS UI baseline unchanged | all green | per-item rollbacks |

Release update or rollback: set `IMAGE_TAG=<tag>` in `/opt/ecloud/ecloud.env`, then run
`ecc --profile migrate run --rm migrate` (migrations are expand/contract) and `ecc up -d`.

### 4.5 Captive portal on the LAN (decision needed before hotspot users, not for admin go-live)

How the code builds the portal URL: the api derives the UAM URL from `PUBLIC_PORTAL_ORIGIN` +
the flavour path (`apps/api/src/internal/portal.ts`, `uamServerUrl`). An admin override
`adapter_config.uam_server_url` must be on the same origin, and **must be https when the origin
is https** (`apps/api/src/portal-admin/routes.ts`). The UAM signature covers that exact URL
(`packages/adapters/src/vendor/uam.ts`), so the AP must be configured with exactly
`https://192.168.203.196:8444/<uam path of the portal type>`. The AP's walled garden must allow
192.168.203.196:8444 (REQUIRES_DEVICE_TEST, separate device step).

| Option | Works for | Change needed |
|---|---|---|
| A. **HTTPS 8444 with the internal CA** (what this list deploys) | lab test devices that trust the CA (the owner's Mac or phone with the CA profile installed) | none. **Real hotspot clients will not trust the CA**: captive-portal assistants (iOS CNA, Android) show a certificate error or fail. Not suitable for real users |
| B. HTTPS with a **publicly trusted certificate** for a public DNS name that resolves to 192.168.203.196 (DNS-only record, certificate via ACME DNS-01) | every client; nothing is exposed (private IP) | owner: DNS record and DNS API token (REQUIRES_CLARIFICATION). Infra: certificate issuance and renewal for the edge. Config: `PUBLIC_PORTAL_ORIGIN=https://<name>:8444`. **No app code change** |
| C. Plain **HTTP** portal on the LAN (e.g. `http://192.168.203.196:8081`) | every client, with cleartext voucher/password on the Wi-Fi | **app code change (APP-CODE-1):** `apps/portal/src/config.ts` refuses `PORTAL_COOKIE_SECURE=false` when `NODE_ENV=production`. It would need an explicit, audited LAN override (the cookie becomes `pf` instead of `__Host-pf`). Edge: a plain-HTTP portal server. Not authored here |

Recommendation: A for today's lab test, then B before any real hotspot user. C only if the owner
accepts cleartext credentials on the LAN.

### 4.6 Backups (same day, after go-live) — D-026, owner decision: GitHub

Design: `scripts/backup/backup.sh` is reused unchanged. It runs nightly and produces
`pg_dump -Fc` + a config tarball, each **age-encrypted to the public key only**, in
`/data/ecloud-backups/<stamp>/` (7 sets kept locally). It then calls
`BACKUP_UPLOAD_COMMAND=/opt/ecloud/bin/upload-github.sh`, which builds **one orphan commit**
holding the newest 7 sets and **force-pushes** it to branch **`vps-local`** of
**github.com/dannymagat/ecloud**:

- The branch has no code history.
- Old sets disappear from the branch on every push, so a clone stays small.
- Files over 95 MB are `split` (`PARTS.txt`; restore with `cat name.part* > name`), which stays
  under GitHub's 100 MB file limit.
- Only `*.age` files that start with the age header, plus `SHA256SUMS` and `manifest.json`, are
  ever pushed. Anything else makes the script refuse.
- The script refuses to push to anything but `vps-local` (allow-list).
- The age private key stays offline with the operator.

| Id | G/S/L | Change | Owner commands | Verify | Rollback |
|---|---|---|---|---|---|
| LCL-BK-1 | S | `git` from the OS repository; `age` as a static linux/amd64 binary in `/usr/local/bin`. Integrity: build it on the Mac from the Go module, which is checked against sum.golang.org, so no EPEL is needed. Owner backup key pair on the Mac (private key offline; the public key goes into `backup-recipients.txt` in the secrets set) | `ssh -t vps-local 'sudo dnf -y install git'` · Mac: `docker run --rm --platform linux/amd64 -e CGO_ENABLED=0 -v /tmp/agebin:/go/bin golang:1.25 go install filippo.io/age/cmd/...@v1.2.1` · `scp /tmp/agebin/age vps-local:` · `ssh -t vps-local 'sudo install -m 0755 age /usr/local/bin/age'` · key pair (Mac): `docker run --rm -v ~/ecloud-age:/k golang:1.25 sh -c 'go install filippo.io/age/cmd/...@v1.2.1 && age-keygen -o /k/backup.key'` → keep `~/ecloud-age/backup.key` offline; its `# public key: age1…` line → `var/secrets/pilot/backup-recipients.txt` before LCL-APP-1 (or install it later with `install-secrets.sh`) | `ssh vps-local 'git --version; /usr/local/bin/age --version'` | `sudo dnf remove git`; `sudo rm /usr/local/bin/age` |
| LCL-BK-2 | S | (Note: `BACKUP_CONFIG_PATHS` excludes `/opt/ecloud/tls/ca`; the CA key has only the offline copy from LCL-TLS-1.)  Install backup.sh, lib.sh and upload-github.sh in `/opt/ecloud/bin`, `backup.env` (0600) and `/etc/ecloud/backup-github.env` (0600), and the systemd service + timer (02:15 UTC) with the drop-in `10-vps-local.conf` (`ReadWritePaths=/data/ecloud-backups`, `AGE_BIN`) | `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-BK-2 /opt/ecloud/infra/vps-local/scripts/setup-backup.sh install'` | the script lists anything missing | `… setup-backup.sh rollback` |
| LCL-BK-3 | S | Write deploy key generated **on the host** (`/root/.ssh/ecloud-backup-deploy`, ed25519, 0600). github.com host keys pinned (fingerprints compared with GitHub's published list, no trust-on-first-use). First run, then enable the timer | `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-BK-3 /opt/ecloud/infra/vps-local/scripts/setup-backup.sh key'` → GitHub: dannymagat/ecloud → Settings → Deploy keys → Add, paste the printed **public** key, tick **Allow write access** · `ssh -t vps-local 'sudo ECLOUD_APPROVED_CHANGE=LCL-BK-3 /opt/ecloud/infra/vps-local/scripts/setup-backup.sh known-hosts'` · `ssh -t vps-local 'sudo systemctl start ecloud-backup.service'` · `ssh -t vps-local 'sudo systemctl enable --now ecloud-backup.timer'` | `ssh -t vps-local 'sudo journalctl -u ecloud-backup -n 20'` ends with `upload-github: vps-local = <sha>`. GitHub shows branch `vps-local` with only `<stamp>/…age` files. Restore drill on the Mac (docs/RESTORE_DRILL.md) with the offline key | disable the timer; delete the deploy key in GitHub; `git push origin --delete vps-local` from the Mac |

**Owner item (risk):** a deploy key with write access can push to **any** branch of
dannymagat/ecloud. The script pushes only `vps-local`, but anyone who compromises the host could
use the key to rewrite code branches. Protect the code branches (branch protection or a ruleset
on `main`: no force-push, require PRs). Later, move backups to a dedicated private repository
with its own key. Also: GitHub is not a backup service. Repository size limits apply, and GitHub
GC timing for pruned sets is not under our control. Q18 (proper object storage) stays open.

### 4.7 Monitoring, logging, RADIUS

| Id | G/S/L | Change | Owner commands | Verify / rollback |
|---|---|---|---|---|
| LCL-MON-1 | L | `check-host.sh ecloud` every 5 min (systemd timer): EZEOS baseline, container health, edge endpoints (`/`, `/healthz` on 8443/8444, `/readyz` = 404), cert expiry < 30 d. Failures are logged with tag `ecloud-check`. Optional uptime-kuma push via `/etc/ecloud/check.env` `CHECK_PUSH_URL` (where uptime-kuma runs: REQUIRES_CLARIFICATION) | `ssh -t vps-local 'sudo install -m 0644 /opt/ecloud/infra/vps-local/systemd/ecloud-check.* /etc/systemd/system/'` · `ssh -t vps-local 'sudo systemctl daemon-reload && sudo systemctl enable --now ecloud-check.timer'` | `journalctl -t ecloud-check` · rollback: `systemctl disable --now ecloud-check.timer` |
| LCL-LOG-1 | L | Optional journald cap (`infra/logging/journald-ecloud.conf`): it caps the **whole appliance journal**, so check the existing EZEOS journald settings first | `ssh vps-local 'ls /etc/systemd/journald.conf.d/; journalctl --disk-usage'` | owner decision |
| LCL-RADIUS-1 | G (AP test) | F-P10-07 is fixed and inherited from the base compose: the one-shot `radius-clients` (api image, user 1000:101, read-only, platform DB role + data key) renders the active NAS into the `radius_clients` volume (`ecloud-nas.conf`, 0640 gid 101). freeradius waits for it, mounts the volume read-only on `/etc/freeradius/clients.d` (nocopy, so the dev client is never seeded) and runs with `RADIUS_CLIENTS_RENDERED=1`. It publishes 1812/1813 udp on 192.168.203.196 only; DOCKER-USER admits only 192.168.203.198. The volume holds NAS secrets, so it is **never backed up** (backups contain only pg_dump + config paths) and is re-rendered from the DB after a restore. Order: (1) in the admin UI/API create the org, the site and the NAS with IP 192.168.203.198 (its RADIUS secret is shown once; configure it on the AP in the separate device step); (2) `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose --profile radius run --rm radius-clients'` (exit 0 = written; 3 = written but some invalid NAS rows skipped, ids in its JSON output; 1/2 = nothing written, e.g. zero NAS); (3) `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose --profile radius up -d freeradius'`. **Operator step after ANY NAS change** (create, IP change, rotate-secret, disable): `ssh -t vps-local 'sudo /opt/ecloud/infra/vps-local/scripts/reload-radius.sh'`. It runs the renderer; on exit 0 or 3 it restarts freeradius (on 3 it also points to the skipped NAS ids and exits 3); on any other exit it does **not** restart, and the previous clients stay. A plain `&&` chain would skip the restart on exit 3. SIGHUP does not reload clients. The source IP is preserved by DNAT, so the AP is seen as .198. CoA/Disconnect (3799) outbound to the AP: REQUIRES_DEVICE_TEST (D-006). Amends D-032 (tunnel-only) for the LAN pilot (D-042) | commands (2), (3) and the NAS-change step in the Change column | verify: `ecc ps` shows freeradius healthy; `ecc logs freeradius` shows client .198 loaded; an Access-Request from the AP gets an answer. Rollback: `ssh -t vps-local 'sudo /opt/ecloud/bin/ecloud-compose stop freeradius'` |

Ports after go-live, on 192.168.203.196 only: 8443/tcp, 8444/tcp (from 192.168.203.0/24), and
1812–1813/udp (from .198, once LCL-RADIUS-1 runs). Never published: 3000, 3001 (api internal), 3002, 3003 (worker
health), 5432, 6379 (ECLOUD Redis; the system Redis is untouched), 3799.

## 5. Rollback summary

| Scope | Action | Time |
|---|---|---|
| one step | that step's rollback (none touches nginx/EZEOS, firewalld zones, sshd, cloudflared or the system Redis) | < 1 min |
| firewall | `apply-firewall.sh rollback` (DOCKER-USER back to `RETURN`); the dead-man does the same after 10 min if `confirm` was not run | < 1 min |
| application | `ecc stop`, or `IMAGE_TAG=<previous>` + `ecc up -d`; DB only via restore | minutes |
| all of ECLOUD | `ecc down` (volumes kept) · disable `ecloud-docker-user`, `ecloud-backup.timer`, `ecloud-check.timer` · `rm -rf /opt/ecloud` (Docker itself was enabled by the owner earlier; disabling it is a separate owner decision) | minutes |
| whole appliance | the owner's local backup/restore (LCL-PRE-1) | owner |

## 6. Differences from the old VPS change list (docs/VPS_CHANGE_LIST.md)

| Area | Old VPS (Ubuntu, public IP) | vps-local (EZEOS/OL8, LAN only) |
|---|---|---|
| Web entry | native Caddy, public 80/443, hostname routing, ACME certs | ECLOUD `edge` container on LAN 8443/8444, internal CA; EZEOS nginx untouched |
| Exposure | Internet (DNS-only A/AAAA) | LAN only, nothing public, no tunnel |
| Host firewall | own `table inet ecloud` (nftables) + DOCKER-USER | no host firewall change (firewalld left as is); DOCKER-USER only, with LAN source allow-lists |
| RADIUS | WireGuard hub 100.100.0.1 only (D-032) | LAN address, only from the AP .198 (D-042); WireGuard deferred |
| api/portal publishes | 127.0.0.1:3000/3002 for Caddy | none (edge reaches them on the Compose network) |
| Packages | apt (fail2ban, wireguard-tools, kernel, swap) | only `git` (dnf) + static `age`; swap already exists; Docker already installed and enabled |
| Backups off-host | S3-compatible via rclone (Q18) | orphan branch `vps-local` of dannymagat/ecloud via deploy key |
| Images | registry pull | `docker save` → scp → `docker load` (GHCR later) |
| Root access | sudo without password | sudo with password → owner runs `ssh -t` one-liners or shipped scripts |

## 7. Items from the old list that no longer apply

- **nftables** (`infra/vps/nftables/ecloud.nft`, `nftables.conf`, VPS-FW-1): EZEOS runs firewalld.
  Loading an extra nft table next to it is not needed, and it would be invisible to the
  appliance's own firewall management.
- **DOCKER-USER for `ens3`/`wg0`** (VPS-FW-2): replaced by `infra/vps-local/firewall/docker-user.sh`.
- **sshd drop-in** (VPS-SSH-1): the appliance owns sshd on 2234. Only the read-only check
  LCL-PRE-4 remains; any hardening is a separate owner decision with EZEOS in mind.
- **Caddy** (VPS-CADDY-1) and **DNS-1**: no Caddy on this host and no public names.
- **Ubuntu packages, kernel reboot, swapfile** (PKG-1…4): not applicable (OL8; 18 GB swap exists).
- **ufw** (VPS-FW-3): not present.
- **fail2ban** (VPS-FW-4): deferred (L). Real LAN client IPs reach the apps, so the `ecloud-*`
  jails would work, but fail2ban needs EPEL on OL8 and bans would have to act on DOCKER-USER, not
  INPUT. Not needed for a LAN pilot.
- **WireGuard** (VPS-WG-1…3): deferred until remote sites exist. It would need a router
  port-forward of UDP 51820.

## 8. Files (all DRAFT, validated locally)

| Path | Target on vps-local | Purpose |
|---|---|---|
| `infra/vps/compose/compose.pilot.yaml`, `db-roles.sql` | `/opt/ecloud/infra/vps/compose/` | **reused unchanged** |
| `infra/vps-local/compose/compose.vps-local.yaml` | `/opt/ecloud/infra/vps-local/compose/` | override: LAN origins, api/portal unpublished (`!reset`), `edge` service, RADIUS on the LAN IP (`!override`) |
| `infra/vps-local/compose/ecloud.env.example` | `/opt/ecloud/ecloud.env` | IMAGE_TAG, registry name, LAN IP, paths (no secrets) |
| `infra/vps-local/edge/ecloud-edge.conf`, `edge/snippets/*.conf` | mounted as `/etc/nginx/conf.d` in `edge` | TLS, headers, CSP, private-path 404, SPA fallback, `/api` proxy, portal cookie allow-list |
| `infra/vps-local/firewall/docker-user.sh`, `ecloud-docker-user.service`, `docker-user.env.example` | `/etc/systemd/system/`, `/etc/ecloud/docker-user.env` | LAN-only DOCKER-USER policy |
| `infra/vps-local/docker/daemon.json` | reference only (Docker already configured by the owner) | data-root, log rotation, `default-address-pools` 172.29.0.0/16. The owner's file additionally has live-restore. Adding the address pool keeps Docker from ever choosing 192.168.x for new networks; applying it needs a Docker restart (L) |
| `infra/vps-local/scripts/apply-firewall.sh` | — | snapshot / config / apply (dead-man) / confirm / rollback / check |
| `infra/vps-local/scripts/apply-docker.sh` | — | stage / config / enable / rollback. Not needed now that Docker is enabled; kept for a rebuild |
| `infra/vps-local/scripts/make-lan-tls.sh` | — | internal CA + leaf |
| `infra/vps-local/scripts/install-secrets.sh`, `create-admin.sh`, `reload-radius.sh`, `ecloud-compose`, `check-host.sh` | — | secrets install, first admin, compose wrapper, read-only checks |
| `infra/vps-local/backup/upload-github.sh`, `backup.env.example`, `backup-github.env.example`, `scripts/setup-backup.sh`, `systemd/ecloud-backup.service.d/10-vps-local.conf` | `/opt/ecloud/bin/`, `/etc/ecloud/`, `/etc/systemd/system/` | GitHub backup branch |
| `infra/vps-local/systemd/ecloud-check.{service,timer}` | `/etc/systemd/system/` | LCL-MON-1 |
| `infra/vps-local/systemd/docker.service.d/10-ecloud-network-online.conf` | `/etc/systemd/system/docker.service.d/` | LCL-DOCKER-4 |
| `infra/vps-local/scripts/validate-local.sh`, `infra/vps-local/test/` | workstation only | local validation |

Local validation (`bash infra/vps-local/scripts/validate-local.sh`, 2026-10-09: **7/7 PASS**):

1. `bash -n` + shellcheck (warnings).
2. `docker compose config -q` with the workstation Compose **and Compose 2.27.0** (the host
   version), plus asserted effective ports and origins.
3. CA + leaf with OL8 openssl 1.1.1k, including refusals: CA overwrite, and an IP outside the
   name constraint.
4. Edge behaviour, with the real built admin SPA on the pinned nginx-unprivileged image
   (read-only, cap_drop ALL), TLS verified against the CA:
   - SPA 200 and fallback; missing asset 404
   - CSP and the other headers present
   - private paths and dotfiles 404 on both ports
   - `/api` proxied with path and query; X-Forwarded-For overwritten (spoof dropped); proto https;
     Host with port
   - `X-Powered-By` hidden; an upstream XFO is not duplicated
   - portal receives only `__Host-pf`
   - http on 8443 → 301 https
5. `dockerd --validate` (26.1).
6. DOCKER-USER on oraclelinux:8 with firewalld 0.9.11 running (nft backend):
   - firewalld's `ct status dnat accept` confirmed
   - apply is idempotent; 0.0.0.0/0, empty and malformed CIDRs refused
   - rules survive `firewall-cmd --reload`; rollback works; guard refuses without approval
7. `upload-github.sh` against a bare repository:
   - one orphan commit; only the newest N sets kept
   - a 3 MB file split at 1 MB and reassembled byte-identical
   - pushing to main, plaintext and non-age `.age` files all refused

**Not verifiable locally (REQUIRES_HOST_TEST):** the real DNAT → DOCKER-USER path on the
appliance, the `docker` zone and container egress, binding to the DHCP address at boot, and the
ownership/mode model of bind-mounted secrets on Linux.

## 9. Open items (REQUIRES_CLARIFICATION / later)

1. DHCP reservation for 192.168.203.196 (LCL-PRE-5).
2. Hotspot client subnet, if it is not 192.168.203.0/24 (LCL-FW-2).
3. Portal certificate path for real hotspot users: option B (public name + DNS-01) or C (needs
   APP-CODE-1) (§4.5).
4. Does EZEOS route between its ports, and does the FORWARD policy now affect it (LCL-PRE-6)?
5. Does an EZEOS upgrade preserve `/opt` and `/etc`? (§1 deploy root)
6. Email of the first platform admin (LCL-APP-5).
7. Branch protection on dannymagat/ecloud code branches, and later a dedicated backup repository
   (LCL-BK-3). Q18 stays open for proper object storage.
8. Where uptime-kuma runs, if push monitoring is wanted (LCL-MON-1).
9. Later: fail2ban, WireGuard, GHCR push + CI deploy identity (D-024), a Bearer-only
   integration-API port, the `default-address-pools` Docker restart, and the journald cap.
10. Image tag of the rebuild after the F-P10-07 fix (`IMAGE_TAG`; 4a445f5 is superseded). The rebuilt api image also carries migration 027 (NAS IP CHECK), applied by LCL-APP-3.
