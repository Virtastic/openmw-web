// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s126: THE GUARD CATCHES YOU. s78 proves a guard the peer simulates pursues a wanted avatar.
// This is what happens when it gets there: on the peer a guard reaching an avatar cannot open
// a dialogue nobody is there to see, so the engine records the reach (mwmp/puppets.hpp
// recordArrest), the peer hands it to the server (PlayerArrest), and the owner's client opens
// the dialogue with ITS copy of that guard -- vanilla's own greeting does the rest (pay the
// fine, go to jail, resist). The wanted player stands still so the guard can reach them.
import assert from 'node:assert/strict';

export const serverRules = `
[content]
enforce = "off"
`;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const STEP = 30_000;
const BOUNTY = 6_000;
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export default async function run(ctx) {
  const peer = ctx.startSimPeer('-2,-9');
  if (!peer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset)'); return; }
  const a = await ctx.launchClient('crook', '', BOOT);
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, 'the peer holds the cell');
  const me = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
  const probe = await probeOf(a);
  const guards = Object.keys(probe).filter((r) => probe[r].guard && !probe[r].dead)
    .sort((x, y) => dist(me, probe[x]) - dist(me, probe[y]));
  assert.ok(guards.length, 'no living guard in this cell');
  const g = probe[guards[0]];
  // Stand in the guard's face: the arrest needs the guard to REACH us, and pathing across the
  // village is s78's business, not this scenario's.
  await a.cmd(`snapto:${Math.round(g.x + 120)},${Math.round(g.y)},${Math.round(g.z + 8)}`);
  await ctx.sleep(4_000);
  ctx.log(`standing beside ${guards[0]}; uiMode=${await a.eval('window.omw.state.uiMode')}`);
  await a.cmd(`bounty:${BOUNTY}`);

  await a.waitFor('String(window.omw.state.uiMode||"") === "Dialogue"', 180_000,
    'the arrest dialogue opened on the wanted player\'s client (PlayerArrest -> MP_OpenDialogue)');
  ctx.log(`ok: ${guards[0]} caught the player and the arrest dialogue opened (bounty ${await a.eval('window.omw.state.bounty')})`);
}
