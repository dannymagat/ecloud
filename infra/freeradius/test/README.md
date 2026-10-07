# radclient attribute files for the A9 lab tests

Inputs for the device-test cases in `PHASE2_VALIDATION.md` §5 (DT-03, DT-07, DT-08,
DT-09, DT-15, DT-16) and the AAA test matrix (`AAA_ARCHITECTURE.md` §10, T-A1..T-A9).
**Every value is a placeholder** (`<...>`, `PLACEHOLDER_*`, documentation addresses
192.0.2.x / 00-11-22-33-44-55). Replace them with the values captured in DT-03 before
use; never commit real secrets, MACs or session ids.

Run from the dev container (`npm run dev:stack` first):

```bash
dc() { docker compose --project-directory . -f infra/compose/docker-compose.dev.yml "$@"; }

# Access-Request (uspot UAM PAP). The dev client CIDR covers the container itself,
# so target its own address. Expected until the api is running: Access-Reject with
# Reply-Message "AAA backend unavailable" and "rlm_rest ... Connection failed" in the logs.
dc exec -T freeradius sh -c 'radclient -x -r 1 -t 3 $(hostname -i):1812 auth "$RADIUS_DEV_CLIENT_SECRET"' \
  < infra/freeradius/test/access-request-uspot-uam-pap.txt

# Accounting (Start -> Interim -> Stop; one radius.radacct_raw row per distinct packet)
for f in acct-start acct-interim-update acct-stop; do
  dc exec -T freeradius sh -c 'radclient -x -r 1 -t 3 $(hostname -i):1813 acct "$RADIUS_DEV_CLIENT_SECRET"' \
    < infra/freeradius/test/$f.txt
done

# Status-Server health probe (loopback listener)
echo "Message-Authenticator = 0x00" | dc exec -T freeradius sh -c 'radclient -x 127.0.0.1:18121 status "$RADIUS_STATUS_SECRET"'

# Disconnect / CoA are sent TO the NAS (hostapd DAS / CoovaChilli coaport), from the
# host or worker that holds the route to the AP; FreeRADIUS has no 3799 listener.
radclient -x -r 3 -t 2 <ap-ip>:3799 disconnect '<DAE_SECRET_PLACEHOLDER>' < infra/freeradius/test/disconnect-hostapd-das.txt
radclient -x -r 3 -t 2 <gw-ip>:3799 disconnect '<RADSECRET_PLACEHOLDER>' < infra/freeradius/test/disconnect-coovachilli.txt
radclient -x -r 3 -t 2 <gw-ip>:3799 coa        '<RADSECRET_PLACEHOLDER>' < infra/freeradius/test/coa-coovachilli.txt
```

`radclient` reads `Attribute = value` lines; a blank line separates packets. With
`Message-Authenticator = 0x00` present radclient computes the real HMAC (required:
the server runs `require_message_authenticator = yes`).

| File | DT / T case | Notes |
|---|---|---|
| `access-request-uspot-uam-pap.txt` | DT-03, T-A1 | attribute set of CAPTIVE_PORTAL_ARCHITECTURE.md §3.4 (TIP uspot `Called-Station-Id = nasmac:ssid`) |
| `access-request-coovachilli-uam-pap.txt` | DT-15, T-A2 | CoovaChilli adds `Service-Type`, `ChilliSpot-Version`, Message-Authenticator |
| `access-request-hostapd-mac-auth.txt` | DT-09, T-A3 | hostapd `mac-filter`: username/password **format REQUIRES DEVICE TEST** |
| `access-request-uspot-mac-auth.txt` | DT-09, T-A3 | uspot `mac-auth`: `Service-Type = Call-Check`, password = `mac_passwd` or MAC |
| `acct-start.txt`, `acct-interim-update.txt`, `acct-stop.txt` | DT-16, T-A6 | interim/stop carry Gigawords (>4 GiB folding) |
| `acct-on.txt` | DT-16, T-A7 | NAS restart (uspot sends On/Off) |
| `disconnect-hostapd-das.txt` | DT-07, T-A8 | minimal identification set first, then add User-Name / Event-Timestamp |
| `disconnect-coovachilli.txt`, `coa-coovachilli.txt` | DT-15, T-A8/T-A9 | chilli requires `User-Name`; CoA re-applies timeouts/bandwidth/quota |
