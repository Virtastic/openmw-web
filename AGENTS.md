# AGENTS.md

Working notes for AI agents (and humans) on this repo. The most important thing here is
**where work runs**: this project has a dedicated local build server and test server. Use them.
The developer laptop is underpowered for this codebase and locks up under engine builds.

---

## Where things run

| Host | Address | Role |
|---|---|---|
| Proxmox host | `192.168.1.106` (`ssh proxmox`) | Hypervisor. Threadripper 1950X, 32 threads, 62GB RAM. |
| Build server | `192.168.1.130` (`ssh jenkins-vm`) | Jenkins + Docker. All builds and relinks happen here. |
| Test app server | `192.168.1.131` (`ssh test-vm`) | Hosts the app for testing. Deploy target. |
| AI VM | `192.168.1.132` (`ssh ai-vm`) | Local model inference (CPU). |

DNS namespace for these boxes is `*.dev.virtastic.app`:
`jenkins.dev.virtastic.app`, `morrowind.dev.virtastic.app`, `ai.dev.virtastic.app`.

Each VM: 10 vCPU, 8GB RAM floor / 24GB ceiling (ballooning), 120GB thin disk on an NVMe pool.

---

## Rules of engagement

**DO NOT build the engine on the laptop.** A clean WASM engine compile is ~13 minutes and is
deliberately uncached (see `Dockerfile`: "A clean compile every build is slower but deterministic").
It will make the machine unusable. Run it on the build server.

**DO NOT test by running the app locally.** Deploy to the test app server and test there.

**DO NOT push to `ovhcloud` to test.** That branch deploys to *production*
(morrowind.virtastic.app) via the self-hosted runner on the OVH VPS. The local build server
exists precisely so testing never touches production. Note `mp.virtastic.app` is **not** a
thing — it has no DNS record and the design that wanted it is dead (see "One origin" below).

**DO NOT push local feature branches to `origin`.** `Virtastic/openmw-web` is a **public** repo.
The `multiplayer` branch is local-only and unpushed. Publishing is the maintainer's decision.
(There is also a credential in `fsroot/resources/vfs/scripts/mp/net.lua` pending rotation.)
The build server does not use git — it builds from a synced working tree, so nothing leaves
the network.

---

## The loop

The build server holds a mirror of the working tree at `~/morrowind-src` on `jenkins-vm`.
Sync local changes to it, then trigger a build.

```bash
# 1. push your working tree to the build server (from the repo root)
./ci/jenkins/sync-to-builder.sh

# 2. build + deploy to the test server
#    Jenkins UI:  http://192.168.1.130:8080/
#      OpenMW-Web-MP-Server     ~1 min    gateway + sim peer, then deploy
#      OpenMW-Web-Engine-WASM   ~13 min   WASM engine: full compile, then deploy
```

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
the `mp.virtastic.app` vhost in `deploy/openmw-mp.caddy` is a dead end and has no DNS record.
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
  https://morrowind.dev.virtastic.app/w/vvardenfell        # expect 101
```

HTTP/2 cannot carry a WebSocket upgrade — without `--http1.1` you get a misleading 404/502.

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
