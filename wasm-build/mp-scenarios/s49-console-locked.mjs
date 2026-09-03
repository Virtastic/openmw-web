// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s49: the in-game console must not open in multiplayer.
//
// The console is a complete cheat suite — `coc` teleports anywhere, `player->additem` spawns
// anything, `setstat`/`tgm` rewrite the character. It dwarfs every URL flag combined, and
// play/index.html deliberately lets backtick through to the engine so it opens as normal in
// single player.
//
// Asserts the ENGINE's own console state (mp.isConsoleOpen -> WindowManager::isConsoleMode),
// not merely that a window looks absent in a screenshot, and drives it through the same
// executeAction(A_Console) path the keybind uses — so this exercises the real guard rather
// than a copy of it.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STEP = 30_000;

export default async function run(ctx) {
  const SHOTS = mkdtempSync(join(tmpdir(), 'omw-s49-'));
  const a = await ctx.launchClient('bot-a', '');
  await a.waitFor("(window.__omwMP||{}).state === 'Joined'", STEP, 'client joins');

  // Channel probe first: 'count:' writes its own mirror, so a dead command poll and a
  // broken console handler stop looking identical (both used to read as undefined).
  await a.eval("Module.__omwMPCmd='count:gold_001'");
  await ctx.sleep(1000);
  ctx.log('  cmd-channel probe (count mirror): ' + String(await a.eval("(window.__omwMP||{}).count")));

  await a.eval("Module.__omwMPCmd='console:request'");
  // WAIT FOR THE GATE TO REPORT, do not sleep a guess. The handler always writes this mirror
  // (both halves are pcall'd), so `undefined` means it has not run YET -- and a fixed 1500 ms
  // lands right on the boundary of when it does on a slow box. That produced a FAILING SECURITY
  // ASSERTION whose message read "the console must NOT open", when the console was in fact
  // shut: measured directly, the mirror says false, it just says it a moment later than the
  // sleep allowed. A security test that cries wolf on a slow machine gets muted, so this waits
  // for an actual answer and then judges it.
  await a.waitFor('(window.__omwMP||{}).consoleOpen !== undefined', STEP,
    'the console gate to report its state (mirror still unwritten)');

  const open = String(await a.eval("(window.__omwMP||{}).consoleOpen"));
  ctx.log(`  console open after request (MP enabled): ${open}`);
  assert.equal(open, 'false',
    'the console must NOT open in multiplayer — it is a complete cheat suite '
    + '(coc/additem/setstat)');

  ctx.log(`  screenshot: ${await a.screenshot(join(SHOTS, '1-console-refused.png'))}`);
  ctx.log(`UI screenshot written to ${SHOTS} — the refusal notice should be visible`);
}
