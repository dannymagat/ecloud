# Vendor logo sources

Self-hosted vendor logos for the Access Points page (DECISIONS.md D-045). They are used nominatively, served locally, and nothing loads from an external host. Every file was downloaded as a real vendor file, not redrawn. Each was then sanitized: scripts, event handlers, external references, comments, metadata and editor data were removed, and fixed width and height were dropped in favour of the viewBox.

Logos are trademarks of their respective owners and identify compatible hardware only.

Retrieved 2026-10-10.

| key | vendor | source type | source URL | notes |
|---|---|---|---|---|
| mikrotik | MikroTik | official press kit | https://mikrotik.com/logo/library/logo/SVG/MT_Black.svg (from https://mikrotik.com/logo) | MT_Black (full colour black logo); sanitized only |
| ubiquiti | Ubiquiti | Wikimedia Commons | https://commons.wikimedia.org/wiki/File:Ubiquiti_Logo_2023.svg | Ubiquiti 2023 "U" logo mark (black). No official SVG found on ui.com; sanitized only |
| ruckus | RUCKUS Networks | official site | https://webresources.vistancenetworks.com/images/assets/Ruckus-Belden_header-only.svg (header logo of https://www.ruckusnetworks.com/) | Current site header logo (dark). The official file is the co-branded "Belden \| RUCKUS" lockup and no standalone dark RUCKUS SVG was found (the footer variant is white), so only the viewBox was cropped (`164 14 98 42`) to the RUCKUS dog + wordmark (+ its "a Belden brand" line); no path was edited, so the artwork is an exact subset of the official file; otherwise sanitized only |
| cisco | Cisco | Wikimedia Commons | https://commons.wikimedia.org/wiki/File:Cisco_logo_blue_2016.svg | Blue 2016 logo. cisco.com blocked scripted download; sanitized only |
| aruba | HPE Aruba Networking | Wikimedia Commons | https://commons.wikimedia.org/wiki/File:Hpe-aruba-networking-logo.svg | "HPE aruba networking" full colour; sanitized only |
| extreme | Extreme Networks | official site | https://extr-p-001.sitecorecontenthub.cloud/api/public/content/74bd9198c8264d88804e525399036cd3?v=36246f18 (header logo "Extreme-logo.svg" on https://www.extremenetworks.com/) | Full colour (purple); sanitized only |
| fortinet | Fortinet | official site | https://www.fortinet.com/content/dam/fortinet/images/general/fortinet-logo.svg | Full colour header logo; sanitized only |
| cisco-meraki | Cisco Meraki | Wikimedia Commons | https://commons.wikimedia.org/wiki/File:Meraki_Logo_2016_transparent.svg | "cisco Meraki" on a transparent background; sanitized only |
| tplink-omada | TP-Link (Omada) | official site | https://static.tp-link.com/assets/images/icon/logo.svg (TP-Link site logo) | Uses the TP-Link logo, not an Omada logo. The only Omada SVG (https://static.tp-link.com/assets/images/omada/logo.svg) is white-only; sanitized only |
| zyxel | Zyxel | official site | https://www.zyxel.com/sites/zyxel/files/library/assets/landing/logo_sp.svg | "ZYXEL COMMUNICATIONS" full colour; sanitized only |
| alcatel-lucent | Alcatel-Lucent Enterprise | Wikimedia Commons | https://commons.wikimedia.org/wiki/File:Alcatel_Lucent_Enterprise_Logo.svg | Full colour. al-enterprise.com serves PNG only; sanitized only |
| cambium | Cambium Networks | official site | https://www.cambiumnetworks.com/ (inline SVG header logo in the homepage HTML) | Full colour; extracted from the page as is, then sanitized only |
| juniper-mist | Juniper Networks (for Juniper Mist) | official site | https://www.juniper.net/content/dam/www/assets/images/global/juniper_black-rgb-header.svg | Juniper Networks logo (black). No separate Mist logo was found; mist.com now shows HPE branding. Sanitized only (Illustrator private data removed) |
| huawei | Huawei | official site | https://www.huawei.com/-/media/htemplate-home/1.0.1.20251205144752/components/assets/img/favicon-logo.svg | Full colour petals plus HUAWEI wordmark; sanitized only |
| draytek | DrayTek | Wikimedia Commons | https://commons.wikimedia.org/wiki/File:DrayTek_Logo.svg | Red wordmark. draytek.com returned 403 to scripted download; sanitized only |
| ruijie | Ruijie Networks | official site | https://eo-sgp-cos.ruijie.com/site_style/new_navs/fer/upimg/logo.svg (header logo of https://www.ruijienetworks.com/) | Red wordmark; sanitized only |
| teltonika | Teltonika | official site | https://teltonika-networks.com/ (inline SVG header logo in the homepage HTML) | Navy full colour; extracted from the page as is, then sanitized only |
| engenius | EnGenius | official site | https://www.engeniustech.com/apac/wp-content/uploads/2023/07/Group-1096.svg (schema.org logo of https://www.engeniustech.com/) | Dark grey wordmark; sanitized only |
| openwrt | OpenWrt | Wikimedia Commons | https://commons.wikimedia.org/wiki/File:OpenWrt_Logo.svg | Full colour with "Wireless Freedom" tagline. openwrt.org served a bot challenge page; sanitized only |

## Fallbacks (no file; the UI renders a text wordmark tile)

| key | vendor | reason |
|---|---|---|
| cisco-catalyst | Cisco Catalyst | No separate official Catalyst logo was found (Catalyst is a Cisco product line that uses the Cisco logo), so the UI falls back to `cisco.svg` |
| openmesh | Open Mesh | The brand is discontinued: openmesh.com does not resolve and Wikimedia Commons has no Open Mesh logo |
| grandstream | Grandstream | The official site offers a PNG only (logo-grandstream-low-web.png), there is no public press kit SVG, and Wikimedia Commons has no file |
| tanaza | Tanaza | The official site and media kit offer PNG only, and Wikimedia Commons has no file |
| ezelink | EZELINK / EZEAP | ezelink.com offers a PNG only (wp-content/uploads/2026/02/IMG_3335.png) and ezelink.ai returned no content. An SVG master is REQUIRES_CLARIFICATION from the owner |
