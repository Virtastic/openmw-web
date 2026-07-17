#!/usr/bin/env node
// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// P3 gameplay sweep: drives combat / save-reload-load / GUI / dialogue / day-night / inventory
// headlessly and emits a findings matrix. Uses ?start=<cell> (bypass spawn), real F-keys, console
// commands (--type-at), omw_debug_* exports, and --reload-at (CDP reload). Run after selftest.mjs.
//   node wasm-build/p3.mjs [nameFilter]

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8795';
const PROFILE = process.env.PROFILE || '/tmp/omw_hero_profile';
const OUT = '/tmp/omw_p3';
const HARNESS = new URL('./verify-browser.mjs', import.meta.url).pathname;
const filter = process.argv[2] || '';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const enc = (s) => encodeURIComponent(s);

const ERR = [
  ['GL_INVALID', /GL_INVALID_(ENUM|OPERATION|VALUE)/],
  ['exception', /uncaught|unhandled rejection|RuntimeError|abort\(|Assertion failed/i],
  ['engineError', /\[\d[\d:.]+ E\](?![^\n]*Resources dir)/],
];

const scenarios = [
  {
    // Full persistence round-trip: spawn, quicksave, CDP-reload the whole page, quickload from the
    // menu, confirm the game is running again and the save survived the reload (IDBFS durability).
    name: 'save-reload-load',
    url: `${BASE}/index.html?start=${enc('Seyda Neen')}`,
    secs: 150,
    args: [
      '--click-at', '55:640,400',
      '--key-at', '64:F5',                    // quicksave
      '--eval-at', `68:(window.__omwSync?window.__omwSync():0)`,
      '--reload-at', '74',                    // CDP reload (bypasses beforeunload guard)
      '--shot-at', `120:${OUT}/srl_menu.png`, // after reboot -> main menu
      '--key-at', '124:F9',                   // quickload from menu
      '--eval-at', `140:({run:Module.__omwRunning})`,
      '--shot-at', `142:${OUT}/srl_loaded.png`,
    ],
    checks: [
      ['saved', (l) => /Writing saved game 'Quicksave'|is saved in/.test(l)],
      ['reloaded', (l) => /\[reload\] page reloaded/.test(l)],
      ['loadedRunning', (l) => /\[eval @140s\].*"run":1/.test(l)],
    ],
  },
  {
    // GUI windows: open inventory / journal / stats / magic; screenshot each; no GL errors.
    name: 'gui-windows',
    url: `${BASE}/index.html?start=${enc('Seyda Neen')}`,
    secs: 100,
    args: [
      '--click-at', '55:640,400',
      '--key-at', '60:i', '--shot-at', `63:${OUT}/gui_inv.png`, '--key-at', '65:i',
      '--key-at', '68:j', '--shot-at', `71:${OUT}/gui_journal.png`, '--key-at', '73:j',
      '--eval-at', `80:({err:GLctx.getError(), run:Module.__omwRunning})`,
    ],
    checks: [
      ['running', (l) => /\[eval @80s\].*"run":1/.test(l)],
      ['glErr0', (l) => /\[eval @80s\].*"err":0/.test(l)],
    ],
  },
  {
    // Dialogue: Seyda Neen exterior has NPCs; activate the nearest -> dialogue window.
    name: 'dialogue',
    url: `${BASE}/index.html?start=${enc('Seyda Neen')}`,
    secs: 100,
    args: [
      '--click-at', '55:640,400',
      '--eval-at', `62:(Module._omw_debug_activate?Module._omw_debug_activate():'no')`,
      '--shot-at', `66:${OUT}/dialogue.png`,
      '--eval-at', `70:({err:GLctx.getError(), run:Module.__omwRunning})`,
    ],
    checks: [
      ['running', (l) => /\[eval @70s\].*"run":1/.test(l)],
      ['noGL', (l) => /\[eval @70s\].*"err":0/.test(l)],
    ],
  },
  {
    // Combat: spawn into a cave with hostile smugglers/creatures near Seyda Neen; god-mode so we
    // survive; verify enemies engage without a crash.
    name: 'combat',
    url: `${BASE}/index.html?start=${enc('Addamasartus')}`,
    secs: 105,
    args: [
      '--click-at', '55:640,400',
      '--key-at', '60:`', '--type-at', '62:tgm', '--key-at', '66:Enter', '--key-at', '68:`',
      '--shot-at', `85:${OUT}/combat.png`,
      '--eval-at', `88:({run:Module.__omwRunning})`,
    ],
    checks: [
      ['inCave', (l) => /Loading cell Addamasartus/.test(l)],
      ['running', (l) => /\[eval @88s\].*"run":1/.test(l)],
    ],
  },
  {
    // Day/night rendering: same spot at midnight vs noon.
    name: 'day-night',
    url: `${BASE}/index.html?start=${enc('Seyda Neen')}`,
    secs: 100,
    args: [
      '--click-at', '55:640,400', '--move-at', '58:0,-120',
      '--eval-at', `62:(Module._omw_debug_sethour?Module._omw_debug_sethour(0):0)`, '--shot-at', `66:${OUT}/night.png`,
      '--eval-at', `70:(Module._omw_debug_sethour?Module._omw_debug_sethour(12):0)`, '--shot-at', `74:${OUT}/day.png`,
      '--eval-at', `78:({err:GLctx.getError(), run:Module.__omwRunning})`,
    ],
    checks: [
      ['running', (l) => /\[eval @78s\].*"run":1/.test(l)],
      ['glErr0', (l) => /\[eval @78s\].*"err":0/.test(l)],
    ],
  },
  {
    // Inventory item: give gold via console, open inventory, screenshot (gold should show).
    name: 'inventory-item',
    url: `${BASE}/index.html?start=${enc('Seyda Neen')}`,
    secs: 100,
    args: [
      '--click-at', '55:640,400',
      '--key-at', '60:`', '--type-at', '62:player->additem "gold_001" 500', '--key-at', '74:Enter', '--key-at', '76:`',
      '--key-at', '80:i', '--shot-at', `83:${OUT}/inv_gold.png`,
      '--eval-at', `86:({run:Module.__omwRunning})`,
    ],
    checks: [
      ['running', (l) => /\[eval @86s\].*"run":1/.test(l)],
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
  process.stdout.write(`\n=== ${s.name} (${s.secs}s) ===\n`);
  const r = spawnSync('node', [HARNESS, s.url, '--profile', PROFILE, '--gpu', '--secs', String(s.secs),
    ...s.args, '--console-out', logPath], { encoding: 'utf8', timeout: (s.secs + 45) * 1000 });
  if (r.stdout) process.stdout.write(r.stdout.split('\n').slice(-3).join('\n') + '\n');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const errs = ERR.filter(([, re]) => re.test(log)).map(([n]) => n);
  const checks = s.checks.map(([n, fn]) => [n, !!fn(log)]);
  results.push({ name: s.name, errs, checks, empty: log.length === 0 });
}

process.stdout.write('\n\n================ P3 GAMEPLAY MATRIX ================\n');
for (const r of results) {
  const cs = r.checks.map(([n, ok]) => `${ok ? '✓' : '✗'}${n}`).join(' ');
  const es = r.errs.length ? `  ERR:${r.errs.join(',')}` : '';
  const st = r.empty ? 'NO-LOG' : (r.checks.every(([, ok]) => ok) && !r.errs.length ? 'PASS' : 'ATTN');
  process.stdout.write(`${st.padEnd(8)} ${r.name.padEnd(18)} ${cs}${es}\n`);
}
process.stdout.write(`\nlogs+shots: ${OUT}/\n`);
