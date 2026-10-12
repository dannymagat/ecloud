# AAA Compatibility Matrix — EZECLOUD / EZECONTROL
Version 1.0  |  2026-10-12

Legend:
  Y   Confirmed working (lab or production test)
  P   Implemented, not lab-tested (code compiles, adapters exist)
  X   Not implemented / not supported by vendor
  -   Not applicable
  ?   Unknown — requires device testing

Note: "Implemented" means adapter code exists and compiles.
No claim of compatibility is made without lab evidence marked Y.
All P cells are REQUIRES_DEVICE_TEST (D-028).

---

## 1. Authentication methods per vendor

Vendor / Controller    PAP   CHAP  MSCHAPv2  EAP-TLS  PEAP  EAP-TTLS  MAB   Cert-auth
---------------------  ----  ----  --------  -------  ----  --------  ----  ---------
EZE Access Points      P     X     X         X        X     P         P     X
TIP OpenWiFi           P     X     X         X        X     P         P     X
CoovaChilli            P     P     X         X        X     P         P     X
MikroTik RouterOS      P     P     X         X        X     X         P     X
Cisco Meraki           P     X     X         X        X     X         P     X
Ubiquiti UniFi         X     X     X         X        X     X         X     X
TP-Link Omada          X     X     X         X        X     X         X     X
Cisco WLC / IOS-XE     X     X     X         X        X     X         X     X
Aruba (Instant/MM)     X     X     X         X        X     X         X     X
Ruckus SmartZone       X     X     X         X        X     X         X     X
Cambium cnMaestro      X     X     X         X        X     X         X     X
OpenWrt (non-TIP)      X     X     X         X        X     X         X     X
Generic RFC RADIUS     P     X     X         X        X     P         P     X

CHAP note: CHAP requires cleartext-equivalent password storage (NTLM/LM hash or cleartext).
EZECLOUD stores Argon2id hashes only.  CHAP is only available through the MikroTik HTTP-CHAP
captive portal path where the portal exchanges it for a broker token.

---

## 2. Accounting capabilities

Vendor / Controller    Start  Stop   Interim  Acct-On  Acct-Off  Octet64  RadSec-acct
---------------------  -----  -----  -------  -------  --------  -------  -----------
EZE Access Points      P      P      P        ?        ?         ?        X
TIP OpenWiFi           P      P      P        ?        ?         ?        X
CoovaChilli            P      P      P        P        P         ?        X
MikroTik RouterOS      P      P      P        P        P         P        X
Cisco Meraki           P      P      P        P        P         ?        X
Ubiquiti UniFi         X      X      X        X        X         X        X
TP-Link Omada          X      X      X        X        X         X        X
Cisco WLC              X      X      X        X        X         X        X
Aruba                  X      X      X        X        X         X        X
Ruckus                 X      X      X        X        X         X        X
Cambium                X      X      X        X        X         X        X
Generic RFC RADIUS     P      P      P        P        P         ?        X

Octet64 note: RADIUS uses 32-bit Acct-Input-Octets/Acct-Output-Octets and
Acct-Input-Gigawords/Acct-Output-Gigawords for 64-bit totals.  Not all NAS send
Gigawords.  EZECLOUD handles wrap detection via accounting_anomalies table.

---

## 3. CoA / Disconnect (RFC 5176) support

Vendor / Controller    Disconnect  CoA-BW    CoA-VLAN  DAS-port  Notes
---------------------  ----------  --------  --------  --------  ----------------------------
EZE Access Points      ?           ?         ?         3799      REQUIRES_DEVICE_TEST
TIP OpenWiFi           ?           ?         ?         3799      REQUIRES_DEVICE_TEST
CoovaChilli            P           X         X         3799      chilli_coova: only Disconnect
MikroTik RouterOS      P           P         X         1700      Uses non-standard port 1700
Cisco Meraki           P           X         X         3799      DAS host: nN.meraki.com
Ubiquiti UniFi         X           X         X         -         No adapter exists
TP-Link Omada          X           X         X         -         No adapter
Cisco WLC              X           X         X         -         No adapter
Aruba                  X           X         X         -         No adapter
Ruckus                 X           X         X         -         No adapter
Cambium                X           X         X         -         No adapter
Generic RFC RADIUS     ?           ?         ?         3799      Depends on NAS firmware

CoA-BW: bandwidth change during active session via CoA-Request.
MikroTik BW change confirmed in adapter code (Mikrotik-Rate-Limit in CoA-Request) but
not lab-tested (D-028).

---

## 4. VSA support

Vendor              VSA namespace               BW control attr       VLAN attr          Notes
------------------  --------------------------  --------------------  -----------------  -------
MikroTik            Mikrotik (9)                Mikrotik-Rate-Limit   X (no VLAN VSA)    Tested
CoovaChilli/WISPr   WISPr (14122)               WISPr-BW-Max-Down/Up  X                  Tested
TIP OpenWiFi        WISPr (UAM mode)            WISPr-BW-Max-Down/Up  X                  P
Meraki              Meraki Cloud RADIUS         X                     X                  P
Generic 802.1X      RFC 3580 (Tunnel attrs)     Filter-Id (partial)   Tunnel-PVID        P
Cisco               Cisco-AVPair (9)            Cisco-AVPair BW       Cisco-AVPair VLAN  X (no adapter)
Aruba               Aruba (14823)               Aruba-User-Role       X                  X (no adapter)
Ruckus              Ruckus-SCG (25053)          ?                     ?                  X (no adapter)
Cambium             Cambium (17713)             ?                     ?                  X (no adapter)

---

## 5. Bandwidth control mechanisms

Vendor              Mechanism                      Rate-limit unit  Burst support
------------------  -----------------------------  ---------------  -------------
MikroTik            Mikrotik-Rate-Limit VSA        kbps/mbps        No (adapter: UNSUPPORTED)
CoovaChilli         WISPr-Bandwidth-Max-Down/Up    bps              No
TIP OpenWiFi (UAM)  WISPr attributes               bps              No
Generic 802.1X      Filter-Id (string policed)     vendor-specific  Vendor-dependent
Meraki              No BW VSA in Cloud RADIUS       -                No
All others          Not implemented                -                -

---

## 6. Captive portal integration types

Adapter key                  Portal type           Redirect mechanism       Challenge
---------------------------  --------------------  -----------------------  ---------
mikrotik-hotspot             mikrotik-http-chap    MikroTik login URL       CHAP
coovachilli-uam              coovachilli-uam       UAM redirect             CHAP/PAP
openwifi-uspot-uam           uspot-uam             UAM redirect             PAP
uspot-upstream-uam           uspot-uam             UAM redirect             PAP
external-portal-postback     external-postback     NAS splash + postback    Token
meraki-splash                meraki-splash         Meraki splash page       Token
openwifi-hostapd-radius      none-8021x-macauth    802.1X supplicant        EAP
generic-radius-8021x         none-8021x-macauth    802.1X supplicant        EAP/MAB
openwifi-config              none (config-only)    N/A                      N/A

---

## 7. Known limitations

  L1  CHAP/MS-CHAPv2: Cannot be supported natively because EZECLOUD uses Argon2id one-way
      hashing.  Cleartext or reversible credential storage is deliberately not provided.
      Impact: MSCHAPv2-only supplicants (legacy Windows without PEAP/TLS) cannot use 802.1X.

  L2  NAS client hot-reload: FreeRADIUS 3.2 reads clients.conf only at startup.
      Adding or removing a NAS requires a container restart (graceful, ~3 s).
      Impact: in a busy deployment, ~3 s auth outage on restart.

  L3  EAP-TLS: Not yet implemented. Client certificate management (CA, enrollment, revocation)
      requires a separate PKI service not currently in-scope.

  L4  RadSec: Not implemented. Remote APs must reach RADIUS port 1812 via VPN or private network.
      Exposing raw RADIUS/UDP to the public internet is a security risk and is not supported.

  L5  IPv6 RADIUS listener: Configured but not end-to-end tested.

  L6  CoA bandwidth change: Only MikroTik adapter has the VSA; no confirmed lab test.

  L7  VLAN assignment via CoA: Not implemented for any vendor.

  L8  PPPoE: No PPPoE gateway adapter. PPPoE concentrators can be registered as generic NAS
      but PPPoE-specific attributes (Framed-Protocol=PPP, Framed-MTU, NAS-Port-Type=Virtual)
      are not emitted by the policy engine.

  L9  Sponsor-approved guest: No sponsor approval workflow in UI or API.

  L10 Subscription/billing: No payment gateway integration.

  L11 Multi-FR HA: Single FreeRADIUS container. No keepalived / active-active config.

---

END OF AAA_COMPATIBILITY_MATRIX.md
