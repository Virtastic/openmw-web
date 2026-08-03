#!/usr/bin/env bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# Local multiplayer test stack: a world server + the play/ static server, wired the same way
# mp-harness.mjs wires them, so what you click through here is what the tests exercise.
#
#   ./wasm-build/dev-local.sh              # keeps its data between runs
#   ./wasm-build/dev-local.sh --fresh      # wipes the local data dir first (new character)
#
# Ctrl+C stops both. Only the PIDs started here are killed — never a pkill pattern.
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

if [ "${1:-}" = "--fresh" ]; then
  echo "==> wiping ${DATA_DIR} (fresh account + character)"
  rm -rf "${DATA_DIR}"
fi
mkdir -p "${DATA_DIR}"

# Same config the harness writes. allowHarnessAuth lets ?mpauto=1 log in without SSO — this is
# a throwaway local server, and real servers refuse that path.
cat > "${DATA_DIR}/config.toml" <<'TOML'
[server]
motd = "local dev"

[login]
allowHarnessAuth = true

[rules]
respawnCellKey = "26,25"
respawnX = 216831.0
respawnY = 204909.0
respawnZ = 513.0
TOML

echo "==> building server"
(cd "${ROOT}/server" && npm run build >/dev/null)

PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "==> world server on :${MP_PORT} (data: ${DATA_DIR})"
(cd "${ROOT}/server" && node dist/server.mjs --data "${DATA_DIR}" --port "${MP_PORT}") &
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
