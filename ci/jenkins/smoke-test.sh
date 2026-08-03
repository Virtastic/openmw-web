#!/usr/bin/env bash
# Post-deploy contract test. Run against a DEPLOYED origin; fails the deploy if the site is
# serving something a player cannot actually use.
#
# Usage: smoke-test.sh https://your-deployed-origin
#
# Why this exists: every check below is a bug that actually shipped, was invisible from
# /healthz, and cost hours to find. A 200 from the front page proves almost nothing — the
# gateway can be healthy while the per-world process crash-loops, the launcher gate can bounce
# the game back to the chooser forever, and a stale config can redirect every sign-in to
# somebody's laptop. Assert the contract, not the uptime.
#
# Intentionally curl-only: it must run against ANY deployment, including a from-scratch one
# that has none of this repo's tooling on it.
set -uo pipefail

BASE="${1:?usage: smoke-test.sh <base-url>}"
BASE="${BASE%/}"
FAILED=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n       -> %s\n' "$1" "$2"; FAILED=$((FAILED+1)); }

get()      { curl -s --max-time 20 "$@"; }
code()     { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
redirect() { curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 "$@"; }

echo "==> serving contract: $BASE"

# 1. Cross-origin isolation. Without BOTH headers the engine refuses to start with a
#    "Browser not supported" overlay, because SharedArrayBuffer is unavailable.
H=$(curl -s -D- -o /dev/null --max-time 20 "$BASE/index.html")
grep -qi 'cross-origin-opener-policy: *same-origin' <<<"$H" && pass "COOP: same-origin"   || fail "COOP: same-origin"   "engine cannot start without it"
grep -qi 'cross-origin-embedder-policy: *require-corp'<<<"$H" && pass "COEP: require-corp" || fail "COEP: require-corp" "engine cannot start without it"

# 2. The launcher gate. "/" is the chooser; "/index.html" is the GAME. Rewriting index.html
#    back to the launcher makes multiplayer bounce between the two forever — the boot URL
#    carries its parameters in the FRAGMENT, which never reaches the server, so a
#    "no query string" guard sees a bare /index.html and rewrites it.
LAUNCHER_RE='Bring your own|CHOOSE DATA FILES|FREE SAMPLE'
# Capture first, then match. Piping curl into `grep -q` makes grep close the pipe on the
# first hit, curl dies of SIGPIPE, and with pipefail the pipeline reports failure ON A
# MATCH — inverting every one of these checks.
is_launcher() { grep -qE "$LAUNCHER_RE" <<<"$1"; }
B_ROOT=$(get "$BASE/"); B_IDX=$(get "$BASE/index.html"); B_NOMW=$(get "$BASE/index.html?nomw")
is_launcher "$B_ROOT" && pass "/ serves the launcher" || fail "/ serves the launcher" "the chooser is missing"
is_launcher "$B_IDX"  && fail "/index.html serves the game" "rewritten to the launcher -> multiplayer loops on 'Creating...'" || pass "/index.html serves the game"
is_launcher "$B_NOMW" && fail "?nomw serves the game" "rewritten to the launcher" || pass "/index.html?nomw serves the game"
# The gate that keeps a bare /index.html from booting into whatever data the host serves
# lives in the PAGE, because only the client can see the fragment multiplayer arrives on.
# curl always gets the game HTML back, so assert the gate script is present rather than
# inferring it from the response.
if grep -q "location.replace('launcher.html')" <<<"$B_IDX"; then
  pass "bare /index.html gated to the launcher (client-side)"
else
  fail "bare /index.html gated to the launcher" "missing: a visitor who types the URL boots straight into the host's game data"
fi

# 3. The multiplayer gateway must be reachable ON THIS ORIGIN. The page refuses to hand its
#    session ticket to another hostname, so a gateway on a second origin can never be used.
P=$(get "$BASE/auth/providers")
grep -q '"providers"' <<<"$P" && pass "/auth/providers proxied ($P)" || fail "/auth/providers proxied" "got: ${P:0:120}"
[ "$(code "$BASE/locker/needed")" = "401" ] && pass "/locker/* proxied (401 = reachable)" || fail "/locker/* proxied" "expected 401; a 404 means Caddy never forwards it, so uploads die"
# Savegames ride the same door. A 404 here is the Caddyfile missing /saves, and the symptom
# is silent: the game plays fine and every save is simply never uploaded.
[ "$(code "$BASE/saves")" = "401" ] && pass "/saves proxied (401 = reachable)" || fail "/saves proxied" "expected 401; a 404 means Caddy never forwards it, so saves never leave the browser"
# An unsigned blob URL must never be served, whichever storage backend is configured
# (403 = filesystem storage refusing a forged token, 503 = S3, which mints its own URLs).
_blob="$(code "$BASE/locker/blob/forged/gamedata/x")"
{ [ "$_blob" = "403" ] || [ "$_blob" = "503" ]; } && pass "forged blob URL refused ($_blob)" || fail "forged blob URL refused" "got $_blob, expected 403 or 503"

# 4. The gameplay socket. HTTP/2 cannot carry an upgrade, so --http1.1 is mandatory here;
#    without it this returns a misleading 404/502.
# Worlds start a moment AFTER the gateway answers /healthz, so a deploy that restarts it
# races this check. Retry briefly rather than reporting a red gate for a server that is
# merely still coming up — a gate that cries wolf is one people learn to ignore.
WID=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  WID=$(get "$BASE/worlds" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$WID" ] && break
  sleep 3
done
if [ -n "$WID" ]; then
  WS=000
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    WS=$(code --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
          -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$BASE/w/$WID")
    [ "$WS" = "101" ] && break
    sleep 3   # 502 here usually means the world process is still starting
  done
  [ "$WS" = "101" ] && pass "/w/$WID upgrades (101)" || fail "/w/$WID upgrades" "got $WS after retries; the game can sign in and then reach no world"
else
  fail "/worlds lists a world" "no world id in the directory response"
fi

# 5. The directory must not advertise an address. `host` was a configured guess defaulting to
#    127.0.0.1 — a remote player's own machine — and `port` leaked a world's internal port.
W=$(get "$BASE/worlds")
grep -q '"wsPath"' <<<"$W" && pass "/worlds returns wsPath" || fail "/worlds returns wsPath" "client has no way to dial"
grep -q '"host"'   <<<"$W" && fail "/worlds omits host" "advertising an address; 127.0.0.1 means the player's OWN machine" || pass "/worlds omits host"
grep -q '"port"'   <<<"$W" && fail "/worlds omits port" "leaking a world's internal port" || pass "/worlds omits port"

# 6. Operator surfaces must not be public.
for p in /admin /metrics /healthz /status; do
  c=$(code "$BASE$p")
  [ "$c" = "404" ] && pass "$p not exposed" || fail "$p not exposed" "got $c"
done

# 7. Sign-in must return to THIS origin over https. A stale returnUrl redirects every player
#    to wherever it was last pointed, and an http:// return silently downgrades a site that
#    only works in a secure context.
R=$(redirect "$BASE/auth/nosuchprovider/start")
case "$R" in
  "$BASE"/*)  pass "sign-in returns to this origin" ;;
  *127.0.0.1*|*localhost*) fail "sign-in returns to this origin" "returns to $R — a loopback address; players land on their own machine" ;;
  *) fail "sign-in returns to this origin" "returns to ${R:-<nothing>}" ;;
esac
case "$BASE" in
  https://*) case "$R" in https://*) pass "sign-in return keeps https" ;;
                          *) fail "sign-in return keeps https" "returns $R — check the edge forwards X-Forwarded-Proto" ;; esac ;;
esac

# 8. Range support. StreamFS reads archives by range; without 206 the asset pack silently
#    never mounts (mountAssetPack fails soft, so nothing in the UI says so).
A=$(code -r 0-0 "$BASE/data/openmw-web-assets.bsa")
case "$A" in
  206) pass "asset pack range-served (206)" ;;
  404) printf '  \033[33mskip\033[0m %s\n' "asset pack not staged (optional)" ;;
  *)   fail "asset pack range-served" "got $A; StreamFS needs 206" ;;
esac

echo
if [ "$FAILED" -gt 0 ]; then
  echo "FAILED: $FAILED contract check(s). The site may still answer 200 on the front page."
  exit 1
fi
echo "all contract checks passed"
