// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s158: A LOCK A SCRIPT SETS TRAVELS. Quest scripts Lock and Unlock doors with nobody touching
// them (a gate opening when the quest advances, a vault sealing behind you), and the only
// lock watcher armed on ACTIVATION for four seconds -- a scripted change with no activation
// was never seen, so the friend beside you found the door still locked (or still open). The
// cell poll now carries lock state like it carries enable state. The hook changes the object
// with nothing sent, exactly as MWScript does; the poll has to notice, at 1 Hz.
import assert from 'node:assert/strict';

const STEP = 15_000;

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a'), ctx.launchClient('bot-b')]);
  await a.waitFor('window.omw.state.doorLocked === "false"', STEP, 'door mirror live on A');
  await b.waitFor('window.omw.state.doorLocked === "false"', STEP, 'door mirror live on B');
  await ctx.sleep(1_500); // the poll's first sighting is the baseline, never reported

  await a.cmd('door:scriptlock:40'); // no ObjectLock sent by the hook
  await a.waitFor('window.omw.state.doorLocked === "true"', STEP, 'the script locked it on A');
  const t0 = Date.now();
  await b.waitFor('window.omw.state.doorLocked === "true"', STEP, 'B sees the scripted lock (the cell poll carried it)');
  ctx.log(`scripted lock reached B in ~${Date.now() - t0} ms`);

  await b.cmd('door:scriptunlock');
  await b.waitFor('window.omw.state.doorLocked === "false"', STEP, 'the script unlocked it on B');
  await a.waitFor('window.omw.state.doorLocked === "false"', STEP, 'A sees the scripted unlock');

  // No ping-pong: the state settles and stays.
  await ctx.sleep(3_000);
  assert.equal(await a.eval('window.omw.state.doorLocked'), 'false', 'A flipped back');
  assert.equal(await b.eval('window.omw.state.doorLocked'), 'false', 'B flipped back');
  ctx.log('PASS: a scripted lock and unlock reach the other screen and stay put');
}
