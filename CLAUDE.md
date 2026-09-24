# openmw-web — working notes for Claude

## Where builds run

**Heavy builds do NOT run on the laptop.** The engine bake (wasm64, ~15-35 min), the native
sim-peer image (tier2, ~25 min cold) and the multiplayer browser-harness sweeps all run on the
LAN Jenkins box (`builder`, 192.168.1.130: 32 cores, 38 GB). That box is **dev/test only** —
it deploys to the test app server (192.168.1.131) and never to prod.

**Prod is GitHub Actions**: `deploy-ovh` / `deploy-mp` run on push to `ovhcloud` (NOT `main`) and ship to OVH.
Nothing in Jenkins reaches prod.

### The Jenkins job: `openmw-web-dev`

Pipeline from `ci/jenkins/Jenkinsfile` (read from the `dev` branch, so a Jenkinsfile change must
land on `dev` before it takes effect). Parameters:

| param | default | meaning |
|---|---|---|
| `BRANCH` | `dev` | branch to build (a feature branch for a bake + sweep) |
| `DEPLOY` | `true` | deploy engine + server to the test app server — set `false` for feature branches |
| `RUN_HARNESS` | `false` | run the MP browser harness on the images just built |
| `SCENARIOS` | `''` | space-separated ids (`s149 s152`); empty = the full suite |

Stages: checkout into `/src` → restage inputs → `build-engine.sh` (morrowind:test) → deploy engine →
`build-server.sh` (openmw-mp:tier2) → deploy server → `run-harness.sh` (play/ artifacts out of the
engine image, harness image on top of the peer, then `mp-harness.mjs`). The harness log is archived
on the build as `jenkins-<n>.log`; verdicts are deduped at the end of the stage log.

Drive it through the Jenkins MCP (`mcp__jenkins__*`, authenticated as admin):

- trigger a feature-branch bake + sweep:
  `triggerBuild openmw-web-dev {BRANCH=<branch>, DEPLOY=false, RUN_HARNESS=true, SCENARIOS="s149 s152"}`
- watch: `getBuild` (building/result), `getBuildLog` with a negative `limit` for the tail,
  `searchBuildLog` for `^(PASS|FAIL) s`.
- one executor, `disableConcurrentBuilds`: a second trigger queues behind the first.

The branch must be **pushed** — Jenkins clones from GitHub. Push the feature branch, trigger,
keep working locally while it runs.

### Fix everything first, then test ONCE

A bake plus a full sweep costs **hours** (engine ~15-35 min, tier2 ~25 min, harness ~4 h). Do not
spend them on a branch that still has known open issues. For an objective with several problems:

1. Find and fix **every** known issue for the objective; commit and push each fix. Use the cheap
   checks while fixing — Lua unit runner, `npm test`, reading code and existing logs (the harness
   prints the server log tail after every FAIL; read that before asking for a new run).
2. Only when nothing known is left open: **one** bake + sweep. Prefer `SCENARIOS="…"` for the
   scenarios that cover the objective; the full suite is the final evidence before a merge/deploy.
3. From that run, fix everything it shows, commit all of it, then one more run. Never a run per fix.

Do not start ad-hoc harness containers or Jenkins builds mid-fix "to see", and do not leave a
sweep running on a head you already know is broken (stop it and fix instead).

### When the laptop is still the right tool

- Lua unit runner: `bash wasm-build/lua-tests/run.sh`
- server suite: `cd server && npm test` (tsc + ~1080 tests)
- a single harness scenario against images already on the laptop, for a fast edit-run loop
  (see memory `local-fullstack-builds`). Do not start a fresh engine/peer bake here.

## Process

feature branch → PR to protected `main` → `gh pr merge --rebase --delete-branch` → fast-forward
`dev`, `ovhcloud`, `multiplayer912026` to `main`. **Merging to `main` alone deploys nothing**:
`deploy-ovh` / `deploy-mp` trigger on push to `ovhcloud`, so prod ships only when `ovhcloud` is
fast-forwarded. Before pushing `ovhcloud`, tag the running prod image on the box for rollback
(`docker tag openmw-mp:ovh openmw-mp:prev`) — the deploy overwrites `:ovh` and keeps no previous.
Client-Lua or C++ edits need an engine rebake
(browser Lua is baked into openmw.data); peer C++ edits need a tier2 rebuild; both before trusting
a harness verdict.

Commits end `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`; PR bodies end
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Never commit or paste private keys or tokens (prod SSH key and CF token live outside the repo).
