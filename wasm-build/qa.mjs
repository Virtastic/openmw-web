#!/usr/bin/env node
// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Full 1:1 QA sweep. Runs many scenarios headlessly (settings, GUI, environments, gameplay,
// first-person viewmodel) and emits a pass/fail matrix + screenshots for visual review.
//   node wasm-build/qa.mjs [nameFilter]
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:8795';
const PROFILE = process.env.PROFILE || '/tmp/omw_qa_profile';
const OUT = '/tmp/omw_qa';
const HARNESS = new URL('./verify-browser.mjs', import.meta.url).pathname;
const filter = process.argv[2] || '';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const enc = (s) => encodeURIComponent(s);
const RUN = 'Module.__omwRunning===1';

const ERR = [
  ['GL_INVALID', /GL_INVALID_(ENUM|OPERATION|VALUE)/],
  ['exception', /uncaught|unhandled rejection|RuntimeError|abort\(|Assertion failed/i],
  ['shaderFail', /FAILED|client\/version number|No precision|undeclared/i],
  ['engineError', /\[\d[\d:.]+ E\](?![^\n]*(Resources dir|OutsideBanner|lookoutScript|fallingScript))/],
];

const S = (t, path) => ['--shot-at', `${t}:${OUT}/${path}`];
const look = (t, y, p) => ['--eval-at', `${t}:(Module._omw_debug_look?Module._omw_debug_look(${y},${p}):0)`];
const hour = (t, h) => ['--eval-at', `${t}:(Module._omw_debug_sethour?Module._omw_debug_sethour(${h}):0)`];

const scenarios = [
  { // FIRST-PERSON VIEWMODEL: fists readied, weapon equipped+readied, spell readied.
    name: 'fp-viewmodel', url: `${BASE}/index.html?start=${enc('Seyda Neen')}`, secs: 95,
    args: [
      '--click-at', '5:640,400',
      ...S(9, 'fp_idle.png'),                          // sheathed: expect NO hands (stock MW)
      '--key-at', '12:f', ...S(15, 'fp_fists.png'),    // ready fists: expect two fists
      // give + equip an iron dagger via console, then ready it
      '--key-at', '18:`', '--type-at', '20:player->additem "iron dagger" 1', '--key-at', '33:Enter',
      '--type-at', '35:player->equip "iron dagger"', '--key-at', '46:Enter', '--key-at', '48:`',
      '--key-at', '52:f', ...S(56, 'fp_weapon.png'),   // ready weapon: expect hand + dagger
      // ready a spell (cast stance) — give a spell first
      '--key-at', '60:`', '--type-at', '62:player->addspell "fireball"', '--key-at', '74:Enter', '--key-at', '76:`',
      '--key-at', '80:r', ...S(84, 'fp_spell.png'),    // R = ready magic (default)
      '--eval-at', `88:({run:Module.__omwRunning, err:GLctx.getError()})`,
    ],
    checks: [['running', l => /eval @88s.*"run":1/.test(l)], ['additem', l => /iron dagger/i.test(l)]],
  },
  { // GUI: right-click = inventory/character screen; J journal; M map.
    name: 'gui', url: `${BASE}/index.html?start=${enc('Seyda Neen')}`, secs: 80,
    args: [
      '--click-at', '5:640,400',
      '--rclick-at', '9:640,400', ...S(13, 'gui_inventory.png'), '--rclick-at', '16:640,400',
      '--key-at', '20:j', ...S(24, 'gui_journal.png'), '--key-at', '27:j',
      '--key-at', '31:m', ...S(35, 'gui_map.png'), '--key-at', '38:m',
      '--key-at', '42:Escape', ...S(46, 'gui_pausemenu.png'), '--key-at', '49:Escape',
      '--eval-at', `54:({run:Module.__omwRunning, err:GLctx.getError()})`,
    ],
    checks: [['running', l => /eval @54s.*"run":1/.test(l)], ['noGL', l => /eval @54s.*"err":0/.test(l)]],
  },
  { // ENVIRONMENTS: exterior day/night, distant terrain vista.
    name: 'exterior', url: `${BASE}/index.html?start=${enc('Seyda Neen')}`, secs: 80,
    args: [
      '--click-at', '5:640,400',
      ...hour(8, 13), ...look(11, 90, -5), ...S(15, 'ext_day.png'),
      ...hour(19, 0), ...S(23, 'ext_night.png'),
      ...hour(27, 8), ...look(30, 200, -5), ...S(34, 'ext_vista.png'),
      '--eval-at', `40:({run:Module.__omwRunning, err:GLctx.getError()})`,
    ],
    checks: [['running', l => /eval @40s.*"run":1/.test(l)], ['noGL', l => /eval @40s.*"err":0/.test(l)]],
  },
  { // BALMORA: bigger town, statics + render distance.
    name: 'balmora', url: `${BASE}/index.html?start=${enc('Balmora')}`, secs: 80,
    args: [
      '--click-at', '5:640,400', ...hour(8, 12),
      ...look(11, 0, -5), ...S(15, 'balmora_1.png'),
      ...look(19, 120, -5), ...S(23, 'balmora_2.png'),
      ...look(27, 240, 0), ...S(31, 'balmora_3.png'),
      '--eval-at', `37:({run:Module.__omwRunning, err:GLctx.getError()})`,
    ],
    checks: [['loaded', l => /Loading cell Balmora/i.test(l)], ['running', l => /eval @37s.*"run":1/.test(l)]],
  },
  { // INTERIOR: a shop interior (lighting, statics).
    name: 'interior', url: `${BASE}/index.html?start=${enc("Balmora, Eight Plates")}`, secs: 75,
    args: [
      '--click-at', '5:640,400',
      ...look(9, 0, 0), ...S(13, 'interior_1.png'),
      ...look(17, 130, 0), ...S(21, 'interior_2.png'),
      '--eval-at', `28:({run:Module.__omwRunning, err:GLctx.getError()})`,
    ],
    checks: [['running', l => /eval @28s.*"run":1/.test(l)], ['noGL', l => /eval @28s.*"err":0/.test(l)]],
  },
  { // COMBAT: cave with hostile smugglers, god-mode, magic VFX.
    name: 'combat-magic', url: `${BASE}/index.html?start=${enc('Addamasartus')}`, secs: 95,
    args: [
      '--click-at', '5:640,400',
      '--key-at', '9:`', '--type-at', '11:tgm', '--key-at', '15:Enter',
      '--type-at', '18:player->addspell "fireball"', '--key-at', '30:Enter', '--key-at', '32:`',
      ...S(40, 'combat_scene.png'),
      '--key-at', '44:r', '--click-at', '47:640,400', ...S(50, 'combat_castready.png'),
      '--eval-at', `56:({run:Module.__omwRunning, err:GLctx.getError()})`,
    ],
    checks: [['inCave', l => /Loading cell Addamasartus/i.test(l)], ['running', l => /eval @56s.*"run":1/.test(l)]],
  },
  { // DIALOGUE: nearest NPC.
    name: 'dialogue', url: `${BASE}/index.html?start=${enc('Seyda Neen')}`, secs: 70,
    args: [
      '--click-at', '5:640,400',
      '--eval-at', `10:(Module._omw_debug_activate?Module._omw_debug_activate():'no')`,
      ...S(15, 'dialogue.png'),
      '--eval-at', `20:({run:Module.__omwRunning, err:GLctx.getError()})`,
    ],
    checks: [['running', l => /eval @20s.*"run":1/.test(l)], ['npcs', l => /activate.*=> [1-9]/.test(l)]],
  },
  { // SAVE / RELOAD / LOAD roundtrip (IDBFS persistence).
    name: 'save-load', url: `${BASE}/index.html?start=${enc('Seyda Neen')}`, secs: 150,
    args: [
      '--click-at', '5:640,400',
      '--key-at', '10:F5', '--eval-at', `16:(window.__omwSync?window.__omwSync():0)`,
      '--reload-at', '22', ...S(120, 'srl_menu.png'),
      '--key-at', '124:F9', ...S(140, 'srl_loaded.png'),
      '--eval-at', `144:({run:Module.__omwRunning})`,
    ],
    checks: [['saved', l => /Writing saved game|is saved in/i.test(l)], ['reloaded', l => /reload.*reloaded/i.test(l)], ['loaded', l => /eval @144s.*"run":1/.test(l)]],
  },
  { // SETTINGS variations render (no distant terrain, post-processing on).
    name: 'settings-vary', url: `${BASE}/index.html?start=${enc('Balmora')}&dt=0&pp=1`, secs: 70,
    args: [
      '--click-at', '5:640,400', ...hour(8, 12),
      ...look(11, 0, -5), ...S(16, 'set_dt0_pp1.png'),
      '--eval-at', `24:({run:Module.__omwRunning, err:GLctx.getError()})`,
    ],
    checks: [['running', l => /eval @24s.*"run":1/.test(l)], ['noShaderFail', l => !/FAILED|No precision/i.test(l)]],
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
    '--start-when', RUN, ...s.args, '--console-out', logPath], { encoding: 'utf8', timeout: (s.secs + 60) * 1000 });
  if (r.stdout) process.stdout.write(r.stdout.split('\n').slice(-2).join('\n') + '\n');
  const logtxt = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const errs = ERR.filter(([, re]) => re.test(logtxt)).map(([n]) => n);
  const checks = (s.checks || []).map(([n, fn]) => [n, !!fn(logtxt)]);
  results.push({ name: s.name, errs, checks, empty: logtxt.length === 0 });
}
process.stdout.write('\n\n================ QA MATRIX ================\n');
for (const r of results) {
  const cs = r.checks.map(([n, ok]) => `${ok ? '✓' : '✗'}${n}`).join(' ');
  const es = r.errs.length ? `  ERR:${r.errs.join(',')}` : '';
  const st = r.empty ? 'NO-LOG' : (r.checks.every(([, ok]) => ok) && !r.errs.length ? 'PASS' : 'ATTN');
  process.stdout.write(`${st.padEnd(7)} ${r.name.padEnd(16)} ${cs}${es}\n`);
}
process.stdout.write(`\nshots+logs: ${OUT}/\n`);
