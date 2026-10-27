// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s158: A PLAYER'S SCRIPTED RELOCK STAYS ON THAT PLAYER'S SCREEN (H3). The cell poll reports a
// lock a script sets with nobody touching the door, but a relock of world content is the sim
// peer's to make: a player's client could seal any door in the world, persisted. The server
// refuses it, so B's door stays open to B, and nothing ping-pongs when A's script unlocks again.
// The hook changes the object with nothing sent, exactly as MWScript does.
import assert from 'node:assert/strict';

const STEP = 15_000;

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a'), ctx.launchClient('bot-b')]);
  await a.waitFor('window.omw.state.doorLocked === "false"', STEP, 'door mirror live on A');
  await b.waitFor('window.omw.state.doorLocked === "false"', STEP, 'door mirror live on B');
  await ctx.sleep(1_500); // the poll's first sighting is the baseline, never reported

  await a.cmd('door:scriptlock:40'); // no ObjectLock sent by the hook; the poll sends it
  await a.waitFor('window.omw.state.doorLocked === "true"', STEP, 'the script locked it on A');
  await ctx.sleep(3_000); // three poll ticks: long enough for the relay that must not happen
  assert.equal(await b.eval('window.omw.state.doorLocked'), 'false', "A's scripted relock of world content reached B");

  await a.cmd('door:scriptunlock');
  await a.waitFor('window.omw.state.doorLocked === "false"', STEP, 'the script unlocked it on A');

  // No ping-pong: the state settles and stays.
  await ctx.sleep(3_000);
  assert.equal(await a.eval('window.omw.state.doorLocked'), 'false', 'A flipped back');
  assert.equal(await b.eval('window.omw.state.doorLocked'), 'false', 'B flipped');
  ctx.log('PASS: a player scripted relock stays local; the unlock settles on both');
}
