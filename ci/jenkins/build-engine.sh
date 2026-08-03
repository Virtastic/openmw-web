#!/usr/bin/env bash
# Build the WASM engine image on the local build server.
# Clean compile, ~13 min by design (Dockerfile deliberately has no ninja cache mount).
set -euo pipefail

SRC="${SRC:-/src}"
TAG="${TAG:-morrowind:test}"

cd "$SRC"

# The build fails deep and confusingly if these gitignored inputs are missing, so check up front.
[ -d deps/wasm ]            || { echo "FATAL: deps/wasm missing - restage from build-artifacts"; exit 1; }
[ -n "$(ls -A fsroot/gamedata 2>/dev/null)" ] || { echo "FATAL: fsroot/gamedata is empty"; exit 1; }
[ -f fsroot/icudt68l.dat ]  || { echo "FATAL: fsroot/icudt68l.dat missing"; exit 1; }
docker image inspect openmw-builder:1 >/dev/null 2>&1 \
  || { echo "FATAL: openmw-builder:1 not built. See ci/jenkins/README.md"; exit 1; }

echo "==> building $TAG from $(cat .source-commit 2>/dev/null || echo 'unknown commit')"
# --network=host: CMake FetchContent (recastnavigation) needs egress; the default bridge has none.
DOCKER_BUILDKIT=1 docker build --network=host -t "$TAG" -f Dockerfile .

echo "==> built $TAG"
docker image inspect "$TAG" --format '    size: {{.Size}} bytes  created: {{.Created}}'
