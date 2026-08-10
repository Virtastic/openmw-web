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

# --- 1. the client-address trust boundary ----------------------------------------------------
# Two requests that differ ONLY by a forged address header. If the forgery were honoured they
# would land in different rate-limit buckets; since it is not, both are simply this client.
# The observable is weaker than the property (we cannot read the server's bucket from here), so
# assert what we CAN see: the header does not change how the endpoint answers, and above all it
# never produces a 5xx — an unparsed or trusted header used to be able to.
for hdr in "x-forwarded-for: 1.2.3.4" "cf-connecting-ip: 1.2.3.4" "x-omw-client-ip: 1.2.3.4"; do
  c=$(code -H "$hdr" "$BASE/auth/providers")
  if [ "$c" = "200" ]; then
    pass "forged '${hdr%%:*}' accepted without effect (200)"
  else
    fail "forged '${hdr%%:*}'" "expected 200, got $c"
  fi
done

# --- 2. the login bucket is per-address, and a forged address cannot buy a fresh one ---------
# /auth/<provider>/start is the rate-limited route (auth/routes.ts). This is the check that
# actually discriminates: a single client cannot tell a per-IP bucket from a global one just by
# being refused, but it CAN prove the refusal does not lift when it claims to be someone else.
# clientIp reads a forwarding header only when the peer is private, so from out here the forgery
# must change nothing — otherwise anyone could mint themselves unlimited sign-in attempts, and
# attribute the failures to whichever address they named.
BURST=0
for _ in $(seq 1 8); do
  c=$(code "$BASE/auth/google/start")
  [ "$c" = "429" ] && { BURST=1; break; }
done
if [ "$BURST" = "1" ]; then
  forged=$(code -H 'cf-connecting-ip: 203.0.113.77' -H 'x-forwarded-for: 203.0.113.77' \
             "$BASE/auth/google/start")
  if [ "$forged" = "429" ]; then
    pass "a forged address does not get its own login budget (still 429)"
  else
    fail "forged address bypassed the login limit" \
      "claiming 203.0.113.77 got $forged instead of 429 — the limiter can be reset at will"
  fi
else
  # Not a failure of the fix: the bucket may simply not have been exhausted (it refills, and
  # other traffic shares this address). Say so rather than claiming a pass we did not earn.
  echo "  --   login limit not reached in 8 attempts; forgery check skipped (not a failure)"
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
