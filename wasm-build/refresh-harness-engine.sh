#!/usr/bin/env bash
# Refresh the browser harness's engine from the DEPLOYED image, and refuse to run the suite
# against a stale one.
#
# Why this exists: client Lua is baked into openmw.data, so a scenario tests the engine as
# BUILT, not the tree. The harness serves its own copy under play/, which the Jenkins deploy
# does NOT touch -- that only updates the running app container. The two drifted for most of a
# day and produced ten scenario failures that looked like product bugs and were not, because
# nothing anywhere says "the thing you are testing is older than the thing you fixed".
#
# Do not date-check the bundle to decide whether it is current. The mtimes look fine. Probe for
# a bare identifier, which is what --verify does.
#
# --verify ONLY WORKS FOR LUA. openmw.data is the virtual filesystem -- client scripts and
# game assets -- so a Lua identifier appears in it as plain text. A C++ change does not: it
# is compiled into openmw.wasm with its symbols gone, and probing for one reports STALE on a
# bundle that is perfectly current. That false negative was hit for real. For an engine-side
# change, trust the build number instead.
set -euo pipefail

CONTAINER="${CONTAINER:-morrowind-test}"
PLAY="${PLAY:-/home/testapp/mpharness/play}"

# The engine lives in a content-hashed directory inside the image, so the name changes on every
# build and cannot be hardcoded.
src_dir() {
  docker exec "$CONTAINER" sh -c 'dirname "$(find /srv/e -name openmw.data | head -1)"'
}

verify() {
  local sym="$1"
  if grep -qa "$sym" "$PLAY/openmw.data"; then
    echo "  ok: '$sym' is in the harness bundle"
  else
    echo "  STALE: '$sym' is in the tree but NOT in $PLAY/openmw.data" >&2
    echo "  The suite would be testing an engine older than your fix. Run this without --verify." >&2
    return 1
  fi
}

if [ "${1:-}" = "--verify" ]; then
  shift
  [ $# -gt 0 ] || { echo "usage: $0 --verify <identifier> [identifier...]" >&2; exit 2; }
  rc=0
  for sym in "$@"; do verify "$sym" || rc=1; done
  exit $rc
fi

SRC="$(src_dir)"
[ -n "$SRC" ] || { echo "FATAL: no openmw.data inside $CONTAINER — is it running the deployed image?" >&2; exit 1; }
echo "==> copying engine from $CONTAINER:$SRC to $PLAY"

# Written to a sidecar and moved into place: a half-copied 200 MB openmw.data is a boot failure
# that looks nothing like a truncated download, and the copy takes long enough to be interrupted.
for f in openmw.data openmw.js openmw.wasm streamfs.js; do
  docker cp "$CONTAINER:$SRC/$f" "$PLAY/$f.new"
  mv "$PLAY/$f.new" "$PLAY/$f"
  echo "  $f"
done
echo "==> done. Verify with: $0 --verify <an identifier your change added>"
