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
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // repo root
const SCENARIO_DIR = join(ROOT, 'wasm-build', 'mp-scenarios');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PLAY_PORT = 8910; // fixed in play/server.py (no port flag); we reuse a live one if present
const JOIN_TIMEOUT_MS = 120_000; // full engine boot to world + MP join; ~30-60s typical
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
async function startGameServer() {
  const dist = join(ROOT, 'server', 'dist', 'server.mjs');
  if (!existsSync(dist)) {
    console.log('[harness] building server (dist/server.mjs missing)...');
    execSync('npm run build', { cwd: join(ROOT, 'server'), stdio: 'inherit' });
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'omw-mp-data-'));
  // Per-run MOTD so scenario asserts can prove THIS server's welcome line reached the client
  // (not a stale mirror from a previous run). Merged over config.default.toml.
  const motd = `MOTD-${RUN_ID} welcome`;
  writeFileSync(join(dataDir, 'config.toml'), `[server]\nmotd = "${motd}"\n`);
  const port = await freePort();
  const proc = spawn(process.execPath, [dist, '--data', dataDir, '--port', String(port)], {
    cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  proc.stdout.on('data', (d) => out.push(String(d)));
  proc.stderr.on('data', (d) => out.push(String(d)));
  try {
    await waitHttp(`http://127.0.0.1:${port}/healthz`, 10_000, 'omw-mp /healthz');
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch {}
    throw new Error(e.message + '\nserver output:\n' + out.join(''));
  }
  return {
    port, motd,
    status: async () => (await fetch(`http://127.0.0.1:${port}/status`)).json(),
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
  const url = `http://127.0.0.1:${PLAY_PORT}/index.html?nomw&skipintro=1&start=Village`
    + `&mp=${encodeURIComponent(mpUrl)}${auth}`
    + extraParams;
  const chrome = spawn(CHROME, [
    '--headless=new', ...glArgs,
    '--disable-gpu-sandbox', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=0',
    '--window-size=1280,720', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const logs = [];
  const handle = {
    name,
    logTail: (n = 30) => logs.slice(-n).join('\n'),
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
    const t0 = Date.now();
    while (!wsUrl && Date.now() - t0 < 15_000) await sleep(100);
    if (!wsUrl) throw new Error('Chrome CDP endpoint never came up');

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
    handle.waitFor = async (expr, timeoutMs = 5000, what = expr) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { if (await handle.eval(expr)) return; } catch {}
        await sleep(250);
      }
      throw new Error(`[${name}] timeout (${timeoutMs}ms) waiting for: ${what}\n--- last logs ---\n${handle.logTail()}`);
    };

    console.log(`[harness] ${name}: booting ${url}`);
    const boot0 = Date.now();
    // Error-path scenarios pass their own terminal condition (e.g. state === "Failed").
    const waitExpr = opts.waitExpr ?? '(window.__omwMP||{}).state === "Joined"';
    const waitWhat = opts.waitWhat ?? '__omwMP.state === Joined';
    await handle.waitFor(waitExpr, JOIN_TIMEOUT_MS, waitWhat);
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
  let server = null;
  let err = null;
  console.log(`\n=== scenario ${file} ===`);
  try {
    server = await startGameServer();
    const { default: run } = await import(pathToFileURL(join(SCENARIO_DIR, file)));
    await run({
      runId: RUN_ID,
      motd: server.motd,
      serverStatus: server.status,
      serverKill: server.kill,
      sleep,
      log: (...a) => console.log('[' + file + ']', ...a),
      launchClient: async (name, extraParams, opts) => {
        const c = await launchClient(`${name}-${RUN_ID}`, server.port, extraParams, opts);
        clients.push(c);
        return c;
      },
    });
  } catch (e) {
    err = e;
  } finally {
    for (const c of clients) c.close();
    server?.stop();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ file, ok: !err, secs });
  if (err) console.error(`FAIL ${file} (${secs}s):\n${err.stack || err}`);
  else console.log(`PASS ${file} (${secs}s)`);
}
play.stop();

console.log('\n=== mp-harness summary ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}  (${r.secs}s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
