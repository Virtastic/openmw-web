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
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
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
  const proc = spawn(process.execPath, [dist, '--data', dataDir, '--port', String(port)], {
    cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  const out = [];
  proc.stdout.on('data', (d) => out.push(String(d)));
  proc.stderr.on('data', (d) => out.push(String(d)));
  try {
    await waitHttp(`http://127.0.0.1:${port}/healthz`, 45_000, 'omw-mp /healthz');
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch {}
    throw new Error(e.message + '\nserver output:\n' + out.join(''));
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
    kill: () => { try { proc.kill('SIGKILL'); } catch {} },
    stop: () => {
      try { proc.kill('SIGTERM'); } catch {}
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
async function launchClient(name, mpPort, extraParams = '', opts = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'omw-mpharness-'));
  const glArgs = process.env.SMOKE_GL === 'swiftshader'
    ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
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
  const url = `http://127.0.0.1:${PLAY_PORT}/index.html${world}`
    + `&mp=${encodeURIComponent(mpUrl)}${auth}`
    + extraParams;
  const chrome = spawn(CHROME, [
    '--headless=new', ...glArgs,
    // --no-sandbox only off the developer machine: Chrome's sandbox needs user namespaces
    // that a CI VM usually does not grant, and it fails to launch at all rather than warning.
    ...(process.env.CHROME_BIN ? ['--no-sandbox'] : []),
    '--disable-gpu-sandbox', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=0',
    '--window-size=1280,720', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const logs = [];
  const handle = {
    name,
    logTail: (n = 30) => logs.slice(-n).join('\n'),
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
    close: () => {
      try { chrome.kill('SIGKILL'); } catch {}
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
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
    // A REAL key press via CDP (trusted browser input, identical to a physical key): the only
    // honest way to test key-driven UI (T chat / O social) — synthetic KeyboardEvents are
    // untrusted and some paths ignore them. `def` e.g. { key:'t', code:'KeyT', keyCode:84 }.
    handle.key = async (def) => {
      const base = { key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
      await bsend('Input.dispatchKeyEvent', { type: 'keyDown', text: def.text ?? def.key, ...base }, sessionId);
      await bsend('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
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
    return handle;
  } catch (e) {
    handle.close(); // never leak a Chrome on a failed boot
    throw e;
  }
}

// --- scenario runner -------------------------------------------------------------------------
const wanted = process.argv.slice(2);
const files = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.mjs')).sort()
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)));
if (files.length === 0) { console.error('no scenarios matched:', wanted.join(' ')); process.exit(2); }

const play = await ensurePlayServer();
const results = [];
for (const file of files) {
  const t0 = Date.now();
  const clients = []; // everything launched by this scenario, closed no matter what
  let torndown = false; // a client that finishes booting AFTER teardown must not leak
  let bootQueue = Promise.resolve(); // serializes client boots (see launchClient below)
  let server = null;
  let err = null;
  console.log(`\n=== scenario ${file} ===`);
  try {
    // Import first: a scenario may declare server rules it needs (e.g. pvp = true).
    const { default: run, serverRules, serverEnv } = await import(pathToFileURL(join(SCENARIO_DIR, file)));
    const envForRun = typeof serverEnv === 'function' ? serverEnv(RUN_ID) : (serverEnv ?? {});
    server = await startGameServer(serverRules, envForRun);
    await run({
      runId: RUN_ID,
      motd: server.motd,
      // s42 attaches protocol bots to this same server (bots/soak.ts --attach) so a
      // scenario can put crowd load behind its real browser clients.
      serverPort: server.port,
      serverDataDir: server.dataDir,
      serverStatus: server.status,
      serverKill: server.kill,
      sleep,
      log: (...a) => console.log('[' + file + ']', ...a),
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
    for (const c of clients) c.close();
    server?.stop();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ file, ok: !err, secs });
  if (err) {
    console.error(`FAIL ${file} (${secs}s):\n${err.stack || err}`);
    const srv = server?.logTail?.();
    if (srv) console.error(`--- SERVER LOG (the other half of the conversation) ---\n${srv}`);
  }
  else console.log(`PASS ${file} (${secs}s)`);
}
play.stop();

console.log('\n=== mp-harness summary ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}  (${r.secs}s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
