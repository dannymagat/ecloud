# Remote Environment — `vps` (Phase 1 Discovery Inventory)

Discovery date: 2026-10-07 (~05:50–06:05 UTC)
Method: read-only inspection over `ssh vps` with passwordless `sudo -n`. No packages, services, files, firewall rules, containers or configuration were changed. Secret-bearing files are recorded by path and permissions only; contents were never read.

Raw specialist reports (local, outside the repo): `~/.claude/jobs/6ede8b14/tmp/{a1_infra,a2a8_network_security,a5a6a3_services_apps}.md`


---

## 1. Host identity and platform — CONFIRMED

| Item | Value |
|---|---|
| Hostname | `vps-6391e47f` (`vps-6391e47f.vps.ovh.net`) |
| OS | Ubuntu 24.04.4 LTS (Noble Numbat), x86_64 |
| Kernel | `6.8.0-136-generic` running; `6.8.0-142-generic` installed, **reboot pending since 2026-09-25** |
| Virtualisation | KVM, OpenStack Nova (DMI vendor "OpenStack Foundation"), SeaBIOS |
| Provider | OVHcloud (`/etc/cloud/ovhcloud.manifest`, OpenStack datasource, OVH resolver 213.186.33.99, `vps.ovh.net` domain) |
| cloud-init | status `done`, no errors |
| Timezone / NTP | `Etc/UTC`, systemd-timesyncd synchronised |
| Uptime | 35 days (booted 2026-09-01); load average 0.00 |

## 2. Compute, memory, storage — CONFIRMED

| Resource | Value |
|---|---|
| CPU | 2 vCPU (Intel Haswell class) |
| RAM | 3.7 GiB total, ~3.1 GiB available |
| Swap | **none** |
| Disk | single 40 GB virtual disk; `/` 38 GB ext4, 6.9 GB used, 31 GB free; `/boot` 913 MB; `/boot/efi` 106 MB |
| LVM / RAID / extra volumes | none |
| Inodes | 3 % used |
| Largest directories | `/home/ubuntu` 3.7 GB (VS Code server 3.6 GB), `/var/lib` 398 MB, `/var/log` 356 MB (journal 319 MB), `/opt/qmira-site` 1.8 MB, `/srv` empty |

## 3. Networking — CONFIRMED

| Item | Value |
|---|---|
| Interfaces | `ens3` (public, dual-stack), `docker0` 172.17.0.1/16, one veth. **No second NIC, no RFC1918 LAN leg, no bridge/VLAN/tunnel/GRE/VXLAN interfaces.** |
| IPv4 | 57.129.69.122/32 via DHCP (netplan `50-cloud-init.yaml`), gateway 57.129.69.1, MTU 1500 |
| IPv6 | 2001:41d0:701:1100::21c9/128 static, default route via 2001:41d0:701:1100::1 |
| DNS | systemd-resolved stub (127.0.0.53/54) → 213.186.33.99 (OVH); DNSSEC/DoT off |
| Network stack | systemd-networkd + systemd-resolved; NetworkManager not used |
| Kernel forwarding | `net.ipv4.ip_forward=1` (set by Docker; FORWARD policy DROP), `net.ipv6.conf.all.forwarding=0`, `rp_filter=2`, syncookies on |
| Traffic control | `fq_codel` root qdisc only. **No HTB/shaping/policing/per-client classes.** |
| Netfilter | iptables-nft backend; only Docker-managed chains; `xt_recent`, `ip_set` loaded but unused; `sch_htb`, `wireguard`, `tun`, `br_netfilter` not loaded |
| VPN / overlay | WireGuard, OpenVPN, Tailscale, ZeroTier, cloudflared, ngrok, frp: **none** |

### Listening sockets

| Proto | Bind | Port | Process | Exposure |
|---|---|---|---|---|
| tcp | 0.0.0.0, [::] | 22 | sshd (socket-activated) | public |
| tcp | * | 80 | caddy | public |
| tcp | * | 443 | caddy | public |
| udp | * | 443 | caddy (HTTP/3) | public |
| tcp | 127.0.0.1 | 8088 | docker-proxy → `qmira-web` nginx :80 | loopback |
| tcp | 127.0.0.1 | 2019 | caddy admin API | loopback |
| tcp | 127.0.0.1 | 45617 | VS Code remote server (user ubuntu) | loopback |
| tcp/udp | 127.0.0.53/54 | 53 | systemd-resolved stub | loopback |
| udp | ens3 | 68 | DHCP client | n/a |

Free and unused: 1812/1813/3799 UDP (RADIUS/CoA), 1645/1646, 2083 (RadSec), 5432, 3306, 6379, 27017, 3990/3991, 2050, 9090, 3000, 9100.

## 4. Firewall and perimeter

| Item | State | Classification |
|---|---|---|
| ufw | installed 0.36.2, unit enabled, **status inactive** (`ENABLED=no`) | EXISTING — REQUIRES MODIFICATION |
| Saved ufw rules | `/etc/ufw/user.rules` allows only tcp 80,443; **no rule for SSH 22** | EXISTING — REQUIRES MODIFICATION (lock-out hazard if enabled as-is) |
| iptables / nft | `INPUT ACCEPT` with zero rules; `FORWARD DROP` (Docker); ip6tables `INPUT ACCEPT`, `FORWARD ACCEPT`; Docker chains present; `DOCKER-USER` empty | MISSING (host ingress filtering) |
| fail2ban / crowdsec / sshguard | not installed | MISSING |
| Provider-side firewall (OVH edge / security groups / anti-DDoS) | not observable from guest | REQUIRES CLARIFICATION |

## 5. SSH and accounts — CONFIRMED

| Item | Value |
|---|---|
| Shell accounts | `root`, `ubuntu` (uid 1000) only |
| `ubuntu` privileges | `NOPASSWD:ALL` sudo (`/etc/sudoers.d/90-cloud-init-users`), member of `docker` group (root-equivalent) |
| Authorized keys | `ubuntu`: 1 × ssh-rsa (0600). `root`: file exists, **empty** |
| sshd | port 22 on v4+v6; `PasswordAuthentication no`; `KbdInteractiveAuthentication no`; `PubkeyAuthentication yes`; `PermitRootLogin without-password` (inert, root has no key); `MaxAuthTries 6`; `X11Forwarding yes`; `AllowTcpForwarding yes`; no `AllowUsers`; `ClientAliveInterval 0` |
| Logins (7 days) | 23 successful, all publickey for `ubuntu`, from two operator IPs |
| Brute-force noise (7 days) | ~17,200 failed/invalid-user lines in the ssh journal; top 3 sources each 400–825 attempts; `btmp` 12 MB |

## 6. Security posture

| Control | State | Classification |
|---|---|---|
| AppArmor | enabled, 118 profiles, 24 enforcing incl. `docker-default` | CONFIRMED |
| unattended-upgrades | active; security origins only (`noble`, `noble-security`, ESM) | EXISTING — REUSABLE |
| auditd, AIDE, rkhunter, ClamAV, Lynis, osquery, Wazuh | none | MISSING |
| World-writable files/dirs in /opt /srv /var/www /etc /home | none | CONFIRMED |
| SUID/SGID | 13 / 7, all standard | CONFIRMED |
| Ubuntu Pro | client installed, not attached | CONFIRMED |
| Secret-bearing files (paths only) | `/etc/cf-dns-failover.env` (root 0600), `/home/ubuntu/cf-dns-failover.env` (root 0600, duplicate), `~ubuntu/.claude.json` (0600), `~ubuntu/.copilot/`, `~ubuntu/.vscode-server/` | CONFIRMED present, contents not read |

## 7. Installed software and runtimes — CONFIRMED

| Category | Present | Absent |
|---|---|---|
| Reverse proxy / web | Caddy 2.11.4 (native, official apt repo) | nginx (host), apache2, haproxy, traefik, certbot |
| Containers | Docker CE 29.8.0, Compose plugin 5.5.1, buildx 0.37.1, containerd 2.3.5 (official Docker repo) | podman, legacy `docker-compose` |
| Languages | Python 3.12.3 (system, **no pip**), Perl, git 2.43 | Node/npm, Go, Java, PHP, Ruby, gcc/make |
| Databases | `libsqlite3-0` library only | PostgreSQL, MySQL/MariaDB, Redis, MongoDB, sqlite3 CLI |
| AAA / portal | — | FreeRADIUS, radsecproxy, daloRADIUS, CoovaChilli, nodogsplash, openNDS, hostapd, dnsmasq |
| Firewall / IPS | ufw (inactive), nftables, iptables | fail2ban, crowdsec |
| VPN | — | WireGuard, OpenVPN, Tailscale |
| Backup | rsync | restic, borg, rsnapshot, duplicity, rclone |
| Monitoring | sysstat (sar) | Prometheus, Grafana, node_exporter, netdata, uptime-kuma, Portainer, Watchtower |
| Mail | — | postfix, msmtp, exim (cron mail is discarded) |
| Misc | jq, curl, wget, tmux, htop, vim, qemu-guest-agent, open-vm-tools (unneeded on KVM), snapd (no snaps) | |

dpkg count 747; third-party repos: Docker, Caddy only.

## 8. Services, timers, cron — CONFIRMED

- Running services (24): stock Ubuntu plus `caddy`, `containerd`, `docker`, `qemu-guest-agent`, `snapd`, `unattended-upgrades`. **0 failed units.**
- Custom systemd units/timers: **none**. User-level units for `ubuntu`: none.
- Cron: `ubuntu` has none. **root crontab has one job**: `* * * * * /home/ubuntu/cf-dns-failover.sh >> /var/log/cf-dns-failover-cron.log 2>&1` (see §11).
- Timers: stock only (apt-daily, logrotate, fstrim, sysstat, etc.).

## 9. HTTP/HTTPS and TLS

| Item | Value | Classification |
|---|---|---|
| Caddy service | enabled, active since 2026-09-11, `User=caddy`, stock unit, `--config /etc/caddy/Caddyfile`, no `--resume` | EXISTING — REUSABLE |
| Caddyfile | single flat file (151 B), one site block, no imports/snippets/global options, no access logging | EXISTING — REQUIRES MODIFICATION (to add vhosts) |
| Vhosts | `q-mira.com` → `reverse_proxy 127.0.0.1:8088`; `www.q-mira.com` → 301 to apex | CONFIRMED production |
| TLS | Let's Encrypt production via Caddy ACME; certs for both names expire 2026-12-10, auto-renew | EXISTING — REUSABLE |
| Admin API | 127.0.0.1:2019, unauthenticated (default) | CONFIRMED |
| Other web servers | none on host | MISSING (no conflicts) |

## 10. Containers — CONFIRMED

| Container | Image | State | Restart | Ports | Mounts | Managed by |
|---|---|---|---|---|---|---|
| `qmira-web` | `qmira-web:latest` (local build on `nginx:1.27-alpine`, 77 MB) | Up 3 weeks, healthy | unless-stopped | 127.0.0.1:8088→80 | none | `docker run` from `/opt/qmira-site/deploy/deploy.sh` |
| `beautiful_hofstadter` | hello-world | Exited (0) 2026-09-11 | — | — | — | leftover test |
| `blissful_sutherland` | hello-world | Exited (0) 2026-09-11 | — | — | — | leftover test |

- Daemon: no `/etc/docker/daemon.json` (json-file logs **unbounded**, no live-restore, default bridge 172.17.0.0/16). Storage driver overlayfs, cgroup v2.
- Compose projects: **none**. Volumes: **none**. Networks: defaults only. Build cache 133 MB.
- nginx inside `qmira-web` runs as root (unprivileged container, default seccomp/AppArmor).

## 11. Existing applications

### 11a. q-mira.com static site — CONFIRMED (production, preserve)
- Source `/opt/qmira-site` (owner ubuntu, 1.8 MB): static HTML/CSS generated by stdlib-only `build.py`; `deploy/{Dockerfile,nginx.conf,deploy.sh,README.md}`.
- Deployed manually (rsync from a workstation, `sudo bash deploy/deploy.sh`); no git, no CI/CD. Manual copy in `/home/ubuntu/qmira-backup-2026-09-11/`.
- DNS for `q-mira.com`/`www` resolves to this host.

### 11b. cf-dns-failover cron — EXISTING, REQUIRES CLARIFICATION
- Script `/home/ubuntu/cf-dns-failover.sh` (root 0755; a copy also at `/usr/local/bin/cf-dns-failover.sh`), runs every minute as root. Health-checks two origin IPs over HTTPS and flips a Cloudflare A record for `ezenoc.ezelink.ai` (an **external** host, Cloudflare-proxied, not served here).
- Env var names only: `CF_API_TOKEN CF_ZONE_ID RECORD_NAME PRIMARY_IP SECONDARY_IP HEALTH_PATH VERBOSE`.
- State `/var/lib/cf-dns-failover/state`: `fail_count=0`, **`both_down_alerted="true"`**. Cron log shows repeated `jq: parse error` (last 2026-09-14); main log empty since rotation on 2026-10-04.
- Unrelated to the bandwidth platform but shares the host and root privileges.

### 11c. `/home/ubuntu/ezecloud/` — MISSING (placeholder)
- Empty directory, owner ubuntu, created 2026-10-07 05:27 UTC. Presumed landing spot for this project; not confirmed.

### 11d. Nothing else
- No git repositories, no custom systemd units, no app servers (node/gunicorn/uvicorn/java/php-fpm), no pm2/supervisor. `/srv` empty, `/var/www` absent.

## 12. Databases — MISSING
No PostgreSQL, MySQL/MariaDB, Redis or MongoDB, native or containerised. No dumps, migrations or data directories. Port 5432 free.

## 13. RADIUS / AAA / captive portal — MISSING
No FreeRADIUS/radiusd/radsecproxy/daloRADIUS; no `/etc/freeradius` or `/etc/raddb`; nothing listening on 1812/1813/3799/1645/1646/2083. No CoovaChilli, nodogsplash, openNDS, hostapd or dnsmasq. No DHCP server, DNS interception or HTTP-redirect machinery. No vendor (UniFi/Omada/MikroTik/Ruckus/Aruba/Meraki/OpenWrt) configuration anywhere on the host.
NAS/AP/gateway inventory, RADIUS attributes, CoA/Disconnect support, portal redirect mechanism: **REQUIRES CLARIFICATION — zero evidence on the server.**

## 14. Backups, logging, updates

| Item | State | Classification |
|---|---|---|
| Backup tooling / jobs | none; `/var/backups` has only stock dpkg state; OVH snapshots unknown | MISSING |
| journald | no size cap configured; 302 MB on disk (mostly sshd noise) | EXISTING — REQUIRES MODIFICATION |
| Docker logs | json-file, no `max-size`/`max-file` | EXISTING — REQUIRES MODIFICATION |
| rsyslog / logrotate | active, stock, plus drop-in for cf-dns-failover | CONFIRMED |
| Pending reboot | since 2026-09-25 (kernel 142, libc6) | EXISTING — REQUIRES MODIFICATION |
| Upgradable packages | 50, incl. docker-ce 29.8.2, containerd 2.3.6, compose 5.6.0, caddy 2.11.7 (vendor repos, not auto-applied) | EXISTING — REQUIRES MODIFICATION |
| Limits / sysctl | Ubuntu defaults; `DefaultLimitNOFILE=524288`; no custom tuning | CONFIRMED |
