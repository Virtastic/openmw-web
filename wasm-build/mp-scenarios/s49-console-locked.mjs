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

  await a.eval("Module.__omwMPCmd='console:request'");
  await ctx.sleep(1500);

  const open = String(await a.eval("(window.__omwMP||{}).consoleOpen"));
  ctx.log(`  console open after request (MP enabled): ${open}`);
  assert.equal(open, 'false',
    'the console must NOT open in multiplayer — it is a complete cheat suite '
    + '(coc/additem/setstat)');

  ctx.log(`  screenshot: ${await a.screenshot(join(SHOTS, '1-console-refused.png'))}`);
  ctx.log(`UI screenshot written to ${SHOTS} — the refusal notice should be visible`);
}
