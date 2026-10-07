# @ecloud/adapters

The five NAS adapters of `POLICY_ENGINE.md` §3 as data (capability declarations) plus a small
amount of shared code (`base.ts`). Nothing here sends packets; AAA does.

| Key                       | Portal type                 | Granularity | VERIFIED_SUPPORTED fields                                                                                        |
| ------------------------- | --------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `openwifi-hostapd-radius` | none (802.1X / MAC-auth)    | per-client  | none — every RADIUS attribute is `REQUIRES_DEVICE_TEST` (NETWORK_INTEGRATION.md §2)                              |
| `openwifi-uspot-uam`      | `uam-chillispot` (TIP fork) | per-client  | rates, quotas (32-bit `ChilliSpot-Max-Total-Octets`), `session_timeout_s`, `idle_timeout_s`                      |
| `uspot-upstream-uam`      | `uam-chillispot+capport`    | per-client  | rates, quotas (Octets + Gigawords), `session_timeout_s`, `idle_timeout_s`                                        |
| `coovachilli-uam`         | `uam-chillispot+wispr+json` | per-client  | rates, quotas (`CoovaChilli-Max-*-Octets/Gigawords`), `session_timeout_s`, `idle_timeout_s`                     |
| `openwifi-config`         | config-only                 | per-SSID    | rates (`rate-limit` Mbit/s), `session_timeout_s` (`captive.session-timeout`), `idle_timeout_s` (`max-inactivity`) — site-scoped intent only |

Every declaration carries an `evidence` string citing the document section it rests on
(`POLICY_ENGINE.md §3.1`, `NETWORK_INTEGRATION.md §2`, `CAPTIVE_PORTAL_ARCHITECTURE.md §3–§7`,
`AAA_ARCHITECTURE.md §4.3/§6`). `capabilities.test.ts` encodes the expected VERIFIED set per adapter
so a status cannot be upgraded without touching the test (D-028: approved design ≠ verified device
capability). Disconnect is `REQUIRES_DEVICE_TEST` on every RADIUS adapter (D4); `openwifi-config`
has no Disconnect path.

## API

- `getAdapter(key)`, `listAdapters()`, `listCapabilities()` — `registry.ts`
- `NasAdapter` (`types.ts`): `capabilities()`, `translate()`, `buildReplyAttributes()`,
  `describeDisconnect()`, `buildDisconnect()`, `buildCoa()`, optional `renderConfig()`.

Attribute names are exactly the FreeRADIUS dictionary names (`WISPr-Bandwidth-Max-Down`,
`ChilliSpot-Max-Total-Octets`, `CoovaChilli-Max-Total-Gigawords`, `Session-Timeout`, …). The
`ChilliSpot-Max-*-Gigawords` attributes (21–23) are missing from FreeRADIUS's `dictionary.chillispot`
and need the ECLOUD dictionary additions described in `AAA_ARCHITECTURE.md §4.3`.
