# AAA Deployment Guide — EZECLOUD / EZECONTROL
Version 1.0  |  2026-10-12

---

## 1. Prerequisites

  Software:
    Docker 24+, Docker Compose v2 plugin
    PostgreSQL 16 (managed by ecloud-postgres container)
    FreeRADIUS 3.2 (managed by ecloud-freeradius container)
    Redis 7 (managed by ecloud-redis container)

  Required environment variables in /opt/ecloud/ecloud.env:
    ECLOUD_LAN_IP           Internal IP of the EZECLOUD host (e.g. 192.168.203.196)
    ECLOUD_FR_INTERNAL_IP   IP FreeRADIUS container binds to (default: same as LAN_IP)
    RADIUS_SHARED_SECRET    Default NAS secret (envelope-encrypted, set via secrets store)
    RADIUS_LISTEN_IP        0.0.0.0 or a specific interface IP
    RADIUS_LISTEN_PORT      1812 (auth), 1813 (acct)
    ECLOUD_COA_ENABLED      false (default) — set true ONLY after lab CoA testing complete
    RADIUS_EAP_ENABLED      false (default) — set true only if EAP-TTLS certs are in place
    PUBLIC_ADMIN_ORIGIN     https://<your-admin-domain> (for CSRF protection)
    PUBLIC_API_ORIGIN       https://<your-api-domain>
    PUBLIC_PORTAL_ORIGIN    https://<your-portal-domain>

---

## 2. Initial stack deployment

  cd /opt/ecloud
  ecloud-compose up -d

  Verify:
    ecloud-compose ps
    Expected: 6 containers UP/Healthy (redis, postgres, edge, api, worker, portal).

  NOTE — `up -d` does NOT start FreeRADIUS.  `freeradius` and `radius-clients` sit behind
  `profiles: ['radius']` (infra/vps/compose/compose.pilot.yaml:266 and :297) and the
  ecloud-compose wrapper sets no COMPOSE_PROFILES
  (infra/vps-local/scripts/ecloud-compose:9-11).  To include them:

    ecloud-compose --profile radius up -d
    Expected: 7 containers, the six above plus freeradius.

  `migrate` is likewise behind `profiles: ['migrate']` (compose.pilot.yaml:157), which is why
  it is run explicitly below.

  Run migrations:
    ecloud-compose --profile migrate run --rm migrate

  Verify FreeRADIUS is ready (Status-Server probe on loopback — the same check the container
  healthcheck uses, infra/freeradius/healthcheck.sh:14):
    ssh vps-local 'docker exec ecloud-freeradius /healthcheck.sh'
    Expected: exit 0.  The probe reads the Status-Server secret from
    RADIUS_STATUS_SECRET_FILE inside the container; no secret is typed on the command line.

---

## 3. NAS registration

  Every NAS must be registered before FreeRADIUS accepts its packets.

  Step 1: Generate a random 32-byte shared secret.
    openssl rand -hex 32

  Step 2: Register via API or admin dashboard.
    POST /v1/platform/sites/<site_id>/nas-clients
    {
      "name": "AP-Building-A",
      "ip": "192.168.1.10",
      "identifier": "ap-building-a",
      "secret": "<generated secret>",
      "adapter_key": "mikrotik-hotspot",
      "coa_supported": false,
      "coa_port": 1700
    }

  Step 3: Restart FreeRADIUS to load the new NAS client.
    ssh vps-local 'ecloud-compose restart freeradius'
    Note: This is a ~3 s interruption. Schedule during low-traffic window.
    (Hot-reload without restart: planned in Phase 2A.)

  Step 4: Verify NAS authentication.
    ssh vps-local 'docker exec ecloud-freeradius radtest \
      <username> <password> 127.0.0.1 0 <shared_secret>'

---

## 4. Deployment mode A — Local RADIUS (recommended for initial deployment)

  Topology:
    NAS <-> FreeRADIUS on same private LAN or VLAN.

  Configuration:
    Set RADIUS_LISTEN_IP to internal interface (e.g. 192.168.203.196).
    Add NAS with IP matching the NAS's source IP as seen by the EZECLOUD host.

  Firewall:
    Allow UDP 1812/1813 FROM NAS IP TO EZECLOUD_LAN_IP.
    Block UDP 1812/1813 from any untrusted network.

  Verify:
    From NAS host: radtest user pass <EZECLOUD_LAN_IP> 0 <shared_secret>
    From external: connection must time out (not rejected — blocked by firewall).

---

## 5. Deployment mode B — Remote NAS over VPN (planned, Phase 3)

  Until RadSec (Phase 3A) is implemented, remote NAS must use a site-to-site VPN.

  Recommended: WireGuard

  Server side (EZECLOUD VPS):
    Install WireGuard: apt install wireguard
    Generate server keypair: wg genkey | tee server.key | wg pubkey > server.pub
    Create /etc/wireguard/wg0.conf:
      [Interface]
      PrivateKey = <server.key>
      Address = 10.99.0.1/24
      ListenPort = 51820
      PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
      PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

      [Peer]
      PublicKey = <nas-peer.pub>
      AllowedIPs = 10.99.0.2/32

    systemctl enable --now wg-quick@wg0

  NAS side:
    Configure WireGuard peer with EZECLOUD VPS public IP and key.
    Set RADIUS server = 10.99.0.1 (VPN tunnel IP).

  EZECLOUD:
    Register NAS with ip = 10.99.0.2 (WireGuard peer IP).
    Allow UDP 51820 inbound in firewall.
    Allow UDP 1812/1813 only from 10.99.0.0/24.

---

## 6. Captive portal integration

  Step 1: Create a captive portal in the dashboard.
    POST /v1/platform/sites/<site_id>/captive-portals
    { "name": "Guest WiFi", "public_slug": "my-guest", "auth_methods": ["password","voucher"] }

  Step 2: Configure NAS to redirect unauthenticated clients to:
    https://<PORTAL_ORIGIN>/portal/<public_slug>

  Step 3: Configure NAS RADIUS server to point to EZECLOUD FreeRADIUS.

  Step 4: Test login flow.
    Browser on captive portal network -> portal URL -> login -> NAS sends Access-Request ->
    FreeRADIUS -> API -> Accept -> NAS grants internet access.

  Supported NAS portal types (see adapter_key):
    mikrotik-hotspot      — MikroTik login page redirect
    coovachilli-uam       — CoovaChilli UAM redirect
    openwifi-uspot-uam    — TIP OpenWiFi uspot UAM
    meraki-splash         — Cisco Meraki splash page
    external-postback     — Any NAS with postback URL support

---

## 7. EAP-TTLS deployment (opt-in)

  Requirements:
    A valid TLS server certificate for FreeRADIUS (self-signed or CA-signed).
    Certificate must be trusted by client supplicants (deploy CA to devices or use public CA).

  Step 1: Generate or obtain a server cert.
    Place in infra/freeradius/certs/:
      server.crt (PEM)
      server.key (PEM, no passphrase)
      ca.crt (PEM)

  Step 2: Set RADIUS_EAP_ENABLED=true in ecloud.env.

  Step 3: Restart FreeRADIUS.
    ecloud-compose restart freeradius

  Step 4: Configure NAS for 802.1X/EAP.
    Auth method: EAP-TTLS, inner: PAP.
    Trust: install CA cert on client device (or use commercial cert signed by public CA).

  Step 5: Verify.
    eapol_test -c eapol_test.conf -s <shared_secret>
    Expected: SUCCESS

  Security note:
    Do not use self-signed cert without CA deployment on client devices.
    Without cert validation, clients are vulnerable to RADIUS impersonation (evil AP).

---

## 8. CoA / Disconnect enablement

  CoA is disabled by default.  Enable ONLY after lab testing confirms your NAS firmware
  supports RFC 5176 for the required operations.

  Step 1: Lab test CoA on your specific NAS firmware version.
    Record: NAS model, firmware version, tested operations, result.
    Update docs/AAA_TEST_RESULTS.md section 9.

  Step 2: If lab test passes, set in ecloud.env:
    ECLOUD_COA_ENABLED=true

  Step 3: For each NAS client, set in the dashboard:
    coa_supported = true
    coa_port = 3799   (or 1700 for MikroTik)

  Step 4: Test admin disconnect.
    POST /v1/platform/sites/<site_id>/sessions/<session_id>/disconnect
    Verify: session status changes to 'stopped', NAS drops the client.

---

## 9. Multi-tenant RADIUS setup

  Each tenant (organization) has its own:
    - Users, groups, and policies
    - NAS clients with per-NAS shared secrets
    - Captive portals
    - Accounting records

  Tenant isolation is enforced at the database layer (PostgreSQL RLS).
  No FreeRADIUS-level tenant separation is required; all routing happens in the API.

  Onboarding a new tenant:
    1. Create organization via admin dashboard.
    2. Register NAS clients for that organization.
    3. Create authentication policies.
    4. Create captive portal or configure 802.1X.
    5. Test authentication with a test user.

---

## 10. Monitoring and alerting

  Health checks:
    API:           GET /health -> 200
    FreeRADIUS:    docker exec ecloud-freeradius /healthcheck.sh   (Status-Server on
                   127.0.0.1:18121, secret from RADIUS_STATUS_SECRET_FILE)
    PostgreSQL:    pg_isready -h localhost -p 5432
    Redis:         redis-cli ping

  Key metrics to monitor (via API or Prometheus scrape, future):
    aaa_auth_accept_total      — accepts per minute
    aaa_auth_reject_total      — rejects per minute
    aaa_auth_latency_ms_p99    — tail latency (target < 100 ms)
    sessions_active_total      — active sessions
    accounting_queue_depth     — radacct_raw rows not yet drained
    coa_dispatch_failures      — CoA ACK failures

  Alerts:
    auth_reject_rate > 50% of requests for 5 min -> PagerDuty (misconfiguration likely)
    API /health non-200 for 30 s -> PagerDuty
    accounting_queue_depth > 10,000 rows -> Warning (worker possibly stuck)

---

## 11. Backup and restore

  Do NOT use a bare `pg_dump -U ecloud`.  Two reasons: the application role cannot read the
  FORCE RLS tables (pg_dump refuses them without BYPASSRLS, so the dump fails or omits
  tenant data — docs/RESTORE_DRILL.md:109), and a plaintext .sql dump of this database
  contains NAS shared secrets and subscriber material.

  Database backup — use the approved path, scripts/backup/backup.sh:
    pg_dump -Fc runs inside the Postgres container and is piped straight into
    `age -R <recipients>`, so no plaintext dump ever touches disk.  It writes SHA256SUMS and
    manifest.json, 0700 directory / 0600 files, atomic .partial-* rename, keep-N retention
    (BACKUP_RETENTION_COUNT), and an optional off-site upload hook.  Credentials come from
    the container secret files, never from the command line.
    Host install and the nightly timer: infra/vps-local/scripts/setup-backup.sh install
    (approval gate LCL-BK-2 / LCL-BK-3).
    Full description, including the dedicated backup role and its BYPASSRLS requirement:
    docs/RESTORE_DRILL.md.

  FreeRADIUS config backup:
    infra/freeradius/raddb/ is tracked in git.  No external backup needed for config.
    NAS secrets are in the database; covered by the database backup above.

  Restore:
    scripts/backup/restore.sh  (and scripts/backup/restore-drill.sh for a rehearsal into a
    throwaway database).  Follow docs/RESTORE_DRILL.md — restoring by hand with psql skips
    the decrypt, checksum and role steps it documents.

  The age PRIVATE key is never created, read or stored by any script here; it is held by the
  owner offline.  Without it no backup can be restored.

---

## 12. Upgrade procedure

  Step 1: Read CHANGELOG for schema migration notes.

  Step 2: Pull new image.
    ssh vps-local 'cd /opt/ecloud && git pull && IMAGE_TAG=<new_tag> ecloud-compose pull'

  Step 3: Run migrations (zero-downtime if all migrations are backward-compatible).
    ecloud-compose run --rm migrate

  Step 4: Restart services (rolling if multiple replicas, sequential if single).
    ecloud-compose up -d --no-deps api worker portal freeradius

  Step 5: Verify health.
    ecloud-compose ps && curl -sk https://localhost/health

  Rollback:
    IMAGE_TAG=<previous_tag> ecloud-compose up -d --no-deps api worker portal freeradius
    If a migration was applied, run the down migration (if provided) or restore from backup.

---

## 13. Troubleshooting

  Symptom: FreeRADIUS rejects all requests with "No such client"
  Cause:   NAS IP not registered or NAS was registered after last FR restart.
  Fix:     Register NAS in dashboard, then: ecloud-compose restart freeradius

  Symptom: Access-Reject for valid user
  Cause:   Policy not assigned, user suspended, quota exceeded, or site mismatch.
  Fix:     Use RADIUS flow tester (Phase 6D) or check auth_events table.
           SELECT * FROM auth_events WHERE username='<user>' ORDER BY created_at DESC LIMIT 10;

  Symptom: Accounting records not appearing in dashboard
  Cause:   Worker not draining radacct_raw, or accounting packet not reaching FR.
  Fix:     Check worker logs: ecloud-compose logs worker | grep drain
           Check radacct_raw count: SELECT COUNT(*) FROM radius.radacct_raw WHERE drained_at IS NULL;

  Symptom: CoA / Disconnect has no effect
  Cause:   ECLOUD_COA_ENABLED=false, or NAS coa_supported=false, or NAS firewall blocks 3799.
  Fix:     Verify ecloud.env ECLOUD_COA_ENABLED=true; verify NAS coa_supported flag;
           verify NAS firewall allows UDP 3799 from EZECLOUD LAN IP.

  Symptom: EAP-TTLS fails at TLS handshake
  Cause:   Certificate not trusted by supplicant, or cert expired, or wrong cert path.
  Fix:     Verify cert in infra/freeradius/certs/; check expiry: openssl x509 -noout -dates -in server.crt
           Deploy CA cert to client devices.

---

## 14. NAS Hot-Reload Automation

When a NAS is provisioned, updated, deleted, or has its RADIUS secret rotated via the API,
the API writes a Redis key `radius:clients:reload_pending` with a 300 s TTL
(apps/api/src/radius-clients/reload-signal.ts).  A host-side cron job polls that key every
60 s and runs `reload-radius.sh`.

STATUS — the API side exists and the watcher script exists and is tested
(tests/scripts/radius-reload-watch.test.ts, 6 cases, no Redis or Docker required).  Whether
the host-side install below has actually been performed on vps-local is NOT verified from
this repository: REQUIRES_CLARIFICATION.  Until it is confirmed, treat NAS changes as
requiring the manual `reload-radius.sh` step in §3.  This supersedes the earlier claim that
the automation is installed and working, and matches AAA_AUDIT.md G4 and AAA_SECURITY.md R2.

Install (run once as root on the VPS).  BOTH scripts are required: the watcher resolves
reload-radius.sh from its own directory and exits 1 without it, so a copy of the watcher
alone cannot work.

  install -m 0755 infra/vps-local/scripts/reload-radius.sh       /opt/ecloud/bin/
  install -m 0755 infra/vps-local/scripts/radius-reload-watch.sh /opt/ecloud/bin/
  install -d -m 0755 /var/log/ecloud

  dnf install -y redis                    # provides redis-cli on Oracle Linux 8 (D-041)

  cat > /etc/cron.d/ecloud-radius-reload << 'EOF'
  SHELL=/bin/bash
  PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
  * * * * * root /opt/ecloud/bin/radius-reload-watch.sh >> /var/log/ecloud/radius-reload.log 2>&1
  EOF

`redis-tools` is a Debian/Ubuntu package name and does not exist on this host.  The watcher
reads REDIS_URL from /opt/ecloud/ecloud.env and passes any password to redis-cli through
REDISCLI_AUTH, never as an `-a` argument, so it does not appear in `ps`.

Exit-code contract (do not change one side without the other): reload-radius.sh exits 0 when
it re-rendered and restarted FreeRADIUS, 3 when it did so with some invalid NAS rows skipped
— the reload still happened — 4 when it refuses to run as non-root, and 1 when nothing was
written and FreeRADIUS was NOT restarted.  The watcher consumes the Redis key on both 0 and
3.  Treating 3 as a failure keeps the key and makes cron restart FreeRADIUS every 60 s for as
long as one malformed NAS row exists, each restart a brief authentication outage; that was
the behaviour before commit 2eb9be9.  Repeated genuine failures are capped at
ECLOUD_RELOAD_MAX_ATTEMPTS (default 5) via `radius:clients:reload_attempts`, after which the
watcher stops acting and logs what the operator must do.

Verify: create a NAS in the dashboard, wait up to ~2 min (60 s poll plus the reload), then
confirm `/var/log/ecloud/radius-reload.log` shows "Reload succeeded" and that
`redis-cli GET radius:clients:reload_pending` is empty.

---

END OF AAA_DEPLOYMENT.md
