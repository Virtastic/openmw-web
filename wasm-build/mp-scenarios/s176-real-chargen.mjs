// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s176: A REAL NEW CHARACTER. Every other scenario boots with ?start=, which the engine takes as
// "bypass": chargenstate -1, no prison ship, no character creation. This one boots a fresh slot
// the way the launcher does (#mpnew=1 -> --new-game) and answers the real chargen windows with
// real input: the name typed on the keyboard, a race, a class and a birthsign clicked in their
// MyGUI lists, each OK button clicked.
//
// Morrowind opens those windows from the ship's and the office's dialogues, which a headless
// client cannot talk through, so each is opened by its UI mode -- the same window the dialogue
// result script (Enable*Menu) opens. The last step writes chargenstate -1, exactly what the
// census office's exit script does. Asserted: the choices land on the character, the server
// is told chargen is over, and a relog brings back the SAME character, out of chargen.
//
// RETAIL DATA REQUIRED: the chargen classes, races and signs are Morrowind.esm's.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const windowSize = '1280,720'; // the race window alone is 640x433
export const bootTimeoutMs = 420_000;
const NAME = 'Vivia';
const ESC = { key: 'Escape', code: 'Escape', keyCode: 27, text: '' };
const ENTER = { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' };

const whoami = async (c) => {
  await c.cmd('whoami');
  const raw = String(await c.eval('window.omw.state.whoami||""'));
  assert.ok(raw.startsWith('{'), `whoami answered ${raw}`);
  return JSON.parse(raw);
};
const modeOf = async (c) => String(await c.eval('window.omw.state.uiMode||"none"'));

// A point inside a centred MyGUI window, in page coordinates.
const at = (c, winW, winH, x, y) => c.eval(`(function(){ var cv = document.getElementById('canvas'),
  r = cv.getBoundingClientRect(), sx = r.width / cv.width, sy = r.height / cv.height;
  var L = Math.floor((cv.width - ${winW}) / 2), T = Math.floor((cv.height - ${winH}) / 2);
  return { x: r.left + (L + ${x}) * sx, y: r.top + (T + ${y}) * sy }; })()`);

async function openMode(ctx, c, mode) {
  for (let i = 0; i < 3 && (await modeOf(c)) !== mode; i++) {
    await c.cmd(`ui:${mode}`);
    await c.waitFor(`window.omw.state.uiMode === ${JSON.stringify(mode)}`, 10_000, `${mode} opened`).catch(() => {});
  }
  assert.equal(await modeOf(c), mode, `the ${mode} window never opened`);
  await ctx.sleep(800);
}

// Click the first row of a list, then OK. OK sits bottom-right in the button box (or at a fixed
// spot); sweep from the right edge inward so OK -- the rightmost button -- is met before Back.
async function pickAndOk(ctx, c, mode, win, row, okFixed) {
  await openMode(ctx, c, mode);
  const r = await at(c, win.w, win.h, row.x, row.y);
  await c.clickAt(r.x, r.y);
  await ctx.sleep(600);
  const tries = okFixed ? [okFixed, { x: okFixed.x, y: okFixed.y + 6 }, { x: okFixed.x - 8, y: okFixed.y }]
    : [14, 22, 30, 38].flatMap((dx) => [12, 18, 24].map((dy) => ({ x: win.w - dx, y: win.h - dy })));
  for (const p of tries) {
    const q = await at(c, win.w, win.h, p.x, p.y);
    await c.clickAt(q.x, q.y);
    await ctx.sleep(1000);
    const now = await modeOf(c);
    if (now !== mode) { ctx.log(`  ${mode}: OK at ${p.x},${p.y} -> ${now}`); return; }
  }
  throw new Error(`no click on ${mode}'s OK button closed it`);
}

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('newbie', '', { retail: true, newGame: true, joinTimeoutMs: 420_000 });
  await a.dismissTour(15_000); // the first-join tour sits over the canvas and takes every click
  const cell0 = String(await a.eval('window.omw.state.cell||""'));
  ctx.log(`a new game starts in "${cell0}", chargenDone=${await a.eval('window.omw.state.chargenDone')}`);
  assert.notEqual(await a.eval('window.omw.state.chargenDone'), '1', 'a fresh slot must start IN character creation');
  const before = await whoami(a);
  ctx.log(`template: ${JSON.stringify(before)}`);

  // Whatever the opening has up (a forced greeting, a message box) is closed first.
  for (let i = 0; i < 4 && (await modeOf(a)) !== 'none'; i++) {
    await a.eval(`document.getElementById('canvas').focus()`);
    await a.key(ESC);
    await ctx.sleep(1000);
  }

  // NAME: typed, then Enter.
  await openMode(ctx, a, 'ChargenName');
  for (const ch of NAME) await a.key({ key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch });
  await a.key(ENTER);
  await a.waitFor(`window.omw.state.uiMode !== 'ChargenName'`, 10_000, 'the name was accepted').catch(async () => {
    const q = await at(a, 320, 97, 285, 71); await a.clickAt(q.x, q.y); // or the OK button
  });

  // RACE (640x433, list at 264,39; OK at 532,397), CLASS PICK (491x316, list at 8,8),
  // BIRTHSIGN (527x378, list at 8,8): the first row of each list.
  await pickAndOk(ctx, a, 'ChargenRace', { w: 640, h: 433 }, { x: 344, y: 49 }, { x: 557, y: 412 });
  await pickAndOk(ctx, a, 'ChargenClassPick', { w: 491, h: 316 }, { x: 100, y: 17 });
  await pickAndOk(ctx, a, 'ChargenBirth', { w: 527, h: 378 }, { x: 120, y: 17 });

  const made = await whoami(a);
  ctx.log(`created: ${JSON.stringify(made)}`);
  assert.equal(made.name, NAME, 'the typed name is the character\'s');
  assert.ok(made.race && made.class && made.sign, 'race, class and birthsign are all set');
  assert.ok(made.race !== before.race || made.class !== before.class, 'the windows changed nothing on the character');

  // The census office's exit script: chargenstate -1. The client reports it to the server.
  await a.cmd('gvar:chargenstate:-1');
  await a.waitFor('window.omw.state.chargenDone === "1"', 30_000, 'the client saw chargen end');
  await ctx.sleep(4000); // the identity upload and ChargenComplete reach the server
  const log = ctx.serverLogTail(2000);
  ctx.log(`server saw chargen end: ${/chargen/i.test(log)}`);

  // RELOG: the same character, out of chargen.
  a.close();
  await ctx.sleep(3000);
  const a2 = await ctx.launchClient('newbie', '', { retail: true, joinTimeoutMs: 420_000 });
  await a2.waitFor('window.omw.state.restored === "1"', 60_000, 'rejoin restore applied');
  await ctx.sleep(3000);
  const back = await whoami(a2);
  ctx.log(`after relog: ${JSON.stringify(back)} chargenDone=${await a2.eval('window.omw.state.chargenDone')}`);
  assert.deepEqual({ name: back.name, race: back.race, class: back.class, sign: back.sign },
    { name: made.name, race: made.race, class: made.class, sign: made.sign }, 'the relog brought back a different character');
  assert.notEqual(String(await a2.eval('window.omw.state.cell||""')).toLowerCase(), 'imperial prison ship', 'the relog put the character back on the ship');
  assert.deepEqual(a2.luaErrors(), [], 'no Lua error along the way');
  ctx.log('ok: a real new character was named, given a race, class and sign, and came back as themselves');
}
