#!/usr/bin/env bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# Local multiplayer test stack: a world server + the play/ static server, wired the same way
# mp-harness.mjs wires them, so what you click through here is what the tests exercise.
#
#   ./wasm-build/dev-local.sh              # one world; keeps its data between runs
#   ./wasm-build/dev-local.sh --fresh      # wipes the local data dir first (new character)
#   ./wasm-build/dev-local.sh --gateway    # the world SUPERVISOR: solo/party/public switching
#                                          # (needs a peer binary — see OMW_PEER_BIN below)
#
# Ctrl+C stops both. Only the PIDs started here are killed — never a pkill pattern.
#
# THIS SCRIPT COULD NOT BOOT A SERVER, and had not been able to since 1.1.0. Two hard
# preconditions appeared and nothing here was updated for either:
#
#   * [server] password is the sim peer's ONLY credential, and an empty one now refuses every
#     system connection — so the server refuses to start rather than run a world whose NPCs
#     nobody can simulate. The config written below had no password at all.
#   * A headless openmw binary is required for the same reason, and startServer throws
#     "no sim-peer binary" when it cannot find one.
#
# Both are correct behaviour for a real deployment and neither is reachable on an ordinary dev
# box, so this now writes a password and picks its ENTRY POINT to match what is available:
#
#   peer binary present -> dist/server.mjs   (the real thing; NPCs are simulated)
#   no peer binary      -> dist/testhost.mjs (the harness entry point, requireGameData:false)
#
# testhost.mjs exists for exactly this and is what the browser scenarios and bots/soak.ts
# already use. Saying "no peer, NPCs will not move" while still invoking server.mjs would have
# been a lie the script could not keep: main.ts refuses to boot at all without one.
#
# SCOPE: one world, no gateway. Solo/Party/Public switching needs the world SUPERVISOR
# (dist/gateway.mjs), which needs a peer binary and real game data; see --gateway below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ROOT}/.dev-local"
MP_PORT=8931
PLAY_PORT=8910   # fixed inside play/server.py

# Node 22+: the server uses node:sqlite.
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  if [ -d "$HOME/.nvm/versions/node/v22.19.0/bin" ]; then
    export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
  else
    echo "need Node 22+ (node:sqlite); found $(node -v)" >&2; exit 1
  fi
fi

GATEWAY=0
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --gateway) GATEWAY=1 ;;
    --fresh)   FRESH=1 ;;
    *) echo "unknown option: $arg (expected --fresh and/or --gateway)" >&2; exit 2 ;;
  esac
done

# The peer binary decides what this stack can actually demonstrate, so resolve it BEFORE
# printing any promises. Same conventional paths findPeerBinary probes, plus an override.
PEER_BIN="${OMW_PEER_BIN:-}"
if [ -z "${PEER_BIN}" ]; then
  for cand in "${ROOT}/deps/build-native/openmw" /usr/local/bin/openmw /usr/bin/openmw; do
    [ -x "$cand" ] && { PEER_BIN="$cand"; break; }
  done
fi

if [ "${GATEWAY}" = "1" ] && [ -z "${PEER_BIN}" ]; then
  cat >&2 <<'MSG'
--gateway needs a headless openmw binary and real game data: the gateway spawns worlds, and a
world refuses to boot without a peer to simulate it. Build one with

    docker build -f server/Dockerfile.simpeer -t openmw-simpeer .

and point OMW_PEER_BIN at it, or drop --gateway to run the single-world stack.
MSG
  exit 1
fi

if [ "${FRESH}" = "1" ]; then
  echo "==> wiping ${DATA_DIR} (fresh account + character)"
  rm -rf "${DATA_DIR}"
fi
mkdir -p "${DATA_DIR}"

# Same config the harness writes. allowHarnessAuth lets ?mpauto=1 log in without SSO — this is
# a throwaway local server, and real servers refuse that path.
cat > "${DATA_DIR}/config.toml" <<TOML
[server]
motd = "local dev"
# The sim peer's ONLY credential. An empty value refuses every system connection, and the
# server refuses to boot without one — this is why the script used to die on startup.
# Fixed and local: this data dir is a throwaway and is never reachable from anywhere else.
password = "dev-local-peer"

[login]
allowHarnessAuth = true

[rules]
respawnCellKey = "26,25"
respawnX = 216831.0
respawnY = 204909.0
respawnZ = 513.0

[simPeer]
binary = "${PEER_BIN}"

[worlds]
# Tiny on purpose: a dev box should hit the governor early and legibly rather than swapping.
memBudgetMb = 2048
TOML

echo "==> building server"
(cd "${ROOT}/server" && npm run build >/dev/null)

PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if [ -z "${PEER_BIN}" ]; then
  ENTRY=dist/testhost.mjs
  cat <<'MSG'

  NOTE: no headless openmw binary found, so this runs the HARNESS entry point (testhost.mjs)
  and there is no sim peer.

  Working:      login, chat, social, parties, world state, persistence, the switcher UI.
  NOT working:  NPCs and creatures. The sim peer is the only thing permitted to hold cell
                authority, so every cell stays DORMANT and its actors never move. That is
                the designed behaviour, not a bug you have just found.

  For NPCs:  docker build --build-arg BUILD_JOBS=6 -f server/Dockerfile.simpeer -t openmw-simpeer .
             then set OMW_PEER_BIN=/path/to/openmw   (measured: 487 MB, ~11 s to start)

MSG
else
  ENTRY=dist/server.mjs
fi

if [ "${GATEWAY}" = "1" ]; then
  echo "==> gateway on :${MP_PORT} (worlds under ${DATA_DIR}/worlds)"
  (cd "${ROOT}/server" && node dist/gateway.mjs       --worlds "${DATA_DIR}/worlds" --shared "${DATA_DIR}" --port "${MP_PORT}"       --server-entry "${ROOT}/server/${ENTRY}") &
else
  echo "==> world server on :${MP_PORT} (${ENTRY}, data: ${DATA_DIR})"
  (cd "${ROOT}/server" && node "${ENTRY}" --data "${DATA_DIR}" --port "${MP_PORT}") &
fi
PIDS+=($!)

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:${MP_PORT}/healthz" >/dev/null && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:${MP_PORT}/healthz" >/dev/null \
  || { echo "world server did not come up on :${MP_PORT}" >&2; exit 1; }

if curl -sf "http://127.0.0.1:${PLAY_PORT}/index.html" >/dev/null 2>&1; then
  echo "==> reusing play server already on :${PLAY_PORT}"
else
  echo "==> play server on :${PLAY_PORT}"
  (cd "${ROOT}/play" && python3 server.py) &
  PIDS+=($!)
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:${PLAY_PORT}/index.html" >/dev/null && break
    sleep 0.2
  done
fi

WS="ws%3A%2F%2F127.0.0.1%3A${MP_PORT}%2Fws"
URL="http://127.0.0.1:${PLAY_PORT}/index.html?nomw&skipintro=1&start=Village&mp=${WS}&mpauto=1&mpuser=local"

cat <<EOF

  ready — open this:

  ${URL}

  ?nomw uses the bundled demo data, so no Morrowind files are needed.

  what to check
    T          opens chat; type, then Enter must SEND (was broken)
    O          opens social; clicking tabs / Close must work (the unverified fix)
    refresh    mid-play, then reload the URL: you must resume in place, never
               back at the name prompt (the data-loss fix)

  if a click dies, the in-game console prints:  [ui] click at X,Y went to <...>
  that line names what swallowed it — paste it back.

  data dir: ${DATA_DIR}   (--fresh to reset)   Ctrl+C stops everything

EOF

wait
