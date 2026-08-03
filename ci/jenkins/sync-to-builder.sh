#!/usr/bin/env bash
# Push the local working tree to the build server. Run from the repo root.
#
# The build server does NOT use git: the multiplayer branch is unpushed and the repo is
# public, so the source arrives by rsync over the LAN and nothing leaves the network.
# That also means uncommitted work builds exactly as it sits on disk.
set -euo pipefail

# Deployment values come from ci/jenkins/config.env (gitignored — this repo is public).
# Environment wins, so a CI job can override without touching the file.
_cfg="$(dirname "$0")/config.env"
# shellcheck disable=SC1090
[ -f "$_cfg" ] && . "$_cfg"
BUILDER="${BUILDER:?set BUILDER in ci/jenkins/config.env (see config.env.example)}"
DEST="${DEST:-morrowind-src}"

cd "$(dirname "$0")/../.."   # repo root

command -v rsync >/dev/null || { echo "rsync not found"; exit 1; }

echo "==> syncing working tree to $BUILDER:$DEST"
# Excludes mirror .dockerignore plus the local-only heavy trees. deps/ and fsroot/gamedata
# are NOT sent - they are staged once on the builder at ~/build-artifacts and copied in by
# this script's tail, because re-sending ~750MB on every build is pointless.
rsync -a --delete \
  --exclude '.git/' --exclude '.github/' \
  --exclude 'deps/' \
  --exclude 'build-wasm/' --exclude 'build-wasm.good/' --exclude 'build-native/' \
  --exclude 'build-bullet-native/' --exclude 'build-mygui-native/' \
  --exclude 'archive/' --exclude 'source-mw/' --exclude 'content/' \
  --exclude 'node_modules/' --exclude 'wasm-build/mod-src/' \
  --exclude 'play/mwdata/' --exclude 'play/moddata/' \
  --exclude 'play/openmw.*' --exclude 'play/*.tar' \
  --exclude 'fsroot/gamedata/' \
  ./ "$BUILDER:$DEST/"

# Record what was built, so a Jenkins log can be traced back to a commit even though the
# tree is not a git checkout. Dirty trees are the normal case here.
git rev-parse HEAD 2>/dev/null | ssh "$BUILDER" "cat > $DEST/.source-commit"

echo "==> restaging the gitignored build inputs"
ssh "$BUILDER" "
  set -e
  cp -a ~/build-artifacts/deps $DEST/
  cp -a ~/build-artifacts/fsroot/gamedata $DEST/fsroot/
  cp -a ~/build-artifacts/fsroot/icudt68l.dat $DEST/fsroot/
"

echo "==> done. commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (dirty)')"
echo "    now trigger a job on the build server's Jenkins (BUILDER=$BUILDER)"
echo "      OpenMW-Web-Engine-WASM   ~13 min   engine + statics"
echo "      OpenMW-Web-MP-Server     ~1 min    gateway + sim peer (longer if openmw/ changed)"
