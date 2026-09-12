// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s124: "I'LL MEET YOU THERE" -- A DIALOGUE SENDS AN NPC WALKING. "AITravel x y z" on
// Goodbye is how Morrowind moves quest NPCs: the guide leaves for the shrine, the informant
// heads for the docks. It runs on the talking player's client (AI off there), so
// companion.lua reports the Travel package, the claim is admitted from the player who holds
// the NPC's dialogue lock, and the holder walks its NPC. Everyone else must see the NPC go.
import assert from 'node:assert/strict';

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const DEST = { x: -12288, y: -69632, z: 87 };

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  for (const c of [a, b]) await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, `${c.name} puppeted the cell actors`);
  const [pa, pb] = await Promise.all([probeOf(a), probeOf(b)]);
  const rec = Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard
    && !/mudcrab|scrib|rat|slaughterfish|kwama|cliff/.test(r) && dist2(pa[r], DEST) > 800);
  assert.ok(rec, 'need a living NPC visible to both, standing away from the spawn');
  const start = pa[rec];
  await a.cmd(`snapto:${Math.round(start.x + 80)},${Math.round(start.y)},${Math.round(start.z + 8)}`);
  await ctx.sleep(3_000);

  // The conversation: the lock is what admits the travel claim. The dialogue result lands
  // while it is held; Goodbye releases it (dlg:release) -- and companion.lua only polls once
  // the game is unpaused, so the claim goes out right after, inside the server's grace.
  await a.cmd(`dlg:${rec}`);
  await ctx.sleep(1_500);
  await a.cmd(`travel:${rec}:${DEST.x},${DEST.y},${DEST.z}`);
  await a.cmd('dlg:release');
  await ctx.sleep(3_000);
  ctx.log(`A sent "${rec}" walking to the spawn (${Math.round(dist2(start, DEST))} units); report=${await a.eval('window.omw.state.companionReport')}`);

  const deadline = Date.now() + 120_000;
  let dB = Infinity, dA = Infinity;
  while (Date.now() < deadline) {
    const [qa, qb] = await Promise.all([probeOf(a), probeOf(b)]);
    if (qa[rec]) dA = dist2(qa[rec], DEST);
    if (qb[rec]) dB = dist2(qb[rec], DEST);
    if (dB < 400 && dA < 400) break;
    await ctx.sleep(2_000);
  }
  ctx.log(`NPC distance to the destination: on A ${Math.round(dA)}, on B ${Math.round(dB)}`);
  assert.ok(dB < 400 && dA < 400, `"${rec}" never arrived (A ${Math.round(dA)}, B ${Math.round(dB)}): the travel claim was refused or the holder did not start the package`);
  ctx.log(`ok: "${rec}" walked to where the dialogue sent it, on both screens`);
}
