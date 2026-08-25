#!/usr/bin/env bash
# Build `dev` on the build server and deploy it to the test app server. Run from the repo root.
#
#   ci/jenkins/release-to-test.sh            # both images
#   ci/jenkins/release-to-test.sh engine     # just the WASM engine
#   ci/jenkins/release-to-test.sh server     # just the gateway + sim peer
#
# THIS IS THE DEPLOY PATH. Jenkins holds the same jobs and runs the same scripts, but it does
# not poll: triggering it needs a credential (both /git/notifyCommit and the remote build URL
# answer 401/403 with anonymous read disabled), so a build happens when somebody asks for one.
# This is how you ask.
#
# Everything runs ON THE BUILD SERVER over ssh. Nothing compiles on the laptop -- a clean WASM
# engine build is ~13 minutes and will make that machine unusable (see AGENTS.md).
#
# What it does, in order, and it stops at the first failure:
#   1. fetch + hard checkout of origin/dev in ~/morrowind-src
#   2. restage the gitignored build inputs (deps/, gamedata, ICU) if they are missing
#   3. build the requested image(s)
#   4. deploy each one, which runs the contract gate and fails the deploy on any miss
set -euo pipefail

WHAT="${1:-both}"
case "$WHAT" in both|engine|server) ;; *) echo "usage: $0 [both|engine|server]" >&2; exit 2 ;; esac

_cfg="$(dirname "$0")/config.env"
# shellcheck disable=SC1090
[ -f "$_cfg" ] && . "$_cfg"
BUILDER="${BUILDER:?set BUILDER in ci/jenkins/config.env (see config.env.example)}"
DEST="${DEST:-morrowind-src}"

echo "==> releasing '$WHAT' to the test server via $BUILDER"

ssh -o BatchMode=yes "$BUILDER" "WHAT='$WHAT' DEST='$DEST' bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/$DEST"
export SRC="$HOME/$DEST"

echo "==> fetching origin/dev"
git fetch -q --depth=1 origin dev
git checkout -f -q -B dev FETCH_HEAD
git rev-parse HEAD > .source-commit
echo "    building $(git log --oneline -1)"

bash ci/jenkins/restage-inputs.sh

if [ "$WHAT" = "both" ] || [ "$WHAT" = "server" ]; then
  echo "==> build: server"; bash ci/jenkins/build-server.sh
fi
if [ "$WHAT" = "both" ] || [ "$WHAT" = "engine" ]; then
  echo "==> build: engine"; bash ci/jenkins/build-engine.sh
fi
if [ "$WHAT" = "both" ] || [ "$WHAT" = "server" ]; then
  echo "==> deploy: server"; bash ci/jenkins/deploy-test.sh server
fi
if [ "$WHAT" = "both" ] || [ "$WHAT" = "engine" ]; then
  echo "==> deploy: engine"; bash ci/jenkins/deploy-test.sh engine
fi
echo "==> done: $(git log --oneline -1)"
REMOTE
