# openmw-web — working notes for Claude

## Where builds run

**Everything builds locally on the laptop, in Docker.** Jenkins is retired and nothing is built
remotely. The laptop has 32 cores / 31 GB; builds are memory-bound, so run ONE docker build at a time
(`flock /tmp/omw-build.lock docker build ...`; parallel agents share that lock).

**This branch is OpenTES3 (v2).** Its deploy path is not settled yet, so nothing on OpenTES3
deploys anywhere. `ci/jenkins/*` is kept only as the recipe the local commands below come from.

### Gitignored build inputs (not in git; see docs/DEMO-DATA-PROVENANCE.md)

| path | what | where it comes from |
|---|---|---|
| `deps/wasm64` | the cross-compiled dependency stack | `wasm-build/fetch-deps.sh`, then `OMW_WASM64=1 wasm-build/build-deps.sh em_ports lz4 lua boost bullet recast mygui ffmpeg osg` inside `emscripten/emsdk:6.0.1` (mount the repo at `/build`, `-e ROOT=/build -e EM_LIBEXEC=/emsdk/upstream/emscripten -e OMW_WASM64=1 -e JOBS=10`) |
| `openmw-builder64:1` | toolchain image | `docker build -t openmw-builder64:1 -f Dockerfile.builder64 --build-arg HOST_REPO_DIR=$PWD .` |
| `fsroot/icudt68l.dat` | ICU 68 data | `icu4c-68.2-data-bin-l.zip` from the unicode-org/icu release-68-2 assets |
| `fsroot/gamedata/` | the FREE `?nomw` demo, baked into `openmw.data` | the `/gamedata/` entries of the public `openmw.data` (manifest in `openmw.js`). **Never retail Morrowind files here.** |
| `play/mwdata/` | retail Morrowind/Tribunal/Bloodmoon, read by the harness peer | your own install |

### Build and sweep commands

- engine image: `DOCKER_BUILDKIT=1 docker build --network=host --build-arg CCACHE=1 --build-arg TEST_HOOKS=1 -t morrowind:test -f Dockerfile .`
- peer image (runs the server suite inside): `DOCKER_BUILDKIT=1 docker build --network=host --build-arg CCACHE=1 -f server/Dockerfile.simpeer --target tier2 -t openmw-mp:tier2 .`
  A test that reads files outside `server/` (play/, openmw/, deploy/, wasm-build/) must `skip` when they are absent, or this build fails. BuildKit clips its log at 2 MB, so reproduce a failure by running the suite against a copy of `server/` alone.
- sweep: `SRC=$PWD HOST_SRC=$PWD ENGINE_TAG=morrowind:test PEER_TAG=openmw-mp:tier2 SCENARIOS="s98 s99" LOG=<file> bash ci/jenkins/run-harness.sh` (empty `SCENARIOS` = the full suite; `HARNESS_LANES=n` for parallel lanes). Docker has no NVIDIA runtime here, so browsers render in software: leave the machine idle during a sweep or timing assertions fail for load, not for the code.

### Fix everything first, then test ONCE

A bake plus a full sweep costs **hours** (engine ~15-35 min, tier2 ~25 min, harness ~4 h). Do not
spend them on a branch that still has known open issues. For an objective with several problems:

1. Find and fix **every** known issue for the objective; commit each fix (push only when the maintainer asks). Use the cheap
   checks while fixing — Lua unit runner, `npm test`, reading code and existing logs (the harness
   prints the server log tail after every FAIL; read that before asking for a new run).
2. Only when nothing known is left open: **one** bake + sweep. Prefer `SCENARIOS="…"` for the
   scenarios that cover the objective; the full suite is the final evidence before a merge/deploy.
3. From that run, fix everything it shows, commit all of it, then one more run. Never a run per fix.

Do not start ad-hoc harness containers or image builds mid-fix "to see", and do not leave a
sweep running on a head you already know is broken (stop it and fix instead).

### Cheap checks while fixing

- Lua unit runner: `bash wasm-build/lua-tests/run.sh`
- server suite: `cd server && npm test` (tsc + ~1450 tests)
- a single scenario against the images already built (the sweep command above with one id).

## Process

All v2 work commits to `OpenTES3` (one commit per ticket, `CLn (OT3-nnn): …`). It never goes
to `main` (v1), `dev` or `ovhcloud`, and OpenTES3 is pushed only when the maintainer asks.
Client-Lua or C++ edits need an engine rebake
(browser Lua is baked into openmw.data); peer C++ edits need a tier2 rebuild; both before trusting
a harness verdict.

Commits carry no `Co-Authored-By` line; PR bodies end
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Never commit or paste private keys or tokens; they live outside the repo.
