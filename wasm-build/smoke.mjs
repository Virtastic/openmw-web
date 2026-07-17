// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Headless-Chrome smoke test for the OpenMW-Web build.
// Drives Chrome via the DevTools Protocol using node's built-in WebSocket (no puppeteer).
// Captures console/exception/context-loss, waits for a boot signal, screenshots the page,
// and asserts a non-black, non-uniform frame. Scoped to a throwaway --user-data-dir so it
// NEVER touches the user's Chrome profile.
//
// Usage: node wasm-build/smoke.mjs "<url>" [seconds] [labelForScreenshot]
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const URL = process.argv[2] || 'http://localhost:8795/index.html?nomw&skipintro=1';
const SECONDS = Number(process.argv[3] || 45);
const LABEL = process.argv[4] || 'smoke';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + Math.floor((Date.now() % 500));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- minimal PNG -> mean luminance + luminance variance (non-black / non-uniform check) ---
function pngStats(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unexpected bit depth ' + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error('unsupported color type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let ri = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[ri++];
    for (let x = 0; x < stride; x++) {
      const v = raw[ri++];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let val;
      switch (f) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: val = v + paeth(a, b, c); break;
        default: throw new Error('bad filter ' + f);
      }
      out[y * stride + x] = val & 0xff;
    }
  }
  // sample luminance
  let n = 0, sum = 0, sumSq = 0, nonBlack = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = y * stride + x * channels;
      const r = out[i], g = channels >= 3 ? out[i + 1] : out[i], bl = channels >= 3 ? out[i + 2] : out[i];
      const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
      sum += lum; sumSq += lum * lum; n++;
      if (lum > 8) nonBlack++;
    }
  }
  const mean = sum / n, variance = sumSq / n - mean * mean;
  return { width, height, mean, std: Math.sqrt(Math.max(0, variance)), nonBlackFrac: nonBlack / n };
}

async function cdp(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const logs = [], errors = [];
let contextLost = false;

(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'omw-smoke-'));
  const glArgs = process.env.SMOKE_GL === 'swiftshader'
    ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'];
  const args = [
    '--headless=new', ...glArgs,
    '--disable-gpu-sandbox', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--window-size=1280,720', 'about:blank',
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

  // wait for the debugging endpoint
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://localhost:' + PORT + '/json/version');
      const j = await r.json();
      target = j.webSocketDebuggerUrl; break;
    } catch { await sleep(250); }
  }
  if (!target) throw new Error('Chrome CDP endpoint never came up');

  const browser = new WebSocket(target);
  await new Promise((res) => browser.addEventListener('open', res, { once: true }));
  let mid = 1;
  const t = await cdp(browser, mid++, 'Target.createTarget', { url: 'about:blank' });
  const attach = await cdp(browser, mid++, 'Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sessionId = attach.sessionId;

  // session-scoped send/recv
  function sessionSend(method, params = {}) {
    const id = mid++;
    return new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) { browser.removeEventListener('message', onMsg); m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result); }
      };
      browser.addEventListener('message', onMsg);
      browser.send(JSON.stringify({ sessionId, id, method, params }));
    });
  }
  browser.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push('[' + m.params.type + '] ' + txt);
      if (/webglcontextlost|context lost/i.test(txt)) contextLost = true;
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      errors.push('EXC: ' + (e.exception?.description || e.text));
    } else if (m.method === 'Log.entryAdded') {
      logs.push('[log] ' + m.params.entry.text);
    }
  });

  await sessionSend('Page.enable');
  await sessionSend('Runtime.enable');
  await sessionSend('Log.enable');
  await sessionSend('Runtime.addBinding', {}).catch(() => {});
  await sessionSend('Page.navigate', { url: URL });

  // let it boot
  const deadline = Date.now() + SECONDS * 1000;
  const SEND_INPUT = process.env.SMOKE_INPUT === '1';
  let isolated = null, glError = null, inputSent = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    // Optionally, once past the halfway boot mark, synthesize a click + keypress + mousemove to
    // unstick anything waiting on user input (real players always provide input).
    if (SEND_INPUT && !inputSent && Date.now() > deadline - (SECONDS * 1000) / 2) {
      inputSent = true;
      try {
        await sessionSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 360, button: 'left', clickCount: 1 });
        await sessionSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 360, button: 'left', clickCount: 1 });
        await sessionSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 680, y: 380 });
        for (const k of ['Escape', 'KeyW', 'Space']) {
          await sessionSend('Input.dispatchKeyEvent', { type: 'keyDown', code: k, key: k === 'Space' ? ' ' : k, windowsVirtualKeyCode: k === 'Escape' ? 27 : k === 'Space' ? 32 : 87 });
          await sessionSend('Input.dispatchKeyEvent', { type: 'keyUp', code: k, key: k === 'Space' ? ' ' : k, windowsVirtualKeyCode: k === 'Escape' ? 27 : k === 'Space' ? 32 : 87 });
        }
        logs.push('[smoke] synthesized input (click+keys)');
      } catch (e) { errors.push('input: ' + e.message); }
    }
    try {
      const r = await sessionSend('Runtime.evaluate', {
        expression: 'JSON.stringify({iso: self.crossOriginIsolated, hasCanvas: !!document.querySelector("canvas"), lost: (window.__omwContextLost||false)})',
        returnByValue: true,
      });
      const v = JSON.parse(r.result.value);
      isolated = v.iso;
      if (v.lost) contextLost = true;
    } catch {}
  }

  // screenshot
  let stats = null, shotPath = null;
  try {
    const shot = await sessionSend('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    shotPath = '/tmp/omw-' + LABEL + '.png';
    writeFileSync(shotPath, buf);
    stats = pngStats(buf);
  } catch (e) { errors.push('screenshot: ' + e.message); }

  // verdict
  const bootOk = logs.some((l) => /pump|frame|OpenMW|Engine|main menu|MWGui|initialised|Loading/i.test(l));
  const abort = errors.concat(logs).some((l) => /unreachable|RuntimeError|abort\(|Aborted|out of memory/i.test(l));
  const frameOk = stats && stats.nonBlackFrac > 0.02 && stats.std > 3;

  console.log('=== SMOKE: ' + LABEL + ' ===');
  console.log('URL:', URL);
  console.log('crossOriginIsolated:', isolated);
  console.log('contextLost:', contextLost);
  console.log('frame:', stats ? `${stats.width}x${stats.height} mean=${stats.mean.toFixed(1)} std=${stats.std.toFixed(1)} nonBlack=${(stats.nonBlackFrac*100).toFixed(1)}%` : 'NONE');
  console.log('screenshot:', shotPath);
  console.log('bootSignal:', bootOk, '| abort:', abort, '| frameOk:', frameOk);
  try { writeFileSync('/tmp/omw-' + LABEL + '-alllogs.txt', logs.join('\n')); } catch {}
  console.log('--- last 40 log lines ---');
  console.log(logs.slice(-40).join('\n'));
  if (errors.length) { console.log('--- errors ---'); console.log(errors.slice(-20).join('\n')); }

  const pass = isolated === true && !contextLost && !abort && frameOk;
  console.log('\nRESULT:', pass ? 'PASS ✅' : 'FAIL ❌');
  try { chrome.kill('SIGKILL'); } catch {}
  try { execSync('rm -rf ' + profile); } catch {}
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR:', e); process.exit(2); });
