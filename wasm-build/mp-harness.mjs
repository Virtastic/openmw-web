#!/usr/bin/env node
// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M0 multiplayer browser test harness: boots the omw-mp server + play/server.py, then drives
// N headless-Chrome game clients over raw CDP (same transport as smoke.mjs — node's built-in
// WebSocket, no puppeteer) through scenarios in wasm-build/mp-scenarios/.
//
// Usage: node wasm-build/mp-harness.mjs [s01 s03 ...]   (default: all scenarios, sorted)
// Env:   SMOKE_GL=swiftshader  -> software GL (default: real GPU via ANGLE Metal, like smoke.mjs)
//
// Each scenario gets a FRESH server (ephemeral port, throwaway data dir) so account state can
// never leak between runs; account names are additionally suffixed with a per-run id. Teardown
// kills ONLY the PIDs this harness spawned — never any pkill pattern (repo hard rule: the
// user's real Chrome must be untouchable; every client runs in a throwaway --user-data-dir).
import { spawn, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // repo root
const SCENARIO_DIR = join(ROOT, 'wasm-build', 'mp-scenarios');
// CHROME_BIN overrides the path. The suite was macOS-only by hardcode, so it could only run
// on the developer's own machine — where six concurrent engine boots fight the daily driver,
// which is why it stopped being run at all. The build server has 32 cores and no one using it.
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PLAY_PORT = 8910; // fixed in play/server.py (no port flag); we reuse a live one if present
// Full engine boot to world + MP join; ~30-60s on a real GPU. SwiftShader (a CI box with no
// GPU) is several times slower and the engine is genuinely making progress the whole time, so
// a fixed 120s reported a stall that was really just software rasterisation.
// Engine boot is bimodal: the FIRST client on a machine warms the page/wasm caches and joins
// in ~25s, while a second client booting alongside it competes for CPU with a running WASM
// engine and streams its own animation data far slower. 120s was tuned when only one client
// ever booted; a two-bot scenario times out on the second while it is still visibly loading,
// which reads as "the bot cannot join" and is really "this laptop is running two engines".
const JOIN_TIMEOUT_MS = Number(process.env.JOIN_TIMEOUT_MS || 300_000);
const RUN_ID = Date.now().toString(36); // suffix for account names -> no cross-run collisions
// Per-run, so a peer from one run can never authenticate against another's server.
const SERVER_PASSWORD = `harness-${RUN_ID}`;
const NL = String.fromCharCode(10); // avoids escape-mangling in generated edits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  // Ask the kernel for an ephemeral port, then release it for the child to bind. Tiny
  // TOCTOU window, acceptable for a local test harness.
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitHttp(url, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${what} (${url})`);
}

// --- omw-mp game server (one per scenario) ---------------------------------------------------
// `extraRules` = additional keys for the [rules] table, e.g. a scenario that needs PvP on
// (`export const serverRules = 'pvp = true'`). Config is deep-merged over the defaults.
// serverEnv lets a scenario shape WORLD IDENTITY, which is env-driven (OMW_WORLD_OWNER /
// OMW_WORLD_MODE / OMW_WORLD_ID) rather than config-driven, so it cannot be set through
// serverRules. Exported as a function receiving the run id, because an owner is an ACCOUNT
// NAME and account names carry the run-id suffix.
async function startGameServer(extraRules = '', extraEnv = {}) {
  // testhost.mjs, NOT server.mjs. main.ts refuses to boot without real game data, a peer
  // binary and a server password (the tier-2 mandate) — right for a deployment, fatal for a
  // harness whose whole point is a throwaway data dir with none of those. When that landed,
  // every scenario here died at "server never became healthy" and stayed dead, which is how a
  // round of regressions reached a player instead of a test run. src/testhost.ts is the same
  // server started through the code-only requireGameData seam.
  const dist = join(ROOT, 'server', 'dist', 'testhost.mjs');
  // Rebuild when dist is missing OR older than any source under src/. Checking only for
  // existence means a source change silently does not take effect: every scenario then runs
  // against the previous build and reports confident, wrong results — a server-side feature
  // can look completely unimplemented while its unit tests pass, because the tests import
  // src/ and the harness runs dist/.
  const newestSrc = (dir) => {
    let newest = 0;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      newest = Math.max(newest, ent.isDirectory() ? newestSrc(p) : statSync(p).mtimeMs);
    }
    return newest;
  };
  const srcMs = newestSrc(join(ROOT, 'server', 'src'));
  if (!existsSync(dist) || statSync(dist).mtimeMs < srcMs) {
    console.log(`[harness] building server (dist ${existsSync(dist) ? 'stale' : 'missing'})...`);
    execSync('npm run build', { cwd: join(ROOT, 'server'), stdio: 'inherit' });
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'omw-mp-data-'));
  // Per-run MOTD so scenario asserts can prove THIS server's welcome line reached the client
  // (not a stale mirror from a previous run). Merged over config.default.toml.
  const motd = `MOTD-${RUN_ID} welcome`;
  // Respawn coords = the ?start=Village drop point (measured; see M1/M2 scenarios).
  // Merge by SECTION rather than concatenating TOML text. A scenario that wants one more
  // key in a table the harness already wrote (e.g. [server] maxPlayers alongside our motd)
  // would otherwise emit a second [server] header, and TOML rejects a redefined table —
  // the server then dies at boot with a parse error that reads like an unrelated
  // "/healthz timeout". Cheaper to merge here once than to make every scenario know which
  // sections we happen to have used.
  const sections = new Map([
    ['server', [`motd = "${motd}"`]],
    // The browser clients log in via ?mpauto=1, whose password is fixed and public — real
    // servers refuse it (see [login].allowHarnessAuth). These servers exist for exactly
    // that traffic, so they opt in explicitly rather than the client being trusted.
    ['login', ['allowHarnessAuth = true']],
    ['rules', ['respawnCellKey = "26,25"', 'respawnX = 216831.0', 'respawnY = 204909.0', 'respawnZ = 513.0']],
    // EVERY browser client dials from 127.0.0.1, so the shipped per-IP defaults
    // (maxConnsPerIp = 3, loginPerMinPerIp = 5) throttle the harness itself. s30 launches
    // four clients and was intermittently losing the last one to the connection cap — which
    // reads exactly like load flakiness, because whether it trips depends on how fast the
    // previous client's socket is reaped. s42/s43 had each already discovered this and
    // patched it locally; it belongs here, once, for every scenario.
    ['limits', ['maxConnsPerIp = 64', 'loginPerMinPerIp = 100000']],
  ]);
  // Default section is `rules`: scenarios predating the merge export a bare key
  // (`serverRules = 'pvp = true'`) because the old writer appended straight after the
  // [rules] table. Honour that implicit contract rather than throwing — otherwise those
  // scenarios die before boot with a config error that surfaces as an instant, mystifying
  // 0.0s failure.
  let current = 'rules';
  for (const raw of (extraRules ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    // Last writer wins per KEY. Appending blindly emits the key twice in one table, which
    // TOML rejects — and now that the harness itself sets [limits], every scenario that
    // overrides them (s42, s43) would have hit exactly that.
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    const bucket = sections.get(current);
    const at = key ? bucket.findIndex((l) => new RegExp(`^${key}\\s*=`).test(l)) : -1;
    if (at >= 0) bucket[at] = line; else bucket.push(line);
  }
  writeFileSync(join(dataDir, 'config.toml'),
    [...sections].map(([name, lines]) => `[${name}]\n${lines.join('\n')}\n`).join(''));
  const port = await freePort();
  // A server password, so a scenario can stand up its own sim peer. `system` is client-declared
  // and connection.ts only believes it when the claim carries this password — and an UNSET
  // password means no peer can authenticate at all, which is what testhost shipped. Without a
  // peer nothing can hold cell authority (canSimulate is `p.system === true`), so no browser
  // scenario could exercise the M4/M5 layer.
  const proc = spawn(process.execPath,
    [dist, '--data', dataDir, '--port', String(port), '--server-password', SERVER_PASSWORD], {
    cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
    // Its own process group, so the sim peers the SERVER spawns can be reaped with it. A
    // SIGKILLed server leaves them orphaned (the engine ignores TERM), and six of them from
    // earlier scenarios were still burning CPU an hour later -- the load that timed out
    // s60b/s69 in run 12 (2026-09-04). kill()/stop() below take the whole group.
    detached: true,
  });
  const killGroup = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } };
  const out = [];
  proc.stdout.on('data', (d) => out.push(String(d)));
  proc.stderr.on('data', (d) => out.push(String(d)));
  try {
    await waitHttp(`http://127.0.0.1:${port}/healthz`, 45_000, 'omw-mp /healthz');
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch {}
    throw new Error(e.message + '\nserver output:\n' + out.join(''));
  }
  // THE PORT WE HAND OUT MUST BE THE PORT THIS SERVER IS ON.
  //
  // /healthz answering on `port` is not proof of that: a LEAKED server from an earlier
  // scenario answers it just as happily, and then everything a scenario builds on
  // ctx.serverPort quietly talks to the wrong world. Not hypothetical — s43's soak bots
  // reported `port=46765` while s43's own testhost logged `listening on 46835`, passed their
  // own health check against whatever was on 46765, and never produced a live bot
  // (`alive=0/8`) because the crowd was joining a world with nobody in it. The scenario then
  // failed on "roster reached 8 remote players", which points at everything except the cause.
  //
  // testhost prints its real port for exactly this reason ("Prints ... so a harness can wait
  // on the line rather than polling"), so compare the two and fail loudly rather than hand out
  // a number that is merely plausible.
  const bound = /testhost: listening on (\d+)/.exec(out.join(''));
  if (bound && Number(bound[1]) !== port) {
    try { proc.kill('SIGKILL'); } catch {}
    throw new Error(
      `harness/server port disagreement: asked for ${port}, testhost bound ${bound[1]}. `
      + 'Something else answered /healthz on the asked-for port — almost certainly a server '
      + 'leaked by an earlier scenario. Every scenario using ctx.serverPort would have been '
      + 'talking to the wrong world.\nserver output:\n' + out.join(''));
  }
  return {
    port,
    // Scenarios that spawn a gateway must point it at THIS dir: accounts, friends and
    // parties live here, and a world that cannot see them refuses its own members.
    dataDir, motd,
    status: async () => (await fetch(`http://127.0.0.1:${port}/status`)).json(),
    // The server's own log, surfaced on failure. It was captured and then DISCARDED once
    // startup succeeded, so a client stuck at HelloSent looked like silence from both ends —
    // the server's refusal (bad engine hash, content mismatch, full, banned) was sitting in a
    // buffer nobody printed. Every scenario failure now prints it.
    logTail: (n = 40) => out.join('').split('\n').slice(-n).join('\n'),
    // Abrupt death (no SessionDisconnect, no clean close) — for connection-lost scenarios.
    kill: () => killGroup(),
    stop: () => {
      // TERM the server itself so it drains (stores flushed, peers told to leave), then sweep
      // the group once it has exited -- or after a bound, so a wedged server cannot hold the
      // suite. The server's own stopAll() already SIGKILLs its peers; this is the backstop.
      try { proc.kill('SIGTERM'); } catch {}
      const t = setTimeout(killGroup, 15_000); t.unref?.();
      proc.once('exit', () => { clearTimeout(t); killGroup(); });
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

// --- play/server.py (one instance reused across scenarios) -----------------------------------
async function ensurePlayServer() {
  // The port is a constant in server.py; if something already serves /index.html there
  // (e.g. a dev instance the user left running) just reuse it instead of failing the bind.
  try {
    const r = await fetch(`http://127.0.0.1:${PLAY_PORT}/index.html`);
    if (r.ok) { console.log(`[harness] reusing play server on :${PLAY_PORT}`); return { stop: () => {} }; }
  } catch {}
  const proc = spawn('python3', ['server.py'], { cwd: join(ROOT, 'play'), stdio: 'ignore' });
  await waitHttp(`http://127.0.0.1:${PLAY_PORT}/index.html`, 10_000, 'play/server.py');
  return { stop: () => { try { proc.kill('SIGTERM'); } catch {} } };
}

// --- headless-Chrome game client over raw CDP (transport per smoke.mjs) ----------------------
// ---------------------------------------------------------------- native simulating sim peer
// A REAL headless OpenMW, for the scenarios that need NPCs to actually move and fight.
//
// `server/dist/testpeer.mjs` gives a scenario a peer that HOLDS a cell, which is enough for
// anything asserting on routing (s41, s58). It is not enough for s40/s42/s51, which compare NPC
// positions between clients: a peer that answers the wire produces no ActorMoveBatch. This one
// runs the engine.
//
// Requires wasm-build/Dockerfile.harness-peer (the peer's own Ubuntu image plus a browser);
// OMW_SIM_PEER_BIN points at the binary there.
//
// THE CONFIG IS buildPeerCfg()'s SHAPE, deliberately (server/src/core/gamedata.ts): data=,
// content= in load order, `content=mp.omwscripts` LAST, fallback-archive= per BSA, resources=.
// It does NOT declare builtin.omwscripts — openmw loads that implicitly from resources, and
// declaring it aborts startup with "Content file specified more than once", which is a
// confusing way to spend an afternoon. Keep this in step with buildPeerCfg rather than
// inventing a second config.
function startSimPeer(port, password, cellKey, gameDataDir, watch) {
  const bin = process.env.OMW_SIM_PEER_BIN;
  if (!bin || !existsSync(bin)) return null;
  const cfgDir = mkdtempSync(join(tmpdir(), 'omw-peercfg-'));
  const userDir = mkdtempSync(join(tmpdir(), 'omw-peeruser-'));
  const entries = readdirSync(gameDataDir);
  const order = ['Morrowind.esm', 'Tribunal.esm', 'Bloodmoon.esm'];
  const content = order.filter((f) => entries.includes(f));
  const archives = order.map((f) => f.replace(/\.esm$/, '.bsa')).filter((a) => entries.includes(a));
  writeFileSync(join(cfgDir, 'openmw.cfg'), [
    '# GENERATED by mp-harness for a scenario that needs a SIMULATING peer.',
    `data=${gameDataDir}`,
    ...content.map((c) => `content=${c}`),
    'content=mp.omwscripts',
    ...archives.map((a) => `fallback-archive=${a}`),
    'resources=/usr/local/share/openmw/resources',
  ].join('\n') + '\n');
  // Without a framerate cap the headless peer spins at ~97% of a core and the box it shares
  // with the browsers cannot keep the broadcast tick — see buildPeerSettings().
  // Mirrors buildPeerSettings() (core/gamedata.ts). `actors processing range` stays at the
  // engine default: the AI gate is anchor-aware now (mwmechanics/actors.cpp), so the default
  // range around each anchor is right and raising it only simulates empty cells.
  writeFileSync(join(cfgDir, 'settings.cfg'),
    '[Video]' + NL + 'framerate limit = 20' + NL + 'vsync mode = 0' + NL
    + '[Shadows]' + NL + 'enable shadows = false' + NL
    );
  // THE PEER MUST RUN THE SCRIPTS UNDER TEST, not the ones baked into its image.
  //
  // openmw-simpeer:local ships its own copy of scripts/mp under the resources tree, and
  // `resources=` wins over any later `data=` line, so a working-tree fix reaches the browsers
  // and NOT the peer. That failure is invisible from the outside: the browser forwards
  // correctly and the peer fails on old code, so the feature looks broken in a way that points
  // at neither. Cost several rebuild cycles to spot — a 0-based index fix in combat.lua looked
  // inert because only half the fleet had it.
  const peerScripts = '/usr/local/share/openmw/resources/vfs/scripts/mp';
  try {
    if (existsSync(peerScripts)) {
      rmSync(peerScripts, { recursive: true, force: true });
      cpSync(join(ROOT, 'openmw', 'files', 'data', 'scripts', 'mp'), peerScripts, { recursive: true });
    }
  } catch (e) {
    console.log(`[harness] WARNING: could not sync mp scripts into the peer (${e.message}). `
      + 'The peer will run its baked copy, so client-script changes will not be under test.');
  }
  const proc = spawn(bin, [
    '--config', cfgDir, '--replace', 'config', '--user-data', userDir,
    '--skip-menu', '--start', cellKey, '--no-sound',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/tmp',
      OPENMW_HEADLESS: '1',
      OSG_THREADING: 'SingleThreaded',
      OPENMW_MP_SYSTEM: '1',
      OPENMW_MP_URL: `ws://127.0.0.1:${port}/ws`,
      // SANITISE THE NAME. A cellKey is "-2,-9" and the account charset is
      // "2-24 chars of A-Z a-z 0-9 _ - space" (connection.ts), so `simpeer-${cellKey}` is
      // refused at register with AUTH_FAILED and the cell then has no owner at all — which
      // surfaces three minutes later as "the simulating peer never took it", pointing at the
      // engine rather than at a comma.
      OPENMW_MP_NAME: `simpeer-${cellKey.replace(/[^A-Za-z0-9_-]/g, '_')}`,
      OPENMW_MP_PASS: password,
    },
  });
  if (watch) watch('simpeer', proc);
  return {
    proc,
    stop: () => {
      // SIGKILL, not SIGTERM: the headless engine does not exit on TERM (measured 2026-09-02:
      // a peer sent TERM, then INT, kept running until its container was killed). With TERM
      // every scenario left its peer alive after finishing and a sweep accumulated them --
      // the "host load 20" that self-skips s40/s42. A scenario that wants the peer GONE
      // (s69 peer outage) needs it gone.
      try { proc.kill('SIGKILL'); } catch {}
      try { rmSync(cfgDir, { recursive: true, force: true }); } catch {}
      try { rmSync(userDir, { recursive: true, force: true }); } catch {}
    },
  };
}
async function launchClient(name, mpPort, extraParams = '', opts = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'omw-mpharness-'));
  // THREE BACKENDS, and the difference matters on a box with no GPU. `swiftshader` is RAW
  // SwiftShader GL, which does not implement every entry point the engine probes; the engine
  // resolves GL dynamically (libGL-getprocaddr.a), so a missing one comes back null and calling
  // it is a bare `RuntimeError: null function` in the middle of render setup. `angle-swiftshader`
  // runs ANGLE — the same translator the engine targets in a real browser — over SwiftShader's
  // Vulkan, so the GL surface is ANGLE's rather than SwiftShader's. On a GPU-less Linux box that
  // is the one to reach for.
  const glArgs = process.env.SMOKE_GL === 'swiftshader'
    ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
    : process.env.SMOKE_GL === 'angle-swiftshader'
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'];
  // ?start=Village: MP global.lua only runs once a world is loaded (onInit), so deep-link
  // into the demo cell (--skip-menu path; same as mp-vectors.mjs). ?nomw = baked example suite.
  const mpUrl = opts.mpUrl ?? `ws://127.0.0.1:${mpPort}/ws`;
  // opts.noAuto: skip the harness auto-login (&mpauto=1) so a scenario can supply its own
  // &name=/&pass= via extraParams (e.g. deliberately wrong credentials).
  const auth = opts.noAuto ? '' : `&mpauto=1&mpuser=${encodeURIComponent(name)}`;
  // opts.retail: boot REAL Morrowind data instead of the baked example suite. Required by
  // the M4 actor scenarios — the clean Example Suite ships no NPCs at all (verified: the
  // only active actors are the player and MP puppets), so shared-NPC authority can only be
  // exercised against content that actually places actors. ?stream lazy-mounts the BSAs
  // (range reads) so the boot only pulls the bytes it touches.
  const world = opts.retail
    ? `?stream&novid&skipintro=1&start=${encodeURIComponent(opts.startCell ?? 'Seyda Neen')}`
    : `?nomw&skipintro=1&start=${encodeURIComponent(opts.startCell ?? 'Village')}`;
  // NOTE: a locker session is NOT passed here. #mplocker in the URL flips index.html into
  // locker/launcher mode at boot -- a different asset path entirely, which never comes up in
  // the harness and killed the client outright. Scenarios that need one inject it AFTER the
  // client is up (see grantLockerSession in s47), which is the only part rebootIntoWorld
  // actually reads.
  // opts.homeUrl -> #mphome: WHICH WORLD IS THIS PLAYER'S OWN. A switch RELOADS the page and
  // Lua state dies with it, so without this the client relearns 'own world' as wherever it
  // just landed -- go Solo from Public and it asks the PUBLIC world to turn private. The
  // launcher sets this in production and it rides every switch; a harness client had none.
  // Unlike #mplocker this does not flip the page into locker mode, so it is safe in the URL.
  const frag = opts.homeUrl ? `#mphome=${encodeURIComponent(opts.homeUrl)}` : '';
  const url = `http://127.0.0.1:${PLAY_PORT}/index.html${world}`
    + `&mp=${encodeURIComponent(mpUrl)}${auth}`
    + extraParams + frag;
  const chrome = spawn(CHROME, [
    '--headless=new', ...glArgs,
    // --no-sandbox only off the developer machine: Chrome's sandbox needs user namespaces
    // that a CI VM usually does not grant, and it fails to launch at all rather than warning.
    // --no-sandbox AND --disable-dev-shm-usage, both only off the developer machine.
    //
    // Chrome's sandbox needs user namespaces a CI VM usually does not grant, and without the
    // flag it fails to launch at all rather than warning.
    //
    // /dev/shm is 64 MB in a default container and Chrome puts its shared render buffers there.
    // One client fits; the SECOND one does not, and the way it fails is silent -- the browser
    // starts, the page loads, and it simply never finishes joining. Measured in the peer image:
    // the first client reached Joined in 8.7 s and the second timed out at 420 s, with the
    // example suite and no sim peer involved, so nothing about retail data or the peer was
    // implicated. --disable-dev-shm-usage moves those buffers to /tmp, which is disk-backed and
    // unbounded.
    //
    // Harmless where it was already working: Debian's older chromium in Dockerfile.harness fits
    // two clients inside 64 MB, which is exactly why this went unnoticed until an image with
    // google-chrome 152 needed the same thing.
    ...(process.env.CHROME_BIN ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    '--disable-gpu-sandbox', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=0',
    '--window-size=1280,720', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const logs = [];
  const handle = {
    name,
    // DISTINCT lines, newest last. A raw tail is useless the moment the engine repeats
    // itself: one WebGL warning (GL_INVALID_ENUM: glDrawElements) recurs every frame and filled
    // all 30 slots, so the failure dump for a container bug contained nothing but that line and
    // the actual drop reason was pushed out. Collapsing repeats keeps the RARE line -- always
    // the interesting one -- and still reports how often the noisy one fired.
    logTail: (n = 30) => {
      const seen = new Map();
      for (const l of logs) seen.set(l, (seen.get(l) ?? 0) + 1);
      const out = [];
      for (const [line, count] of seen) out.push(count > 1 ? line + '  (x' + count + ')' : line);
      return out.slice(-n).join(String.fromCharCode(10));
    },
    // A Lua event handler that throws takes its whole subsystem down SILENTLY: the engine
    // logs the error and carries on, so the game still runs, the mirrors still update from
    // whatever else is working, and scenarios fail somewhere far away with a misleading
    // symptom. That is exactly how a one-word scoping bug in MP_MoveBatch was chased through
    // two wrong hypotheses while the answer sat in the log the whole time. Surfaced per
    // client so it is never buried again.
    luaErrors: () => logs.filter((l) => l.includes('Lua error')),
    // UNCAUGHT JS EXCEPTIONS, promoted to a first-class signal for the same reason Lua errors
    // were. A ReferenceError inside a setInterval callback kills the REST of that callback
    // forever while the page keeps running and every mirror this harness reads stays fresh
    // from other code — so scenarios pass and the feature is dead. That is exactly how three
    // undeclared identifiers silently killed chat, and how a cross-block call killed the
    // world switch, both shipping green because nothing in CI ever loaded the page.
    jsErrors: () => logs.filter((l) => l.startsWith('EXC:')),
    // SIGKILL AND THEN ACTUALLY WAIT. This used to return the instant the signal was sent, so
    // the next scenario started booting while several retail Chromes (~1.5 GB each) were still
    // tearing down. Host load was measured at 17-20 DURING the suite, and s10, s31 and s69 all
    // failed there while passing solo -- convergence and timing assertions losing to a machine
    // still busy with the previous scenario's corpses. A second or two per client here removes
    // a whole class of phantom failure, and phantom failures are worse than slow ones: they
    // train you to re-run rather than to look.
    close: () => {
      const dead = chrome.exitCode !== null || chrome.signalCode !== null;
      const exited = dead ? Promise.resolve() : new Promise((res) => {
        chrome.once('exit', res);
        setTimeout(res, 10_000).unref?.(); // never hang the suite on a wedged process
      });
      try { chrome.kill('SIGKILL'); } catch {}
      return exited.then(() => {
        try { rmSync(profile, { recursive: true, force: true }); } catch {}
      });
    },
  };
  try {
    // --remote-debugging-port=0 -> Chrome prints the actual endpoint on stderr (no port race).
    let wsUrl = null;
    chrome.stderr.on('data', (d) => {
      const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) wsUrl = m[1];
    });
    // 60s, not 15: with a retail client already resident (~1.5 GB) the machine is under
    // memory pressure, and Chrome's own startup — before it ever prints the DevTools
    // endpoint — slows to tens of seconds. A short wait here reports "CDP never came up"
    // for what is really just a slow launch.
    const t0 = Date.now();
    while (!wsUrl && Date.now() - t0 < 60_000) await sleep(100);
    // A launch that never printed its endpoint must still be cleaned up. Without this a
    // failed launch leaked BOTH the stillborn Chrome and its profile dir — 62 of them had
    // piled up under /var/folders from this session alone, and each leaked browser makes the
    // next launch likelier to fail the same way.
    if (!wsUrl) { handle.close(); throw new Error('Chrome CDP endpoint never came up (60s)'); }

    const browser = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      browser.addEventListener('open', res, { once: true });
      browser.addEventListener('error', () => rej(new Error('CDP ws error')), { once: true });
    });
    let mid = 1;
    const bsend = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = mid++;
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) {
          browser.removeEventListener('message', onMsg);
          m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result);
        }
      };
      browser.addEventListener('message', onMsg);
      browser.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const t = await bsend('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await bsend('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    browser.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.consoleAPICalled') {
        logs.push('[' + m.params.type + '] ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const e = m.params.exceptionDetails;
        logs.push('EXC: ' + (e.exception?.description || e.text));
      } else if (m.method === 'Log.entryAdded') {
        logs.push('[log] ' + m.params.entry.text);
      }
    });
    await bsend('Page.enable', {}, sessionId);
    await bsend('Runtime.enable', {}, sessionId);
    await bsend('Log.enable', {}, sessionId);
    await bsend('Page.navigate', { url }, sessionId);

    // PNG screenshot of the client's viewport (visual checks / M1 puppet captures).
    handle.screenshot = async (path) => {
      const shot = await bsend('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      return path;
    };
    handle.eval = async (expr) => {
      const r = await bsend('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(`eval(${expr}): ` + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    };
    // A COMMAND THAT WILL NOT BE CLOBBERED. `Module.__omwMPCmd` is a SINGLE SLOT drained at
    // roughly one command per frame (pollHarness runs in onFrame), and a client under load runs
    // at a fraction of 1 fps -- so a scenario that writes the slot on a timer silently destroys
    // whatever has not been consumed yet.
    //
    // s51 is the case that proves it: it swings every 600 ms for 90 s, and in-suite most of
    // those hits were overwritten before the engine ever saw them, so the NPC never died and it
    // reported the "my attacks do nothing" failure -- a REAL bug's exact signature, produced by
    // the test harness. It passed solo, where the client drains fast enough.
    //
    // Opt-in, not automatic: waiting on every eval taxed hot loops for a hazard most scenarios
    // do not have (it cost s58 its budget). Use this wherever a command MUST land.
    handle.cmd = async (text, timeoutMs = 20_000) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (!(await handle.eval('!!(window.Module && Module.__omwMPCmd)'))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return handle.eval(`Module.__omwMPCmd=${JSON.stringify(text)}`);
    };

    // A WALK THAT ACTUALLY HAPPENED. `walk:` is a ONE-SHOT command with a deadline: player.lua
    // drops it on the floor if the player cannot move yet (chargen is still running on a fresh
    // client, and an overlay can hold Interface mode), the command then expires unused, and the
    // scenario sits waiting for movement it already threw away.
    //
    // s22 spent 120 s doing exactly that. It passed standalone and failed in the suite purely on
    // boot timing, which is why it read as a broken movement path rather than a race. Do not
    // replace this with a sleep before the walk: the first attempt at a fix waited on the page's
    // `__omwUiHold`, which never drops at all, so it was a 15 s sleep wearing a gate's clothes --
    // it made s22 pass and cost every other scenario 15 s per client for nothing.
    //
    // Issuing the command until it takes needs no guess about how long the box needs.
    handle.walk = async (dx, dy, ms = 2500, minDist = 40, tries = 6) => {
      const read = async () => JSON.parse(await handle.eval('(window.__omwMP||{}).pose||"null"'));
      const from = await read();
      if (!from) throw new Error('no pose mirror before walk — the client is not reporting');
      for (let i = 0; i < tries; i++) {
        const issued = Date.now();
        await handle.eval(`Module.__omwMPCmd='walk:${dx},${dy},${ms}'`);
        const until = issued + ms + 5_000;
        while (Date.now() < until) {
          const p = await read();
          // Judge the attempt once the walk has had its full duration: a command consumed late
          // covers only part of the ground, and returning on the first sign of movement handed
          // back a pose barely off the start while the caller wanted 250 units. Distance is
          // measured from the ORIGINAL position, so successive attempts accumulate.
          if (p && Date.now() >= issued + ms + 750) {
            if (Math.hypot(p.x - from.x, p.y - from.y) > minDist) return p;
            break; // this attempt fell short — walk again rather than report a false stall
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      throw new Error(`walk:${dx},${dy} never moved the player ${minDist} units`
        + ` (${tries} attempts) — movement is blocked, or the pose mirror is dead`);
    };
    // A REAL key press via CDP (trusted browser input, identical to a physical key): the only
    // honest way to test key-driven UI (T chat / O social) — synthetic KeyboardEvents are
    // untrusted and some paths ignore them. `def` e.g. { key:'t', code:'KeyT', keyCode:84 }.
    handle.key = async (def) => {
      const base = { key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
      await bsend('Input.dispatchKeyEvent', { type: 'keyDown', text: def.text ?? def.key, ...base }, sessionId);
      await bsend('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
    };
    // A RAW MOUSE BUTTON on the game canvas, which is how you attack.
    //
    // `handle.click(selector)` is for DOM elements — it hit-tests a CSS selector. The engine
    // takes input on the canvas through SDL, so an in-game swing needs a press and a release at
    // canvas coordinates with a real hold between them (Morrowind charges an attack for as long
    // as the button is down). Nothing in this harness could produce one before, which is why
    // every combat test drives the synthetic `hitn:` command instead — and why a fault in the
    // INPUT path rather than the combat path would leave the whole suite green.
    handle.mouseHold = async (ms = 700, button = 'left') => {
      const box = await handle.eval(
        `(function(){ var c = document.querySelector('canvas');
           if (!c) return null; var r = c.getBoundingClientRect();
           return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2 }); })()`);
      if (!box) throw new Error('mouseHold: no canvas');
      const { x, y } = JSON.parse(box);
      const base = { x, y, button, clickCount: 1 };
      await bsend('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, sessionId);
      await bsend('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 }, sessionId);
      await new Promise((r) => setTimeout(r, ms));
      await bsend('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, sessionId);
    };
    // eval WITH transient user activation. Gesture-gated APIs (requestPointerLock, fullscreen)
    // are rejected outright from a plain Runtime.evaluate, which silently turns any test of
    // them into a no-op that passes whether or not the code under test works.
    handle.evalGesture = async (expr) => {
      const r = await bsend('Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
      if (r.exceptionDetails) return 'threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    // A REAL mouse click at the element's on-screen centre, hit-tested by the browser exactly
    // like a physical click. element.click() is NOT a substitute: it invokes the handler
    // directly and bypasses hit-testing, so it passes even when the element is covered by the
    // canvas, has pointer-events:none, or is behind a pointer lock — precisely the failures
    // this is here to catch.
    handle.click = async (selector) => {
      const box = await handle.eval(
        `(function(){ var el = document.querySelector(${JSON.stringify(selector)});
           if (!el) return null; var r = el.getBoundingClientRect();
           if (!r.width || !r.height) return null;
           return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2 }); })()`);
      if (!box) throw new Error(`click(${selector}): element missing or not laid out`);
      const { x, y } = JSON.parse(box);
      // What does the browser actually hand this click to? Names the covering element on failure.
      const hit = await handle.eval(
        `(function(){ var el = document.elementFromPoint(${x}, ${y});
           return el ? (el.id || el.tagName + (el.className ? '.' + el.className : '')) : 'null'; })()`);
      const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
      await bsend('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 }, sessionId);
      await bsend('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId);
      await bsend('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, sessionId);
      return hit;
    };
    handle.waitFor = async (expr, timeoutMs = 5000, what = expr) => {
      const deadline = Date.now() + timeoutMs;
      // An eval that keeps THROWING is a different failure from a condition that keeps being
      // false, and swallowing it reported the two identically. When the page's execution
      // context goes away (a reload, a navigation) every poll throws, and the timeout then
      // blamed the condition — s30's bot-c looked hung on "state === Joined" while its own
      // log showed it had reached Joined a minute earlier. Keep the last error and say so.
      let lastErr = null, evalOk = false;
      while (Date.now() < deadline) {
        try { if (await handle.eval(expr)) return; evalOk = true; lastErr = null; }
        catch (e) { lastErr = e; }
        await sleep(250);
      }
      const lua = handle.luaErrors();
      throw new Error(`[${name}] timeout (${timeoutMs}ms) waiting for: ${what}`
        + (lastErr ? `\n--- EVAL NEVER SUCCEEDED (${evalOk ? 'context died mid-wait' : 'never once evaluated'})`
            + ` — the condition may well have been TRUE; the page could not be read ---\n${lastErr}` : '')
        + (lua.length ? `\n--- LUA ERRORS (${lua.length}) — a throwing handler disables its whole subsystem ---\n`
            + [...new Set(lua)].slice(0, 5).join('\n') : '')
        + `\n--- last logs ---\n${handle.logTail()}`);
    };

    console.log(`[harness] ${name}: booting ${url}`);
    const boot0 = Date.now();
    // Error-path scenarios pass their own terminal condition (e.g. state === "Failed").
    const waitExpr = opts.waitExpr ?? '(window.__omwMP||{}).state === "Joined"';
    const waitWhat = opts.waitWhat ?? '__omwMP.state === Joined';
    // Retail boots stream ~hundreds of MB of game data before the world exists.
    await handle.waitFor(waitExpr, opts.joinTimeoutMs ?? JOIN_TIMEOUT_MS, waitWhat);
    console.log(`[harness] ${name}: reached [${waitWhat}] in ${((Date.now() - boot0) / 1000).toFixed(1)}s`);

    // BOOT HEALTH: THE LOADING SCREEN MUST ACTUALLY CLEAR.
    //
    // Reaching Joined is a MIRROR value — Lua publishes it whether or not the player can see
    // anything, so a client that is authenticated and playing is indistinguishable here from
    // one stuck behind a full-screen overlay forever. That is not hypothetical: holding the
    // arrival screen until the world settled put the release inside a function gated on chargen
    // being finished, so every NEW character sat on a loading screen that could never be
    // dismissed. Nothing threw, so the uncaught-exception gate stayed quiet, every mirror this
    // harness reads looked perfect, and the player found it instead of the tests.
    //
    // #loading gets the `hide` class when it is dismissed (play/index.html finish()), so this
    // asks the one question the mirrors cannot: is the player actually looking at the game?
    // Deliberately harness-wide rather than one scenario's assertion — a boot that cannot be
    // seen through is never what a scenario meant to test.
    if (opts.expectStuckLoading !== true) {
      await handle.waitFor(
        "(function(){var el=document.getElementById('loading');"
        + "return !el || el.classList.contains('hide') || el.style.display === 'none';})()",
        // Generous on purpose: the settle hold waits for the world to be simulated plus a 5s
        // grace, and its own backstop gives up at 30s. Anything past that is genuinely stuck.
        // LOADING_CLEAR_MS raises it for one specific job: a `--profiling-funcs` build carries a
        // name section and is ~40% larger, and it does not finish downloading and compiling
        // inside 45s under software rasterisation — so the run dies here with no console output
        // at all, which is the opposite of what you built a named binary to find out.
        Number(process.env.LOADING_CLEAR_MS || 45_000),
        'the loading screen to clear (is the player actually IN the world?)');
      console.log(`[harness] ${name}: loading screen cleared`);
    }
    return handle;
  } catch (e) {
    handle.close(); // never leak a Chrome on a failed boot
    throw e;
  }
}

// --- scenario runner -------------------------------------------------------------------------
const wanted = process.argv.slice(2);
// A leading underscore marks a LIBRARY, not a scenario. Without this the shared gateway
// helper would be imported and run as one, fail for having no default export, and read as
// a broken scenario.
const files = readdirSync(SCENARIO_DIR)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)));
if (files.length === 0) { console.error('no scenarios matched:', wanted.join(' ')); process.exit(2); }

const play = await ensurePlayServer();
const results = [];
for (const file of files) {
  const t0 = Date.now();
  const clients = []; // everything launched by this scenario, closed no matter what
  let torndown = false; // a client that finishes booting AFTER teardown must not leak
  const ownedChildren = []; // processes a scenario spawned through ctx (sim peers, gateways)
  let bootQueue = Promise.resolve(); // serializes client boots (see launchClient below)
  let server = null;
  let err = null;
  // A SKIP IS NOT A PASS. Scenarios opt out by logging 'SKIP: <reason>' and returning, and
  // while this harness had no notion of a skip every one of them was reported as a pass --
  // so a summary reading "43 PASS" covered five scenarios that never ran, among them NPC
  // combat, spell damage and NPC simulation. Coverage that is not there must not read as
  // coverage that is.
  //
  // Read from the logged line rather than from a new ctx.skip() every scenario would have to
  // adopt: the convention already exists wherever a scenario opts out, so this catches all of
  // them at once and cannot drift from what the scenario actually prints.
  let skipReason = null;
  // Hoisted out of the try: the scenario module is imported inside it, but the result is
  // recorded after the finally, where that binding is out of scope.
  let isCritical = false;
  const childLogs = []; // scenario-spawned processes (gateways), dumped on failure
  console.log(`\n=== scenario ${file} ===`);
  try {
    // Import first: a scenario may declare server rules it needs (e.g. pvp = true).
    const { default: run, serverRules, serverEnv, critical } = await import(pathToFileURL(join(SCENARIO_DIR, file)));
    isCritical = !!critical;
    const envForRun = typeof serverEnv === 'function' ? serverEnv(RUN_ID) : (serverEnv ?? {});
    server = await startGameServer(serverRules, envForRun);
    await run({
      // CAPTURE ANY CHILD A SCENARIO SPAWNS. Gateways were started with stdio:'ignore', so a
      // gateway that came up healthy while every world it spawned crashed on startup looked
      // identical to a working one — the scenario then failed on an unrelated downstream
      // assertion with the cause sitting in a dead pipe. Pass a spawned process through here
      // and its output is printed whenever the scenario fails. Spawn it with
      // stdio: ['ignore','pipe','pipe'] for this to have anything to read.
      watchChild: (label, proc) => {
        ownedChildren.push(proc); // reaped in the finally: a scenario that throws never reaches peer.stop()
        const buf = [];
        proc.stdout?.on('data', (d) => buf.push(String(d)));
        proc.stderr?.on('data', (d) => buf.push(String(d)));
        childLogs.push({ label, tail: () => buf.join('').split('\n').slice(-40).join('\n') });
        return proc;
      },
      runId: RUN_ID,
      motd: server.motd,
      // s42 attaches protocol bots to this same server (bots/soak.ts --attach) so a
      // scenario can put crowd load behind its real browser clients.
      serverPort: server.port,
      // Hand it to the scenario: TestClient.simPeer-style peers need it to be believed.
      serverPassword: SERVER_PASSWORD,
      // A REAL simulating peer, for scenarios that need NPCs to move rather than just a cell to
      // have an owner. Returns null when the binary is absent (the plain harness image), so a
      // scenario can skip cleanly instead of failing.
      startSimPeer: (cellKey, gameDataDir) => startSimPeer(
        server.port, SERVER_PASSWORD, cellKey,
        gameDataDir ?? join(ROOT, 'play', 'mwdata'),
        (label, proc) => {
          const buf = [];
          proc.stdout?.on('data', (d) => buf.push(String(d)));
          proc.stderr?.on('data', (d) => buf.push(String(d)));
          childLogs.push({ label, tail: () => buf.join('').split(NL).slice(-40).join(NL) });
        }),
      serverDataDir: server.dataDir,
      serverStatus: server.status,
      serverKill: server.kill,
      sleep,
      log: (...a) => {
        const first = typeof a[0] === 'string' ? a[0] : '';
        if (skipReason === null && /^\s*SKIP\b/i.test(first))
          skipReason = first.replace(/^\s*SKIP:?\s*/i, '');
        console.log('[' + file + ']', ...a);
      },
      launchClient: async (name, extraParams, opts) => {
        // Serialize BOOTS even when a scenario asks for clients via Promise.all. Two retail
        // clients booting at once each want ~1.5 GB plus streamed game data; concurrently
        // they thrash a busy machine badly enough to blow even a 420 s join timeout, while
        // either one alone boots in ~20 s. Scenarios still run their clients in parallel
        // afterwards — only the expensive boot window is queued.
        const mine = bootQueue.then(() =>
          launchClient(`${name}-${RUN_ID}`, server.port, extraParams, {
            // Each RESIDENT browser measurably slows the next boot: in s30 the four clients
            // reached Joined in 3.8s, 10.6s, 14.2s and 88.6s. Against a flat 120s that last
            // one is marginal, not generous, so it tipped over whenever the machine was a
            // little busier — which reads as flakiness and is really contention.
            // ponytail: linear allowance from the measurement above, not a guess. If boots
            // ever get slower than this, the answer is fewer resident clients, not a bigger
            // number here.
            ...(opts ?? {}),
            // Capped: the slowest LEGITIMATE boot measured was 88.6s, and the failure mode
            // here is bimodal — a client either boots in tens of seconds or wedges forever —
            // so a bigger number past this point only delays the report of a hang.
            joinTimeoutMs: (opts ?? {}).joinTimeoutMs
              // The cap tracks JOIN_TIMEOUT_MS rather than being a bare 180s: the bimodal
              // reasoning above holds on a GPU, but SwiftShader (a CI box with no GPU) boots
              // several times slower while genuinely progressing, and the fixed cap silently
              // overrode an explicitly raised budget and reported a stall that was not one.
              ?? Math.min(Math.max(180_000, JOIN_TIMEOUT_MS),
                          JOIN_TIMEOUT_MS + clients.length * 30_000),
          }));
        bootQueue = mine.catch(() => {}); // a failed boot must not wedge the queue
        const c = await mine;
        // Promise.all([launchClient, launchClient]) rejects as soon as ONE client fails,
        // while its sibling is still booting. That sibling used to resolve after teardown
        // and leak a headless Chrome (each retail client pins ~1.5 GB) — close it here.
        if (torndown) { c.close(); return c; }
        clients.push(c);
        return c;
      },
    });
  } catch (e) {
    err = e;
  } finally {
    torndown = true;
    // SIGKILL, not TERM: the engine ignores TERM (see startSimPeer.stop). Idempotent on a
    // process the scenario already stopped.
    for (const p of ownedChildren) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
    // A scenario that PASSES while a Lua handler was throwing is not a pass — it means the
    // assertions happened to be satisfied by some other path while a subsystem was dead.
    // Reported (not failed) so it cannot be silently normalised, and so a green suite still
    // says "something is broken in here".
    // A page that threw is a FAILURE, not a note. Unlike a Lua handler (whose blast radius is
    // one subsystem), an uncaught JS exception silently kills everything after it in its
    // callback — including the 150 ms mirror poll that drives chat, social and the world
    // switch. Nothing else in CI loads this page, so this is the only gate that sees it.
    const jsErrs = [...new Set(clients.flatMap((c) => c.jsErrors?.() ?? []))];
    if (jsErrs.length && !err) {
      err = new Error(`${jsErrs.length} uncaught JS exception(s) on the page — the rest of the`
        + ` throwing callback never ran:\n` + jsErrs.slice(0, 5).map((l) => '  ' + l.trim()).join('\n'));
    }
    const luaErrs = [...new Set(clients.flatMap((c) => c.luaErrors?.() ?? []))];
    if (luaErrs.length) {
      console.error(`[harness] ${file}: ${luaErrs.length} distinct LUA ERROR(s) during this scenario —`
        + ' a throwing handler disables its whole subsystem even when the run passes:');
      for (const l of luaErrs.slice(0, 5)) console.error('  ' + l.trim());
    }
    await Promise.all(clients.map((c) => c.close()));
    server?.stop();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  // A scenario that FAILED is a failure even if it logged a skip on the way out.
  results.push({ file, ok: !err, secs, skip: err ? null : skipReason, critical: isCritical });
  if (err) {
    console.error(`FAIL ${file} (${secs}s):\n${err.stack || err}`);
    const srv = server?.logTail?.();
    if (srv) console.error(`--- SERVER LOG (the other half of the conversation) ---\n${srv}`);
    for (const c of childLogs) {
      const t = c.tail();
      if (t.trim()) console.error(`--- ${c.label.toUpperCase()} LOG ---\n${t}`);
    }
  }
  else if (skipReason !== null) console.log(`SKIP ${file} (${secs}s): ${skipReason}`);
  else console.log(`PASS ${file} (${secs}s)`);
}
play.stop();

console.log('\n=== mp-harness summary ===');
for (const r of results) {
  const verdict = !r.ok ? 'FAIL' : (r.skip !== null ? 'SKIP' : 'PASS');
  console.log(`${verdict}  ${r.file}  (${r.secs}s)` + (r.skip !== null ? `  -- ${r.skip}` : ''));
}
const passed = results.filter((r) => r.ok && r.skip === null).length;
const skipped = results.filter((r) => r.ok && r.skip !== null);
const failed = results.filter((r) => !r.ok).length;
console.log(``);
console.log(`${passed} passed, ${failed} failed, ${skipped.length} SKIPPED (did not run)`);
if (skipped.length) {
  // Repeated at the very bottom, because a per-line SKIP scrolls past and a bare count reads
  // as a footnote. What did NOT run is exactly what a reader is most likely to mistake for
  // coverage, so it gets the last word.
  console.log(``);
  console.log(`NOT RUN -- these assert nothing about the build:`);
  for (const r of skipped) console.log(`  ${r.file}  -- ${r.skip}`);
}
const criticalFails = results.filter((r) => !r.ok && r.critical);
if (criticalFails.length) {
  // A CRITICAL scenario is one that proves something the rest of the suite cannot. s64 is the
  // only scenario that presses a real key -- everything else moves the player through the
  // walk: command, which bypasses key bindings -- so when it fails, a green count beside it is
  // actively misleading. Both F42 and F46 shipped as 'landed' with the suite otherwise green.
  // Given the last word for the same reason SKIPs are.
  console.log(``);
  console.log(`CRITICAL FAILURE -- the rest of this run cannot be trusted:`);
  for (const r of criticalFails) console.log(`  ${r.file}`);
  console.log(`  A critical scenario proves something no other scenario covers. Fix this first;`);
  console.log(`  passes elsewhere do not mean the build is playable.`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
