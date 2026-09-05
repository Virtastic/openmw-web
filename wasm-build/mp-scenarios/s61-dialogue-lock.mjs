// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s61 (M6): one player at a time may converse with an NPC (PROTOCOL.md §M6 DialogueLock).
//   1. A activates a cell NPC through the ENGINE activation pipeline; the client blocks the
//      dialogue window until the server grants the lock, then re-runs the activation.
//   2. B activates the SAME NPC -> denied, and the notice names the holder (by roster name,
//      not just a bare id).
//   3. A disconnects -> the server drops A's locks -> B's next attempt is granted.
//
// RETAIL DATA REQUIRED: the clean Example Suite ships no NPCs at all.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP_TIMEOUT = 20_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

const lockOf = async (c) => {
  const raw = await c.eval('window.omw.state.dialogueLock');
  return raw ? JSON.parse(raw) : null;
};
const npcsOf = async (c) => JSON.parse(await c.eval('window.omw.state.cellNpcs||"[]"'));

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for NPCs)');
    return;
  }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  const b = await ctx.launchClient('bot-b', '', BOOT);
  const nameA = `bot-a-${ctx.runId}`;

  // Pick an NPC both clients have in their own cell (the mirror is sorted, so the choice
  // is deterministic on both sides).
  await a.waitFor('JSON.parse(window.omw.state.cellNpcs||"[]").length > 0', STEP_TIMEOUT, 'A sees cell NPCs');
  await b.waitFor('JSON.parse(window.omw.state.cellNpcs||"[]").length > 0', STEP_TIMEOUT, 'B sees cell NPCs');
  const [na, nb] = await Promise.all([npcsOf(a), npcsOf(b)]);
  const shared = na.filter((r) => nb.includes(r));
  ctx.log(`A sees ${na.length} NPC records, B ${nb.length}, shared ${shared.length}`);
  assert.ok(shared.length > 0, 'no NPC record is present in both clients\' cells');
  const npc = shared[0];
  ctx.log(`locking "${npc}"`);

  // A acquires.
  await a.eval(`window.omw.send('dlg:${npc}')`);
  await a.waitFor('JSON.parse(window.omw.state.dialogueLock||"{}").granted === true',
    STEP_TIMEOUT, 'A granted the dialogue lock');
  ctx.log('ok: A holds the lock');

  // B is denied, and learns WHO holds it.
  await b.eval(`window.omw.send('dlg:${npc}')`);
  await b.waitFor('(window.omw.state.dialogueLock||"") !== ""', STEP_TIMEOUT, 'B got a lock result');
  const denied = await lockOf(b);
  ctx.log(`B result: ${JSON.stringify(denied)}`);
  assert.equal(denied.granted, false, 'B must be denied while A holds the lock');
  assert.equal(denied.ref, npc, 'the denial must name the NPC B asked for');
  // Mechanism, not symptom: the holder is identified, and identified as A specifically.
  assert.equal(denied.holder, nameA, `denial must name the holder (${nameA}), got ${denied.holder}`);
  assert.ok(denied.holderId, 'denial must carry the holder id');
  ctx.log(`ok: B blocked, holder reported as "${denied.holder}"`);

  // A leaves -> the server releases every lock A held.
  a.close();
  await ctx.sleep(4000);
  await b.eval(`window.omw.send('dlg:${npc}')`);
  await b.waitFor('JSON.parse(window.omw.state.dialogueLock||"{}").granted === true',
    STEP_TIMEOUT, 'B acquires the lock after A disconnects');
  ctx.log('ok: lock released on disconnect and re-acquired by B');
}
