#!/usr/bin/env node
// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Headless-Chrome CDP harness for verifying the openmw-web build.
//
// Usage:
//   node wasm-build/verify-browser.mjs <url> [options]
// Options:
//   --secs N            total run time (default 60)
//   --shot path.png     screenshot at the END of the run (repeatable with --shot-at)
//   --shot-at T:path    screenshot at T seconds into the run (repeatable)
//   --eval-at T:expr    evaluate JS expression at T seconds (repeatable; result logged)
//   --click-at T:x,y    dispatch a full mouse click at (x,y) at T seconds (repeatable)
//   --key-at T:Key      dispatch a key press (e.g. Escape, Enter, a) at T seconds (repeatable)
//   --inject js-code    script evaluated on every new document BEFORE page scripts run
//   --console-out path  write full console log to file (default /tmp/omw_cdp_console.log)
//   --window WxH        browser window size (default 1280x800)
//   --gpu               use real GPU (default: SwiftShader software GL)
//
// Exit code 0 always (inspection tool); check the console log + screenshots.
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args[0];
if (!url) { console.error('need a URL'); process.exit(2); }
function opts(flag) { const out = []; for (let i = 1; i < args.length; i++) if (args[i] === flag) out.push(args[++i]); return out; }
const secs = parseInt(opts('--secs')[0] || '60', 10);
const endShot = opts('--shot')[0];
const shotAts = opts('--shot-at').map(s => { const i = s.indexOf(':'); return { t: parseFloat(s.slice(0, i)), path: s.slice(i + 1) }; });
const evalAts = opts('--eval-at').map(s => { const i = s.indexOf(':'); return { t: parseFloat(s.slice(0, i)), expr: s.slice(i + 1) }; });
const clickAts = opts('--click-at').map(s => { const i = s.indexOf(':'); const [x, y] = s.slice(i + 1).split(',').map(Number); return { t: parseFloat(s.slice(0, i)), x, y }; });
const keyAts = opts('--key-at').map(s => { const i = s.indexOf(':'); return { t: parseFloat(s.slice(0, i)), key: s.slice(i + 1) }; });
// --rclick-at T:x,y  — right mouse click (OpenMW: inventory / activate / GUI context)
const rclickAts = opts('--rclick-at').map(s => { const i = s.indexOf(':'); const [x, y] = s.slice(i + 1).split(',').map(Number); return { t: parseFloat(s.slice(0, i)), x, y }; });
const typeAts = opts('--type-at').map(s => { const i = s.indexOf(':'); return { t: parseFloat(s.slice(0, i)), text: s.slice(i + 1) }; });
// --move-at t:dx,dy  — relative mouse motion for in-game mouselook (no click). Delivered as a
// short sweep of mouseMoved events so emscripten SDL sees per-event deltas (turns the camera).
const moveAts = opts('--move-at').map(s => { const i = s.indexOf(':'); const [dx, dy] = s.slice(i + 1).split(',').map(Number); return { t: parseFloat(s.slice(0, i)), dx, dy }; });
// --reload-at t  — reload the page via CDP Page.reload (bypasses the in-page beforeunload guard,
// which blocks location.reload() while a game is running). Used to test persistence across a reload.
const reloadAts = opts('--reload-at').map(s => ({ t: parseFloat(s) }));
// --start-when EXPR  — before the --*-at timeline starts, poll this JS expression until it is truthy
// (or --start-timeout seconds elapse). All --*-at times are then measured from that moment, not from
// page load. Fixes fixed-timing races against the ~800MB asset load (e.g. clicking "New" before the
// menu exists, or screenshotting before a cell has rendered). Example: --start-when "Module.__omwRunning===1".
const startWhen = opts('--start-when')[0];
const startTimeout = parseInt(opts('--start-timeout')[0] || '180', 10);
const consoleOut = opts('--console-out')[0] || '/tmp/omw_cdp_console.log';
const [w, h] = (opts('--window')[0] || '1280x800').split('x').map(Number);
const useGpu = args.includes('--gpu');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// --profile <dir> reuses a fixed user-data-dir so the Cache API (817MB assets) + IDBFS persist
// across runs → fast, deterministic boots after the first warm-up. Omit for a throwaway profile.
const profile = opts('--profile')[0] || `/tmp/omw_cdp_profile_${process.pid}`;
const chromeArgs = [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run',
  `--window-size=${w},${h}`, '--remote-debugging-port=0', '--disable-dev-shm-usage',
];
if (!useGpu) chromeArgs.push('--use-angle=swiftshader');
// --chrome-flag <flag> (repeatable) — extra Chrome switches, e.g.
// --chrome-flag --autoplay-policy=no-user-gesture-required to unlock the AudioContext
// headlessly (matches a live session where video/game audio actually runs).
chromeArgs.push(...opts('--chrome-flag'));
chromeArgs.push(url);

writeFileSync(consoleOut, '');
const log = (line) => appendFileSync(consoleOut, line + '\n');

const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
let wsUrl = null;
chrome.stderr.on('data', (d) => {
  const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/);
  if (m) wsUrl = m[1];
});
const t0 = Date.now();
while (!wsUrl && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 100));
if (!wsUrl) { console.error('chrome devtools endpoint not found'); chrome.kill(); process.exit(2); }

// Find the page target via the browser endpoint.
const browserWs = new WebSocket(wsUrl);
let msgId = 0; const pending = new Map();
function send(ws, method, params, sessionId) {
  return new Promise((resolve) => {
    const id = ++msgId; pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
await new Promise(r => browserWs.onopen = r);
browserWs.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  handleEvent(m);
};
// Poll for the page target: on a cold profile the tab hasn't navigated to the
// localhost URL yet when the browser endpoint first comes up, so getTargets can
// race and return only about:blank. Retry for a few seconds.
let page = null;
const tTarget = Date.now();
while (!page && Date.now() - tTarget < 10000) {
  const targetsResp = await send(browserWs, 'Target.getTargets', {});
  const targetInfos = targetsResp.result?.targetInfos ?? [];
  // Prefer the localhost tab, but fall back to ANY page target: a warm profile can
  // restore to chrome://newtab and swallow the command-line URL, so we grab whatever
  // page exists and navigate it to the target URL below.
  page = targetInfos.find(t => t.type === 'page' && t.url.includes('localhost'))
      || targetInfos.find(t => t.type === 'page');
  if (!page) await new Promise(r => setTimeout(r, 200));
}
if (!page) { console.error('no page target'); chrome.kill(); process.exit(2); }
const attach = await send(browserWs, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
const sessionId = attach.result.sessionId;

function handleEvent(m) {
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
    log(`[console.${m.params.type}] ${text}`);
  } else if (m.method === 'Log.entryAdded') {
    log(`[${m.params.entry.source}.${m.params.entry.level}] ${m.params.entry.text}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    log(`[exception] ${JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)}`);
  }
}
await send(browserWs, 'Runtime.enable', {}, sessionId);
await send(browserWs, 'Log.enable', {}, sessionId);
await send(browserWs, 'Page.enable', {}, sessionId);
// If the profile restored to newtab (URL arg swallowed), drive the navigation ourselves.
if (!page.url.includes('localhost')) {
  await send(browserWs, 'Page.navigate', { url }, sessionId);
}
const inject = opts('--inject')[0];
if (inject) {
  await send(browserWs, 'Page.addScriptToEvaluateOnNewDocument', { source: inject }, sessionId);
  // the page already loaded before we attached — reload so the injection takes effect
  await send(browserWs, 'Page.reload', { ignoreCache: false }, sessionId);
}

async function screenshot(path) {
  const r = await send(browserWs, 'Page.captureScreenshot', { format: 'png' }, sessionId);
  if (r.result?.data) { writeFileSync(path, Buffer.from(r.result.data, 'base64')); console.log(`[shot] ${path}`); }
  else console.log(`[shot FAILED] ${path}: ${JSON.stringify(r.error || r)}`);
}
await send(browserWs, 'Page.enable', {}, sessionId);

async function click(x, y, button = 'left') {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send(browserWs, 'Input.dispatchMouseEvent',
      { type, x, y, button: type === 'mouseMoved' ? 'none' : button, clickCount: 1 }, sessionId);
    await new Promise(r => setTimeout(r, 60));
  }
  console.log(`[${button === 'right' ? 'rclick' : 'click'}] ${x},${y}`);
}

const KEYCODES = { Escape: 27, Enter: 13, Space: 32, Tab: 9, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  // Function keys — without these, key('F5') fell back to 'F5'.charCodeAt(0)=70 ('F'), so F5/F9
  // (quicksave/quickload) etc. were NEVER delivered as real function keys. F1=112 … F12=123.
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123 };
// Physical `code` mapping for punctuation whose scancode matters (e.g. the console key). Emscripten
// SDL derives the SDL scancode from the DOM `code`, so 'Key`' would fail to map to GRAVE.
const CODEMAP = { '`': ['Backquote', 192], '~': ['Backquote', 192], '-': ['Minus', 189], '>': ['Period', 190], '<': ['Comma', 188], '"': ['Quote', 222], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191] };
async function key(k) {
  const mapped = CODEMAP[k];
  const code = mapped ? mapped[1] : (KEYCODES[k] ?? k.toUpperCase().charCodeAt(0));
  const codeStr = mapped ? mapped[0] : (k.length === 1 ? 'Key' + k.toUpperCase() : k);
  // CDP quirk: 'keyDown' WITHOUT a text field is silently treated as 'rawKeyDown', which never
  // produces a DOM keydown for the page — so Escape/WASD were never delivered at all. Provide
  // the generated text (control chars for Escape/Enter/Tab, the char itself for printables).
  const TEXTMAP = { Escape: '', Enter: '\r', Tab: '\t', Backspace: '', Space: ' ' };
  const text = k.length === 1 ? k : (TEXTMAP[k] ?? '');
  const base = { key: k.length === 1 ? k : k, code: codeStr, text, unmodifiedText: text,
    windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  // 'keyDown' (not 'rawKeyDown') — rawKeyDown skips text processing and emscripten SDL misses
  // some non-printable keys with it (Escape never skipped videos, Return never hit OK buttons).
  await send(browserWs, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base }, sessionId);
  if (k.length === 1) // printable: deliver the character too (text inputs need the char event)
    await send(browserWs, 'Input.dispatchKeyEvent', { type: 'char', text: k, ...base }, sessionId);
  await new Promise(r => setTimeout(r, 60));
  await send(browserWs, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
  console.log(`[key] ${k}`);
}

async function move(dx, dy) {
  // Sweep from canvas center outward in small steps; SDL relative mode integrates the per-event
  // deltas into camera yaw/pitch. Center-start avoids clamping at a screen edge.
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await send(browserWs, 'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: cx + Math.floor(dx * i / steps), y: cy + Math.floor(dy * i / steps), button: 'none' }, sessionId);
    await new Promise(r => setTimeout(r, 16));
  }
  console.log(`[move] ${dx},${dy}`);
}

async function reload() {
  await send(browserWs, 'Page.reload', { ignoreCache: false }, sessionId);
  console.log('[reload] page reloaded via CDP');
}

async function type(text) {
  // Every char (incl. space/quote) goes through the single-char path so a `char`
  // event with the literal text is delivered — MyGUI edit boxes need that char event.
  for (const ch of text) await key(ch);
  console.log(`[type] ${text}`);
}

const timeline = [
  ...shotAts.map(s => ({ t: s.t, fn: () => screenshot(s.path) })),
  ...clickAts.map(c => ({ t: c.t, fn: () => click(c.x, c.y) })),
  ...rclickAts.map(c => ({ t: c.t, fn: () => click(c.x, c.y, 'right') })),
  ...keyAts.map(k => ({ t: k.t, fn: () => key(k.key) })),
  ...typeAts.map(t => ({ t: t.t, fn: () => type(t.text) })),
  ...moveAts.map(m => ({ t: m.t, fn: () => move(m.dx, m.dy) })),
  ...reloadAts.map(r => ({ t: r.t, fn: () => reload() })),
  ...evalAts.map(e => ({
    t: e.t, fn: async () => {
      const r = await send(browserWs, 'Runtime.evaluate', { expression: e.expr, returnByValue: true, awaitPromise: true }, sessionId);
      console.log(`[eval @${e.t}s] ${e.expr} => ${JSON.stringify(r.result?.result?.value ?? r.result?.result?.description ?? r.error)}`);
      log(`[eval @${e.t}s] ${e.expr} => ${JSON.stringify(r.result?.result?.value ?? r.result?.result?.description ?? r.error)}`);
    }
  })),
].sort((a, b) => a.t - b.t);

if (startWhen) {
  const t0poll = Date.now();
  let fired = false;
  while (Date.now() - t0poll < startTimeout * 1000) {
    try {
      const r = await send(browserWs, 'Runtime.evaluate',
        { expression: `!!(${startWhen})`, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.result?.result?.value === true) { fired = true; break; }
    } catch { /* context not ready yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  const waited = ((Date.now() - t0poll) / 1000).toFixed(1);
  console.log(fired ? `[start-when] fired after ${waited}s: ${startWhen}` : `[start-when] TIMEOUT after ${waited}s: ${startWhen}`);
  log(`[start-when] ${fired ? 'fired' : 'TIMEOUT'} after ${waited}s: ${startWhen}`);
}

const start = Date.now();
for (const item of timeline) {
  const wait = item.t * 1000 - (Date.now() - start);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  await item.fn();
}
const remaining = secs * 1000 - (Date.now() - start);
if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
if (endShot) await screenshot(endShot);

chrome.kill();
console.log(`[done] console log: ${consoleOut}`);
process.exit(0);
