# Phase 1 Discovery Report — Cloud Bandwidth Management Platform

Target: `ssh vps` → `vps-6391e47f` (OVHcloud, Ubuntu 24.04.4 LTS)
Date: 2026-10-07
Mode: READ-ONLY. Nothing was installed, removed, updated, restarted, stopped or modified. No secrets were read or recorded.
Agents: A1 Infrastructure, A2 Network & Enforcement + A8 Security, A3/A4/A5/A6 AAA/Portal/Backend/Database (combined). Orchestrator A0 synthesised.
Full inventory: [REMOTE_ENVIRONMENT.md](REMOTE_ENVIRONMENT.md). Open questions: [QUESTIONS.md](QUESTIONS.md).

---

## 1. Summary of the current remote server

The server is a small, nearly empty OVHcloud VPS (2 vCPU, 3.7 GiB RAM, no swap, 40 GB disk with 31 GB free) running Ubuntu 24.04.4 on a single public dual-stack interface. Its only production workload is the static marketing site `q-mira.com`, served by an nginx container bound to loopback and fronted by a natively installed Caddy 2.11.4 that terminates TLS with automatic Let's Encrypt certificates on ports 80/443. A root cron job runs every minute to perform Cloudflare DNS failover for an external hostname (`ezenoc.ezelink.ai`) and appears to be in a stuck or silent state.

There is no database, no RADIUS/AAA software, no captive portal software, no application runtimes beyond system Python 3.12 (no pip), no monitoring, no mail transport, no backups, and no VPN or overlay network. The host firewall is absent in practice: ufw is installed but inactive, the iptables INPUT policy is ACCEPT with no rules, and there is no brute-force protection despite ~17k failed SSH attempts per week. SSH is key-only with a single operator account that holds passwordless sudo and Docker group membership. A kernel reboot has been pending since 2026-09-25 and the Docker/Caddy vendor packages are behind their repos.

Critically for this project, the host has **no inline network position**: a single `/32` public IP, no LAN leg, no bridge, no tunnel, no traffic shaping. It cannot enforce bandwidth on client traffic itself. Enforcement must happen on remote network devices, none of which are visible from the server.

An empty directory `/home/ubuntu/ezecloud/` was created today, presumably as the project's landing spot.

## 2. Classified findings

### 2.1 Platform and resources

| # | Finding | Classification |
|---|---|---|
| F-01 | Ubuntu 24.04.4 LTS on OVHcloud OpenStack KVM; cloud-init done; UTC; NTP synced; 0 failed units | CONFIRMED |
| F-02 | 2 vCPU, 3.7 GiB RAM (3.1 GiB free), 40 GB disk (31 GB free), idle | CONFIRMED |
| F-03 | No swap on a 3.7 GiB host | EXISTING — REQUIRES MODIFICATION |
| F-04 | Reboot pending since 2026-09-25 (kernel 6.8.0-142, libc6) | EXISTING — REQUIRES MODIFICATION |
| F-05 | 50 upgradable packages incl. Docker 29.8.2, containerd 2.3.6, Compose 5.6.0, Caddy 2.11.7 (vendor repos, not auto-applied) | EXISTING — REQUIRES MODIFICATION |
| F-06 | unattended-upgrades active for security origins | EXISTING — REUSABLE |
| F-07 | OVH-side snapshots/backups and edge firewall | REQUIRES CLARIFICATION |

### 2.2 Networking and enforcement position

| # | Finding | Classification |
|---|---|---|
| F-08 | Single public NIC `ens3`, IPv4 /32 + IPv6 /128; no LAN, VLAN, bridge, tunnel or second IP | CONFIRMED |
| F-09 | Host as inline traffic enforcement point (shaping client traffic, DHCP/DNS to clients, NAT) | UNSUPPORTED (as provisioned) |
| F-10 | Traffic control: fq_codel only; no HTB/policing/per-client classes; `sch_htb` not loaded | MISSING |
| F-11 | Any per-client/per-MAC/session enforcement primitive (ipset/nft sets, policy routing, portal redirect) | MISSING |
| F-12 | VPN/overlay to sites (WireGuard, OpenVPN, Tailscale, etc.) | MISSING |
| F-13 | Site-to-cloud connectivity model, NAS/gateway/AP inventory, vendor, firmware, data path (bridged vs routed) | REQUIRES CLARIFICATION |
| F-14 | Docker bridge 172.17.0.0/16 in use (potential overlap with any site/VPN addressing) | CONFIRMED; overlap REQUIRES CLARIFICATION |

### 2.3 HTTP/HTTPS edge

| # | Finding | Classification |
|---|---|---|
| F-15 | Caddy 2.11.4 native, enabled, owns *:80/*:443 (TCP+UDP), auto Let's Encrypt, admin API loopback-only | EXISTING — REUSABLE |
| F-16 | Caddyfile: single flat file, one vhost (`q-mira.com`), no imports, no access logs; new vhosts require editing a live production config | EXISTING — REQUIRES MODIFICATION |
| F-17 | `q-mira.com` / `www.q-mira.com` production site, certs valid to 2026-12-10 | CONFIRMED (preserve) |
| F-18 | No nginx/apache/haproxy/traefik on host (no port conflicts beyond Caddy) | CONFIRMED |
| F-19 | Target domains for API, admin UI, captive portal; whether they will point at 57.129.69.122 | REQUIRES CLARIFICATION |

### 2.4 Containers and runtimes

| # | Finding | Classification |
|---|---|---|
| F-20 | Docker CE 29.8.0 + Compose plugin 5.5.1 + buildx, healthy daemon, `ubuntu` in docker group | EXISTING — REUSABLE |
| F-21 | No `/etc/docker/daemon.json`: json-file logs unbounded, no live-restore (changing it restarts Docker and briefly interrupts `qmira-web`) | EXISTING — REQUIRES MODIFICATION |
| F-22 | `qmira-web` container (nginx, 127.0.0.1:8088, restart unless-stopped, not compose-managed) | CONFIRMED (preserve; port 8088 reserved) |
| F-23 | Two exited `hello-world` containers, 133 MB build cache | CONFIRMED (cleanup candidate) |
| F-24 | No compose projects, volumes or custom networks | CONFIRMED |
| F-25 | Runtimes: Python 3.12 (no pip), Perl, git only; no Node/Go/Java/PHP/Ruby/gcc | CONFIRMED |

### 2.5 Databases, AAA, captive portal, applications

| # | Finding | Classification |
|---|---|---|
| F-26 | PostgreSQL / MySQL / Redis / MongoDB (native or container), dumps, migrations | MISSING |
| F-27 | FreeRADIUS / radsecproxy / daloRADIUS; UDP 1812/1813/3799/2083 listeners; dictionaries; clients | MISSING |
| F-28 | RADIUS attribute set, VSAs, CoA/Disconnect (RFC 5176) support of any NAS | REQUIRES CLARIFICATION |
| F-29 | Captive portal software (CoovaChilli, nodogsplash, openNDS, hostapd, dnsmasq) and redirect mechanism | MISSING; mechanism REQUIRES CLARIFICATION |
| F-30 | Any backend/API/admin/portal application, git repos, custom systemd units, pm2/supervisor | MISSING |
| F-31 | `/home/ubuntu/ezecloud/` empty dir created 2026-10-07 — intended deployment root? | REQUIRES CLARIFICATION |
| F-32 | Monitoring (Prometheus/Grafana/node_exporter/uptime-kuma/Portainer/Watchtower) | MISSING |
| F-33 | Mail transport (postfix/msmtp) — cron mail discarded | MISSING |
| F-34 | Backups: no tooling, no jobs | MISSING |

### 2.6 Security

| # | Finding | Classification |
|---|---|---|
| F-35 | Host firewall: ufw inactive; INPUT ACCEPT, zero rules (v4 and v6) | MISSING |
| F-36 | Saved ufw rules allow only 80/443 and omit SSH 22; enabling ufw as-is would lock out SSH; `DOCKER-USER` empty so Docker-published 0.0.0.0 ports bypass ufw | EXISTING — REQUIRES MODIFICATION |
| F-37 | fail2ban/crowdsec absent while ~17,200 failed SSH attempts/7 days on v4+v6 | MISSING |
| F-38 | SSH key-only (password and keyboard-interactive disabled), single ssh-rsa key for `ubuntu`, root key file empty | EXISTING — REUSABLE |
| F-39 | sshd hardening gaps: `PermitRootLogin without-password` (inert), X11/TCP forwarding on, no `AllowUsers`, `ClientAliveInterval 0` | EXISTING — REQUIRES MODIFICATION |
| F-40 | Single root-equivalent operator account (NOPASSWD sudo + docker group); no per-person accounts, no 2FA, no auditd | EXISTING — REQUIRES MODIFICATION |
| F-41 | AppArmor enforcing incl. docker-default; no world-writable files; standard SUID set | CONFIRMED |
| F-42 | Secret-bearing files in a user home (`/home/ubuntu/cf-dns-failover.env`, `~/.claude.json`, `.copilot`, `.vscode-server`) | CONFIRMED present; acceptability REQUIRES CLARIFICATION |
| F-43 | root cron `cf-dns-failover.sh` for external `ezenoc.ezelink.ai`: state `both_down_alerted=true`, jq parse errors, empty log; script lives in user-owned dir | EXISTING — REQUIRES CLARIFICATION |
| F-44 | journald uncapped (302 MB, growing toward ~3.8 GB default) | EXISTING — REQUIRES MODIFICATION |
| F-45 | IDS/integrity tooling (auditd, AIDE, rkhunter, Lynis) | MISSING |

## 3. Reusable components

- **Caddy as the single TLS-terminating edge** (F-15). Automatic ACME already proven; new hostnames become additional site blocks with `reverse_proxy 127.0.0.1:<port>`. Requires a careful, validated edit of the live Caddyfile (F-16).
- **Docker Engine + Compose v2** (F-20). Current, healthy, from the vendor repo; the existing production pattern (loopback-published container behind Caddy) is the one to extend.
- **SSH key-only access** (F-38) and **AppArmor** (F-41) as the security baseline.
- **unattended-upgrades** (F-06) for OS security patches.
- **Operational tooling present**: curl, jq, rsync, git, flock, sysstat.
- **Cloudflare API access pattern** exists on the box (cf-dns-failover) — reusable only if the owner confirms the token/zone are in scope (F-43).

## 4. Missing components (greenfield)

Everything in the platform scope must be built or deployed from scratch on this host:

- Database (D-008 open; PostgreSQL is the obvious candidate, none present).
- AAA/RADIUS server (D-004 open; nothing present).
- Captive portal backend and pages.
- Backend/API, admin UI, policy engine, session manager, accounting ingestion.
- Monitoring/alerting, log shipping or at least log caps.
- Backups (database dumps + config), restore drill.
- Host firewall, SSH brute-force protection, audit logging.
- Mail or webhook notification path.
- Swap, Docker log rotation, journald cap, pending reboot and vendor-package upgrades.

## 5. Risks and conflicts

| Severity | Risk | Evidence |
|---|---|---|
| **High (blocking)** | Enforcement point unknown. The server cannot shape or gate traffic itself (F-08–F-11). The entire policy/portal/CoA design depends on devices that are not visible from the server. | A2 report §1, §2, §4d |
| **High** | Enabling ufw blindly would drop SSH (no rule for 22) and Docker would bypass it anyway via `DOCKER-USER`. Any firewall work must be sequenced with explicit SSH allow and Docker-aware rules. | F-36 |
| **High once services land** | No host firewall at all on v4 and v6. Any container published to 0.0.0.0 (Postgres 5432, RADIUS 1812/1813/3799) is instantly internet-exposed. | F-35 |
| **Medium** | Ports 80/443 are owned by host Caddy serving a live site. New HTTP services must be added to the Caddyfile; replacing Caddy with a containerised proxy means downtime and ACME storage migration. | F-15–F-17 |
| **Medium** | 3.7 GiB RAM, no swap, 2 vCPU. Postgres + RADIUS + API + portal + Caddy is feasible but tight; no monitoring to detect pressure. | F-02, F-03 |
| **Medium** | Pending kernel reboot and outdated Docker/Caddy. A reboot interrupts q-mira.com briefly and should precede new deployments. | F-04, F-05 |
| **Medium** | No brute-force protection on a host that will carry authentication services. | F-37 |
| **Medium** | Single root-equivalent account, no audit trail. | F-40, F-45 |
| **Medium** | Unbounded Docker and journald logs; RADIUS accounting and API logs will be chatty. | F-21, F-44 |
| **Medium** | cf-dns-failover cron runs as root every minute, holds a Cloudflare token, appears stuck; it shares the host with the future auth platform and its intent is unknown. | F-43 |
| **Low** | Docker default bridge 172.17.0.0/16 could overlap site/VPN addressing. | F-14 |
| **Low** | No MTA: cron and alert emails vanish silently. | F-33 |
| **Low** | Leftover hello-world containers, open-vm-tools on KVM, 3.6 GB VS Code server in home. | F-23 |

## 6. Questions requiring clarification

See [QUESTIONS.md](QUESTIONS.md) for the full list (Q1–Q22). The architecture-blocking ones are:

1. NAS/gateway/AP inventory: vendor, model, firmware, and whether client traffic is bridged or routed at each site (D-002, D-003).
2. Where bandwidth enforcement is expected to happen and by what mechanism (RADIUS attributes, device API, other) (D-003).
3. Captive portal integration mechanism supported by those devices (D-005).
4. RADIUS attribute set / VSAs and CoA/Disconnect support (D-006).
5. Site-to-cloud connectivity (public internet to 57.129.69.122, VPN, or other) (D-010).
6. Single organisation vs multi-tenant SaaS (D-007).
7. Target domain names for API, admin UI and portal (F-19).
8. Whether this VPS is the intended production host given its size, or a staging host.

## 7. Proposed Phase 2 architecture (based only on verified findings)

**Status: PROPOSAL FOR APPROVAL — NOT IMPLEMENTED.** Everything below reuses what was verified on the host and stops where evidence stops.

### 7.1 Deployment model (D-009 proposal)
- **Keep the native Caddy as the sole edge** on 80/443. Add new site blocks for the project's hostnames (once Q7 answers them), each `reverse_proxy 127.0.0.1:<port>`. Convert the Caddyfile to `import /etc/caddy/sites/*.caddy` only via a validated (`caddy validate`) and reloaded change that preserves the `q-mira.com` block verbatim. Enable access logging for the new vhosts.
- **Application tier as a single Docker Compose project** in an agreed deployment root (Q9: `/home/ubuntu/ezecloud` vs `/opt/ezecloud`), on a dedicated Compose network with a subnet that does not collide with 172.17.0.0/16 or any site addressing (Q14).
- Rationale: Docker + Compose are already installed and current; the host has no application runtimes, so native installs would add many packages to a small box; the loopback-container-behind-Caddy pattern is already proven here (F-20, F-22, F-25).
- Exception: anything requiring host networking or kernel integration (RADIUS CoA sender behind NAT, VPN endpoint) will be decided per answer to Q5 and Q13.

### 7.2 Services (containers)
| Service | Proposal | Exposure | Depends on |
|---|---|---|---|
| Reverse proxy | existing host Caddy | 80/443 public | Q7 domains |
| Database | PostgreSQL (D-008 proposal), named volume, daily `pg_dump` to a backup location | **internal Compose network only**, never published to 0.0.0.0 | — |
| Backend/API + admin UI | language/framework to be chosen in Phase 2 (none constrained by host); one container, published on 127.0.0.1:<port> | via Caddy only | DB |
| Captive portal backend | same codebase or separate container, published on 127.0.0.1:<port>; serves login/success/error/expired/logout pages | via Caddy only | **Q3 mechanism** |
| AAA/RADIUS | FreeRADIUS container with SQL module against PostgreSQL (D-004 proposal). UDP 1812/1813 published on the public IP only after a firewall exists with source restriction to the NAS addresses | public UDP, firewall-restricted | **Q1, Q4, Q5** |
| CoA/Disconnect | not designed until Q4 is answered | — | Q4 |
| Policy engine / session manager / accounting | within the backend, writing to PostgreSQL; translate policy intent only to **verified** device mechanisms | internal | Q1–Q4 |
| Monitoring | minimal: node_exporter + container metrics or uptime-kuma; Caddy access logs; Docker log caps | loopback / via Caddy with auth | — |

### 7.3 Enforcement model (D-003)
The server is **out-of-band**. Verified fact: it has no inline position (F-08, F-09). Therefore the platform can only (a) answer RADIUS with attributes the NAS honours, (b) send CoA/Disconnect if the NAS supports it, or (c) call a device API if one exists. All three are REQUIRES CLARIFICATION. Phase 2 cannot finalise the policy translation layer until Q1–Q4 are answered and, ideally, tested against one real device.

### 7.4 Security model (A8 inputs to Phase 2)
- Host firewall (nftables or ufw with Docker-aware rules) that explicitly allows 22, 80, 443 and later 1812/1813(/3799) from approved NAS sources only; applied in a sequenced change with an SSH allow rule first and a console fallback plan (OVH KVM console: Q10).
- fail2ban (or nft rate-limit) for sshd; later jails for portal and admin login.
- Database and admin API bound to internal networks/loopback only; secrets in `.env` files with 0600 outside git, as per SECURITY.md.
- sshd hardening: `PermitRootLogin no`, `X11Forwarding no`, `AllowUsers`, keepalives. Consider per-person accounts and auditd (Q11).
- TLS via Caddy for every public HTTP endpoint; RADIUS secrets per NAS; RadSec only if NAS support is confirmed.

### 7.5 Host prerequisites before any deployment (all require approval)
1. Resolve cf-dns-failover intent (Q12) — keep/fix/move/remove.
2. Schedule the pending reboot (brief q-mira.com interruption).
3. Upgrade docker-ce, containerd, compose plugin, caddy from vendor repos.
4. Add swap (e.g. 2 GB file or zram) given 3.7 GiB RAM.
5. Create `/etc/docker/daemon.json` with log rotation (restarts Docker; brief qmira-web interruption) and set journald `SystemMaxUse`.
6. Firewall + fail2ban as per 7.4, sequenced to avoid SSH lock-out.
7. Remove the two hello-world containers and build cache (optional cleanup).

### 7.6 Decision register updates proposed (not yet applied)
- D-001 → CONFIRMED: Ubuntu 24.04.4 LTS, OVHcloud KVM VPS, 2 vCPU / 3.7 GiB / 40 GB.
- D-008 → PROPOSED: PostgreSQL in Compose, internal-only.
- D-009 → PROPOSED: containers for the app tier behind existing native Caddy.
- D-002, D-003, D-005, D-006, D-007, D-010 remain REQUIRES_CLARIFICATION (no server-side evidence).

## 8. Stop point

Phase 1 discovery is complete. Phase 2 is **not** implemented. No change has been made to the remote server. Awaiting owner answers to QUESTIONS.md and approval of the Phase 2 proposal and host prerequisites.
