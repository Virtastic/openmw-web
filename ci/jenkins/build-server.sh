#!/usr/bin/env bash
# Build the multiplayer server image: the gateway plus the headless sim peer, in one
# container. This is THE server deployment.
#
# Do NOT build server/Dockerfile for a deploy - that alpine/musl image has no peer binary
# and cannot run the glibc one. It is legacy and is being stripped out.
#
# Context is the REPO ROOT, not server/ - the build compiles the OpenMW fork natively and
# needs openmw/ in the context.
set -euo pipefail

SRC="${SRC:-/src}"
TAG="${TAG:-openmw-mp:tier2}"   # image tag follows the Dockerfile's build target name

cd "$SRC"

[ -d openmw ] || { echo "FATAL: openmw/ missing from the build context"; exit 1; }

echo "==> building $TAG from $(cat .source-commit 2>/dev/null || echo 'unknown commit')"
# --network=host: npm ci and the MyGUI/Bullet git clones need egress.
# The native OpenMW compile dominates; layers cache unless openmw/ changed.
DOCKER_BUILDKIT=1 docker build --network=host \
  -f server/Dockerfile.simpeer --target tier2 -t "$TAG" .

echo "==> built $TAG"
docker image inspect "$TAG" --format '    size: {{.Size}} bytes  created: {{.Created}}'

# The peer binary must actually be in there. Without it the server comes up in the legacy
# client-simulated mode and looks healthy while doing the wrong thing.
docker run --rm --entrypoint sh "$TAG" -c 'command -v openmw >/dev/null' \
  || { echo "FATAL: $TAG has no openmw peer binary"; exit 1; }
echo "    peer binary present"
