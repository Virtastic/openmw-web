#!/usr/bin/env node
// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OpenMW-Web self-test battery. Drives the game headlessly through a fixed set of scenarios via
// verify-browser.mjs (?noopt => OSG per-frame GL error checking ON), captures console logs +
// screenshots, greps for error classes, and prints a pass/fail matrix. This is the verification
// gate for every fix phase — run before and after a change; the matrix must not regress.
//
// Usage:
//   node wasm-build/selftest.mjs [scenarioNameFilter]
//   BASE=http://localhost:8795 PROFILE=/tmp/omw_hero_profile node wasm-build/selftest.mjs
//
// Requires: the play/ server running (BASE), a warm --profile (assets cached) for fast boots.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8795';
const PROFILE = process.env.PROFILE || '/tmp/omw_hero_profile';
const OUT = '/tmp/omw_selftest';
const HARNESS = new URL('./verify-browser.mjs', import.meta.url).pathname;
const filter = process.argv[2] || '';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// Error classes to flag in any scenario's console log. Each is a real problem if present.
const ERROR_PATTERNS = [
  ['GL_INVALID', /GL_INVALID_(ENUM|OPERATION|VALUE|FRAMEBUFFER_OPERATION)/],
  ['glGenerateMipmap', /glGenerateMipmap/],
  ['ClipPlane', /ClipPlane::apply/],
  ['FBO_INCOMPLETE', /FRAMEBUFFER.*(INCOMPLETE|0x8cd)/i],
  ['exception', /uncaught|unhandled rejection|RuntimeError|abort\(|Assertion/i],
  ['cellNotFound', /could not find cell|failed to load cell/i],
  // engine Log Error lines, excluding the known-benign "Resources dir doesn't match" false alarm.
  ['engineError', /\[\d[\d:.]+ E\](?![^\n]*Resources dir)/],
];

// cell names use the real comma form. `enc()` url-encodes the whole start value.
const enc = (s) => encodeURIComponent(s);

// Each scenario: {name, url, secs, args:[...harness flags], checks:[{name, test(log)->bool|str}]}
// t values are seconds from page load. Boot to a cached full-game world is ~35-45s; keep margin.
const scenarios = [
  {
    name: 'boot-menu',
    url: `${BASE}/index.html?noopt`,
    secs: 55,
    args: [
      '--shot-at', `48:${OUT}/boot.png`,
      '--eval-at', `50:({err:(typeof GLctx!=='undefined'?GLctx.getError():-1), run:(typeof Module!=='undefined')&&Module.__omwRunning})`,
    ],
    checks: [
      ['reachedMenu', (log) => /Playing "music\/special\/morrowind title|OpenMW version/i.test(log)],
      ['glErr0', (log) => /\[eval @50s\].*"err":0/.test(log)],
    ],
  },
  {
    name: 'exterior-day',
    url: `${BASE}/index.html?noopt&start=${enc('Seyda Neen')}`,
    secs: 105,
    args: [
      '--click-at', '55:640,400',
      '--eval-at', `60:(typeof Module!=='undefined'&&Module._omw_debug_sethour?Module._omw_debug_sethour(12):'no-export')`,
      '--eval-at', `64:(Module._omw_debug_look?Module._omw_debug_look(30,-8):'no')`,
      '--shot-at', `70:${OUT}/exterior.png`,
      '--eval-at', `74:(function(){var g=GLctx,p=new Uint8Array(4);g.readPixels(640,300,1,1,g.RGBA,g.UNSIGNED_BYTE,p);return {sky:[p[0],p[1],p[2]], err:g.getError(), run:Module.__omwRunning};})()`,
    ],
    checks: [
      ['newGame', (log) => /Starting a new game/.test(log)],
      ['running', (log) => /\[eval @74s\].*"run":1/.test(log)],
      ['glErr0', (log) => /\[eval @74s\].*"err":0/.test(log)],
    ],
  },
  {
    // ?start=<interior> with --new-game lands in the intro boat (Imperial Prison Ship), not an
    // arbitrary cell — the new-game sequence owns the start. To reach a SPECIFIC cell, coc from the
    // console once the world is running. Here we coc into South Wall Cornerclub after boot.
    name: 'interior',
    url: `${BASE}/index.html?noopt&start=${enc('Seyda Neen')}`,
    secs: 120,
    args: [
      '--click-at', '60:640,400',
      '--key-at', '66:`', '--type-at', '68:coc "Balmora, South Wall Cornerclub"',
      '--key-at', '80:Enter', '--key-at', '82:`',
      '--eval-at', `95:(function(){var g=GLctx,p=new Uint8Array(4);g.readPixels(640,300,1,1,g.RGBA,g.UNSIGNED_BYTE,p);return {px:[p[0],p[1],p[2]], err:g.getError(), run:Module.__omwRunning};})()`,
      '--shot-at', `98:${OUT}/interior.png`,
    ],
    checks: [
      ['inSouthWall', (log) => /Loading cell Balmora, South Wall Cornerclub/.test(log)],
      ['running', (log) => /\[eval @95s\].*"run":1/.test(log)],
      ['glErr0', (log) => /\[eval @95s\].*"err":0/.test(log)],
    ],
  },
  {
    name: 'saveload',
    url: `${BASE}/index.html?noopt&start=${enc('Seyda Neen')}`,
    secs: 100,
    args: [
      '--click-at', '55:640,400',
      '--eval-at', `60:(Module._omw_debug_teleport?Module._omw_debug_teleport(-23000,-15000,600):'no')`,
      '--key-at', '64:F5', // quicksave
      '--eval-at', `68:(window.__omwSync?window.__omwSync():'no-sync')`,
      '--eval-at', `72:(function(){try{return FS.readdir('/userdata/data-home/openmw').filter(function(f){return /save|\\.ess|\\.omwsave/i.test(f);});}catch(e){try{return FS.readdir('/userdata');}catch(e2){return String(e2);}}})()`,
    ],
    checks: [
      ['running', (log) => /Starting a new game/.test(log)],
      ['saveWritten', (log) => /\[eval @72s\].*(save|ess|omwsave)/i.test(log)],
    ],
  },
  {
    name: 'gui-windows',
    url: `${BASE}/index.html?noopt&start=${enc('Balmora, South Wall Cornerclub')}`,
    secs: 105,
    args: [
      '--click-at', '55:640,400', '--click-at', '58:640,376',
      '--key-at', '62:i', '--shot-at', `65:${OUT}/gui_inventory.png`,
      '--key-at', '68:j', '--shot-at', `71:${OUT}/gui_journal.png`,
      '--key-at', '74:Escape',
      '--eval-at', `78:({err:GLctx.getError(), run:Module.__omwRunning})`,
    ],
    checks: [
      ['running', (log) => /\[eval @78s\].*"run":1/.test(log)],
      ['glErr0', (log) => /\[eval @78s\].*"err":0/.test(log)],
    ],
  },
];

function cleanLock() {
  spawnSync('bash', ['-c', `pkill -9 -f "Google Chrome.*headless" 2>/dev/null; rm -rf ${PROFILE}/Singleton* 2>/dev/null; sleep 1`]);
}

const results = [];
for (const s of scenarios) {
  if (filter && !s.name.includes(filter)) continue;
  cleanLock();
  const logPath = `${OUT}/${s.name}.log`;
  const argv = [HARNESS, s.url, '--profile', PROFILE, '--gpu', '--secs', String(s.secs),
    ...s.args, '--console-out', logPath];
  process.stdout.write(`\n=== ${s.name} (${s.secs}s) ===\n`);
  const r = spawnSync('node', argv, { encoding: 'utf8', timeout: (s.secs + 40) * 1000 });
  if (r.stdout) process.stdout.write(r.stdout.split('\n').slice(-4).join('\n') + '\n');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  // error classes present
  const errs = ERROR_PATTERNS.filter(([, re]) => re.test(log)).map(([n]) => n);
  // scenario checks
  const checks = s.checks.map(([n, fn]) => [n, !!fn(log)]);
  results.push({ name: s.name, errs, checks, logPath, empty: log.length === 0 });
}

// ---- matrix ----
process.stdout.write('\n\n================ SELF-TEST MATRIX ================\n');
for (const r of results) {
  const checkStr = r.checks.map(([n, ok]) => `${ok ? '✓' : '✗'}${n}`).join(' ');
  const errStr = r.errs.length ? `  ERRORS: ${r.errs.join(',')}` : '';
  const status = r.empty ? 'NO-LOG(harness fail)' : (r.checks.every(([, ok]) => ok) && !r.errs.length ? 'PASS' : 'ATTN');
  process.stdout.write(`${status.padEnd(20)} ${r.name.padEnd(16)} ${checkStr}${errStr}\n`);
}
process.stdout.write(`\nlogs+shots: ${OUT}/\n`);
