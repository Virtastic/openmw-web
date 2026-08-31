// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Browser half of the MEMORY64 gate: serve wasm-build/memory64-gate.html cross-origin
// isolated, drive headless Chrome over the DevTools Protocol (node's built-in WebSocket, no
// puppeteer -- same approach as wasm-build/smoke.mjs), and report what the page found.
//
// Serves from a 30-line handler rather than play/server.py on purpose: server.py rewrites "/"
// to the launcher and proxies the MP gateway, neither of which a static two-file gate wants.
// The only thing that matters here is the three headers, and they are set below.
//
// Usage: node wasm-build/memory64-gate-browser.mjs [buildDir]

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, basename } from 'node:path';

const ROOT = process.argv[2] || join(process.cwd(), 'build-memory64-gate');
const GATE_HTML = join(process.cwd(), 'wasm-build', 'memory64-gate.html');
const PORT = 8930;
const CDP_PORT = 9430;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.mjs': 'text/javascript',
};

// COOP/COEP/CORP. Without all three, crossOriginIsolated is false, SharedArrayBuffer is
// undefined, and the gate fails for a reason that has nothing to do with memory64 --
// exactly the trap smoke.mjs:17-24 warns about for the engine.
const server = createServer(async (req, res) => {
  const name = basename(new URL(req.url, 'http://x').pathname) || 'memory64-gate.html';
  const path = name === 'memory64-gate.html' ? GATE_HTML : join(ROOT, name);
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(name)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found: ' + name);
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

function cdp(ws, id, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ sessionId, id, method, params }));
  });
}

const profile = mkdtempSync(join(tmpdir(), 'omw-m64-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu-sandbox', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--user-data-dir=' + profile, '--remote-debugging-port=' + CDP_PORT,
  '--window-size=1024,768', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

let target = null;
for (let i = 0; i < 80; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl;
    break;
  } catch { await sleep(250); }
}
if (!target) { console.error('Chrome CDP endpoint never came up'); process.exit(2); }

const ws = new WebSocket(target);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let mid = 1;
const t = await cdp(ws, mid++, 'Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp(ws, mid++, 'Target.attachToTarget', { targetId: t.targetId, flatten: true });

await cdp(ws, mid++, 'Runtime.enable', {}, sessionId);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') {
    const e = m.params.exceptionDetails;
    console.error('EXC:', e.exception?.description || e.text);
  }
});

await cdp(ws, mid++, 'Page.navigate', { url: `http://127.0.0.1:${PORT}/memory64-gate.html` }, sessionId);

// The >4 GiB allocation is real work; give it room but do not hang forever.
let gate = null;
for (let i = 0; i < 240; i++) {
  await sleep(500);
  const r = await cdp(ws, mid++, 'Runtime.evaluate', {
    expression: 'JSON.stringify(window.__gate || null)',
    returnByValue: true,
  }, sessionId);
  const v = r.result?.value;
  if (!v) continue;
  const parsed = JSON.parse(v);
  if (parsed?.done) { gate = parsed; break; }
}

server.close();
try { chrome.kill('SIGKILL'); } catch {}

if (!gate) { console.error('gate never finished (timeout)'); process.exit(1); }
console.log(gate.lines.join('\n'));
process.exit(gate.failures ? 1 : 0);
