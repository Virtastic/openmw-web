#!/usr/bin/env bash
# Put the GITIGNORED build inputs back into the source tree, if they are not already there.
#
# deps/, fsroot/gamedata/ and fsroot/icudt68l.dat are ~750 MB of retail data and prebuilt
# dependencies. They are deliberately not in git (the repo is public, and they are not ours to
# publish), so a git checkout ALONE cannot produce a buildable tree — build-engine.sh hard-fails
# on all three, and link-openmw.sh fails on the ICU package. That is not hypothetical: it is
# exactly how the first Jenkins-side engine build broke.
#
# A plain `git checkout -f` leaves untracked files alone, so normally these survive from one
# build to the next and this script does nothing. It exists for the cases that DO lose them:
# a wiped workspace, a `git clean -xfd`, or a freshly provisioned builder.
#
# The copy runs in a throwaway container rather than directly: this script runs INSIDE the
# Jenkins container, which has no mount for ~/build-artifacts, but it can reach the host's
# docker daemon — and the daemon resolves -v paths on the HOST. So the container borrows the
# daemon's view of the filesystem to move files it cannot see itself.
set -euo pipefail

SRC="${SRC:-/src}"
ARTIFACTS="${BUILD_ARTIFACTS:-/home/jenkins/build-artifacts}"
HOST_SRC="${HOST_SRC:-/home/jenkins/morrowind-src}"

cd "$SRC"

need=0
[ -d deps/wasm ] || { echo "   missing: deps/wasm"; need=1; }
[ -n "$(ls -A fsroot/gamedata 2>/dev/null)" ] || { echo "   missing: fsroot/gamedata"; need=1; }
[ -f fsroot/icudt68l.dat ] || { echo "   missing: fsroot/icudt68l.dat"; need=1; }

if [ "$need" = "0" ]; then
  echo "==> build inputs already present, nothing to restage"
  exit 0
fi

echo "==> restaging build inputs from $ARTIFACTS"
docker run --rm \
  -v "$ARTIFACTS":/art:ro \
  -v "$HOST_SRC":/dst \
  alpine:3.20 sh -c '
    set -e
    [ -d /dst/deps ]  || cp -a /art/deps /dst/
    mkdir -p /dst/fsroot
    [ -n "$(ls -A /dst/fsroot/gamedata 2>/dev/null)" ] || cp -a /art/fsroot/gamedata /dst/fsroot/
    [ -f /dst/fsroot/icudt68l.dat ] || cp -a /art/fsroot/icudt68l.dat /dst/fsroot/
  '

# Prove it, rather than trusting the copy: the build scripts assert on exactly these three and
# a silent partial restage would fail later, further from the cause.
[ -d deps/wasm ] || { echo "FATAL: deps/wasm still missing after restage" >&2; exit 1; }
[ -n "$(ls -A fsroot/gamedata 2>/dev/null)" ] || { echo "FATAL: fsroot/gamedata still empty after restage" >&2; exit 1; }
[ -f fsroot/icudt68l.dat ] || { echo "FATAL: fsroot/icudt68l.dat still missing after restage" >&2; exit 1; }
echo "==> build inputs restaged"
