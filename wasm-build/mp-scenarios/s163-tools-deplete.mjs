// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s163: A LOCKPICK WEARS OUT (backlog 233). Lockpick/probe/repair uses and torch burn happen
// on the client only -- the avatar on the peer never picks a lock -- so the raise-only rule
// refused the client's drop and the avatar's untouched copy refilled it on every report
// (free lockpicks, infinite torches). The client tags those records `own`; the server takes
// their condition wholesale and keeps it under the peer's report. A spends a pick down to 10
// uses, waits out a full peer refresh, and still holds a pick at 10.
import assert from 'node:assert/strict';

const BOOT = { retail: true, joinTimeoutMs: 420_000 }; // pick_apprentice is retail content
const ITEM = 'pick_apprentice_01'; // Morrowind.esm's LOCK ids: pick_apprentice_01, pick_journeyman_01, pick_master, pick_grandmaster, pick_secretmaster (#105: 'pick_apprentice' does not exist, give: created nothing)
const LEFT = 10;
// The avatar carries the pick after the 2 s inventory diff; the peer reports its states every
// 2 s and refreshes them wholesale every 10 s -- 12 s covers a full refill window either way
// (avatarApplied is a peer-side flag the browser cannot read).
const SETTLE = 12_000;
// tostring() of the engine's number: a pick at 10 reads "10.0/nil/nil", so the old
// startsWith('10/') was false for exactly the value it asked for (#106; s160 the same).
const condOf = (s) => Number(String(s).split('/')[0]);
async function stateOf(c, id) {
  await c.eval("if (window.omw.state) window.omw.state.itemState = null; 'cleared';");
  await c.cmd(`itemstate:${id}`);
  await c.waitFor("typeof window.omw.state.itemState === 'string'", 10_000, `${id} state answered`);
  return String(await c.eval('window.omw.state.itemState'));
}

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.cmd(`give:${ITEM}`);
  await ctx.sleep(SETTLE);
  const fresh = await stateOf(a, ITEM);
  ctx.log(`A's pick as given: ${fresh}`);
  assert.notEqual(fresh, 'none', 'A never received the pick');

  await a.cmd(`setcond:${ITEM}:${LEFT}`);
  const spent = await stateOf(a, ITEM);
  ctx.log(`A's pick after use: ${spent}`);
  assert.equal(condOf(spent), LEFT, `the use did not take on A (${spent})`);

  await ctx.sleep(SETTLE);
  const later = await stateOf(a, ITEM);
  ctx.log(`A's pick after a full peer refresh: ${later}`);
  assert.equal(condOf(later), LEFT, `the avatar's untouched copy refilled the pick (${later} after ${spent})`);
  ctx.log('PASS: a lockpick spent on the client stays spent under the peer');
}
