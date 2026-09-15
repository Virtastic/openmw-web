#!/usr/bin/env bash
# The fresh-install rehearsal: "a stranger can host this", on the images THIS build made.
#
# run-harness.sh runs the suite against a server it pre-seeds (config.toml, harness auth, a
# locker session minted by hand). This runs ONE scenario, s170, against nothing: an EMPTY data
# dir that the container's own entrypoint brings up, the setup wizard driven through the
# dashboard's routes, the game files uploaded, two accounts, and a session played through the
# launcher. Same images, same harness container, same --user rules as run-harness.sh.
#
# Two things s170 needs that the suite does not, both passed as environment:
#   OMW_FRESH_DATA      the empty data dir, under /repo so the host daemon can see it and the
#                       run's artefacts (setup-token, .mode, gamedata/, logs/) survive for a
#                       look afterwards; wiped before the run so it is genuinely empty.
#   OPENMW_MP_UPSTREAM  play/server.py proxies the launcher's same-origin /auth, /worlds and
#                       /w/ paths to this address -- the job Caddy does in front of a real
#                       deployment. s170's gateway listens on 18700 (the scenario declares it).
set -euo pipefail

SRC="${SRC:-/src}"
FRESH_REL="wasm-build/harness-out/fresh-${BUILD_NUMBER:-local}"
GW_PORT=18700

cd "$SRC"
rm -rf "$FRESH_REL"
mkdir -p "$FRESH_REL"
echo "==> fresh data dir: $FRESH_REL (empty)"

export HARNESS_DOCKER_ARGS="-e OMW_FRESH_DATA=/repo/$FRESH_REL -e OPENMW_MP_UPSTREAM=127.0.0.1:$GW_PORT"
export SCENARIOS=s170 LOG="wasm-build/harness-out/fresh-${BUILD_NUMBER:-local}.log"
exec "$(dirname "$0")/run-harness.sh"
