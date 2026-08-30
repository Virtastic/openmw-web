# AGENTS.md

Working notes for AI agents (and humans) on this repo. The most important thing here is
**where work runs**: this project has a dedicated local build server and test server. Use them.
The developer laptop is underpowered for this codebase and locks up under engine builds.

---

## Where things run

| Host | Reached as | Role |
|---|---|---|
| Hypervisor | `ssh proxmox` | Proxmox. Hosts the VMs below. |
| Build server | `ssh $BUILDER` | Jenkins + Docker. All builds and relinks happen here. |
| Test app server | `$TEST_HOST` | Hosts the app for testing. Deploy target. |
| AI VM | `ssh ai-vm` | Local model inference. |

**Addresses are NOT in this file — this repo is public.** The real values live in
`ci/jenkins/config.env` (gitignored; copy `config.env.example` and fill it in), and the
scripts read them from there or from the environment. Host aliases like `proxmox` /
`ai-vm` are whatever you put in your own `~/.ssh/config`.

Sizing that matters for builds: each VM wants ~10 vCPU and enough RAM to hold a WASM link
step (8GB floor, 24GB ceiling with ballooning works), on an NVMe-backed pool.

---

## Rules of engagement

**DO NOT build the engine on the laptop.** A clean WASM engine compile is ~13 minutes and is
deliberately uncached (see `Dockerfile`: "A clean compile every build is slower but deterministic").
It will make the machine unusable. Run it on the build server.

**DO NOT test by running the app locally.** Deploy to the test app server and test there.

**DO NOT push to `ovhcloud` to test.** That branch deploys to *production*
(morrowind.virtastic.app) via the self-hosted runner on the OVH VPS. The local build server
exists precisely so testing never touches production. Note `mp.virtastic.app` is **not** a
thing: the design that wanted it is dead, and the vhost that kept the name alive has been
deleted (see "One origin" below).

**`dev` IS THE INTEGRATION BRANCH, AND IT IS PUBLIC.** `Virtastic/openmw-web` is a **public**
repo, so everything merged to `dev` is published permanently the moment it lands. Read what you
are pushing. `ci/jenkins/config.env` is gitignored and must stay that way — it holds this
network's hosts and key paths.

`dev` is branch-protected: **one approving review**, stale reviews dismissed, no force-push and
no deletion. Admins are not forced through it (`enforce_admins` is off), so the maintainer keeps
a direct push for emergencies — use it as one.

**Contributors open a PR against `dev`.** The maintainer approves and merges. `main` and
`ovhcloud` are NOT touched by this flow: `ovhcloud` deploys production and is a separate,
deliberate promotion.

---

## The loop

**Merge to `dev`, then TRIGGER THE JENKINS JOB. That is the deploy path -- use it first.**

```
job: openmw-web-dev      https://build.dev.virtastic.app/job/openmw-web-dev/
scm: */dev  (github.com/Virtastic/openmw-web.git)
```

Trigger it with the Jenkins MCP tools (`triggerBuild` on `openmw-web-dev`; `getBuild` /
`getBuildLog` to follow it). The pipeline lives in the repo at `ci/jenkins/Jenkinsfile` and runs
`restage-inputs.sh` -> `build-engine.sh` -> `deploy-test.sh engine` -> the server stage.

CORRECTION, 2026-08-30: this section previously said Jenkins could not be triggered at all --
"needs a credential this setup does not hand out", `/git/notifyCommit` 401, remote build URL 403.
That is no longer true. The Jenkins MCP server triggers it authenticated (verified: build #81),
so the manual SSH route below is now the FALLBACK, not the normal way.

**Why the job and not the script.** The job carries `disableConcurrentBuilds`. The SSH script
ssh's straight past it, and NOTHING else locks the builder -- there is no flock or lockfile
anywhere in `ci/`. Two overlapping runs share one `~/morrowind-src` and one set of image tags, so
a manual run during a Jenkins build can swap the source tree mid-compile and produce a silently
wrong image. Use the job; it serialises for you.

**Fallback, when you need a ref Jenkins will not build (an unmerged branch):**

```bash
CONFIRM=1 ci/jenkins/release-to-test.sh engine                    # dev
CONFIRM=1 REF=my-branch ci/jenkins/release-to-test.sh engine      # a branch, detached checkout
```

`CONFIRM=1` is required because there is no build-without-deploy -- this ALWAYS replaces the
shared test site. Announce it first; you are holding a ~15 minute lock nothing enforces.

DO NOT wrap it in `timeout`. A deploy runs well past 50 minutes with brotli -q 11 over a ~176MB
`openmw.data`, and a timeout kills the SSH session mid-compression leaving the previous image in
place -- which looks exactly like a deploy that is still running. (Learned the expensive way.)

Either path fetches the ref, restages the build inputs git cannot carry, builds, and deploys --
stopping at the first failure. The deploy runs the contract gate and fails on any miss.

**CLIENT LUA IS BAKED INTO THE ENGINE.** `fsroot/resources/vfs/scripts/mp/*.lua` is packed into
`openmw.data`, so the browser scenario suite runs whatever was in the engine at BUILD time, not
what is on disk. Editing a client script and re-running `mp-harness.mjs` tests the OLD code and
passes, which is worse than not running it. Rebuild the engine (~13 min) before believing a
scenario result about a client-side change. Cheap check:

```bash
grep -c <your-new-symbol> play/openmw.data    # 0 means the harness cannot see your change
```

**RUN IT SO IT OUTLIVES ITS CALLER.** It drives the build server over a single ssh session, so if
the local process dies the ssh dies with it and the remote run stops WHEREVER IT HAD GOT TO. That
is not a visible failure: a run killed between the two deploys shipped the server and not the
engine, every line it had printed said success, and the site kept serving the previous client
while the server ran new code. Nothing in the logs says so -- the tell is the engine hash in
`/index.html` not moving, and the container's age not resetting. Foreground it, or use a job
runner that keeps it alive; `nohup cmd &` from a shell that then exits is exactly the trap.

Confirm a deploy by what CHANGED, never by the exit code:

```bash
curl -sk https://<origin>/index.html | grep -o '__ENGINE_VER = "[^"]*"'   # must differ
ssh <test-host> 'docker ps --format "{{.Names}} {{.RunningFor}}"'         # must have reset
```

| Job | Time | What it does |
|---|---|---|
| server | ~1 min, longer if `openmw/` changed | gateway + sim peer -> deploy -> contract gate |
| engine | ~13 min | WASM engine + statics -> deploy -> contract gate |

Nothing compiles on the laptop. A clean engine build is ~13 minutes and will lock that machine
up; `release-to-test.sh` only ever drives the build server over ssh.

**Jenkins holds the same two jobs**, defined by `ci/jenkins/Jenkinsfile.engine` and
`.server` in this repo, and runs the identical scripts. Use *Build Now* from its UI if you
prefer a button and a build history. It is deliberately not scheduled.

**The build inputs are not in git.** `deps/`, `fsroot/gamedata/` and `fsroot/icudt68l.dat` are
~750 MB of retail data and prebuilt dependencies, deliberately unpublished, so a checkout alone
is NOT a buildable tree -- `build-engine.sh` hard-fails on all three.
`ci/jenkins/restage-inputs.sh` puts them back from `~/build-artifacts` when missing; normally a
no-op, since `git checkout -f` leaves untracked files alone.

**`sync-to-builder.sh` is retired.** It rsynced the laptop's tree including
`ci/jenkins/config.env` -- which is how the deploy stage silently broke: that file carries
laptop-shaped `TEST_HOST`/`SSH_KEY` values that cannot resolve inside the Jenkins container, so
deploys failed there while working by hand, and nobody saw a red build because the job simply
stopped being used. Commit your work and push it instead.

After a deploy the test server serves:

| Container | Port on `test-vm` | What |
|---|---|---|
| `morrowind-test` | `8080` | The web root: engine WASM + statics + `/mwdata` + `/srv/data` |
| `openmw-mp-test` | *none* | The server: `dist/gateway.mjs` + sim peer |

**The gateway publishes NO host port.** Both containers join the `omw-test` docker network
and `morrowind-test`'s Caddy reverse-proxies the gateway on the SAME origin (see "One origin"
below). A second published port is a second address to get wrong, and the client has no way
to use one. `--network omw-test` is therefore mandatory: the default bridge has no DNS, so
Caddy could not resolve `openmw-mp-test` at all.

### The contract gate — run this after ANY deploy

```bash
ci/jenkins/smoke-test.sh https://your-origin
```

`deploy-test.sh` runs it automatically and FAILS the deploy on any miss. Point it at a
from-scratch deployment too — it is curl-only and needs nothing from this repo.

Every check in it is a bug that actually shipped, passed `/healthz`, and cost hours:

| Check | The failure it catches |
|---|---|
| `/index.html` serves the game | The launcher gate rewriting it back to the chooser. MP boot params live in the FRAGMENT, which never reaches the server, so a "no query string" guard rewrites the boot URL and the two bounce forever. **Presents as a character screen stuck on "Creating…" while the server log shows the world starting perfectly.** |
| `/w/<id>` upgrades to 101 | The gameplay socket not proxied — sign-in works, then the game reaches no world. |
| `/locker/*` returns 401 | Not proxied (404) — sign-in works, then the data upload dies. |
| `/worlds` omits `host`/`port` | The directory advertising an address; the old default was `127.0.0.1`, which is a remote player's OWN machine. |
| sign-in returns to this origin | A stale `[auth].returnUrl` redirecting every player to wherever it last pointed. |
| return keeps `https` | The edge not forwarding `X-Forwarded-Proto`, silently downgrading every sign-in. |
| COOP/COEP present | The engine refusing to start (no SharedArrayBuffer). |
| `/admin` `/metrics` not exposed | Operator surfaces reachable from the internet. |
| asset pack 206 | Range requests broken, so StreamFS never mounts the pack — and it fails soft, so nothing says so. |

Two traps when writing checks like these by hand:
- **HTTP/2 cannot carry a WebSocket upgrade.** Without `--http1.1` you get a misleading 404/502.
- **`curl … | grep -q` under `set -o pipefail` reports failure ON A MATCH** — grep closes the
  pipe, curl dies of SIGPIPE. Capture to a variable first. This inverted three checks in the
  first version of the smoke test.

### One origin: the gateway lives behind the game's own Caddy

The game page and the multiplayer server are **one origin**. `deploy/Caddyfile` reverse-proxies
a fixed set of paths to the gateway (`{$MP_UPSTREAM:openmw-mp:8080}`; the test deploy passes
`MP_UPSTREAM=openmw-mp-test:8080` because the container is named per environment).

This is not a preference. `index.html` refuses to hand its session ticket to a gateway whose
hostname differs from the page's, so a separate `mp.<domain>` origin can never receive it —
`deploy/openmw-mp.caddy` used to keep an `mp.virtastic.app` vhost alive for a deploy
healthcheck; it has been deleted. It proxied the gateway with NO path filter, so it exposed
`/healthz` and `/status`, which the same-origin config deliberately withholds - and since Caddy
routes on the Host header, having no DNS record protected nothing.
The launcher derives the server from `location`, so production, the dev preview and a
self-host all work with **no per-environment constant**. A baked-in hostname is wrong in every
deployment but the one it was built for; that bug shipped once and cost a full debugging pass.

**Proxy exactly these, and know why:**

| Path | Why it must be proxied |
|---|---|
| `/w/*` | **The gameplay WebSocket.** The directory returns `wsPath=/w/<worldId>` and the client dials it on the page's origin — this is what lets each world run on an unpublished internal port. |
| `/auth/*` | SSO. `/auth/providers` is what renders the "Continue with Google" button. |
| `/locker/*` | The S3-backed game-data upload (`/locker/needed`). |
| `/worlds`, `/worlds/*` | World directory. |
| `/ws` | NOT a gateway route — it answers **502 by design**. It is only the base the launcher derives its HTTP origin from (`httpBaseOf`) plus a local-dev direct-dial fallback. Proxied so dev matches prod. |

`/admin`, `/metrics`, `/healthz` and `/status` are deliberately NOT proxied.

Miss `/w/*` and the failure lands one step *after* the part that looks fixed: sign-in succeeds,
then the game connects to nothing. Verify with an explicit upgrade, not a browser click:

```bash
curl -i -N --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://morrowind.dev.virtastic.app/w/vvardenfell        # 101 ONLY if that world is running
```

HTTP/2 cannot carry a WebSocket upgrade — without `--http1.1` you get a misleading 404/502.

**A 502 here is usually CORRECT, not a fault.** `[worlds] publicEnabled` is OFF by default and
deliberately so (config.default.toml), and the gateway starts no world until a player creates
their own — so `vvardenfell` does not exist on a default deployment and dialling it 502s. Verified
on dev 2026-08-30: `/worlds` returns `{"worlds":[]}` and the gateway's own boot line reads
`{"event":"gateway.start","publicEnabled":false,"publicWorlds":0}` while both containers are
healthy. deploy-test.sh already encodes this ("NO WORLD AT BOOT IS A VALID STATE NOW... Reading it
as broken failed a deploy of a perfectly good server").

So check the CAUSE before calling it an outage:

```bash
curl -s https://morrowind.dev.virtastic.app/worlds          # [] = no world is running
# on the test host: docker logs openmw-mp-test | grep gateway.start   # publicEnabled true/false
```

Expect 101 only when a public world is actually up — i.e. `publicEnabled = true`, or the gateway
was started with `--public-world vvardenfell`.

### Simulation authority: one peer, every occupied cell

**Authority belongs to the sim peer. Never to a player.** A cell simulated by a client is a
bug, not a fallback — a modified client would author NPC state for everyone in it.

One peer covers the whole world, not one peer per region. A peer is a full OpenMW instance
(one ESM store, one physics world, one navmesh, one AI tick), and the server hands it a list
of ANCHORS: regions to keep loaded and ticking. Everything happens inside a single coherent
simulation, so there is nothing to reconcile between regions. A process per region was tried
and abandoned — it is also unsolvable in principle, because N simulations of one world have
to agree with each other.

Anchors come in two kinds, and the difference is not cosmetic:

| | How it is held | Peer must stand there? |
|---|---|---|
| **Exterior** | grid coordinate (`osg::Vec2i`), 3x3 block per anchor | no |
| **Interior** | cell NAME | no (since the interior-anchoring change) |

Interiors used to be impossible to anchor: `Scene::setSimAnchors` took only grid coordinates,
and an interior has none. A peer could therefore simulate exactly one room — the one its own
avatar stood in — so **every indoor player was in a cell nothing simulated**. Morrowind's
opening is entirely indoors, which is why chargen stalled at the census office with the guard
frozen mid-line: no simulator, no AI tick, no quest progression.

What makes interiors work, all three needed together:

- `Scene` keeps `mSimAnchorInteriors` loaded AND exempts them from the unload sweep in
  `changeCellGrid`. Without the exemption, any exterior grid change dropped every held room —
  so one player walking a cell boundary outdoors froze another player's NPCs indoors.
- `MWMechanics::Actors` skips the processing-range cull for actors in a held interior.
  Distance across a door is meaningless (the room may be a mile away in world units), so the
  range check culled precisely the NPCs the server asked for. They are not distance-faded
  either, for the same reason.
- `setSimAnchors(anchors, interiors)` takes the second list; `SimAnchors` carries it;
  `global.lua` forwards it; `server.ts` sends every occupied cell.

`simpeer.anchors` logs `exteriors: N, interiors: M` — that is the fastest check that a room is
actually held.

### There are no tiers

"Tier 1" / "tier 2" is dead vocabulary from an older design and is being stripped out. There is
one deployment. Do not describe the server in tiers, and do not treat NPCs-simulated-by-clients
as a supported fallback — if the sim peer is not running, the deploy is broken.

The deployment is:
- image built with `docker build -f server/Dockerfile.simpeer --target tier2 .` from the
  **repo root** (it needs `openmw/` in the context — it compiles the fork natively). The
  `tier2` target name is a leftover in the Dockerfile; the thing it builds is just the server.
- **NOT** `server/Dockerfile` — that alpine/musl image has no peer binary and cannot run the
  glibc one. Legacy.
- runs `dist/gateway.mjs` — world supervisor + directory + SSO/locker front door, on **ONE**
  public port. Per-world server processes get internal ports from `--base-port 9000`; they are
  never exposed.
- requires real game data at `/data/gamedata`. Without `Morrowind.esm` the peer does not start
  and the server silently falls back to client-simulated NPCs — the deploy script asserts on
  the `simpeer` log line and fails rather than shipping that.

The engine container and the gateway container are separate images, but the gateway is *the*
server. The multiplayer CLIENT is baked into the engine
(`fsroot/resources/vfs/scripts/mp/*.lua`), so "one server does SP and MP" is about the gateway,
not about running two backends.

### Deploying the server: four ways it silently goes wrong

All four of these were live at once on 2026-07-31 and produced a site that looked healthy.

1. **NEVER deploy with a hand-rolled `docker build` / `docker run`.** Every guard lives in
   `ci/jenkins/build-server.sh` and `deploy-test.sh`; a manual command bypasses all of them.
   This is how `openmw-mp:test` — an **alpine/musl image with NO `openmw` binary** — ended up
   deployed and running for hours. If you see the tag `openmw-mp:test`, it is the legacy
   image and it is wrong; the real one is `openmw-mp:tier2`. Check with:
   `docker run --rm --entrypoint sh <tag> -c 'command -v openmw'`
2. **`[server].password` must be set in `config.toml`.** Empty is a hard refusal now (the
   peer's only credential). The symptom is nasty: the gateway answers `/healthz` with **200**
   while the per-world process crash-loops underneath it — grep the logs for `world.crashed`.
3. **UID mismatch on the mounted secrets.** `openmw-mp:tier2` runs as `app` = **uid 1001**;
   `config.toml` and `s3.env` are mode `600` owned by **uid 1000**, so the container dies at
   `loadConfig()` with `EACCES`. The legacy alpine image ran as `node`, which *is* uid 1000,
   so it only ever worked by coincidence. `deploy-test.sh` now derives the flag with
   `--user $(stat -c '%u:%g' /opt/openmw-mp-test/data)` — do not hardcode it.
4. **The deploy gate must match the logs the server actually emits.** It asserts on
   `simpeer.ready_to_spawn` (emitted only once the peer binary resolved AND the game data
   parsed). It previously asserted `"enabled":true`, a log shape that no longer exists, so it
   failed *every* deploy including correct ones. If you change the server's logging, change
   the gate.

Prove the gate still bites, rather than trusting it:
`TAG=openmw-mp:test ci/jenkins/deploy-test.sh server` must exit **1** even though `/healthz`
returns 200.

### Local dev needs a gateway too

`play/server.py` proxies the same path set to `OPENMW_MP_UPSTREAM` (default `127.0.0.1:8080`),
so local dev is single-origin exactly like production. There is deliberately no "if localhost
use port 8080" branch in the launcher any more: a special case makes local behave differently
from prod, which is how a broken production path can pass local testing.

That means **local multiplayer needs something listening on the upstream**. Either run a
gateway locally, or tunnel to the test server's (it publishes no host port, so go via its
container IP on the docker network):

```bash
GWIP=$(ssh test-vm "docker inspect openmw-mp-test --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'")
ssh -N -L 18080:$GWIP:8080 test-vm &
OPENMW_MP_UPSTREAM=127.0.0.1:18080 OPENMW_LAUNCHER=1 python3 play/server.py
```

With no upstream you get a clean **502** on the gateway paths (never a hang), and the launcher
reports the server as unreachable — which is the correct signal, not a bug.

### The performance asset pack

`openmw-web-assets.bsa` (~119 MB, MOP + Project Atlas) is NOT in the image and NOT in git.
`mountAssetPack()` probes `moddata/` then `data/`, and **fails soft** — a missing pack just
logs and continues, so its absence is invisible unless you look. Stage it at
`/opt/morrowind-test/data/` on `test-vm` (mounted `/srv/data:ro`). Verify it is range-served,
since StreamFS needs `Content-Range`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -r 0-0 https://morrowind.dev.virtastic.app/data/openmw-web-assets.bsa   # expect 206
```

### Which job to run

- Touched `server/**` only → `OpenMW-Web-MP-Server` (~1 min for the node bundle; the image
  reuses cached native layers unless `openmw/` changed).
- Touched `openmw/**`, `fsroot/**`, `configure-openmw.sh`, `wasm-build/**` → `OpenMW-Web-Engine-WASM`
  (~13 min). Note `openmw/**` also invalidates the server's native peer build.
- Touched `play/*.html` only → still the engine job (statics are baked into the image).

---

## Build prerequisites (already staged on the build server)

The engine build needs three **gitignored** inputs that are not in the repo. They live at
`~/build-artifacts` on `jenkins-vm` and are copied into `~/morrowind-src` before a build:

- `deps/` — prebuilt cross-compiled dependency stack (OSG, Bullet double-precision, MyGUI,
  FFmpeg, Boost 1.85, ICU). ~600MB of the 2.3GB local tree is what the builder image needs.
- `fsroot/gamedata/` — game data. Build fails loud if empty.
- `fsroot/icudt68l.dat`

The toolchain image `openmw-builder:1` (4.4GB) is prebuilt on the build server from
`Dockerfile.builder`. It pins **emscripten 6.0.1** — a mismatch breaks the prebuilt deps.

`Dockerfile.builder.dockerignore` exists because the main `.dockerignore` excludes `deps/`
(correct for `Dockerfile`, fatal for `Dockerfile.builder`, which must bake deps in). BuildKit
picks the per-Dockerfile ignore file automatically.

All docker builds need `--network=host` — CMake FetchContent (recastnavigation) and `npm ci`
need egress and the default bridge has none.

---

## Serving contract (do not break)

The engine uses `-pthread` / `SharedArrayBuffer`, so any host serving it must provide:

- **HTTPS** — `SharedArrayBuffer` requires a secure context. `localhost` is exempt; a bare
  hostname over plain HTTP is **not**, and the engine will fail to start.
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: cross-origin`
- `application/wasm` MIME, precompressed `.br` siblings, Range requests on `openmw.data`

The engine image is self-contained (caddy + `deploy/Caddyfile`) and already sets these.

---

## Game data on the test server

Two separate stagings, for two different consumers. Neither is in git.

| Path on `test-vm` | Source on the dev Mac | Mounted as | For |
|---|---|---|---|
| `/opt/morrowind-test/mwdata` | `CS-Web/play/mwdata` | `/srv/mwdata:ro` on `morrowind-test` | The browser. `index.html` fetches `/mwdata/{Morrowind,Tribunal,Bloodmoon}.esm`. Use THIS source — it carries the `.br` siblings and `.tar` bundles the serving contract needs. |
| `/opt/openmw-mp-test/data/gamedata` | `~/Downloads/Morrowind-DataFiles` | `/data/gamedata` on `openmw-mp-test` | The sim peer. Use THIS source — the peer is a real OpenMW install and wants the FULL Data Files tree (BSAs, Fonts, Music, Sound, Splash, Video), not just the ESM/BSA subset in `play/mwdata`. |

Do not cross the sources. `play/mwdata` lacks Fonts/Sound/Video and will not satisfy the peer;
`Morrowind-DataFiles` lacks the `.br` siblings and will make the browser refetch uncompressed.
Never mix the Example Suite demo data into `/data/gamedata` — it is a different game.

`play/mwdata` is excluded by `.dockerignore` and is never baked into an image — it is always
mounted. A deploy that forgets the mount gives you a working launcher that can only run `?nomw`.

## Server config and secrets on the test server

`/opt/openmw-mp-test/data/config.toml` (mode 600, NOT in git) — seeded from
`server/devdata/config.toml` plus a `[locker]` block:

```toml
[locker]
endpoint = "https://s3.us-east-va.io.cloud.ovh.us"   # note .ovh.US, not .ovh.net
region   = "us-east-va"
bucket   = "openmw-web"
```

S3 credentials are NEVER in config — `s3FromEnv` reads `S3_ACCESS_KEY_ID` /
`S3_SECRET_ACCESS_KEY` from the environment. Staged at
`/opt/openmw-mp-test/data/s3.env` (mode 600) and passed with `--env-file` by
`ci/jenkins/deploy-test.sh`. Confirm with `s3.configured` in the startup logs; if that line
is absent the locker is off, because `s3FromEnv` returns undefined unless ALL FOUR of
endpoint/bucket/key/secret are set.

Google SSO lives in the same config. `redirectUri` must match a URI registered in the Google
console EXACTLY, so it differs per environment — on the test server it is
`https://morrowind.dev.virtastic.app/auth/google/callback`.

Note `.dev-local/config.toml` has NO `[locker]` section — local dev runs with the locker
disabled and the launcher falling back to bring-your-own-disk. Do not go looking there for
S3 settings; they only exist in the OVH console and on the test server.

## Gotchas worth knowing

- `build-wasm/`, `build-native/`, `build-*` are **output directories**, not scripts. The real
  scripts are in `wasm-build/` (`link-openmw.sh`, `make_br.sh`, `version-engine.sh`).
- `link-openmw.sh` must rebuild `openmw-lib` via ninja, or new engine bindings ship MISSING and
  silently kill the MP transport.
- Node **22** for the server (`node:22-alpine`), npm (not pnpm/yarn), `npm ci`.
- The server test suite is the deploy gate: `tsc --noEmit && node --test`. If it fails,
  nothing is deployed.
