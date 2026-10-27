// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s32 (M3): rotating doors + locks over CONTENT refs (the demo Village's WhiteFortDoor*
// instances — this exercises the RefNum ref path end to end: GObject -> LSER 'o' ->
// server refKey -> relayed 'o' -> GObject on the peer).
// A toggles the nearest door -> B sees it open; A's relock is refused (H3); B's unlock relays.
import assert from 'node:assert/strict';

const STEP_TIMEOUT = 30_000; // 30, not 15: both clients were at 2.2 s a frame with the engine stalled when B's own unlock missed 15 s (#136); the suite's usual step

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a'),
    ctx.launchClient('bot-b'),
  ]);
  // Both spawn at the same point, so "nearest door" resolves to the SAME content ref.
  await a.waitFor('window.omw.state.doorOpen === "false"', STEP_TIMEOUT, 'door mirror live on A');
  await b.waitFor('window.omw.state.doorOpen === "false"', STEP_TIMEOUT, 'door mirror live on B');

  // Open.
  await a.eval(`window.omw.send('door:toggle')`);
  await a.waitFor('window.omw.state.doorOpen === "true"', STEP_TIMEOUT, 'door opens locally on A');
  const t0 = Date.now();
  await b.waitFor('window.omw.state.doorOpen === "true"', STEP_TIMEOUT, 'door opens on B (relay)');
  ctx.log(`ok: door open relayed in ~${Date.now() - t0}ms`);

  // H3: a player's relock of world content is refused -- the peer relocks, a player only
  // unlocks. A's lock stays on A's screen; B's door never locks.
  await a.eval(`window.omw.send('door:lock:50')`);
  await a.waitFor('window.omw.state.doorLocked === "true"', STEP_TIMEOUT, 'door locked on A');
  await ctx.sleep(3_000);
  assert.equal(await b.eval('window.omw.state.doorLocked'), 'false', "A's relock of a content door reached B");

  // Unlock is a lockpick or a key: anyone's, and it relays (it also puts A back in step).
  await b.eval(`window.omw.send('door:unlock')`);
  await b.waitFor('window.omw.state.doorLocked === "false"', STEP_TIMEOUT, 'door unlocked on B');
  await a.waitFor('window.omw.state.doorLocked === "false"', STEP_TIMEOUT, 'unlock relayed to A');
  ctx.log('ok: a player relock stays local, the unlock relays');
}
