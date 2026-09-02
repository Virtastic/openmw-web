// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s68 (Phase 5): NO CLIENT SAVE OR LOAD IN MULTIPLAYER.
//
// Every MP session's save is the server's (the PlayerDoc), Solo included: Solo is a private
// world on the server, not local play. The engine refuses at the chokepoint --
// StateManager::saveGame / loadGame when MWMP::NetManager is Joined -- which covers the
// menu, quicksave (F5), autosave, the wait dialog and the console in one predicate; the
// main menu omits Save/Load/New Game while joined; and the page marks saves disabled so the
// locker never offers an .omwsave upload for an MP session.
//
// Provable without introspecting MyGUI: press F5 while joined and assert (a) the ENGINE saw
// the key -- player.lua's onKeyPress mirrors every key it receives as `lastKey`, so the
// assertion is not vacuous -- and (b) no .omwsave appeared in the wasm FS saves directory
// (the page's own __SAVES_DIR), plus (c) the page reports saves disabled.
import assert from 'node:assert/strict';

const STEP = 20_000;
const F5 = { key: 'F5', code: 'F5', keyCode: 116, text: '' };
const SAVES_DIR = '/userdata/data-home/openmw/saves';

export default async function run(ctx) {
  const a = await ctx.launchClient('saver', '');
  await a.waitFor("(window.__omwMP||{}).state === 'Joined'", STEP, 'joined');

  // Baseline: whatever is in the saves dir before we try (normally nothing).
  const list = async () => JSON.parse(await a.eval(
    `JSON.stringify((function(){ try { return FS.readdir(${JSON.stringify(SAVES_DIR)})`
    + `.filter(function(n){ return /\\.omwsave$/i.test(n); }); } catch (e) { return []; } })())`));
  const before = await list();
  ctx.log(`  saves before F5: ${JSON.stringify(before)}`);

  // Focus the game (as a player does) and press quicksave.
  await a.click('#canvas');
  await ctx.sleep(300);
  const keyBefore = String(await a.eval('(window.__omwMP||{}).lastKey'));
  await a.key(F5);
  // (a) the engine received the key at all.
  await a.waitFor(`String((window.__omwMP||{}).lastKey) !== ${JSON.stringify(keyBefore)}`, STEP,
    'the engine received the F5 keypress (lastKey mirror moved)');
  ctx.log(`  engine saw key: lastKey=${await a.eval('(window.__omwMP||{}).lastKey')}`);

  // (b) give a would-be quicksave ample time to hit the FS, then assert nothing did.
  await ctx.sleep(4_000);
  const after = await list();
  ctx.log(`  saves after F5: ${JSON.stringify(after)}`);
  assert.deepEqual(after, before,
    'quicksave must be refused while joined -- an .omwsave appeared: ' + JSON.stringify(after));
  // (c) the page side, last: no locker save path for an MP session.
  const savesEnabled = await a.eval('window.__omwSavesEnabled');
  ctx.log(`  page __omwSavesEnabled=${savesEnabled}`);
  assert.equal(savesEnabled, false, 'the page must mark saves disabled while MP is enabled');
  ctx.log('ok: F5 reached the engine and produced no save; the page reports saves disabled');
}
