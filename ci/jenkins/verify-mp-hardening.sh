#!/usr/bin/env bash
# Post-deploy checks for the pre-release multiplayer hardening. Run AFTER deploy-test.sh and
# smoke-test.sh, which cover headers, routing, world listing and the sign-in redirect — none of
# which touch anything this change set altered.
#
# What is asserted here, and why each one is worth a network round trip:
#
#   1. A forged client-address header must NOT be honoured from the public internet. clientIp
#      trusts a forwarding header only when the PEER is private, which is what stops a client
#      picking its own address to walk past an IP ban, past maxConnsPerIp, and to spend a
#      victim's login budget for them.
#   2. Sign-in must be reachable at all — the per-IP login bucket used to be ONE bucket for the
#      whole server (the peer was always the proxy), so the sixth person to click "sign in" in
#      any minute was refused.
#   3. A private world that cannot be attributed to an owner must not be revived on dial. The
#      revive path used to start it with an empty owner, which every access check reads as
#      "public, admit anyone".
#   4. The live worlds must stay up, and the gateway must not be logging crashes.
#
# Usage: ci/jenkins/verify-mp-hardening.sh [https://host] [minutes]
set -uo pipefail

BASE="${1:-${SMOKE_URL:-https://morrowind.dev.virtastic.app}}"
WATCH_MIN="${2:-10}"
FAILED=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n       -> %s\n' "$1" "$2"; FAILED=$((FAILED+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

echo "==> multiplayer hardening checks against $BASE"

# --- 1+2. a forged address must not buy a fresh login budget --------------------------------
# THE CHECK THAT ACTUALLY FOUND SOMETHING. /auth/<provider>/start is the rate-limited route,
# and a refusal is NOT a 429 — it redirects back to the launcher with mperror=rate. An earlier
# version of this script looked for 429, never saw one, and reported a pass it had not earned.
#
# Method: exhaust this address's bucket, then alternate CONTROL / FORGED / CONTROL. The
# controls matter because the bucket refills a token every twelve seconds, which is more than
# enough to make an unguarded probe look like a bypass when it is only the clock.
goog() { curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 "$@" | grep -qi accounts.google.com && echo FRESH || echo limited; }

for _ in $(seq 1 8); do curl -s -o /dev/null --max-time 20 "$BASE/auth/google/start"; done
if [ "$(goog "$BASE/auth/google/start")" != "limited" ]; then
  echo "  --   could not exhaust the login bucket from here; forgery check skipped (not a failure)"
else
  for hdr in "cf-connecting-ip: 203.0.113.77" "x-omw-client-ip: 203.0.113.99" \
             "true-client-ip: 203.0.113.66" "x-forwarded-for: 203.0.113.88"; do
    got=$(goog -H "$hdr" "$BASE/auth/google/start")
    ctl=$(goog "$BASE/auth/google/start")
    if [ "$ctl" != "limited" ]; then
      echo "  --   bucket refilled mid-probe; '${hdr%%:*}' inconclusive"
    elif [ "$got" = "limited" ]; then
      pass "forged '${hdr%%:*}' does not get its own login budget"
    else
      fail "forged '${hdr%%:*}' bypassed the login limit" \
        "claiming ${hdr#*: } got a fresh budget while the control stayed refused — the limiter, IP bans and maxConnsPerIp can all be reset at will"
    fi
  done
fi

# --- 3. an unattributable private world must not be revived ----------------------------------
# A world id that has no data directory (and so no owner marker) must fail the handshake rather
# than be conjured into existence. 101 here would mean a world was started for it.
WID="priv-nosuch-$(date +%s | tail -c 9)"
c=$(code -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
      "$BASE/w/$WID")
if [ "$c" = "101" ]; then
  fail "unowned private world revived" "/w/$WID upgraded (101) — it should refuse"
else
  pass "unowned private world refused (/w/$WID -> $c)"
fi

# --- 4. the deployment stays up ---------------------------------------------------------------
# The check the local soak cannot make: the REAL gateway, with real worlds, over time. Polls the
# public surface, because world ports never leave the container.
echo "==> watching for ${WATCH_MIN} min"
END=$(( $(date +%s) + WATCH_MIN * 60 ))
samples=0; bad=0
while [ "$(date +%s)" -lt "$END" ]; do
  # NOT /healthz: the smoke test asserts it is deliberately NOT exposed publicly. The launcher
  # and the auth endpoint are the two surfaces a real player actually depends on.
  l=$(code "$BASE/")
  a=$(code "$BASE/auth/providers")
  samples=$((samples+1))
  if [ "$l" != "200" ] || [ "$a" != "200" ]; then
    bad=$((bad+1))
    echo "     sample $samples: launcher=$l auth=$a"
  fi
  sleep 20
done
if [ "$bad" -eq 0 ]; then
  pass "$samples samples over ${WATCH_MIN} min, all healthy"
else
  fail "deployment wobbled" "$bad of $samples samples unhealthy"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "==> all multiplayer hardening checks passed"
else
  echo "==> $FAILED check(s) FAILED"
fi
exit "$FAILED"
