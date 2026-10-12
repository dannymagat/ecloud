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
    Expected: 7 containers UP/Healthy (redis, postgres, edge, api, worker, portal, freeradius)

  Run migrations:
    ecloud-compose run --rm migrate

  Verify FreeRADIUS is ready:
    ssh vps-local 'docker exec ecloud-freeradius radtest test test 127.0.0.1 0 testing123'
    Expected: Access-Reject (no such NAS registered) — confirms FR is running.

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
    FreeRADIUS:    docker exec ecloud-freeradius radtest ping ping 127.0.0.1 0 testing123
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

  Database backup:
    pg_dump -h localhost -U ecloud ecloud > ecloud_backup_$(date +%Y%m%d).sql
    Recommended: daily automated pg_dump via cron, retained 30 days.

  FreeRADIUS config backup:
    infra/freeradius/raddb/ is tracked in git.  No external backup needed for config.
    NAS secrets are in the database; covered by DB backup.

  Restore:
    psql -h localhost -U ecloud ecloud < ecloud_backup_YYYYMMDD.sql
    ecloud-compose restart

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
the API writes a Redis key `radius:clients:reload_pending`.  A host-side cron job polls this
key and runs `reload-radius.sh` automatically.

Install (run once as root on the VPS):

  cp infra/vps-local/scripts/radius-reload-watch.sh /opt/ecloud/bin/
  chmod +x /opt/ecloud/bin/radius-reload-watch.sh
  apt-get install -y redis-tools          # for redis-cli

  cat > /etc/cron.d/ecloud-radius-reload << 'EOF'
  SHELL=/bin/bash
  PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
  * * * * * root /opt/ecloud/bin/radius-reload-watch.sh >> /var/log/ecloud/radius-reload.log 2>&1
  EOF

  mkdir -p /var/log/ecloud

Verify: create a NAS in the dashboard, wait up to 90 s, then confirm
`/var/log/ecloud/radius-reload.log` shows "Reload succeeded".

---

END OF AAA_DEPLOYMENT.md
