// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Engine frame-time sampler, for comparing two builds in the SAME scene.
//
// Written for the wasm32 -> wasm64 cut-over. The microbenchmark inside memory64-gate.cpp is
// noise-dominated and must not be quoted; this samples the engine's own per-frame cost
// (window.__frameMs / window.__fps, maintained by play/index.html's HUD) which is the number
// that actually decides whether MEMORY64's bounds-checking costs anything a player would feel.
//
// CAVEAT, and it matters when reading the output: headless Chrome renders through ANGLE's
// software path here, so the ABSOLUTE numbers are far below real hardware. Only the RATIO
// between two runs on the same machine is meaningful, and even that wants several runs --
// the sampler prints the median and the spread so you can see whether the difference survives
// the noise rather than reading a single figure.
//
// Also reports PEAK HEAP, which is how you answer "does this content load actually need
// wasm64?" -- run it against a real load order and read peakHeapGiB / neededWasm64. For
// Tamriel Rebuilt specifically:
//
//   1. install GOTY + TR through the admin dashboard (contentProfile "tamriel-rebuilt")
//   2. node wasm-build/perf-ab.mjs tr-wasm64 "<url with that load order>" 60
//
// A peakHeapGiB above 4.00 is the acceptance criterion for the conversion: it is content the
// wasm32 build could not have run at all. Below it, the ceiling is headroom rather than a fix,
// and OMW_MAX_MEMORY should be re-sized against the measured number.
//
// Usage: node wasm-build/perf-ab.mjs <label> [url] [sampleSeconds]

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LABEL = process.argv[2] || 'build';
const URL = process.argv[3] || 'http://localhost:8910/index.html?nomw&skipintro=1&hud=1';
const SAMPLE_SECONDS = Number(process.argv[4] || 30);
const CDP_PORT = 9463;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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

const profile = mkdtempSync(join(tmpdir(), 'omw-perf-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + profile, '--remote-debugging-port=' + CDP_PORT,
  '--window-size=1280,720', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

let target = null;
for (let i = 0; i < 80; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; break; }
  catch { await sleep(250); }
}
if (!target) { console.error('Chrome CDP never came up'); process.exit(2); }

const ws = new WebSocket(target);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let mid = 1;
const t = await cdp(ws, mid++, 'Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp(ws, mid++, 'Target.attachToTarget', { targetId: t.targetId, flatten: true });
await cdp(ws, mid++, 'Runtime.enable', {}, sessionId);
const evalIn = async (expression) => {
  const r = await cdp(ws, mid++, 'Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  return r.exceptionDetails ? null : r.result?.value;
};

await cdp(ws, mid++, 'Page.navigate', { url: URL }, sessionId);

// Wait until the engine is actually turning frames, not merely loaded.
let running = false;
for (let i = 0; i < 300; i++) {
  await sleep(500);
  if (await evalIn('!!(window.__fps && window.__fps > 0)')) { running = true; break; }
}
if (!running) { console.error(`${LABEL}: engine never started producing frames`); process.exit(1); }

// Discard the first stretch: shader compilation and the first cell load dominate it and are
// not what we are measuring.
await sleep(10000);

const frameMs = [];
const fps = [];
let peakHeap = 0;
for (let i = 0; i < SAMPLE_SECONDS; i++) {
  await sleep(1000);
  const s = await evalIn(`JSON.stringify({ms: window.__frameMs || 0, fps: window.__fps || 0,
    heap: (window.Module && Module.wasmMemory) ? Module.wasmMemory.buffer.byteLength : 0})`);
  if (!s) continue;
  const v = JSON.parse(s);
  if (v.ms > 0) frameMs.push(v.ms);
  if (v.fps > 0) fps.push(v.fps);
  // PEAK, not final: the heap only ever grows, but a run that ends in a menu would otherwise
  // under-report what the session actually needed. This is the number that sizes the ceiling.
  if (v.heap > peakHeap) peakHeap = v.heap;
}

const med = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const FOUR_GIB = 4 * 1024 ** 3;
console.log(JSON.stringify({
  label: LABEL,
  samples: frameMs.length,
  frameMsMedian: med(frameMs),
  frameMsMin: frameMs.length ? Math.min(...frameMs) : 0,
  frameMsMax: frameMs.length ? Math.max(...frameMs) : 0,
  fpsMedian: med(fps),
  peakHeapGiB: Number((peakHeap / 1024 ** 3).toFixed(2)),
  // The question the wasm64 conversion exists to answer. If a real content load stays under
  // 4 GiB the ceiling is not the binding constraint for it; if it goes over, this build is the
  // only one that can run it at all.
  neededWasm64: peakHeap > FOUR_GIB,
}));

try { chrome.kill('SIGKILL'); } catch {}
process.exit(0);
