#!/usr/bin/env bash
# Build the WASM engine image on the local build server.
# Clean compile, ~13 min by design (Dockerfile deliberately has no ninja cache mount).
set -euo pipefail

SRC="${SRC:-/src}"
TAG="${TAG:-morrowind:test}"

# WASM64 (MEMORY64). OMW_WASM64=1 builds the wasm64 engine, which is what a Tamriel Rebuilt load
# order needs. Everything that differs between the two models is derived from this one variable,
# so there is no second code path here to drift out of sync.
if [ "${OMW_WASM64:-0}" = "1" ]; then
  DEPS_DIR=deps/wasm64; BUILDER_IMAGE=openmw-builder64:1
else
  DEPS_DIR=deps/wasm;   BUILDER_IMAGE=openmw-builder:1
fi

cd "$SRC"

# The build fails deep and confusingly if these gitignored inputs are missing, so check up front.
[ -d "$DEPS_DIR" ]          || { echo "FATAL: $DEPS_DIR missing - restage from build-artifacts"; exit 1; }
[ -n "$(ls -A fsroot/gamedata 2>/dev/null)" ] || { echo "FATAL: fsroot/gamedata is empty"; exit 1; }
[ -f fsroot/icudt68l.dat ]  || { echo "FATAL: fsroot/icudt68l.dat missing"; exit 1; }
docker image inspect "$BUILDER_IMAGE" >/dev/null 2>&1 \
  || { echo "FATAL: $BUILDER_IMAGE not built. See ci/jenkins/README.md"; exit 1; }

echo "==> building $TAG ($DEPS_DIR, $BUILDER_IMAGE) from $(cat .source-commit 2>/dev/null || echo 'unknown commit')"
# --network=host: CMake FetchContent (recastnavigation) needs egress; the default bridge has none.
DOCKER_BUILDKIT=1 docker build --network=host -t "$TAG" -f Dockerfile \
  --build-arg "BUILDER_IMAGE=$BUILDER_IMAGE" .

echo "==> built $TAG"
docker image inspect "$TAG" --format '    size: {{.Size}} bytes  created: {{.Created}}'
