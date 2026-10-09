#!/bin/sh
# Edge behaviour assertions (run by validate-local.sh inside a curl container on the test
# network; the edge container is reachable as `edge`, TLS verified against the test CA).
# $C is split on purpose; "$([ cond ]; echo $?)" passes the condition status to t().
# shellcheck disable=SC2086,SC2319
set -eu
IP="$1"
A="https://$IP:8443"
P="https://$IP:8444"
C="--cacert /ca/ca.crt --connect-to $IP:8443:edge:8443 --connect-to $IP:8444:edge:8444"
fails=0
t() { # t <label> <condition-exit-status>
  if [ "$2" -eq 0 ]; then echo "      ok   $1"; else echo "      FAIL $1"; fails=$((fails + 1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' $C "$@"; }
hdrs() { curl -s -D - -o /dev/null $C "$@" | tr -d '\r'; }
body() { curl -s $C "$@"; }

# TLS: verified with the CA, no -k anywhere.
curl -s -o /dev/null $C "$A/"; t "TLS verifies against the LAN CA (SAN IP $IP)" $?

# Admin SPA
t "admin / -> 200" "$([ "$(code "$A/")" = 200 ]; echo $?)"
t "admin SPA route /orgs/x/sites -> 200 index.html" "$(body "$A/orgs/x/sites" | grep -q '<div id=' ; echo $?)"
t "admin missing /assets/nope.js -> 404" "$([ "$(code "$A/assets/nope.js")" = 404 ]; echo $?)"
H="$(hdrs "$A/")"
for h in "content-security-policy: default-src 'self'" "x-frame-options: DENY" "x-content-type-options: nosniff" \
  "strict-transport-security: max-age=31536000" "referrer-policy: same-origin" "cross-origin-opener-policy: same-origin" \
  "permissions-policy: camera=()"; do
  t "admin header $h" "$(echo "$H" | grep -qi "^$h"; echo $?)"
done
t "admin Server header has no version" "$(echo "$H" | grep -i '^server:' | grep -q '[0-9]' && echo 1 || echo 0)"

# Private paths on both ports
for u in "$A/readyz" "$A/metrics" "$A/metrics/x" "$A/internal" "$A/internal/portal/x" "$A/.env" \
  "$P/readyz" "$P/metrics" "$P/internal/x" "$P/.git/config"; do
  t "private $u -> 404" "$([ "$(code "$u")" = 404 ]; echo $?)"
done

# /api proxied; X-Forwarded-For overwritten (spoof discarded), proto https, Host with port
J="$(body -H 'X-Forwarded-For: 6.6.6.6' -H 'Cookie: __Host-ecloud_sid=abc' "$A/api/v1/me?x=1")"
t "/api -> api upstream" "$(echo "$J" | grep -q '"upstream": "api"'; echo $?)"
t "/api keeps path + query" "$(echo "$J" | grep -q '"path": "/api/v1/me?x=1"'; echo $?)"
t "/api X-Forwarded-For spoof dropped" "$(echo "$J" | grep -q '6.6.6.6'; [ $? -ne 0 ]; echo $?)"
t "/api X-Forwarded-For = single client address" "$(echo "$J" | grep -Eq '"x-forwarded-for": "[0-9.]+"'; echo $?)"
t "/api X-Forwarded-Proto https" "$(echo "$J" | grep -q '"x-forwarded-proto": "https"'; echo $?)"
t "/api Host carries the port" "$(echo "$J" | grep -q "\"host\": \"$IP:8443\""; echo $?)"
t "/api session cookie forwarded to api" "$(echo "$J" | grep -q '__Host-ecloud_sid=abc'; echo $?)"
t "/healthz on 8443 -> api" "$(body "$A/healthz" | grep -q '"path": "/healthz"'; echo $?)"
HA="$(hdrs "$A/api/v1/me")"
t "upstream X-Powered-By hidden" "$(echo "$HA" | grep -qi '^x-powered-by' && echo 1 || echo 0)"
HX="$(hdrs "$A/api/xfo")"
t "upstream X-Frame-Options kept, edge adds none" "$([ "$(echo "$HX" | grep -ci '^x-frame-options')" = 1 ] && echo "$HX" | grep -qi '^x-frame-options: SAMEORIGIN'; echo $?)"

# Portal: proxied, cookie allow-list (__Host-pf only)
JP="$(body -H 'Cookie: a=1; __Host-ecloud_sid=SECRET; __Host-pf=flow123; b=2' "$P/hotspot/uspot?mac=x")"
t "portal -> portal upstream" "$(echo "$JP" | grep -q '"upstream": "portal"'; echo $?)"
t "portal receives only __Host-pf" "$(echo "$JP" | grep -q '"cookie": "__Host-pf=flow123"'; echo $?)"
t "portal never receives the admin session cookie" "$(echo "$JP" | grep -q SECRET && echo 1 || echo 0)"
JP2="$(body -H 'Cookie: __Host-ecloud_sid=SECRET' "$P/x")"
t "portal: no Cookie header when only the admin cookie was sent" "$(echo "$JP2" | grep -q '"cookie"' && echo 1 || echo 0)"
HP="$(hdrs "$P/x")"
t "portal header x-content-type-options" "$(echo "$HP" | grep -qi '^x-content-type-options: nosniff'; echo $?)"

# Plain HTTP on the TLS ports -> redirect to https
R2="$(curl -s -o /dev/null -w '%{redirect_url}' -H 'Host: evil.example' --connect-to "$IP:8444:edge:8444" "http://$IP:8444/p")"
t "http on 8444 -> fixed https target, client Host ignored ($R2)" "$([ "$R2" = "https://$IP:8444/p" ]; echo $?)"
R="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --connect-to "$IP:8443:edge:8443" "http://$IP:8443/x?y=1")"
t "http on 8443 -> 301 https ($R)" "$(echo "$R" | grep -q "^301 https://$IP:8443/x?y=1"; echo $?)"

[ "$fails" -eq 0 ]
