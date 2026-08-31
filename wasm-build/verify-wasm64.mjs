// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Post-boot verification for the WASM64 engine. Boots the real openmw.wasm in headless Chrome
// and checks the things the wasm32 build could not do, plus the JS<->C++ pointer boundaries
// that MEMORY64 changes.
//
// wasm-build/memory64-gate.* proves the TOOLCHAIN can do all this with a toy program. This
// proves the SHIPPING ENGINE does, which is a different claim: the gate links none of OSG,
// Bullet, MyGUI or ffmpeg, and it is not the thing players run.
//
// Usage: node wasm-build/verify-wasm64.mjs [url] [bootSeconds]

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.argv[2] || 'http://localhost:8910/index.html?nomw&skipintro=1';
const BOOT_SECONDS = Number(process.argv[3] || 90);
const CDP_PORT = 9455;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${name.padEnd(34)} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures++;
};
const info = (name, detail) => console.log(`${name.padEnd(34)}      ${detail}`);

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

const profile = mkdtempSync(join(tmpdir(), 'omw-v64-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + profile, '--remote-debugging-port=' + CDP_PORT,
  '--window-size=1280,720', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

let target = null;
for (let i = 0; i < 80; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl;
    break;
  } catch { await sleep(250); }
}
if (!target) { console.error('Chrome CDP never came up'); process.exit(2); }

const ws = new WebSocket(target);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let mid = 1;
const t = await cdp(ws, mid++, 'Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp(ws, mid++, 'Target.attachToTarget', { targetId: t.targetId, flatten: true });
await cdp(ws, mid++, 'Runtime.enable', {}, sessionId);

const exceptions = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') {
    const e = m.params.exceptionDetails;
    exceptions.push(e.exception?.description || e.text);
  }
});

const evalIn = async (expression) => {
  const r = await cdp(ws, mid++, 'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return { value: r.result?.value };
};

// --- 0. THE GATE'S FAILURE PATH -----------------------------------------------------------
// This is a hard cut-over: a browser without memory64 cannot instantiate openmw.wasm at all.
// play/index.html and play/launcher.html feature-detect it and are supposed to show the
// "Browser not supported" overlay instead of a bare LinkError from inside openmw.js. That
// branch is what every such user sees, and it is the one path that never runs on a machine
// that works -- so simulate an old browser by making the u64 memory constructor throw, before
// any page script runs, and check the overlay actually appears.
await cdp(ws, mid++, 'Page.enable', {}, sessionId);
await cdp(ws, mid++, 'Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const Real = WebAssembly.Memory;
    WebAssembly.Memory = function (desc, ...rest) {
      if (desc && (desc.index === 'u64' || desc.address === 'i64'))
        throw new TypeError('simulated: no memory64 in this browser');
      return new Real(desc, ...rest);
    };
    WebAssembly.Memory.prototype = Real.prototype;
  })();`,
}, sessionId);
await cdp(ws, mid++, 'Page.navigate', { url: URL }, sessionId);
await sleep(6000);
const gated = await evalIn(`(document.body.innerText || '')`);
const gateText = String(gated.value ?? '').replace(/\s+/g, ' ');
// Report the MATCHED overlay text, not the head of the page. Printing the first 90 characters
// showed the normal title and "PREPARING...", which sits above the overlay -- so a correct
// PASS looked like a false one and had to be re-checked by hand to be believed.
const gateHit = gateText.match(/Browser not supported.{0,120}/i);
check('gate blocks non-memory64', !!gateHit && /Memory64/i.test(gateHit[0]),
  gateHit ? `"${gateHit[0].trim()}"` : `(no overlay; body began "${gateText.slice(0, 60)}")`);

// Remove the override and reload for the real run below.
await cdp(ws, mid++, 'Page.removeScriptToEvaluateOnNewDocument',
  { identifier: '1' }, sessionId).catch(() => {});
await cdp(ws, mid++, 'Runtime.evaluate',
  { expression: 'location.reload()' }, sessionId).catch(() => {});
await sleep(1500);

console.log(`booting ${URL} (up to ${BOOT_SECONDS}s)…`);
await cdp(ws, mid++, 'Page.navigate', { url: URL }, sessionId);

// Wait for the engine to be RUNNING, not merely present.
//
// `Module.ccall exists` goes true long before main() has -- the runtime is up while the engine
// is still initialising. Calling into an engine export in that window faults with
// "RuntimeError: memory access out of bounds", which reads exactly like a MEMORY64 pointer bug
// and is not one: the C++ side simply is not constructed yet. So wait for the engine to say it
// is alive (same signal smoke.mjs keys on), then let it settle before poking at it.
let booted = false;
for (let i = 0; i < BOOT_SECONDS * 2; i++) {
  await sleep(500);
  const r = await evalIn(`!!(window.Module && typeof Module.ccall === 'function'
    && document.querySelector('canvas')
    && (window.__omwBooted || (document.body.innerText || '').length > 0))`);
  if (r.value) { booted = true; break; }
}
await sleep(4000);   // settle: let prepareEngine()/the first frames finish
check('engine booted', booted);

// --- 1. the model actually shipped ---------------------------------------------------------
const model = await evalIn(`(() => {
  const b = Module.wasmMemory.buffer;
  return { bytes: b.byteLength, shared: b instanceof SharedArrayBuffer,
           kind: b.constructor.name };
})()`);
check('memory is SharedArrayBuffer', model.value?.shared === true, model.value?.kind ?? model.error ?? '');
info('heap after boot', `${(model.value?.bytes / 1024 ** 3).toFixed(2)} GiB`);

// --- 3. the JS -> C++ pointer boundary, in the real engine ----------------------------------
// play/index.html:1049 now routes omw_set_clipboard through ccall. Under MEMORY64 the raw
// export takes an i64 and a JS Number throws, and the paste handler swallows exceptions -- so
// if this regressed it would show up only as paste silently not working.
check('ccall exported', (await evalIn('typeof Module.ccall === "function"')).value === true);
const clip = await evalIn(`(() => {
  try { Module.ccall('omw_set_clipboard', null, ['string'], ['omw-verify-\\u00e9']); return 'ok'; }
  catch (e) { return String(e); }
})()`);
check('omw_set_clipboard via ccall', clip.value === 'ok', clip.value === 'ok' ? '' : String(clip.value ?? clip.error));

// Scalar exports are unaffected by MEMORY64, but they are the other things JS calls into the
// engine, so prove they still dispatch rather than assuming.
const scalars = await evalIn(`(() => {
  const out = {};
  // _emscripten_pause_main_loop is deliberately NOT required: play/index.html:610 already
  // falls back to Module.pauseMainLoop(), so it is optional by design.
  for (const fn of ['_omw_save_settings', '_omw_set_resolution'])
    out[fn] = typeof Module[fn];
  return out;
})()`);
check('scalar exports present',
  scalars.value && Object.values(scalars.value).every((t) => t === 'function'),
  JSON.stringify(scalars.value ?? scalars.error));

// --- 4. the boot gate --------------------------------------------------------------------
check('memory64 probe true here',
  (await evalIn(`(() => { try {
      new WebAssembly.Memory({initial:1n, maximum:262144n, shared:true, address:'i64'});
      return true; } catch(e){ return false; } })()`)).value === true);

// The declared ceiling, read off the live memory rather than trusted from the build script.
const ceiling = await evalIn(`(() => {
  const d = Module.wasmMemory.type ? Module.wasmMemory.type() : null;
  return d && d.maximum ? Number(d.maximum) * 65536 : null;
})()`);
if (ceiling.value) {
  const gib = ceiling.value / 1024 ** 3;
  check('ceiling is V8 max (16 GiB)', Math.abs(gib - 16) < 0.01, `(${gib.toFixed(2)} GiB)`);
} else {
  info('ceiling', '(Memory.type() unavailable; skipped)');
}

// --- ENGINE ALLOCATOR ACROSS 4 GiB ---------------------------------------------------------
// The closest honest proxy for "does a Tamriel Rebuilt load order fit", short of having TR.
//
// The raw mem.grow() check below proves the CEILING is 8 GiB. It does not prove the engine can
// USE it, because growing the memory object by hand skips _emscripten_resize_heap -- which is
// the function that actually runs when the engine allocates, and the one that has to re-point
// HEAPU8 and friends at the new buffer afterwards. TR does not call grow(); it calls malloc a
// great many times. So drive real allocations through mimalloc until the heap crosses 4 GiB,
// write to the far end of a block that can only live above the wasm32 wall, free it all, and
// then confirm the engine is STILL RENDERING rather than merely still loaded.
const engineAlloc = await evalIn(`(async () => {
  const M = window.Module, GiB = 1024 ** 3, FOUR = 4 * GiB;
  const before = M.wasmMemory.buffer.byteLength;
  const blocks = [];
  let highest = 0, wrote = null, readBack = null;
  try {
    // 256 MiB at a time, like the engine's larger buffers, until we are past the wall.
    // Keep going until a BLOCK ADDRESS is past 4 GiB, not merely until the heap size is.
    // Those are different: mimalloc reserves and aligns its regions, so the heap crossed the
    // line while the highest block still sat at 3.88 GiB -- which proves the heap grew but not
    // that anything is addressable up there, and addressability is the whole point.
    while (highest <= FOUR && blocks.length < 60) {
      const p = M._malloc(256 * 1024 * 1024);
      if (!p) break;
      blocks.push(p);
      const addr = typeof p === 'bigint' ? Number(p) : p;
      if (addr > highest) highest = addr;
    }
    // Write through the engine's own heap view at an address beyond 4 GiB.
    const hi = blocks.map(p => typeof p === 'bigint' ? Number(p) : p).filter(a => a > FOUR).pop();
    if (hi !== undefined) {
      const u8 = new Uint8Array(M.wasmMemory.buffer);
      wrote = 0x5A; u8[hi + 1024] = wrote; readBack = u8[hi + 1024];
    }
    const peak = M.wasmMemory.buffer.byteLength;
    for (const p of blocks) M._free(p);
    return { ok: true, before, peak, highest, wrote, readBack, blocks: blocks.length };
  } catch (e) {
    for (const p of blocks) { try { M._free(p); } catch {} }
    return { ok: false, before, error: String(e) };
  }
})()`);
const ea = engineAlloc.value ?? {};
const GiB = 1024 ** 3;
check('engine malloc crossed 4 GiB', ea.ok === true && ea.peak > 4 * GiB,
  ea.ok ? `(${(ea.before / GiB).toFixed(2)} -> ${(ea.peak / GiB).toFixed(2)} GiB via ${ea.blocks} allocations)`
        : (ea.error || engineAlloc.error || ''));
check('wrote above the 4 GiB line', ea.readBack === ea.wrote && ea.wrote != null,
  ea.highest ? `(highest block at ${(ea.highest / GiB).toFixed(2)} GiB)` : '');

// The real question after a growth that big: is the engine still alive, or did the heap views
// go stale underneath it? Count frames -- a loaded-but-frozen engine looks fine to everything
// except this.
const fpsBefore = await evalIn('window.__fps || 0');
await sleep(3000);
const stillRendering = await evalIn('window.__fps || 0');
check('engine still rendering after growth', (stillRendering.value ?? 0) > 0,
  `(fps ${fpsBefore.value ?? 0} -> ${stillRendering.value ?? 0})`);

// --- THE POINT OF THE CONVERSION -----------------------------------------------------------
// RUN LAST, and deliberately so. Growing the memory from here bypasses
// _emscripten_resize_heap, which is what normally calls updateMemoryViews() -- so afterwards
// Module.HEAPU8 and friends still point at the DETACHED pre-grow buffer and every subsequent
// ccall fails with "RuntimeError: memory access out of bounds". That is an artefact of poking
// the memory behind emscripten back, not an engine fault (the engine only ever grows through
// emscripten, which re-syncs the views), but it does mean nothing may run after this.
// Grow the real engine's memory past the wasm32 ceiling. This is the acceptance criterion:
// a Tamriel Rebuilt load order needs address space the wasm32 build simply does not have, and
// on wasm32 this grow() throws RangeError because 4 GiB is the whole address space.
const FOUR_GIB = 4 * 1024 ** 3;
const grow = await evalIn(`(() => {
  const mem = Module.wasmMemory;
  const before = mem.buffer.byteLength;
  const target = ${FOUR_GIB} + 256 * 1024 * 1024;      // 4 GiB + 256 MiB
  // At least one page: the engine-allocator check above may already have taken the heap past
  // this target, and a negative page count throws "Argument 0 must be in u64 range" -- which
  // reads like a MEMORY64 fault and is only arithmetic.
  const pages = Math.max(1, Math.ceil((target - before) / 65536));
  try {
    mem.grow(BigInt(pages));
    const after = mem.buffer.byteLength;
    // Touch the far end through a heap view, so this is a real mapping and not just a number.
    const u8 = new Uint8Array(mem.buffer);
    u8[after - 1] = 0xAB;
    return { ok: true, before, after, readBack: u8[after - 1] };
  } catch (e) { return { ok: false, before, error: String(e) }; }
})()`);
const g = grow.value ?? {};
check('grew past 4 GiB', g.ok === true && g.after > FOUR_GIB,
  g.ok ? `(${(g.before / 1024 ** 3).toFixed(2)} -> ${(g.after / 1024 ** 3).toFixed(2)} GiB)`
       : (g.error || grow.error || ''));
check('far end of heap writable', g.readBack === 0xAB, g.readBack === undefined ? '' : `(read back 0x${(g.readBack ?? 0).toString(16)})`);


// --- 5. nothing threw ----------------------------------------------------------------------
check('no uncaught exceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

try { chrome.kill('SIGKILL'); } catch {}
console.log(failures ? `\n--- WASM64 VERIFY FAILED (${failures}) ---` : '\n--- WASM64 VERIFY PASSED ---');
process.exit(failures ? 1 : 0);
