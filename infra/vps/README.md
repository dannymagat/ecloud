# infra/vps — VPS hardening drafts (P10-A)

**DRAFT — NOT APPLIED.** Nothing in this directory has been copied to, run on or tested against
`vps`. Every file is an input to the owner-approved change list `docs/VPS_CHANGE_LIST.md`
(D-031 gate). q-mira.com must stay up during and after every step (D-030).

| Path | Target on vps | Purpose |
|---|---|---|
| `nftables/ecloud.nft` | `/etc/nftables.d/ecloud.nft` | host firewall `table inet ecloud`: SSH first with per-source rate limit, 80/443 tcp + 443 udp, 51820/udp, RADIUS only from `wg0` to `100.100.0.1`, IPv4/IPv6 parity, overlay isolation in `forward` |
| `nftables/nftables.conf` | `/etc/nftables.conf` | replaces the stock file **without `flush ruleset`** (it would wipe Docker's NAT rules on every reload) |
| `nftables/docker-user.sh` + `ecloud-docker-user.service` | `/opt/ecloud/infra/vps/nftables/`, `/etc/systemd/system/` | DOCKER-USER policy: replies pass, `wg0` → only RADIUS to the hub address, no NEW connection from `ens3` into any container |
| `fail2ban/jail.d/ecloud.local`, `fail2ban/filter.d/*.conf` | `/etc/fail2ban/…` | `sshd`, `recidive`, `ecloud-admin`, `ecloud-portal` (journald, container name match) |
| `ssh/sshd_config.d/10-ecloud-hardening.conf` | `/etc/ssh/sshd_config.d/` | `PermitRootLogin no`, keys only, `AllowUsers ubuntu`, `X11Forwarding no`, `MaxAuthTries 3`, `ClientAliveInterval 300` |
| `caddy/sites/ezecloud.caddy` | `/etc/caddy/sites/ezecloud.caddy` | `ezecloud.` / `api.` / `portal.ezecloud.ezelink.ai` with security headers, private paths (`/readyz`, `/metrics`, `/internal`) answered 404 on all three vhosts (a `handle` block, asserted by the behaviour check), cookies never accepted on `api.`, portal access log without query strings |
| `compose/compose.pilot.yaml`, `compose/db-roles.sql` | `/opt/ecloud/` | pilot Compose project: secrets as files only, loopback publishes, RADIUS on `100.100.0.1`, `br-ecloud` bridge, memory/pids limits, journald logging for api/portal |
| `systemd/docker.service.d/10-ecloud-wg0.conf` | `/etc/systemd/system/docker.service.d/` | VPS-WG-3: Docker starts after `wg0` is configured, so the `100.100.0.1` RADIUS publish can bind after a reboot |
| `scripts/apply-*.sh` | run from `/opt/ecloud/infra/vps/scripts` | SSH-safe apply with dead-man rollback; refuse to run without `ECLOUD_APPROVED_CHANGE` and root |
| `scripts/validate-local.sh`, `test/` | workstation / CI only | container-based syntax and behaviour checks |

## Local validation (no host changes)

```
bash infra/vps/scripts/validate-local.sh
ECLOUD_SECRETS_DIR=$PWD/var/secrets/pilot IMAGE_TAG=x \
  docker compose -f infra/vps/compose/compose.pilot.yaml --profile migrate --profile radius config -q
```

Every check runs in a throw-away container with its own network namespace: `nft -c` + apply /
re-apply / rollback with a foreign (Docker stand-in) table that must survive, on Ubuntu 24.04's
nftables 1.0.9 (the VPS version); DOCKER-USER idempotency (iptables-nft); `caddy validate` +
`caddy fmt` (caddy 2.11; the VPS runs 2.11.4) plus a Caddy behaviour check (the real site file served
over HTTP: private paths 404 on every vhost, SPA 200); `sshd -t` and the effective `sshd -T` settings on
Ubuntu 24.04's OpenSSH 9.6p1 with a competing later drop-in; `fail2ban-regex` of both filters
against `test/sample-auth-events.log` (lines in the exact format the api/portal emit, asserted by
unit tests). Results of the last run: `docs/SECURITY_REVIEW_P10.md` §6.

## Apply order (only after owner approval; details in docs/VPS_CHANGE_LIST.md)

1. Preconditions: OVH KVM console works (Q17); a second operator key is registered; a fresh
   OVH snapshot exists; `curl -sI https://q-mira.com` baseline recorded; operator addresses
   written with `apply-nftables.sh admins <IPs>` (PRE-6, required: `apply` refuses without it).
2. sshd drop-in — `apply-sshd.sh apply`, log in from a **new** terminal, `apply-sshd.sh confirm`.
3. nftables — `apply-nftables.sh stage`, then `apply` (dead-man: deletes only `table inet
   ecloud` after 10 min), new SSH session + q-mira check, `confirm` (refuses if the dead-man
   already fired).
4. DOCKER-USER — install the unit, `systemctl enable --now ecloud-docker-user`, check q-mira.
5. fail2ban — `apt install fail2ban`, real operator IPs into `ignoreip`, start with `sshd` +
   `recidive`; enable the `ecloud-*` jails only once api/portal log to journald.
6. Caddy — `apply-caddy.sh apply` (D-030: backup → append one import line → validate **as the
   caddy user** → reload → verify q-mira.com; a failed reload/verify restores the backup
   automatically) after DNS for the three names exists (D-029).
7. WireGuard (VPS-WG-*) including the Docker-after-`wg0` drop-in, before any `radius` profile start.
8. Reboot test (pending kernel since 2026-09-25): rules, jails and containers come back.

Rollback for each step is the matching `rollback` sub-command; none of them touches Docker's
tables, the q-mira container or the existing Caddy site block.
