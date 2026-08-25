#!/usr/bin/env bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# Logic tests for the mp/ CLIENT scripts, with the engine APIs stubbed.
#
#   ./wasm-build/lua-tests/run.sh
#
# WHY THIS EXISTS, and what it is NOT. The 42 browser scenarios are the real client gate and
# they need a built wasm engine (deps/ is a maintainer artifact), so client-side changes could
# sit in the tree with nothing having executed them at all. For Lua that is the worst case: a
# mistake does not crash the game, it makes one handler throw and silently disables a whole
# subsystem while the server suite stays green — the failure mode server/docs/STATUS.md warns
# about twice.
#
# This does not replace the scenarios. It means the logic has been RUN.
#
# Uses Docker for a Lua 5.1 interpreter (matching the engine's LuaJIT) rather than requiring one
# on the host. Set LUA=... to use a local interpreter instead.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ -n "${LUA:-}" ]; then
  exec "$LUA" wasm-build/lua-tests/run.lua
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "need docker (or set LUA=/path/to/lua5.1)" >&2
  exit 2
fi
# -w rather than a `cd` inside the shell string: Git Bash on Windows rewrites a bare /repo in
# the command into a Windows path, and the cd then fails inside the container. Docker's own
# working-directory flag is not touched. MSYS_NO_PATHCONV covers the -v argument.
export MSYS_NO_PATHCONV=1
exec docker run --rm -v "$ROOT:/repo" -w /repo alpine:3 sh -c \
  'apk add --no-cache lua5.1 >/dev/null 2>&1 && exec lua5.1 wasm-build/lua-tests/run.lua'
