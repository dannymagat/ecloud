# VENDOR_INTEGRATION_RESEARCH.md: third-party AP/gateway hotspot integration research

Status: **RESEARCH ONLY**. No device was tested, no code was changed, no remote command was run.
Date of research: 2026-10-10. Applies to: MULTI_VENDOR_INTEGRATION_PLAN.md (M11) §4 evidence model, §6 contract, §7.4 roadmap rows; DECISIONS.md D-028, D-032, D-033, D-034, D-039.

Every vendor fact in this document has the evidence level **`DOCUMENTED`**. Nothing here is `VERIFIED_FROM_SOURCE`, `SIMULATOR_TESTED` or `LAB_VALIDATED`. Under plan §4.3 the most a vendor row can reach from this work is lifecycle **`researched`**, and V6 applies: no cell is `VERIFIED_SUPPORTED`.

## 0. Method, sources and rules

1. **Starting point.** Social WiFi Academy installation guides index (https://academy.socialwifi.com/en/hardware-and-installation/installation-guides/), which links 68 guide pages. Every vendor guide page was fetched (2026-10-10), and only derived facts are kept here: setting names, mechanism, version statements, port numbers, walled-garden needs. **No Social WiFi prose, scripts or screenshots are reproduced.** Their public IPs, ports, domains and file names are recorded only where they show a mechanism (for example "RADIUS on a non-standard port is accepted"), and they are **never** reused as ECLOUD values.
2. **Cross-check.** The mechanism was then checked against the vendor's own documentation for MikroTik, UniFi, Omada, Meraki, Aruba, Ruckus, Cisco 9800, Fortinet, Juniper Mist and Cambium (Cambium is already cross-checked in MULTI_VENDOR_INTEGRATION_PLAN.md §7.3, sources C1–C5). Source URLs are listed per vendor in §7.
3. **Source type labels.** In the tables, `V` = vendor documentation (vendor doc site, vendor KB, vendor app note), `V-c` = vendor community/employee material (vendor-hosted forum or community PDF, not formal docs), and `T` = third-party (Social WiFi, other portal vendors, blogs).
4. **Never invented.** If a parameter name was not seen in a fetched source, it is written as `REQUIRES_CLARIFICATION`. Where a vendor document is internally inconsistent (for example letter case), both spellings are given and the cell is `REQUIRES_DEVICE_TEST`.
5. **Four-state mapping used in §3** (D-028 statuses, research-state per plan §4.1):
   - `REQUIRES_DEVICE_TEST`: the mechanism is documented, but behaviour is unproven (default for every device-enforced field).
   - `UNSUPPORTED`: the documentation states the mechanism is absent or limited (for example "only Disconnect, no CoA").
   - `ECLOUD_SIDE_ONLY`: the device has no such mechanism, so ECLOUD enforces it before Accept (validity, vouchers, concurrency, schedules), as already defined in POLICY_ENGINE.md §1.1.
   - `UNKNOWN` (registry research state only): nothing was found. This is never shown as supported or unsupported.
   - All cells carry evidence level `DOCUMENTED`.

## 1. Summary table

Legend for **RADIUS** column: A = authentication, Acct = accounting, CoA/DM = RFC 5176 (DM = Disconnect-Message). The **Conf.** column gives the confidence in the mechanism description: H = vendor doc confirms it, M = vendor doc partial plus third-party, L = third-party only.

| Vendor | Product line | Integration family (§2) | Redirect params (names only) | Login completion | RADIUS (A / Acct / CoA) | Bandwidth attrs | HTTPS portal required? | Walled garden | Evidence / source type | Conf. | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MikroTik | RouterOS Hotspot (router/gateway) | `mikrotik-hotspot` | None by default: the router serves its own `login.html`. A redirect to an external portal is built in that template from variables `$(mac)`, `$(mac-esc)`, `$(ip)`, `$(link-login)`, `$(link-login-only)`, `$(link-orig)`, `$(link-orig-esc)`, `$(chap-id)`, `$(chap-challenge)`, `$(identity)`, `$(interface-name)`, `$(server-address)`, `$(error)`, `$(popup)`. **The query-parameter names are ECLOUD-chosen.** | Browser POSTs `username`, `password` (PAP plain, or CHAP = MD5(chap-id + password + chap-challenge)), `dst`, `popup` to `$(link-login-only)` on the router | A yes, Acct yes; DM/CoA via `/radius incoming` (`accept` default **no**, `port` default **1700** per vendor doc) | `Mikrotik-Rate-Limit` (rx = client upload), `Mikrotik-Recv/Xmit/Total-Limit` (+`-Gigawords`), `WISPr-Bandwidth-Min/Max-Up/Down`, `Ascend-Data-Rate`/`Ascend-Xmit-Rate`, `Session-Timeout`, `Idle-Timeout`, `Acct-Interim-Interval`, `Filter-Id`, `Mikrotik-Address-List` | No. Optional `login-by=https` needs a certificate on the router (T: ACME via IP Cloud, ROS ≥ 7.19) | `/ip hotspot walled-garden` (host patterns) | DOCUMENTED (V + T) | H | V: manual.mikrotik.com hotspot-customisation, radius; T: SW mikrotik/winbox, webfig, mikrotik-ssl |
| Teltonika | RutOS Hotspot (routers) | `uam-chillispot` (existing `coovachilli-uam`) | ChilliSpot/Coova UAM set (`res`, `uamip`, `uamport`, `challenge`, `called`, `mac`, `ip`, `nasid`, `sessionid`, `userurl`, `md`) **assumed from CoovaChilli**; Teltonika's own list is not verified | GET `/logon` to `uamip:uamport` (UAM port default 3990) | A, Acct (2 servers, custom ports accepted); CoA UNKNOWN | UNKNOWN for RutOS build (CoovaChilli family attrs if unchanged) | No (T: landing page set to `http://`) | Walled garden tab, "Allowlist" mode | DOCUMENTED (V wiki via search + T) | M | T: SW teltonika; V: wiki.teltonika-networks.com (Hotspot, "uses CoovaChilli") |
| Ubiquiti | UniFi Network ≥ 9.1.105 (Hotspot → External Portal Server) | `unifi-external-portal` (backend API) | `ap`, `id` (client MAC), `t` (not described), `url`, `ssid`; path `/guest/s/<site>/` | **Controller API**: `POST /v1/sites/{siteId}/clients/{clientId}/actions` body `action=AUTHORIZE_GUEST_ACCESS`, `timeLimitMinutes`, `dataUsageLimitMBytes`, `rxRateLimitKbps`, `txRateLimitKbps`; API key generated in Network > Control Plane > Integrations | Not used in API mode | API body fields (above) | Not required (T: HTTPS Redirection, Secure Portal, Encrypted URL all off). ECLOUD→controller over HTTPS | "Allowed Authorization Access" / Pre-Authorization Access | DOCUMENTED (V + T) | H | V: help.ui.com 31228198640023; T: SW ubiquiti/ubiquiti-unifi, known-issues |
| Ubiquiti | UniFi ≤ 7.3 legacy (Guest Hotspot, RADIUS) | (legacy) RADIUS CHAP with uploaded templates | REQUIRES_CLARIFICATION | Controller-hosted template with RADIUS CHAP (T) | A (CHAP), Acct off, "Disconnect Requests" option exists (T) | UNKNOWN | No | Allowed Authorization Access | DOCUMENTED (T) | L | T: SW ubiquiti-unifi-legacy/* |
| TP-Link | Omada Controller (software / cloud Standard plan) external portal **with RADIUS** | `omada-external-portal` (post-back variant) | `clientMac`, `clientIp`, `apMac`, `ssidName`, `radioId`, `scheme`, `originUrl`, `target`, `targetPort`, `raidusServerIp` (vendor spelling); wired: `gatewayMac`, `vid`. The vendor example also shows `clientIP`, `GatewayMac`, `originalUrl` (inconsistent case) | Browser POST `application/x-www-form-urlencoded` to `/portal/radius/browserauth` on `target:targetPort` (since controller 5.3.1), or JSON POST `/portal/radius/auth` (RSA-encrypted AES key); fields `clientMac`, `clientIP`, `apMac`, `gatewayMac`, `ssidName`, `vid`, `radioId`, `authType` (`2` = External RADIUS), `originUrl`, `username`, `password` | A PAP, Acct + interim (T: 600 s); CoA UNKNOWN | UNKNOWN | Cloud controller: "only HTTPS POST to browserauth supported" (V). Ports 8088/8843 must be reachable from the client (T) | Pre-Authentication Access (URL or IP range); T adds the portal IP, citing domain-resolution issues | DOCUMENTED (V + T) | H | V: support.omadanetworks.com/document/13025; T: SW tp-link/* |
| TP-Link | Omada Controller external portal **without RADIUS** (hotspot operator API) | `omada-external-portal` (backend variant) | 5.0.15–6.2.0: `clientMac`, `apMac`, `ssidName`, `radioId`, `site`, `redirectUrl`, `t`; wired `gatewayMac`, `vid`. 6.2.10+: adds `clientIp` | Server-side: login `POST https://CONTROLLER:PORT/CONTROLLER_ID/api/v2/hotspot/login` (`name`, `password`), then `POST …/api/v2/hotspot/extPortal/auth` with header `Csrf-Token`; body `clientMac`, `apMac`/`gatewayMac`, `ssidName`/`vid`, `radioId`, `site`, `time` (microseconds), `authType` `"4"`; 6.2.10 adds `clientIp`, `originUrl`, `totalTrafficLimitBytes`, `downloadRateLimitKbps`, `uploadRateLimitKbps` | None | API body (6.2.10+) | ECLOUD→controller HTTPS | Pre-Authentication Access | DOCUMENTED (V) | H | V: support.omadanetworks.com/document/13080, /132060 |
| Cisco Meraki | MR, Splash "Sign-on with my RADIUS server" | `meraki-splash` | `login_url` (opaque), `continue_url`, `error_message`; other names (`ap_mac`, `client_mac`, …) REQUIRES_CLARIFICATION | Browser POST `username`, `password`, `success_url` to `login_url` | A + Acct sent by the **Meraki Cloud** (public IP), not by the AP; **DM only** ("only dynamic authorization supported are disconnect messages") to the org's Meraki FQDN, UDP 3799, with `Acct-Session-Id` + `Event-Timestamp` (±300 s) | `Filter-Id` → named group policy (V, documented for 802.1X SSIDs; splash use REQUIRES_DEVICE_TEST); per-user rate attr UNKNOWN | `login_url` is Meraki-hosted; portal HTTPS not mandated in the doc | Walled garden must include the portal web server (V); T: 20-entry style lists | DOCUMENTED (V + T) | H | V: documentation.meraki.com (custom-hosted splash, CoA Disconnect for Splash Sign-on, RADIUS with sign-on splash); T: SW cisco/cisco-meraki |
| Cisco Meraki | MR, Click-through splash (no RADIUS) | `meraki-splash` (grant variant) | `base_grant_url`, `user_continue_url` (others REQUIRES_CLARIFICATION) | Browser GET `base_grant_url?continue_url=…[&duration=<s>]` | None | `duration` only | `base_grant_url` example is `https://n##.network-auth.com/splash/grant` | Walled garden with portal server | DOCUMENTED (V) | H | V: documentation.meraki.com custom-hosted splash |
| HPE Aruba | Instant (IAP) and Central (Instant APs) | `aruba-ecp` (post-back) | `cmd` (`login`), `mac`, `essid`, `ip`, `apname`, `apmac`, `vcname`, `switchip`, `url` | Browser POST to `https://securelogin.arubanetworks.com/swarm.cgi` (IAP) or `…/cgi-bin/login` (IAP and controller) with `cmd=authenticate`, `user`, `password`, optional `url`. The AP intercepts that hostname (V-c PDF: DNS spoofed to an AP-local address; AP cert) | A + Acct from the AP; T: "Dynamic Authorization" option exists on the server profile (CoA support REQUIRES_DEVICE_TEST); T: RadSec option exists | UNKNOWN (Aruba VSAs not researched) | Profile option "Use HTTPS" (enforce HTTPS to portal, RADIUS mode only). T used HTTPS port 443 | Walled garden allowlist + pre-auth role with domain rules (T) | DOCUMENTED (V + V-c + T) | M (POST target from V-c/T only) | V: arubanetworking.hpe.com Instant 8.x conf-ext-cp, CLI-Bank wlan external-captive-portal; V-c: HPE community PDF; T: SW aruba/* |
| HPE Aruba | AOS 8 controllers (Mobility Controller) | `aruba-ecp` | `switchip`, AP MAC, IP, VLAN only when the matching profile options are enabled (`switchip-in-redirection-url`, `ap-mac-in-redirection-url`, `ip-addr-in-redirection-url`, `user-vlan-in-redirection-url`); **`url-hash-key`** hashes the redirection URL | POST to controller `cgi-bin/login` (V-c) | A + Acct | UNKNOWN | REQUIRES_CLARIFICATION | captive-portal whitelist | DOCUMENTED (V) | M | V: CLI-Bank aaa-auth-cptv-prtl |
| HPE Aruba | Instant On | `aruba-ecp` (variant) | REQUIRES_CLARIFICATION | Post-back to an AP-intercepted HTTPS name (V-c community: `captive-2019/2020.aio.cloudauth.net`, firmware-dependent) | A + Acct, "Require RADIUS Message-Authenticator" option (T); NAS-ID default = device IP (T) | UNKNOWN | T: External portal URL https | "Allowed Domains" | DOCUMENTED (T + V-c) | L | T: SW aruba/aruba-instant-on; V-c: community.instant-on.hpe.com |
| Alcatel-Lucent Enterprise | OmniAccess Stellar Express | `aruba-ecp`-like **REQUIRES_CLARIFICATION** (UI shows "Dummy IP 1.1.1.1", "Redirect URL param") | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION | A + Acct (interval 600, T) | UNKNOWN | T: HTTPS off | Walled garden (domain) | DOCUMENTED (T) | L | T: SW alcatel-lucent/alcatel-lucent-express |
| Alcatel-Lucent Enterprise | OmniVista Cirrus (Stellar) | post-back (generic) | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION | A + Acct via AAA Server Profile "Captive Portal" | UNKNOWN | T: HTTPS Redirection disabled | "Allow List Domains" in Access Role Profile | DOCUMENTED (T) | L | T: SW alcatel-lucent/omnivista-cirrus |
| Ruckus (CommScope) | ZoneDirector / Unleashed (Hotspot WISPr, external login page) | `ruckus-wispr` (post-back variant) | `sip` (ZD IP), `mac` (AP MAC), `lid` (location id), `uip` (client IP), `dn` (ZD domain from cert); after login to a start page: `uid`, `mac`, `url` | Browser GET or POST (POST recommended) `username`, `password` (≤ 31 chars) to `http://<sip>:9997/login` or `https://<sip>:9998/login`; `ip=<client IP>` required for L3 NAT; logout `/logout` | A + Acct (Start/Interim/Stop, Accounting-On/Off per AP join/leave); `NAS-Identifier` = BSSID, `Calling-Station-Id` = client MAC; CoA UNKNOWN | UNKNOWN | Optional 9998 (ZD cert) | Hotspot "Walled Garden" tab | DOCUMENTED (V 2009 app note + T) | M (app note is old) | V: webresources.ruckuswireless.com appnote-wispr.pdf; T: SW ruckus/ruckus-zone-director, ruckus-unleashed |
| Ruckus | SmartZone / vSZ (Hotspot WISPr portal) | `ruckus-wispr` | `client_mac` (encrypted by default), `uip` (encrypted), `mac`, `ssid`, `url`, `nbiIP`, `sip`, `reason`, `vlan`, `wlan`, `startUrl`, `proxy` (names from the Ruckus One doc; SmartZone set REQUIRES_CLARIFICATION). T: MAC/IP encryption must be turned off (`no encrypt-mac-ip`) for their portal | Either browser login to the controller (path REQUIRES_CLARIFICATION) or **NBI JSON** (`RequestCategory` "UserOnlineControl", `RequestType` "Login", `UE-IP`, `UE-MAC`, `UE-Username`, `UE-Password`, `RequestPassword`, `Vendor`); NBI ports 9080/9443 (T) | A + Acct; CoA UNKNOWN | UNKNOWN | T: HTTPS redirect disabled | Walled Garden / Traffic Class Profile | DOCUMENTED (V Ruckus One + T) | M | V: docs.cloud.ruckuswireless.com/ruckusone/wispr-api; T: SW ruckus/ruckus-virtual-smartzone |
| Ruckus | Ruckus One (cloud) | `ruckus-wispr` (backend NBI) | as above (`nbiIP` = Ruckus One subscriber-management external IP) | NBI JSON to `https://<tenantid>.wispr[.eu/.asia].ruckus.cloud:443/portalintf` (use the `nbiIP` value received). Response codes 101/201/301 etc. | A + Acct (T: 31812/31813 custom ports, RadSec off) | UNKNOWN | NBI is HTTPS-only (V) | Walled garden in network settings | DOCUMENTED (V + T) | H for NBI shape | V: docs.cloud.ruckuswireless.com/ruckusone/wispr-api; T: SW ruckus/ruckus-one |
| Cisco | Catalyst 9800 (IOS-XE) external webauth (EWA) | `cisco-webauth` | Default `switch_url`, `ap_mac`, `ssid`, `client_mac`; names are configurable with `redirect append ap-mac/client-mac/wlan-ssid tag <name>` (T used `ap_mac`, `client_mac`, `wlan_ssid`) | Browser POST to `switch_url` (virtual IP, e.g. `http://192.0.2.1/login.html`) with `buttonClicked=4`, `redirectUrl` (vendor text; form spelling REQUIRES_DEVICE_TEST), `err_flag=0`, `username`, `password` (not needed for `consent` type) | A + Acct via method lists; T enables "Support for CoA"; Call Station ID type `ap-macaddress-ssid` (T) | UNKNOWN (AAA override allowed; attr names not researched) | HTTPS intercept "not recommended"; virtual-IP trustpoint needed or browser warns (V). T disables secure webauth | URL filter `PRE_AUTH` / auto ACL from Portal IP (V) | DOCUMENTED (V + T) | H | V: cisco.com 217457; T: SW cisco/cisco-catalyst |
| Cisco | AireOS WLC (2504/5520, 8.x) | `cisco-webauth` | `switch_url`, `ap_mac`, `client_mac`, `wlan`, `redirect` (T/community; **not** re-verified against a Cisco doc in this pass) | Same POST shape as 9800 (assumed; REQUIRES_DEVICE_TEST) | A + Acct (interim 600, T); T: CoA disabled; Called-Station-Id type "AP MAC Address" (T) | UNKNOWN | T: WebAuth SecureWeb and HTTPS Redirection disabled | Pre-auth ACL with URL entries (T: **20-entry limit**) | DOCUMENTED (T) | M | T: SW cisco/cisco-wlc |
| Fortinet | FortiGate / FortiWiFi (+ FortiAP managed by FortiGate) | `fortinet-ecp` | `post` (callback, e.g. `http://<fgt>:1000/fgtauth`), `magic` (session id), `usermac`, `apmac`, `apip`, `userip`, `ssid`, `apname`, `bssid` | Browser POST to the `post` URL with `magic`, `username`, `password` (POST data ≤ 125 chars); FortiGate then sends RADIUS | A (PAP) + Acct (accounting server set via CLI, T); CoA option exists (T); `auth-timeout` idle mode (T) | UNKNOWN | `set auth-secure-http enable` secures the credential post (V). T: external portal configured as `http://` | FortiGate firewall address group as "Exempt Destinations/Services" | DOCUMENTED (V + V-c + T) | H | V: docs.fortinet.com fortiap 7.4.2 /292926; V-c: community.fortinet.com 101546; T: SW fortinet/fortinet-fortigate-fortiwifi |
| Fortinet | FortiAP via FortiLAN Cloud / FortiAP Cloud | `fortinet-ecp` (cloud variant) **REQUIRES_CLARIFICATION** | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION | T: "RADIUS Authentication by FortiLANCloud" (RADIUS source = cloud, like Meraki); CoA option present (T) | UNKNOWN | T: Secure HTTP off | Walled Garden list on SSID | DOCUMENTED (T) | L | T: SW fortinet/fortiap |
| Cambium | cnPilot E-series / cnMaestro (External Hotspot) | `cambium-hotspot` | `ga_ap_mac`, `ga_nas_id`, `ga_srvr`, `ga_cmac`, `ga_orig_url`, `ga_Qv`, `c_timeout`, `ga_error_code`; newer: `ga_ssid`, `ga_rssi` | Browser POST `ga_user`, `ga_pass` to `/cgi-bin/hotspot_login.cgi` on AP port 880 (HTTPS 444) | A + Acct (Start-Interim-Stop, T); CoA/DM UNKNOWN | `WIFI_ALLIANCE_MAX_UP/DOWN` (dictionary name/units UNKNOWN) | HTTPS 444 variant depends on AP cert (UNKNOWN) | Guest Access whitelist | DOCUMENTED (V + T) | H | Plan §7.3 C1–C5; T: SW cambium-networks/* |
| Juniper | Mist (Guest Portal → Forward to external portal) | `mist-guest-portal` (signed grant) | `wlan_id`, `ap_mac`, `client_mac`, `url`, `ap_name`, `site_name` | Browser 302 to `http(s)://portal.mist.com/authorize` (per-cloud host) with `signature` = base64(HMAC-SHA1(API secret of the guest WLAN, `"expires=<e>&token=<t>[&<optional>]"`)), `token` = base64(`wlan_id/ap_mac/client_mac/authorize_min/0/0/0`), `expires`, optional `forward`; test endpoint `/authorize-test` | Not used (RADIUS not mentioned for this mode) | Only `authorize_min` (meaning of the trailing `0/0/0` not documented) | Portal URL may be `http://` or `https://` | "Allowed hostnames" / allowed subnets | DOCUMENTED (V) | H | V: juniper.net guest-access-external-portal; mist.com/documentation/external-guest-portal; T: SW juniper-mist |
| Extreme Networks | ExtremeCloud IQ (HiveOS APs, e.g. AP230) | `uam-chillispot`-like **REQUIRES_CLARIFICATION** ("Password Encryption: UAM Basic", "Authentication Method: PAP") | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION | A + Acct (T) | UNKNOWN | REQUIRES_CLARIFICATION | CWP walled garden | DOCUMENTED (T) | L | T: SW extreme-networks/extreme-cloud-iq |
| Extreme Networks | WiNG ≥ 5.9 controller | post-back (generic) with **operator-chosen** param names: URL tags `WING_TAG_AP_MAC`, `WING_TAG_CLIENT_MAC` are substituted into the configured login URL | Captive portal mode "Internal (Self)" + external web pages + RADIUS; post target REQUIRES_CLARIFICATION | A (T); Acct REQUIRES_CLARIFICATION | UNKNOWN | T: connection mode HTTP | DNS whitelist | DOCUMENTED (T) | L | T: SW extreme-networks/wing-controller |
| Huawei | AC / FAT AP (V200R019/R020) | `huawei-portal` (post-back via AC HTTP listener) | Keyword names are **configurable** ("URL Option Settings"); T set `ac-ip`, `redirect-url`, `user-ip`, `ap-mac`, `user-mac`, MAC format normal, separator `:` | Portal server profile, "HTTP-based" interpretation mode, AC listens on HTTP port 8000 (default); portal also has a "Packet port number 50100" + shared key (Huawei Portal protocol), so whether HTTP-only works is REQUIRES_DEVICE_TEST | A + Acct (RADIUS template, T) | UNKNOWN | T: HTTPS-based mode possible if AC has a cert | ACL 6030 with domain rules + AC IP:8000 + DNS (T) | DOCUMENTED (T) | L | T: SW huawei/huawei-ac |
| Huawei | eKit cloud (AP361, ≥ V200R023C00SPC200) | post-back ("Relay Authentication") | URL template parameters `device-mac`, `user-mac`, `loginurl`, `redirect-url`; credential field names configurable (T: `username`, `password`; success URL param `redirect_url`) | Browser POST credentials to `loginurl` (protocol HTTPS, T) | A (PAP) + real-time accounting (15 min, T); MAC format `XX-XX-XX-XX-XX-XX` | UNKNOWN | T: HTTPS | "Default permit rule" with domains | DOCUMENTED (T) | L | T: SW huawei/huawei-ekit |
| Grandstream | GWN76xx (local / GWN Cloud), fw ≥ 1.0.25.3 | post-back (generic) | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION | A (PAP per other T) + Acct (interval 600 s), "RADIUS NAS ID" field (T) | UNKNOWN | T: HTTPS Redirection and Secure Portal off | Pre-authentication rules (hostname, Web service) | DOCUMENTED (T) | L | T: SW grandstream/* |
| EnGenius | EnGenius Cloud (e.g. ECW520 fw 1.10.103) | post-back (generic) | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION | A PAP + Acct (T) | UNKNOWN | T: "HTTPS Login: Enabled" | Walled garden list | DOCUMENTED (T) | L | T: SW engenius |
| Zyxel | Nebula APs (fw ≥ V6.10(ABDF.8)) | `meraki-splash`-like **REQUIRES_CLARIFICATION** ("Sign-in method: My RADIUS server") | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION | A (T); source (AP vs cloud) UNKNOWN | UNKNOWN | T: external URL https | Walled garden ranges, **20-entry limit** (T) | DOCUMENTED (T) | L | T: SW zyxel-nebula |
| DrayTek | Vigor routers (2862, 2865, 2926, …) | post-back (generic, gateway) | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION (T: "Redirection URL" points at a DrayTek-hosted name) | A + Acct (T) | UNKNOWN | T: HTTPS Redirection disabled | Whitelist → Dest Domain | DOCUMENTED (T) | L | T: SW draytek-vigor |
| Ruijie | Reyee EG gateways (ReyeeOS ≥ 2.283) + RAP APs | post-back (generic, gateway) ("Auth Protocol: WISPr", "Request Parameters: Ruijie" preset) | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION | A PAP + Acct (T) | UNKNOWN | T: `http://` portal | Pre-auth Allowlist | DOCUMENTED (T) | L | T: SW ruijie |
| DCN | DCWS AC + WL8200 APs | post-back (generic) ("Portal+Radius"; "AUTH AC URL" `http://<AC IP>:8080/auth.html`) | REQUIRES_CLARIFICATION | Browser to AC `auth.html` (T) | A + Acct (T) | UNKNOWN | T: HTTP | URL filter + free resource | DOCUMENTED (T) | L | T: SW dcn |
| Tanaza | TanazaOS | post-back (generic) | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION | A + Acct (T) | UNKNOWN | T: `https://` splash URL | Pre-built domain sets | DOCUMENTED (T) | L | T: SW tanazaos |
| OpenMesh | CloudTrax ("Hosted remotely" splash + RADIUS) | `uam-chillispot`-like **REQUIRES_CLARIFICATION** | REQUIRES_CLARIFICATION | REQUIRES_CLARIFICATION ("Use MAC addr for password" option, T) | A + Acct; T needed an on-AP iptables DNAT to reach non-1812 ports (**suggests fixed 1812/1813**, inference) | UNKNOWN | T: `http://` | Walled garden list | DOCUMENTED (T) | L | T: SW openmesh. Product status (EOL) REQUIRES_CLARIFICATION |
| Any vendor | 802.1X / MAC-auth SSID (no portal) | `generic-radius-8021x` | n/a | n/a (EAP or MAC auth) | A + Acct; CoA per vendor | per vendor | n/a | n/a | — | — | design family; see §3.1 |

## 2. Adapter families

Vendors that share a mechanism share one adapter implementation with a per-vendor **profile** (parameter-name map, login target builder, MAC format, accounting quirks). The registry (`packages/adapters/src/registry`) gets one row per vendor × product line × firmware. `adapterKey` is set only when an adapter exists (V6/V9).

| # | Proposed adapter key | Strategy (`AuthorizationStrategy`) | Member vendors / product lines | Shared mechanism |
|---|---|---|---|---|
| F1 | `coovachilli-uam` (existing; plus `openwifi-uspot-uam`, `uspot-upstream-uam`) | browser-form (GET-302 `/logon`) | EZEAP/EZEGATE (first party), **Teltonika RutOS**; candidates REQUIRES_CLARIFICATION: OpenMesh CloudTrax, Extreme HiveOS "UAM Basic" | ChilliSpot UAM: `challenge`, `uamip`/`uamport`, `md` signature, PAP-XOR or CHAP |
| F2 | `mikrotik-hotspot` | browser-form (POST to `$(link-login-only)`) | MikroTik RouterOS (native, or **gateway** in front of any AP brand) | Router-hosted `login.html` template that ECLOUD generates; RADIUS PAP/CHAP; Mikrotik VSAs |
| F3 | `external-portal-postback` (engine) with vendor profile keys: `cisco-webauth`, `aruba-ecp`, `fortinet-ecp`, `ruckus-wispr`, `cambium-hotspot`, `omada-external-portal` (RADIUS mode), `huawei-portal`, and `postback-generic` (profile-driven) | browser-form (auto-submitted POST) | Cisco 9800 + AireOS; Aruba Instant/Central/AOS 8 (+ Alcatel Stellar Express, which is likely); FortiGate/FortiWiFi; Ruckus ZD/Unleashed (+ SmartZone browser login); Cambium; Omada RADIUS mode; Huawei AC/eKit; Grandstream, EnGenius, DrayTek, Ruijie, DCN, Tanaza, WiNG, Alcatel Cirrus (profiles pending capture) | AP redirects with identity params, the portal auto-POSTs `username`/`password` (plus vendor fields) back to a **login URL on the AP/controller**, and the AP/controller sends RADIUS Access-Request |
| F4 | `meraki-splash` | browser-form (POST to `login_url`) / grant (GET `base_grant_url`) | Cisco Meraki MR; Zyxel Nebula (candidate, REQUIRES_CLARIFICATION) | **Cloud-hosted** login endpoint; RADIUS originates from the vendor cloud, not from the site |
| F5 | `unifi-external-portal` | backend-api | UniFi Network ≥ 9.1.105 | ECLOUD calls the controller's Network API to authorise the client MAC; limits in the API body; no RADIUS |
| F6 | `omada-external-portal` (API mode, same key as F3 Omada with a mode flag) | backend-api | Omada Controller 5.0.15+ (hotspot operator API); 6.2.10+ with limits | Operator login, then `extPortal/auth` |
| F7 | `mist-guest-portal` | browser-form (GET-302 to a signed vendor URL) | Juniper Mist | ECLOUD signs a time-limited authorise URL with the WLAN API secret (HMAC-SHA1) |
| F8 | `ruckus-wispr` (NBI mode) | backend-api | Ruckus One; SmartZone NBI | JSON `UserOnlineControl`/`Login` to the controller NBI |
| F9 | `generic-radius-8021x` | `Unsupported` (no portal) | Every enterprise vendor's 802.1X / MAC-auth SSID | Standard RADIUS A/Acct (+ per-vendor CoA) |

Why F3 is one engine and not N adapters: every member does the same three things. It (1) parses an untrusted query, (2) issues a single-use broker credential bound to NAS + client MAC (D-018), and (3) renders an auto-submitting form whose action URL and field names come from the profile. Only the profile differs. Cambium (plan §5.2) already proves the shape. A profile is data: redirect param map (apMac/clientMac/ssid/clientIp/originalUrl/opaque-token), login target builder (from a redirect param such as `switch_url`, `post`, `sip`, `ga_srvr`, `target`+`targetPort`, `loginurl`, or a fixed name such as `securelogin.arubanetworks.com`), field names, extra constant fields (`buttonClicked=4`, `cmd=authenticate`, `authType=2`), allowed target host classes, MAC normaliser and accounting quirks.

## 3. What ECLOUD must implement, per family

Common to all families (existing contract, `packages/adapters/src/vendor/types.ts`):

- `parseRedirect` keeps the raw query byte-for-byte (`vendorOpaque.raw`); decoded values are display copies only.
- `validateContext` resolves the **registered** NAS server-side and never trusts the query for tenant identity (plan §5.3, SECURITY §5.6–5.7). The AAA layer rejects when the RADIUS-resolved NAS ≠ the credential binding or `Calling-Station-Id` ≠ the bound MAC.
- The single-use broker credential (TTL 90 s) is the anti-forgery backbone for every RADIUS-backed family. A forged redirect yields a credential usable only through the real registered NAS.
- Hand-off URLs that come from the query (`switch_url`, `post`, `sip`, `ga_srvr`, `target`) are **browser targets only**. ECLOUD never fetches them. They are accepted only if they match the registered device address, or (until devices are registrable) an RFC 1918/6598 address or a documented vendor-intercepted name (`securelogin.arubanetworks.com`, the Cisco virtual IP). This follows `safeUserUrl` / `isPrivateIpv4` in `uam.ts`.
- Return URLs (`url`, `userurl`, `continue_url`, `originUrl`, `ga_orig_url`, `dst`) go through `safeUserUrl`.

Contract gaps found. Status after **multi-vendor Cycle A (foundation, 2026-10-10, D-044)**: the
first five are addressed in code (MULTI_VENDOR_INTEGRATION_PLAN.md §13); the rest stay open for the
cycles named.

| Gap | Where | Needed by | Cycle A status |
|---|---|---|---|
| `NasLookup.findNas` keys on `nasid`/`called` only | `vendor/types.ts` | F3–F8 identify by AP MAC (`ap_mac`/`apmac`/`mac`/`ga_ap_mac`/`apMac`) or controller site, so add `apMac` + `controllerId` lookups | **ADDRESSED.** `findNas` query gains `apMac` / `controllerId`; migration 028 `nas_access_points` (AP MAC, globally unique among live rows, child of a NAS); `apps/api/src/internal/nas-lookup.ts` `findNasByIdentity` fails closed on unknown, ambiguous, disabled or conflicting (`nasid` ≠ AP) identities; the UAM portal already uses it for `called`. `controllerId` lookup itself is wired by the first controller-based profile (Cycle C/D) |
| `isReplay` key requires `challenge` | `vendor/types.ts` | Post-back vendors have no challenge. Use the vendor nonce (`magic`, `ga_Qv`, `login_url`, `t`) or an ECLOUD-issued nonce | **ADDRESSED.** `isReplay` key gains `nonceKind` (`uam-challenge` / `vendor-nonce` / `ecloud-login-token`, separate Redis namespaces); `packages/adapters/src/vendor/login-token.ts`: ECLOUD-issued HMAC-SHA256 login token (HKDF purpose `ecloud:portal:login-token:v1`) bound to {org, site, NAS, client MAC, flow}, TTL ≤ 300 s, single use via an injected `SET NX` store, constant-time compare. The F3 engine (Cycle C) issues and consumes it |
| `ParsedRedirect.signature.kind` is `'uam-md5' \| 'none'` | `vendor/types.ts` | All F2–F8 inbound redirects are unsigned (`none`), except Aruba AOS 8 with `url-hash-key` (algorithm REQUIRES_CLARIFICATION) | open (no new kind needed until Aruba `url-hash-key` is clarified; unsigned redirects rely on the login token + RADIUS binding). Cycle C: still REQUIRES_CLARIFICATION; the F3 engine uses the login token + vendor nonce + MAC-bound credential |
| `RegisteredNas` carries only `uamServerUrl`/`uamSecret`; `HandoffSecrets` only `uamSecret` | `vendor/types.ts` | F5 API key, F6 operator name/password, F7 WLAN API secret, F8 `RequestPassword`. Secret references only (D-033) | **STORAGE ADDRESSED.** Migration 028 `vendor_api_credentials` (one per controller: `api_kind`, `base_url`, `username`, sealed `secret_ref` with purpose `ecloud:vendor-api:secret:v1`, `external_org_id`/`external_site_id`); write-only `POST/GET/DELETE /controllers/{id}/api-credential`, SSRF-guarded URL, audited without values, refused while impersonating. Passing the opened secret into `HandoffSecrets` is Cycle D (first outbound call) |
| `RateAttrFamily` = `wispr \| chillispot`; `RadiusVendor` lacks MikroTik | `policy-engine/src/capabilities.ts` | F2 needs a `mikrotik` family (`Mikrotik-Rate-Limit` string "rx/tx", where rx = client **upload**) | **ADDRESSED.** `RateAttrFamily` + `mikrotik`, `RadiusVendor` + `Mikrotik`, combined-attribute rate families in `translate()`; `packages/policy-engine/src/mikrotik.ts` renders `rx/tx` (k/M units, optional burst syntax) with DOCUMENTED / REQUIRES_DEVICE_TEST declarations; FreeRADIUS already loads `dictionary.mikrotik` |
| No "API limits" output from `translate()` | engine | F5/F6/F7 express rate/time/quota as API body fields, not RADIUS reply attributes. This needs a translation target besides `buildReplyAttributes` | open (Cycle D) |
| `DeploymentMode` single-valued per row | registry | MikroTik is native **and** gateway | **ADDRESSED (Cycle B)**: row `mikrotik-routeros-hotspot` has `deploymentModes: ['gateway', 'native']` (the NAS picks one; unspecified defaults to `native` as for any multi-mode adapter) |
| D-032 tunnel-only RADIUS from the site | DECISIONS | F4 (Meraki cloud), FortiLAN Cloud and possibly Ruckus One/cnMaestro send RADIUS **from vendor cloud IPs**. These are shared across all tenants, so "packet source → NAS → tenant" breaks. This needs RadSec or a public RADIUS listener per tenant identity | decided by D-044 (NAS-Identifier + per-NAS secret for Meraki); build-only until an approved exposure change (D-043) |

Also delivered in Cycle A: the F9 `generic-radius-8021x` adapter (§3.1 below) with opt-in
EAP-TTLS/PAP in FreeRADIUS and MAC-as-username MAB.

Per-field status tables below list D-028 fields. `ECLOUD_SIDE_ONLY` rows are identical for every RADIUS family: account/voucher validity, schedules and concurrency are decided before Accept, and Session-Timeout is clipped (POLICY_ENGINE §1.1). They are repeated only as "validity/voucher/schedule/concurrency".

### 3.1 F9 `generic-radius-8021x`

- **Cycle A status: implemented** (engine key `generic-radius-8021x`, registry row `generic-radius-8021x`, lifecycle `implemented`, every enforcement cell DOCUMENTED / REQUIRES_DEVICE_TEST). Per-vendor Called-Station-Id parsing and attribute dictionaries are still open.
- **Implement:** reuse the `openwifi-hostapd-radius` shape (no portal). Per-vendor attribute dictionary and Called-Station-Id parsing (`AP-MAC:SSID` vs other formats; Cisco "ap-macaddress-ssid", Huawei/Aruba unknown).
- **Cannot:** no portal UX, no click-through or social login.
- **Status (DOCUMENTED):** rate `UNKNOWN` per vendor · session/idle timeout `REQUIRES_DEVICE_TEST` (standard attributes; not yet confirmed per vendor) · VLAN `UNKNOWN` per vendor · quotas `UNKNOWN` · Disconnect/CoA per vendor (see the family rows below) · validity/voucher/schedule/concurrency `ECLOUD_SIDE_ONLY`.

### 3.2 F1 `coovachilli-uam` for Teltonika

- **Implement:** a registry row and setup guide only; the adapter exists. Confirm that RutOS passes the standard UAM parameters and `md` (REQUIRES_DEVICE_TEST).
- **Note:** the third-party guide leaves "UAM secret" empty. ECLOUD must require a UAM secret so that `md` can be verified, as SECURITY §5.2 requires for uspot. The RutOS "Password encoding" toggle must match ECLOUD's PAP-XOR encoder (REQUIRES_DEVICE_TEST).
- **Status:** inherits the `coovachilli-uam` engine record, but presented as `REQUIRES_DEVICE_TEST` via the V11 override (`sourceVersionMatchesDevice: false`, because the RutOS CoovaChilli build is unknown).
- **Cycle B status (2026-10-10): implemented as a profile.** Vendor `teltonika` promoted to `implemented`; registry row `teltonika-rutos-hotspot` (`coovachilli-uam`, gateway, V11 override, nothing VERIFIED); `getVendorProfile('teltonika')` = the coovachilli-uam wrapper with its own setup guide (`packages/adapters/src/vendor/teltonika.ts`). The Teltonika wiki answered HTTP 403 to curl and WebFetch again, so RutOS UI field names other than those recorded above stay **REQUIRES_CLARIFICATION**; UAM parameter set, `md`, "Password encoding" and CoA stay **REQUIRES_DEVICE_TEST**. No parameter difference from CoovaChilli is documented, so none is implemented.

### 3.3 F2 `mikrotik-hotspot`

- **Redirect parsing:** ECLOUD generates the router's `login.html` (plus `alogin`/`rlogin`/`flogin` as needed) as part of the setup guide. The template redirects to `https://<portal>/mikrotik/?…` with ECLOUD-chosen names filled from `$(mac-esc)`, `$(ip)`, `$(link-login-only)`, `$(link-orig-esc)`, `$(chap-id)`, `$(chap-challenge)`, `$(identity)`, `$(server-address)`. Because the template is static, it **cannot sign** the redirect.
- **Login completion:** auto-submitted POST to `$(link-login-only)` with `username`, `password`, `dst`. Use PAP only together with `login-by=https` on the router. Otherwise ECLOUD computes CHAP: `MD5(chap-id ‖ password ‖ chap-challenge)`. The portal can compute CHAP server-side because it holds the single-use password and receives `chap-id`/`chap-challenge` in the redirect. This avoids any plaintext password on HTTP.
- **Anti-forgery:** RADIUS binding (source IP of the WireGuard peer → NAS; `Calling-Station-Id` is the client MAC in capitals per vendor doc). Add `$(chap-challenge)` into the replay key.
- **RADIUS mapping:** `Mikrotik-Rate-Limit` (new family), `Session-Timeout`, `Idle-Timeout`, `Acct-Interim-Interval`, `Mikrotik-Total-Limit` + `-Gigawords` (quota), `Mikrotik-Address-List` / `Filter-Id` (optional). Access-Request: `Called-Station-Id` = hotspot server name, `NAS-Identifier` = router identity, `NAS-Port-Id` = interface.
- **Disconnect/CoA:** the setup guide must enable `/radius incoming accept=yes` and either set `port=3799` or ECLOUD must target the documented default **1700**. Which attributes CoA may change on hotspot sessions is REQUIRES_DEVICE_TEST (only a third-party list was found).
- **Message-Authenticator:** `require-message-auth` default `yes-for-request-resp` (vendor doc), so FreeRADIUS replies must carry Message-Authenticator.
- **Cannot:** no burst via ECLOUD intent (the engine has none, D-028 stage 10), although the device syntax supports it. Firmware: RouterOS 7.0–7.4 hotspot reported broken (T); device-mode on ≥ 7.17 factory images (T).
- **Cycle B status (2026-10-10): implemented** (`mikrotik-hotspot`, row `mikrotik-routeros-hotspot`, lifecycle `implemented`, every cell DOCUMENTED / REQUIRES_DEVICE_TEST, nothing VERIFIED). Re-read on help.mikrotik.com (RouterOS 7.26 pages, §7): the redirect uses exactly the RouterOS variable names (`mac`, `ip`, `identity`, `link-login-only`, `link-orig`, `chap-id`, `chap-challenge`, `error`) with `$(name-esc)` values, so the query names are no longer ECLOUD-chosen; the hand-off POSTs the documented login.html fields `username`, `password`, `dst`, `popup`. `chap-id` / `chap-challenge` are octal-escaped bytes in the vendor examples (`"\371"`); whether `-esc` keeps them intact is REQUIRES_DEVICE_TEST. Anti-forgery: CHAP challenge = replay nonce, ECLOUD login token consumed once per redirect, plus the RADIUS binding. CHAP is verified by FreeRADIUS against `Cleartext-Password` returned for that credential only. **CoA change** is now vendor-documented (RADIUS page "Change of Authorization" lists Mikrotik-Rate-Limit, Session-Timeout, Idle-Timeout, …) → still REQUIRES_DEVICE_TEST. `Mikrotik-Total-Limit` / `-Gigawords` appear only in the vendor numeric table (17/18), semantics not described → REQUIRES_DEVICE_TEST. Disconnect port: NAS `coa_port`, defaulting to the documented 1700. Not done: HotSpot `dns-name` / non-IP login targets and `login-by=mac` (REQUIRES_CLARIFICATION).

| Field | Status | Evidence |
|---|---|---|
| up/down rate | REQUIRES_DEVICE_TEST | DOCUMENTED V (manual.mikrotik.com radius) |
| session timeout | REQUIRES_DEVICE_TEST | DOCUMENTED V |
| idle timeout | REQUIRES_DEVICE_TEST | DOCUMENTED V |
| total/daily quota | REQUIRES_DEVICE_TEST (session-scoped byte limit; daily/monthly accounting is ECLOUD_SIDE_ONLY) | DOCUMENTED V |
| VLAN | UNKNOWN | — |
| burst | UNSUPPORTED (engine) | POLICY_ENGINE §3.1 |
| Disconnect | REQUIRES_DEVICE_TEST | DOCUMENTED V (`/radius incoming`) |
| CoA change | REQUIRES_DEVICE_TEST | DOCUMENTED T only |
| interim accounting | REQUIRES_DEVICE_TEST | DOCUMENTED V |
| validity/voucher/schedule/concurrency | ECLOUD_SIDE_ONLY | POLICY_ENGINE §1.1 |

### 3.4 F3 `external-portal-postback` (engine + profiles)

- **Cycle C status (2026-10-10): implemented, DOCUMENTED / REQUIRES_DEVICE_TEST.** Engine key
  `external-portal-postback` (migration 030), profiles `cambium-hotspot`, `aruba-ecp`,
  `cisco-webauth`, `fortinet-ecp`, `ruckus-wispr`, `omada-external-portal`, `huawei-portal` (eKit
  relay, HTTP only) and the admin-configured `postback-generic`; per-NAS `adapter_config`; portal
  entry `/pb/<profile>/<nasid>/`; Cycle A login token + single-use `pc-…` credential; standard
  RADIUS attributes only. Details and open items: MULTI_VENDOR_INTEGRATION_PLAN.md §15. Aruba
  `url-hash-key` stays REQUIRES_CLARIFICATION (algorithm not found in any source read; HPE Central
  help page returned 403 again on 2026-10-10).

- **Implement:** a generic parser driven by the profile map, target validation (above), and an auto-submit form page with no third-party scripts and a CSP that allows `form-action` only to the validated target. Keep the vendor opaque token unchanged (`ga_Qv`, `magic`).
- **Login completion:** POST credential + vendor constants. The table below gives profile values from §1.
- **RADIUS mapping:** standard attributes (Session-Timeout, Idle-Timeout, Acct-Interim-Interval, Class) on all profiles. Bandwidth only where a vendor attribute is documented (Cambium `WIFI_ALLIANCE_MAX_*`, unit unknown). Otherwise rate is `UNKNOWN`, and the editor shows "not device-enforced".
- **HTTPS / mixed content:** the ECLOUD portal is HTTPS (D-039 `portal.ezecloud.ezelink.ai`). Posting to an `http://` private target (Cisco virtual IP, Cambium :880, Ruckus :9997, Fortinet :1000, Omada :8088, MikroTik HTTP) triggers browser insecure-form warnings and possibly Private Network Access restrictions. Prefer the vendor's HTTPS variant where it exists (Aruba `securelogin` with AP cert, Ruckus :9998, Cambium :444, Fortinet `auth-secure-http`, Omada :8843/`browserauth`, Cisco virtual IP with trustpoint). All of this is REQUIRES_DEVICE_TEST on iOS/Android captive browsers.

| Profile | Login target source | Fields posted | Opaque/nonce | Notes |
|---|---|---|---|---|
| `cisco-webauth` | `switch_url` | `buttonClicked=4`, `err_flag=0`, `redirectUrl` (spelling REQUIRES_DEVICE_TEST), `username`, `password` | none | param names configurable on 9800 (setup guide fixes them) |
| `aruba-ecp` | fixed `https://securelogin.arubanetworks.com/cgi-bin/login` or `/swarm.cgi`, or `switchip` when sent | `cmd=authenticate`, `user`, `password`, `url` | none | POST target is V-c/T only |
| `fortinet-ecp` | `post` | `magic`, `username`, `password` | `magic` | ≤ 125 chars POST data |
| `ruckus-wispr` (browser) | `http(s)://<sip>:9997/9998/login` (ZD/Unleashed) | `username`, `password` (≤ 31), `ip` when L3 NAT | none | SmartZone path REQUIRES_CLARIFICATION |
| `cambium-hotspot` | `ga_srvr` + `:880/cgi-bin/hotspot_login.cgi` (or 444) | `ga_user`, `ga_pass` (+ query appended, plan OQ-10/12) | `ga_Qv` | plan §7.3 |
| `omada-external-portal` (RADIUS) | `target`:`targetPort` + `/portal/radius/browserauth` | `clientMac`, `clientIP`, `apMac`/`gatewayMac`, `ssidName`/`vid`, `radioId`, `authType=2`, `originUrl`, `username`, `password` | none | name case inconsistent in vendor doc |
| `huawei-portal` | AC `ac-ip`:8000 (AC) / `loginurl` (eKit) | configurable | none | Huawei Portal protocol (UDP 50100) role REQUIRES_CLARIFICATION |
| `postback-generic` | REQUIRES_CLARIFICATION per vendor | — | — | Grandstream, EnGenius, DrayTek, Ruijie, DCN, Tanaza, WiNG, Alcatel: capture a real redirect in the lab first |

| Field | Status (all F3 profiles unless noted) |
|---|---|
| up/down rate | UNKNOWN (Cambium: REQUIRES_DEVICE_TEST, units unknown) |
| session timeout | REQUIRES_DEVICE_TEST (Cambium, Ruckus ZD, Cisco documented; others UNKNOWN) |
| idle timeout | REQUIRES_DEVICE_TEST (Cambium documented; others UNKNOWN) |
| quotas | UNKNOWN |
| VLAN | UNKNOWN |
| Disconnect | UNKNOWN (Cisco 9800, FortiGate, Aruba IAP have a CoA/DA option in the UI per T: REQUIRES_DEVICE_TEST) |
| CoA change | UNKNOWN |
| interim accounting | REQUIRES_DEVICE_TEST (Ruckus ZD, Cisco, Cambium, Omada, Grandstream documented) |
| validity/voucher/schedule/concurrency | ECLOUD_SIDE_ONLY |

### 3.5 F4 `meraki-splash`

- **Implement:** for sign-on, POST `username`/`password`/`success_url` to `login_url`. For click-through, GET `base_grant_url?continue_url=…&duration=` (no RADIUS, so no ECLOUD AAA enforcement beyond `duration`). Validate that `login_url`/`base_grant_url` host is a Meraki-hosted name (`*.network-auth.com` per vendor example; full allow-list REQUIRES_CLARIFICATION).
- **RADIUS:** Access-Requests come from Meraki cloud public IPs. ECLOUD must expose RADIUS to those IPs (conflicts with D-032) and map tenant by NAS-Identifier/Called-Station-Id plus a per-network secret. **REQUIRES_CLARIFICATION.** Disconnect goes to the org's Meraki FQDN :3799 and needs `Acct-Session-Id` + `Event-Timestamp`.
- **Cannot:** CoA changes (vendor doc: only Disconnect). Per-user rate is only possible via `Filter-Id` → pre-defined Dashboard group policy, so ECLOUD cannot push arbitrary rates.

| Field | Status |
|---|---|
| up/down rate | REQUIRES_DEVICE_TEST via `Filter-Id` group policy only (arbitrary values UNSUPPORTED) |
| session timeout | REQUIRES_DEVICE_TEST (Session-Timeout mentioned) |
| idle timeout | UNKNOWN |
| quotas, VLAN | UNKNOWN |
| Disconnect | REQUIRES_DEVICE_TEST (documented, cloud FQDN) |
| CoA change | UNSUPPORTED (DOCUMENTED V) |
| interim accounting | UNKNOWN |
| validity/voucher/schedule/concurrency | ECLOUD_SIDE_ONLY |

### 3.6 F5 `unifi-external-portal`

- **Parse:** `ap`, `id`, `ssid`, `url`, `t`. Look up the client via `GET /v1/sites/{siteId}/clients?filter=macAddress.eq('…')`, then authorise with `POST …/clients/{clientId}/actions`. Revoke with the `UNAUTHORIZE_GUEST_ACCESS` action (name seen only in third-party search output: REQUIRES_CLARIFICATION).
- **Anti-forgery:** the redirect is unsigned. ECLOUD authorises only a client MAC that the controller reports as a GUEST, unauthorised client on the registered site/AP, so a forged MAC can only authorise a device actually present.
- **Reachability:** ECLOUD → controller HTTPS. Use the WireGuard hub (D-032) toward a local controller. Third-party evidence notes that remote/cloud-hosted controllers add up to ~30 s authorisation delay and roaming re-prompts (inform interval).
- **Mapping:** EffectivePolicy → `timeLimitMinutes`, `dataUsageLimitMBytes`, `rxRateLimitKbps`/`txRateLimitKbps` (rx/tx direction semantics REQUIRES_DEVICE_TEST).
- **Cannot:** RADIUS accounting (none), Disconnect via RFC 5176 (use the API action instead), idle timeout (not in the API body).

| Field | Status |
|---|---|
| up/down rate | REQUIRES_DEVICE_TEST (API fields documented V) |
| session timeout | REQUIRES_DEVICE_TEST (`timeLimitMinutes`) |
| idle timeout | UNKNOWN |
| total quota | REQUIRES_DEVICE_TEST (`dataUsageLimitMBytes`) |
| VLAN | UNKNOWN |
| Disconnect | REQUIRES_DEVICE_TEST via API action (no RFC 5176) |
| CoA change | UNKNOWN (re-authorise semantics unknown) |
| accounting | UNSUPPORTED via RADIUS; usage only by API polling (`ECLOUD_SIDE_ONLY` normalisation) |
| validity/voucher/schedule/concurrency | ECLOUD_SIDE_ONLY |

### 3.7 F6 `omada-external-portal` (API mode)

Operator login → `Csrf-Token` → `extPortal/auth` (`authType` "4", `time` in microseconds). On ≥ 6.2.10, `totalTrafficLimitBytes`, `downloadRateLimitKbps`, `uploadRateLimitKbps` are also sent. Controller URL includes the controller ID. Store the operator credential as a secret reference. Paid "Standard" cloud plan needed; the "Essentials" plan lacks captive portal (T). Statuses mirror F5 (rate/quota REQUIRES_DEVICE_TEST only on 6.2.10+; UNKNOWN before).

### 3.8 F7 `mist-guest-portal`

- **Parse:** `wlan_id`, `ap_mac`, `client_mac`, `url`, `ap_name`, `site_name`.
- **Complete:** build `token` and `expires`, compute HMAC-SHA1 with the WLAN API secret (server-side only), and 302 the browser to the regional `/authorize`. The signed URL is short-lived (`expires`), so it is the anti-forgery mechanism toward Mist. Inbound redirect is unsigned. Validate `ap_mac`/`wlan_id` against the registered Mist org/site.
- **Cannot:** RADIUS/accounting in this mode; per-user rate. A JWT alternative was reported by a search summary but not seen on the fetched vendor pages (REQUIRES_CLARIFICATION).
- **Status:** session duration REQUIRES_DEVICE_TEST (`authorize_min`). Everything else UNKNOWN, except the four ECLOUD_SIDE_ONLY fields.

### 3.9 F8 `ruckus-wispr` NBI mode

Server-side JSON to `nbiIP`/regional host `/portalintf` (`RequestCategory`, `RequestType` "Login", `UE-IP`/`UE-MAC` as received, encrypted accepted). `RequestPassword` = NBI password (secret). ECLOUD must reach the NBI (cloud: HTTPS 443; SmartZone: 9080/9443 per T). Fields mirror F3 Ruckus for RADIUS-side attributes.

## 4. Recommended build order to reach "all vendors"

Coverage reasoning: MikroTik as gateway makes **any** AP brand usable immediately (bridge APs to the guest VLAN, as Social WiFi itself recommends as a UniFi workaround). The F3 engine then unlocks the largest number of native vendors per unit of work.

| Step | Deliverable | Unlocks | Effort |
|---|---|---|---|
| 1 | `generic-radius-8021x` registry rows + per-vendor Called-Station-Id parsing | enterprise SSIDs on every vendor | S |
| 2 | `mikrotik-hotspot` (template generator, CHAP hand-off, `mikrotik` rate family, `/radius incoming` setup) | MikroTik native **and gateway mode for any AP** | M |
| 3 | Teltonika row + guide on existing `coovachilli-uam` | Teltonika | S |
| 4 | F3 `external-portal-postback` engine + contract gaps (`findNas` by AP MAC, nonce replay key, target validation, auto-submit page) | foundation | L |
| 5 | F3 profiles with vendor-doc evidence: `cisco-webauth` (9800 first), `aruba-ecp`, `fortinet-ecp`, `cambium-hotspot`, `ruckus-wispr` (ZD/Unleashed), `omada-external-portal` RADIUS | Cisco, Aruba (+Alcatel Express likely), Fortinet, Cambium, Ruckus, Omada | S each (6 × S ≈ M) |
| 6 | `unifi-external-portal` (API client, secret storage, tunnel reachability, limits mapping) | UniFi ≥ 9.1.105 | M |
| 7 | Decision on cloud-originated RADIUS (RadSec/public listener, tenant mapping), then `meraki-splash` | Meraki, then Zyxel Nebula / FortiLAN Cloud if they prove similar | M (after decision) |
| 8 | `mist-guest-portal` | Juniper Mist | S |
| 9 | `omada-external-portal` API mode + `ruckus-wispr` NBI mode | Omada without RADIUS, Ruckus One/SmartZone | M |
| 10 | Long-tail `postback-generic` profiles after lab capture: Grandstream, EnGenius, Huawei AC/eKit, Zyxel, DrayTek, Ruijie, DCN, Tanaza, Extreme (CWP/WiNG), Alcatel Cirrus, OpenMesh (if not EOL) | remaining Social WiFi list | S each |

Each step ends at lifecycle `implemented` at most. `lab-validated` needs D-034-style device tests per row.

## 5. "How to configure your access points" gallery (setup-guide feature)

The existing hook is `VendorAdapter.buildSetupGuide(site) → SetupStep[]` (`id`, `title`, `setting`, `value` with placeholders only, `evidenceRefs`).

- **One guide per registry row** (vendor × product line × firmware range), rendered in the admin "gallery". Each card shows the lifecycle badge and the "tested on" line. That line is filled **only** from `LAB_VALIDATED` DT results, never from third-party "tested up to" claims.
- **Values filled by ECLOUD at render time** (never hard-coded, never invented):
  - Portal URL: tenant/vendor path under `portal.ezecloud.ezelink.ai` (D-039; the path scheme is REQUIRES_CLARIFICATION).
  - RADIUS server: the site's WireGuard hub address (D-032 proposes `100.100.0.1`, still subject to collision verification) or the RadSec endpoint. Auth/acct ports and the CoA port come from deployment config. The shared secret is shown once via a reveal-and-copy control from the secret store (D-033), never stored in the guide text.
  - NAS-Identifier convention, interim interval (from policy), walled-garden list = portal host + identity-provider hosts that the tenant enabled. Vendor limits are enforced in the UI (Cisco AireOS and Zyxel: 20 entries per T).
  - Vendor constants: CoA port per vendor (MikroTik default 1700 → guide sets 3799), MAC format, "disable MAC encryption" (Ruckus SZ), "Message-Authenticator" settings.
  - Generated artefacts: MikroTik `login.html` set and a `.rsc` script; Teltonika/Coova UAM secret.
- **Copyright rule:** Social WiFi (and Purple, IronWiFi, etc.) guide text, screenshots, scripts and file names are copyrighted. They are used **only as research**. ECLOUD guides are written fresh from vendor documentation, in ECLOUD's own words and step structure. Vendor UI labels (menu and field names) are factual identifiers and may be quoted. No third-party screenshots; ECLOUD captures its own in the lab. Each step cites the vendor source URL in `evidenceRefs`.
- **Safety:** guides include a pre-flight checklist (firmware minimums, licence/plan requirements such as Omada Standard, UniFi controller reachability, Meraki account for accounting) and an explicit "what ECLOUD cannot enforce on this device" panel driven by §3 statuses.

## 6. Open questions / not verified (REQUIRES_CLARIFICATION)

1. **Cloud-originated RADIUS vs D-032** (Meraki cloud, FortiLAN Cloud, possibly Zyxel Nebula, cnMaestro "post through"): public listener, RadSec, or proxy? How is the tenant identified when many tenants share one vendor source IP? Owner decision needed.
2. MikroTik CoA/Disconnect attribute set for hotspot sessions on current RouterOS (vendor doc lists `/radius incoming` but not per-service support). Vendor doc states `port` default **1700**, not 3799; confirm on the target RouterOS version. (Cycle B: the RADIUS page does list CoA-changeable attributes; Disconnect identification attributes remain undocumented → REQUIRES_DEVICE_TEST; ECLOUD defaults the NAS CoA port to 1700.)
3. Aruba: POST target (`swarm.cgi` vs `cgi-bin/login`) and fields come from V-c/T sources only. `url-hash-key` algorithm on AOS 8 is unknown. Instant On intercept hostname is firmware-dependent. (Cycle C re-checked 2026-10-10: still undocumented; profile `aruba-ecp` posts to `cgi-bin/login` and the setup guide leaves `url-hash-key` unset.)
4. Cisco: the 9800 vendor text says `redirectUrl`, but a common form uses `redirect_url`. AireOS redirect parameter names were not re-verified from a Cisco document in this pass.
5. Omada: vendor doc mixes `clientIp`/`clientIP`, `originUrl`/`originalUrl`, `gatewayMac`/`GatewayMac`, and spells `raidusServerIp`. The 6.2.10 change list ("removal of legacy parameters") was not fully enumerated.
6. Meraki: full redirect parameter list (`ap_mac`, `client_mac`, `node_mac`, …) not shown on the fetched page. Whether `Filter-Id` group policies apply to splash sign-on is unknown. The complete allowed `login_url` host set is unknown.
7. UniFi: meaning of `t`, the `UNAUTHORIZE_GUEST_ACCESS` action name, whether the Network API is reachable through UniFi cloud connector vs local only, and rx/tx direction semantics.
8. Ruckus SmartZone browser-login path and the SmartZone (not Ruckus One) NBI port/path; whether ZD app-note behaviour (2009) still holds on current Unleashed.
9. Juniper Mist: JWT alternative; meaning of the trailing `0/0/0` token fields (possibly quota/rate, **not** assumed).
10. Huawei: whether the HTTP-based mode works without the Huawei Portal protocol (UDP 50100) server role.
11. Long-tail vendors (Grandstream, EnGenius, Zyxel, DrayTek, Ruijie, DCN, Tanaza, Extreme CWP/WiNG, Alcatel Cirrus/Express, OpenMesh): redirect parameter names and login targets were **not documented** in any fetched source. They need a lab redirect capture (D-034) before any profile is written. OpenMesh/CloudTrax product availability is unknown.
12. Teltonika: exact UAM parameter set and `md` behaviour of the RutOS CoovaChilli build; the "Password encoding" option semantics. (Cycle B: still open; vendor wiki HTTP 403.)
13. Bandwidth attribute names for Cisco, Aruba, Ruckus, Fortinet, Grandstream, EnGenius, Zyxel were **not researched to vendor-doc level**. They stay `UNKNOWN`, never assumed to be WISPr.
14. Mixed-content / Private Network Access behaviour when an HTTPS ECLOUD portal posts to an `http://` private AP target, on current iOS/Android captive network assistants.

## 7. Source index (fetched 2026-10-10)

Third-party, functional reference only (Social WiFi Academy, © Social WiFi; not copied), base `https://academy.socialwifi.com/en/hardware-and-installation/installation-guides/`:
`mikrotik/winbox/`, `mikrotik/webfig/`, `mikrotik/mikrotik-ssl/`, `mikrotik/device-mode/`, `mikrotik/mikrotik-script-generator/`, `mikrotik/vlans-and-additional-aps/unifi-aps-and-mikrotik/`, `ubiquiti/ubiquiti-unifi/`, `ubiquiti/known-issues/`, `ubiquiti/controller-access-for-social-wifi/`, `ubiquiti/installing-remote-access-tunnel/`, `ubiquiti/ubiquiti-unifi-legacy/overview/`, `ubiquiti/ubiquiti-unifi-legacy/controller-configuration/ubiquiti-unifi/`, `tp-link/tp-link-omada/`, `tp-link/tp-link-omada-legacy/`, `cisco/cisco-meraki/`, `cisco/cisco-catalyst/`, `cisco/cisco-wlc/`, `aruba/aruba-iap/`, `aruba/aruba-central/`, `aruba/aruba-instant-on/`, `ruckus/ruckus-one/`, `ruckus/ruckus-unleashed/`, `ruckus/ruckus-virtual-smartzone/`, `ruckus/ruckus-zone-director/`, `fortinet/fortiap/`, `fortinet/fortinet-fortigate-fortiwifi/`, `cambium-networks/cnmaestro/`, `cambium-networks/cnpilot/`, `juniper-mist/`, `extreme-networks/extreme-cloud-iq/`, `extreme-networks/wing-controller/`, `alcatel-lucent/alcatel-lucent-express/`, `alcatel-lucent/omnivista-cirrus/`, `grandstream/grandstream/`, `grandstream/gwn-cloud/`, `huawei/huawei-ac/`, `huawei/huawei-ekit/`, `engenius/`, `openmesh/`, `draytek-vigor/`, `ruijie/`, `tanazaos/`, `teltonika/`, `zyxel-nebula/`, `dcn/`.

Vendor documentation (V) and vendor community (V-c):
- MikroTik: http://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/hotspot-customisation/ ; http://manual.mikrotik.com/docs/authentication-authorization-accounting/radius/ ; Cycle B re-read (RouterOS 7.26): https://help.mikrotik.com/docs/spaces/ROS/pages/87162881/Hotspot+customisation ; https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS ; https://help.mikrotik.com/docs/spaces/ROS/pages/56459266/HotSpot+-+Captive+portal
- Ubiquiti: https://help.ui.com/hc/en-us/articles/31228198640023-External-Hotspot-API-for-Authorization-Clients
- TP-Link Omada: https://support.omadanetworks.com/ae/document/13025/ (RADIUS + external portal, ≥ 4.1.5); https://support.omadanetworks.com/document/13080/ (5.0.15–6.2.0); https://support.omadanetworks.com/us/document/132060/ (≥ 6.2.10)
- Cisco Meraki: https://documentation.meraki.com/MR/MR_Splash_Page/Configuring_a_Custom-Hosted_Splash_Page_to_Work_with_the_Meraki_Cloud ; https://documentation.meraki.com/MR/Splash_Page/CoA_Disconnect_for_Splash_Sign-on ; https://documentation.meraki.com/General_Administration/Cross-Platform_Content/RADIUS_Authentication_and_Accounting_with_a_Sign-On_Splash_Page ; https://documentation.meraki.com/MR/Group_Policies_and_Block_Lists/Using_RADIUS_Attributes_to_Apply_Group_Policies
- HPE Aruba: https://arubanetworking.hpe.com/techdocs/Instant_8.x_WebHelp/Content/instant-ug/captive-portal/conf-ext-cp.htm (via search extract; direct fetch returned 403) ; https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/instant/wlan-ext-captive.htm ; https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/aos8/aaa-auth-cptv-prtl.htm ; V-c: https://higherlogicdownload.s3.amazonaws.com/HPE/MigratedAssets/Howto%20Aruba%20external%20web%20authentication%20(EN).pdf ; https://community.instant-on.hpe.com/communities/community-home/digestviewer/viewthread?MID=167 ; T: https://www.flomain.de/2016/12/aruba-instant-with-external-captive-portal/
- Ruckus: https://docs.cloud.ruckuswireless.com/ruckusone/wispr-api/index.html (+ GUID-1ABE1706…, GUID-76A71DD1…, GUID-4B699767… pages) ; https://webresources.ruckuswireless.com/pdf/appnotes/appnote-wispr.pdf (ZoneDirector, 2009)
- Cisco 9800: https://www.cisco.com/c/en/us/support/docs/wireless/catalyst-9800-series-wireless-controllers/217457-configure-and-troubleshoot-external-web.html
- Fortinet: https://docs.fortinet.com/document/fortiap/7.4.2/fortiwifi-and-fortiap-configuration-guide/292926 ; V-c: https://community.fortinet.com/fortiauthenticator-8/technical-tip-the-typical-captive-portal-workflow-for-an-end-user-with-a-fortigate-fortiwifi-101546
- Cambium: MULTI_VENDOR_INTEGRATION_PLAN.md §7.3 sources C1–C5
- Juniper Mist: https://www.juniper.net/documentation/us/en/software/mist/mist-wireless/topics/task/guest-access-external-portal.html ; https://www.mist.com/documentation/external-guest-portal
- Teltonika: wiki.teltonika-networks.com Hotspot pages (search extract only: "Hotspot service uses CoovaChilli", UAM port 3990, UAM secret); direct page not fetched → treat as REQUIRES_CLARIFICATION for parameter names.

Fetch limitations: help.ui.com and arubanetworking.hpe.com returned HTTP 403 to the direct fetcher. Their content was read through a search/extract service, and the facts above are from that extract. The Ruckus app note is a 2009 ZoneDirector document. The context-mode fetch tool failed (missing module), so pages were fetched with curl/WebFetch and only derived facts were kept.
