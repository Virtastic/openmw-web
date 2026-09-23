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
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os, { tmpdir } from 'node:os';
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
async function startGameServer(extraRules = '', extraEnv = {}, opts = {}) {
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
  // Respawn coords = the ?start=Village drop point (measured; see M1/M2 scenarios). The
  // shipped default is "" (where you fell, backlog 355); the Example Suite village lives
  // HERE so `?nomw` runs keep their respawn.
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
  // THE SERVER'S OWN SIM PEER (`export const managedPeer = true`). Every other scenario
  // spawns a peer by hand at one cell; that never exercises the production lifecycle --
  // simPeerPass anchoring every occupied cell, INTERIORS held as room anchors, restart and
  // reaping -- so a room nobody simulated (s118) was invisible to the harness. With this the
  // server sees game data, spawns the peer itself and anchors wherever the players go.
  if (opts.managedPeer && process.env.OMW_SIM_PEER_BIN && existsSync(process.env.OMW_SIM_PEER_BIN)) {
    syncPeerScripts();
    const gd = join(ROOT, 'play', 'mwdata');
    try { symlinkSync(gd, join(dataDir, 'gamedata'), 'dir'); } catch (e) { console.log('[harness] gamedata symlink failed: ' + e.message); }
    // THE PEER'S CREDENTIAL, IN THE SHARED CONFIG TOO. This server gets it as --server-password;
    // a world the gateway spawns gets no argv and reads <shared>/config.toml (loadConfig merges
    // it) -- so with this line every gateway world spawns and authenticates its own peer, which
    // is how a guest gets simulated NPCs in a friend's world (s128).
    sections.get('server').push(`password = ${JSON.stringify(SERVER_PASSWORD)}`);
    sections.set('simPeer', [
      `binary = ${JSON.stringify(process.env.OMW_SIM_PEER_BIN)}`,
      `configDir = ${JSON.stringify(join(dataDir, 'peer-config'))}`,
      `userDataDir = ${JSON.stringify(join(dataDir, 'peer-user'))}`,
      'startCell = "-2,-9"', 'maxPeers = 1', 'anchorIdleSec = 60', 'idleReapMs = 600000',
      'startTimeoutMs = 240000', 'restartBackoffMs = 5000',
    ]);
  }
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
// THE PEER MUST RUN THE SCRIPTS UNDER TEST, not the ones baked into its image (see the note
// in startSimPeer). Shared by the hand-spawned peer and the server-managed one.
//
// HONEST, NOT HOPEFUL (backlog 184). Under Jenkins the resources tree is root-owned and the
// harness runs as the jenkins uid, so the copy fails with EACCES; run-harness.sh bind-mounts the
// repo's scripts over the image path instead. Either way the peer must end up running the repo's
// scripts: after the sync (or its failure) both trees are hashed and any difference FAILS the
// run, instead of a warning nobody reads while the peer executes last week's Lua.
function syncPeerScripts() {
  const peerScripts = '/usr/local/share/openmw/resources/vfs/scripts/mp';
  if (!existsSync(peerScripts)) return;
  const repoScripts = join(ROOT, 'openmw', 'files', 'data', 'scripts', 'mp');
  const peerList = join(dirname(dirname(peerScripts)), 'mp.omwscripts');
  const repoList = join(ROOT, 'openmw', 'files', 'data', 'mp.omwscripts');
  try {
    rmSync(peerScripts, { recursive: true, force: true });
    cpSync(repoScripts, peerScripts, { recursive: true });
    // The script LIST too: which types carry which script is part of what is under test
    // (companion.lua on NPCs was a one-line change to this file).
    cpSync(repoList, peerList);
  } catch (e) {
    console.log(`[harness] mp scripts not synced into the peer (${e.message}); verifying the baked/mounted copy instead`);
  }
  const diff = [];
  if (hashTree(repoScripts) !== hashTree(peerScripts)) diff.push(peerScripts);
  if (hashFile(repoList) !== hashFile(peerList)) diff.push(peerList);
  if (diff.length) {
    throw new Error(`FATAL: the peer's scripts differ from the repo (${diff.join(', ')}). `
      + 'Build the peer image from the branch under test, or mount the repo scripts over the image path (ci/jenkins/run-harness.sh).');
  }
}
function hashFile(p) { return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'missing'; }
function hashTree(dir) {
  const h = createHash('sha256');
  for (const f of readdirSync(dir, { recursive: true }).map(String).sort()) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    h.update(f.replace(/\\/g, '/')).update('\0').update(readFileSync(p)).update('\0');
  }
  return h.digest('hex');
}

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
  syncPeerScripts();
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
let currentWindowSize = null; // a scenario's `export const windowSize = '1280,720'` (s162)
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
  // opts.url: a page that is NOT the game. The admin dashboard is served by the same
  // processes this harness drives, and nothing else in CI ever loaded it in a browser -- so
  // a scenario may point a client at it and use the same eval/waitFor/jsErrors machinery.
  // Pair it with opts.waitExpr, since such a page never reaches Joined.
  const url = opts.url ?? (`http://127.0.0.1:${PLAY_PORT}/index.html${world}`
    + `&mp=${encodeURIComponent(mpUrl)}${auth}`
    + extraParams + frag);
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
    // #100/#183: a client whose tab Chrome deems hidden gets its timers throttled to 1 Hz and
    // stops driving the input tier (avatar_stats_gated after ~5 s of silence). Never for a harness client.
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    // ...and never deemed OCCLUDED either: an occluded window stops requestAnimationFrame, which
    // is the engine's main loop (478: four clients whose engine stopped with a live JS thread).
    '--disable-backgrounding-occluded-windows',
    '--user-data-dir=' + profile, '--remote-debugging-port=0',
    // 640x360, not 1280x720: the box has no GPU, so every pixel is SwiftShader on the CPU and
    // a retail scene at 720p is a frame every one to three seconds per client. A quarter of the
    // pixels is roughly three to four times the frame rate; nothing in the suite measures pixels
    // except s65/s74, which read a 256x256 map texture that does not depend on the window.
    `--window-size=${process.env.OMW_HARNESS_WINDOW || currentWindowSize || '640,360'}`, 'about:blank', // OMW_HARNESS_WINDOW=1280,720 to compare a verdict against the old, slower client (s162's 24-29 u step back appeared with 640x360)
  // OWN PROCESS GROUP, so close() can take the WHOLE browser. Chrome's gpu-process,
  // zygote and renderers are children of this pid; SIGKILL on the pid alone left them
  // running, reparented, and invisible to the next scenario -- 1847 chrome processes and
  // 2422 zombies had accumulated by the 80th scenario of sweep #107, load average 39 on a
  // 32-core box, and every timing assertion after that failed for no reason of its own.
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

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
      // The local-map RTT warnings are one per draw per texture and buried the twelve lines
      // that mattered on a cell change (#132 s69); they are never the story.
      for (const l of logs) if (!/Local map: /.test(l)) seen.set(l, (seen.get(l) ?? 0) + 1);
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
    // Every console line matching `re`, for scenarios that count engine prints (s172: snaps).
    logMatches: (re) => logs.filter((l) => re.test(l)),
    // UNCAUGHT JS EXCEPTIONS, promoted to a first-class signal for the same reason Lua errors
    // were. A ReferenceError inside a setInterval callback kills the REST of that callback
    // forever while the page keeps running and every mirror this harness reads stays fresh
    // from other code — so scenarios pass and the feature is dead. That is exactly how three
    // undeclared identifiers silently killed chat, and how a cross-block call killed the
    // world switch, both shipping green because nothing in CI ever loaded the page.
    jsErrors: () => logs.filter((l) => l.startsWith('EXC:') || l.includes('[pump] frame threw')), // the pump's own report of a wasm trap (478)
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
      // The GROUP, not the pid: see the spawn above. The plain kill stays as the fallback for
      // a platform where the group is not ours (and for a process that is already gone).
      try { process.kill(-chrome.pid, 'SIGKILL'); } catch { try { chrome.kill('SIGKILL'); } catch {} }
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
    // BOUNDED. A Runtime.evaluate against a page that is navigating away (a world switch is a
    // full reload) can simply never be answered, and a scenario that awaited it hung for 40
    // minutes with nothing to say (s140, 2026-09-13). Every CDP call answers or throws.
    // GENEROUS, because a booting page blocks its main thread for minutes under load (a
    // retail boot after ten scenarios) and an evaluate issued then is merely late, not lost.
    // And NEVER an unhandled rejection: some callers fire and forget (the log pump, the
    // teardown), and a rejection nobody awaits took the whole harness process down at s67 of
    // a twelve-scenario run. The catch below keeps awaiters' rejections intact.
    const CDP_TIMEOUT_MS = 300_000;
    const bsend = (method, params = {}, sessionId) => {
      const p = bsendRaw(method, params, sessionId);
      p.catch(() => {});
      return p;
    };
    const bsendRaw = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = mid++;
      const timer = setTimeout(() => {
        browser.removeEventListener('message', onMsg);
        reject(new Error(`${method}: no answer from the browser in ${CDP_TIMEOUT_MS / 1000}s (page navigating or dead)`));
      }, CDP_TIMEOUT_MS);
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) {
          clearTimeout(timer);
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
    // opts.newDocScript: JS run at the top of EVERY document this tab loads, before the page's
    // own scripts (Page.addScriptToEvaluateOnNewDocument). A scenario that drives the real
    // launcher never builds the game URL itself -- the launcher does, and navigates -- so this
    // is the only hook that can see that boot before index.html acts on it (s170).
    if (opts.newDocScript) await bsend('Page.addScriptToEvaluateOnNewDocument', { source: opts.newDocScript }, sessionId);
    await bsend('Page.navigate', { url }, sessionId);

    // F5. A page-script reload (`setTimeout(location.reload)`) races the next eval: a
    // Runtime.evaluate sent while the document is being re-fetched is never answered, and
    // waitFor then sits on that one call for the whole CDP deadline (s170 fresh46/51: 'never
    // once evaluated' after an F5 that had in fact rejoined in 40 s). Page.reload is the real
    // F5 (same tab, sessionStorage kept), and this returns only once the new document has
    // fired its load event, so the next eval lands in a live context.
    // AND IT CLICKS 'LEAVE'. index.html guards unload (window.__omwAllowLeave) and a tab that
    // has had a click carries user activation, so an F5 pops the browser's 'Leave site?'
    // dialog -- which freezes the page's JS thread (no eval answers, no load event) while
    // the old page runs on underneath (s170 fresh46/51/52: 'rejoined' logs that were the
    // old page). A player clicks Leave; so does this.
    handle.reload = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { browser.removeEventListener('message', onMsg); reject(new Error(`[${name}] reload: no load event in 120 s`)); }, 120_000);
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.sessionId !== sessionId) return;
        if (m.method === 'Page.javascriptDialogOpening') bsend('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
        if (m.method === 'Page.loadEventFired') { clearTimeout(timer); browser.removeEventListener('message', onMsg); resolve(); }
      };
      browser.addEventListener('message', onMsg);
      bsend('Page.reload', {}, sessionId).catch((e) => { clearTimeout(timer); browser.removeEventListener('message', onMsg); reject(e); });
    });
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
    // Like eval, for an expression that yields a promise: waits for it and returns the value.
    handle.evalAsync = async (expr) => {
      const r = await bsend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(`evalAsync(${expr}): ` + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    };
    // HISTORY. The bridge used to be a SINGLE SLOT (`Module.__omwMPCmd`) drained at
    // roughly one command per frame, and a client under load runs
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
    // A COMMAND THAT ACTUALLY RAN. window.omw.send queues it (nothing can clobber it) and
    // resolves when Lua has dispatched it and acked -- so this returns the ack {id, ok,
    // detail}, and a handler that threw is reported here rather than swallowed.
    //
    // TWO MINUTES, NOT TWENTY SECONDS. A streamed client (?stream) reads its assets over synchronous
    // XHR on the main thread, so ONE frame can last as long as the fetches it triggers: the
    // frame that builds a friend's puppet and the peer's fresh creature spawns in a cell just
    // entered ran past 20 s twice in s149 (#89 and #91, identically 12.5 s after B arrived,
    // then the deadline) and under it once (#90). No frame runs the command loop until that
    // frame ends, so the deadline fired while the client was merely busy. The deadline is a
    // hang guard, not a measurement, and the per-scenario ceiling now bounds a truly dead
    // client, so it can afford to be longer than the longest honest frame.
    // ...AND 60 WAS NOT ENOUGH EITHER (#105 s149): A walked into the sea one cell over, the
    // engine streamed three fresh exterior cells (-4,-8..-10) at 04:29:01, its console went
    // silent at 04:29:07 and the next frame had still not come 73 s later when the deadline
    // fired on sethpbase -- no Lua error, no crash, one frame of synchronous fetches on a box
    // running two retail Chromes and the peer. 120 s.
    // A TIMEOUT SAYS WHAT THE CLIENT WAS DOING. It used to read as one word; waitFor's
    // failure carries the console tail and the Lua errors, and this one now does the same.
    handle.cmd = async (text, timeoutMs = 120_000) => {
      const ack = await handle.evalAsync(
        `window.omw.send(${JSON.stringify(text)}, ${timeoutMs}).then(function(r){ return JSON.stringify(r); })`);
      const r = JSON.parse(ack);
      if (!r.ok) {
        const lua = handle.luaErrors();
        throw new Error(`[${name}] command ${JSON.stringify(text)} failed: ${r.detail}`
          + (lua.length ? `\n--- LUA ERRORS (${lua.length}) ---\n` + [...new Set(lua)].slice(0, 5).join('\n') : '')
          + `\n--- last logs ---\n${handle.logTail()}`);
      }
      return r;
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
      const read = async () => JSON.parse(await handle.eval('window.omw.state.pose||"null"'));
      const from = await read();
      if (!from) throw new Error('no pose mirror before walk — the client is not reporting');
      for (let i = 0; i < tries; i++) {
        const issued = Date.now();
        await handle.cmd(`walk:${dx},${dy},${ms}`);
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
    // A REAL left click at a point on the game canvas, as FRACTIONS of its size (fx, fy in
    // 0..1), for the engine's own MyGUI widgets (the main menu's Exit, its confirm box) that
    // no DOM selector reaches. Fractions, because the window size is a scenario variable.
    handle.clickCanvas = async (fx, fy) => {
      const box = await handle.eval(
        `(function(){ var c = document.querySelector('canvas'); if (!c) return null;
           var r = c.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width*${Number(fx)}, y: r.top + r.height*${Number(fy)} }); })()`);
      if (!box) throw new Error('clickCanvas: no canvas');
      const { x, y } = JSON.parse(box);
      await bsend('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, sessionId);
      await bsend('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }, sessionId);
      await new Promise((r) => setTimeout(r, 120));
      await bsend('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }, sessionId);
      return { x: Math.round(x), y: Math.round(y) };
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
           if (!el) return null; try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {} var r = el.getBoundingClientRect(); // instant: a smooth scroll is asynchronous and the rect read here was the pre-scroll one, so the click landed beside the button (#121 s55 at 640x360)
           if (!r.width || !r.height) return null;
           return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2 }); })()`);
      if (!box) throw new Error(`click(${selector}): element missing or not laid out`);
      const { x, y } = JSON.parse(box);
      // What does the browser actually hand this click to? Names the covering element on failure.
      const hit = await handle.eval(
        `(function(){ var el = document.elementFromPoint(${x}, ${y});
           return el ? (el.id || el.tagName + (el.className ? '.' + el.className : '')) : 'null'; })()`);
      // COVERED: the point lands on something that is not the target or inside it (a modal
      // taller than a 640x360 window, whose button sits under its own footer; #121/#122 s55).
      // A real mouse cannot reach it either, so this is the element's own click, and says so.
      const covered = await handle.eval(
        `(function(){ var t = document.querySelector(${JSON.stringify(selector)}); var el = document.elementFromPoint(${x}, ${y});
           return !!t && !(el && (el === t || t.contains(el))); })()`);
      if (covered) {
        await handle.eval(`(function(){ var t = document.querySelector(${JSON.stringify(selector)}); t.focus(); t.click(); t.blur(); return true; })()`); // blur: a focused button eats the next hotkey (#124/#125 s99: O after Close never reopened the panel)
        return hit + ' (covered; clicked the element itself)';
      }
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
    const waitExpr = opts.waitExpr ?? 'window.omw.state.state === "Joined"';
    const waitWhat = opts.waitWhat ?? 'omw.state.state === Joined';
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
// A BENIGN CDP TIMEOUT MUST NEVER ABORT THE WHOLE RUN. A Runtime.evaluate against a page that
// is navigating (a world switch) or mid-boot can go unanswered; the awaiting scenario handles
// that (its waitFor throws and the scenario fails or retries), but a fire-and-forget caller (the
// 150 ms mirror poll, a log pump) leaves the rejection unowned, and Node aborts the process on
// it -- killing every scenario still queued (a full sweep died at s60b this way). Swallow the
// CDP-timeout shape here; anything else re-throws so a real bug still surfaces.
process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no answer from the browser in \d+s/.test(msg)) {
    console.error('[harness] swallowed a stray CDP timeout (page navigating/dead): ' + msg);
    return;
  }
  throw err;
});

const wanted = process.argv.slice(2);
// A leading underscore marks a LIBRARY, not a scenario. Without this the shared gateway
// helper would be imported and run as one, fail for having no default export, and read as
// a broken scenario.
let files = readdirSync(SCENARIO_DIR)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)));
if (files.length === 0) { console.error('no scenarios matched:', wanted.join(' ')); process.exit(2); }
// A STANDALONE scenario (`export const standalone = true`) needs a stack this runner does not
// stand up -- s170 brings its own gateway and wants the play server proxied at it, which
// ci/jenkins/run-fresh-install.sh provides -- so the full suite leaves it out rather than
// listing it as a skip that fails the run (#128: 126 passed, 0 failed, exit 1). Named
// explicitly it still runs, and still says why when it cannot.
if (wanted.length === 0) {
  const keep = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(SCENARIO_DIR, f)));
    if (mod.standalone === true) console.log(`[harness] ${f}: standalone, not part of the suite (run it through its own script)`);
    else keep.push(f);
  }
  files = keep;
}

const play = await ensurePlayServer();
let harnessLive = { chrome: 0, peers: 0 }; // processes alive after the previous scenario
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
  // `export const diagnostic = true`: the scenario asserts nothing (a screenshot, a boot
  // trace). Reported on its own line, never counted as a PASS -- four of them were.
  let isDiagnostic = false;
  // `export const allowLuaErrors = true`: a scenario that knowingly tolerates a throwing
  // handler says so. Otherwise a Lua error on either engine FAILS the scenario (it used to be
  // printed and forgotten; the last sweep carried one, s125's mpPuppetDetached).
  let luaErrorsAllowed = false;
  const childLogs = []; // scenario-spawned processes (gateways), dumped on failure
  const peerBufs = []; // every sim peer's full stdout (ctx.peerLogTail)
  let ceilingTimer; // the per-scenario ceiling, cleared in the finally
  console.log(`\n=== scenario ${file} ===`);
  try {
    // Import first: a scenario may declare server rules it needs (e.g. pvp = true).
    const { default: run, serverRules, serverEnv, critical, managedPeer, diagnostic, allowLuaErrors, windowSize } = await import(pathToFileURL(join(SCENARIO_DIR, file)));
    currentWindowSize = typeof windowSize === 'string' ? windowSize : null;
    isCritical = !!critical;
    isDiagnostic = !!diagnostic;
    luaErrorsAllowed = !!allowLuaErrors;
    const envForRun = typeof serverEnv === 'function' ? serverEnv(RUN_ID) : (serverEnv ?? {});
    server = await startGameServer(serverRules, envForRun, { managedPeer: !!managedPeer });
    // A CEILING PER SCENARIO. run() was awaited bare: a scenario looping on a cheap eval with
    // no deadline hung the whole sweep, and Jenkins killed the job with no summary at all.
    // Twenty minutes is longer than any honest scenario (the slowest boots twice and waits
    // 300 s at the door); a scenario that needs more declares `export const timeoutMs`.
    const { timeoutMs: declaredTimeout } = await import(pathToFileURL(join(SCENARIO_DIR, file)));
    const ceiling = Number(declaredTimeout) > 0 ? Number(declaredTimeout) : 20 * 60_000;
    const ceilingHit = new Promise((_, reject) => {
      ceilingTimer = setTimeout(() => reject(new Error(`scenario exceeded its ${Math.round(ceiling / 1000)} s ceiling (the harness's, not a waitFor)`)), ceiling);
    });
    await Promise.race([ceilingHit, run({
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
        childLogs.push({ label, tail: () => buf.join('').split('\n').slice(-40).join('\n'), full: (n) => buf.join('').split('\n').slice(-n).join('\n') });
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
      // Under `managedPeer` the SERVER spawns and anchors it (simPeerPass); the call is
      // answered so the scenario's skip-guard sees a peer, and nothing is spawned twice.
      startSimPeer: (cellKey, gameDataDir) => (managedPeer && process.env.OMW_SIM_PEER_BIN && existsSync(process.env.OMW_SIM_PEER_BIN))
        ? { managed: true, stop: () => {} }
        : startSimPeer(
        server.port, SERVER_PASSWORD, cellKey,
        gameDataDir ?? join(ROOT, 'play', 'mwdata'),
        (label, proc) => {
          // OWNED, so the finally reaps it. The watch callback only captured LOGS, so a peer
          // outlived any scenario that did not call peer.stop() itself (or threw before it):
          // one leaked peer per peered scenario, ~360 MB and a busy core each, and by the
          // 20th the box was too loaded for any timing assertion to mean anything (#109 saw
          // peers climb 6 -> 11 while the leak detector printed it).
          ownedChildren.push(proc);
          const buf = [];
          proc.stdout?.on('data', (d) => buf.push(String(d)));
          proc.stderr?.on('data', (d) => buf.push(String(d)));
          childLogs.push({ label, tail: () => buf.join('').split(NL).slice(-40).join(NL) });
          peerBufs.push(buf);
        }),
      // The sim peers' stdout so far (all of it, not the 40-line failure tail): a scenario
      // can read the peer's side of a mechanism it cannot see from the client.
      peerLogTail: (n = 4000) => peerBufs.map((b) => b.join('').split(NL).slice(-n).join(NL)).join(NL),
      // Deliberately the same shape for the peer as for the gateway (childLogTail): the peer
      // watcher used to register no `full`, so ctx.childLogTail('simpeer') answered empty.
      peerLogFull: () => peerBufs.map((b) => b.join('')).join(NL),
      // A watched child's whole stdout (a gateway's, which carries its worlds' and their
      // managed peers' lines) -- for a scenario that needs the far side's narration.
      childLogTail: (label, n = 6000) => childLogs.filter((c) => c.label === label && c.full).map((c) => c.full(n)).join(NL),
      serverDataDir: server.dataDir,
      serverStatus: server.status,
      // For a scenario whose worlds are spawned OUTSIDE this harness's testhost (a gateway
      // running the real server.mjs, s170): their peers still have to run the scripts under test.
      syncPeerScripts,
      // The server's own stdout: the one place a death is undeniable (respawn.sent).
      serverLogTail: (n = 400) => server.logTail(n),
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
    })]);
  } catch (e) {
    err = e;
  } finally {
    torndown = true;
    // LIVENESS, BEFORE ANY TEARDOWN. Four reds so far were a client whose engine stopped mid-run
    // with a live JS thread (478: s149, s114 twice, s150). The main loop rides
    // requestAnimationFrame, so: does rAF still fire, is the page visible, how many actor
    // frames (the actorBatchesIn mirror moves once a frame)? Asked here while the tab is up;
    // asked after close() every client reads as "blocked" (#117 s136), and asked after the
    // scenario's gateway was TERMed every client reads "Connecting" (fresh17).
    if (err) {
      await Promise.all(clients.map(async (c) => {
        c.liveness = await Promise.race([
          c.evalAsync('(async () => { const t0 = performance.now(); const raf = await new Promise((r) => { const id = requestAnimationFrame(() => r(true)); setTimeout(() => { cancelAnimationFrame(id); r(false); }, 1500); }); const b0 = (window.omw && window.omw.state && window.omw.state.actorBatchesIn) || null; await new Promise((r) => setTimeout(r, 2000)); const b1 = (window.omw && window.omw.state && window.omw.state.actorBatchesIn) || null; const sf = window.__streamfsStats ? (typeof window.__streamfsStats === "function" ? window.__streamfsStats() : window.__streamfsStats) : null; return JSON.stringify({ raf, ms: Math.round(performance.now() - t0), vis: document.visibilityState, hidden: document.hidden, batches: [b0, b1], engineAdvancing: b0 !== null && b1 !== null && b1 !== b0, streamfs: sf && { misses: sf.misses, stallMs: Math.round(sf.stallMs || 0), bytes: sf.bytes, evictions: sf.evictions }, state: window.omw && window.omw.state && window.omw.state.state }); })()'),
          new Promise((r) => setTimeout(() => r('(eval did not return in 7 s: the JS thread itself is blocked)'), 7000)),
        ]).catch((e) => `(liveness probe failed: ${e.message})`);
      }));
    }
    // SIGKILL, not TERM: the engine ignores TERM (see startSimPeer.stop). Idempotent on a
    // process the scenario already stopped.
    // The GROUP first: a detached child (the gateway) owns worlds and peers that must go with
    // it; for a non-detached child -pid names no group and throws, and the plain kill follows.
    // TERM FIRST, and give it a moment. A gateway owns WORLD processes that are their own
    // process groups (worlds.ts spawns them detached so it can kill each world's group), so
    // SIGKILLing the gateway's group leaves every world -- and the sim peer each world spawned
    // -- orphaned and burning a core. #110 leaked two peers per gateway scenario that way.
    // A TERM lets the gateway stop its worlds, which stop their peers; the group KILL below is
    // the backstop for anything that ignored it (the headless engine ignores TERM).
    for (const p of ownedChildren) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
    if (ownedChildren.length) await sleep(3000);
    for (const p of ownedChildren) {
      try { process.kill(-p.pid, 'SIGKILL'); } catch { /* not a group leader, or gone */ }
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
    }
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
    clearTimeout(ceilingTimer);
    // THE PEER'S LUA ERRORS TOO. Only the browsers' consoles were scanned: a throwing
    // avatar.lua or actors.lua handler on the simulator -- the half of the game the client
    // cannot see -- left the suite green. Same rule as the client: reported, never silent.
    const peerLuaErrs = [...new Set(peerBufs.flatMap((b) => b.join('').split(NL).filter((l) => /Lua error|lua]: .*error|stack traceback/i.test(l))))];
    if (peerLuaErrs.length) {
      console.error(`[harness] ${file}: ${peerLuaErrs.length} distinct LUA ERROR(s) on the SIM PEER during this scenario:`);
      for (const l of peerLuaErrs.slice(0, 5)) console.error('  ' + l.trim());
    }
    const luaErrs = [...new Set(clients.flatMap((c) => c.luaErrors?.() ?? []))];
    if (luaErrs.length) {
      console.error(`[harness] ${file}: ${luaErrs.length} distinct LUA ERROR(s) during this scenario —`
        + ' a throwing handler disables its whole subsystem even when the run passes:');
      for (const l of luaErrs.slice(0, 5)) console.error('  ' + l.trim());
    }
    // A LUA ERROR IS A FAILURE (client or peer) unless the scenario exports allowLuaErrors.
    // Printed-and-green normalised a dead subsystem for weeks (s125 in #91).
    if (!err && !luaErrorsAllowed && (luaErrs.length || peerLuaErrs.length)) {
      err = new Error(`${luaErrs.length} client + ${peerLuaErrs.length} peer Lua error(s) during the scenario`
        + ` (export allowLuaErrors = true to tolerate them knowingly):\n`
        + [...luaErrs, ...peerLuaErrs].slice(0, 5).map((l) => '  ' + l.trim()).join('\n'));
    }
    await Promise.all(clients.map((c) => c.close()));
    server?.stop();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  // A scenario that FAILED is a failure even if it logged a skip on the way out.
  results.push({ file, ok: !err, secs, skip: err ? null : skipReason, critical: isCritical, diagnostic: isDiagnostic });
  // WHAT THE LAST SCENARIO LEFT BEHIND. A leaked browser or peer does not fail the scenario
  // that leaked it -- it fails the ones after, on timing, for no visible reason (sweep #107:
  // 1847 chrome processes and load 39 by the 80th scenario, and every convergence assertion
  // in the back half red). Counting is cheap and turns an invisible poisoning into a line in
  // the log naming the scenario that did it.
  try {
    // A moment for the SIGKILLs above to be reaped, or every scenario reports the corpse
    // of its own last client as a leak.
    await sleep(1500);
    const count = (pat) => Number(execSync(`pgrep -c -f ${pat} || true`, { encoding: 'utf8' }).trim()) || 0;
    const live = { chrome: count('chrome'), peers: count('openmw') };
    if (live.chrome > (harnessLive.chrome ?? 0) || live.peers > (harnessLive.peers ?? 0)) {
      console.error(`[harness] LEAK after ${file}: chrome ${harnessLive.chrome ?? 0} -> ${live.chrome},`
        + ` peers ${harnessLive.peers ?? 0} -> ${live.peers} (load ${os.loadavg()[0].toFixed(1)})`);
    }
    harnessLive = live;
  } catch { /* pgrep is not everywhere; the count is a diagnostic, never a verdict */ }
  if (err) {
    console.error(`FAIL ${file} (${secs}s):\n${err.stack || err}`);
    const srv = server?.logTail?.();
    if (srv) console.error(`--- SERVER LOG (the other half of the conversation) ---\n${srv}`);
    for (const c of childLogs) {
      const t = c.tail();
      if (t.trim()) console.error(`--- ${c.label.toUpperCase()} LOG ---\n${t}`);
    }
    // EVERY client, not just the one the error names: a scenario reads its verdict through one
    // client while the OTHER has quietly stopped (#115 s114: B's engine died six seconds before
    // the walk and the scenario read a frozen mirror 90 times; s149 is the same shape). Errors
    // and a short distinct tail per client -- the wasm trap or OOM shows here, nowhere else.
    for (const c of clients) {
      try {
        const errs = [...c.jsErrors(), ...c.luaErrors()].slice(-6);
        console.error(`--- CLIENT ${c.name} (errors ${errs.length}) liveness ${c.liveness ?? "(not probed)"} ---\n${errs.join(NL)}${errs.length ? NL : ''}${c.logTail(25)}`);
      } catch { /* a closed handle has nothing to say */ }
    }
    // The PEER's narration (#183): its `[mp]` lines (follow claims, avatar teleports, cell
    // grants) were only reachable through ctx.peerLogTail, so a red like s114 never showed
    // whether the holder acted. The last 80 mp lines of every hand-spawned peer, on every FAIL.
    for (const buf of peerBufs) {
      const mpl = buf.join('').split(NL).filter((l) => /\[mp\]|Lua error|AiFollow|StartAIPackage/.test(l)).slice(-80);
      if (mpl.length) console.error(`--- SIM PEER mp LOG (last ${mpl.length}) ---\n${mpl.join(NL)}`);
    }
  }
  else if (skipReason !== null) console.log(`SKIP ${file} (${secs}s): ${skipReason}`);
  else if (isDiagnostic) console.log(`DIAG ${file} (${secs}s): ran, asserts nothing`);
  else console.log(`PASS ${file} (${secs}s)`);
}
play.stop();

console.log('\n=== mp-harness summary ===');
const verdictOf = (r) => !r.ok ? 'FAIL' : (r.skip !== null ? 'SKIP' : (r.diagnostic ? 'DIAG' : 'PASS'));
for (const r of results) {
  console.log(`${verdictOf(r)}  ${r.file}  (${r.secs}s)` + (r.skip !== null ? `  -- ${r.skip}` : ''));
}
const passed = results.filter((r) => verdictOf(r) === 'PASS').length;
const skipped = results.filter((r) => r.ok && r.skip !== null);
const diagnostics = results.filter((r) => verdictOf(r) === 'DIAG');
const failed = results.filter((r) => !r.ok).length;
console.log(``);
console.log(`${passed} passed, ${failed} failed, ${skipped.length} SKIPPED (did not run), ${diagnostics.length} diagnostic (ran, assert nothing)`);
if (diagnostics.length) console.log(`diagnostic: ${diagnostics.map((r) => r.file).join(' ')}`);
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
// A SKIP IS NOT OK. The exit code read ok = !err, so a sweep where half the suite never ran
// came back green (#114). OMW_ALLOW_SKIP=1 is for a deliberately partial box (no peer binary,
// no retail data) and says so in the log.
if (skipped.length && process.env.OMW_ALLOW_SKIP !== '1') {
  console.log(``);
  console.log(`exit 1: ${skipped.length} scenario(s) skipped (set OMW_ALLOW_SKIP=1 to accept a partial run)`);
  process.exit(1);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
