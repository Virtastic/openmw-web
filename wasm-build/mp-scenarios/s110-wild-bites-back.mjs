// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s110: THE CREATURE BITES BACK. s109 proves two players can kill a wild creature; this is
// the other half of every fight in the game: the creature's blows land on the PLAYER. Nothing
// on the player's own screen can do that -- the creature there is a puppet with its AI off.
// The peer's creature attacks the player's avatar, the avatar's bars ride AvatarStatsBatch
// back to the server, and the owner receives SelfStats (player.lua mirrors it as selfStats).
// If that chain is broken a player is invulnerable to the whole wilderness, which is exactly
// as game-breaking as the s109 ghost was, in the other direction.
//
// s66 covers the same bars for PvP at the unit tier only; this is the product path, live: no
// hit injection on the victim at all, just a provoked creature and an avatar standing in
// reach of it.
import assert from 'node:assert/strict';

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPOT = '-12500,-53100,512'; // inside -2,-7 (see s109)

const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));
const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-7');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('window.omw.state.state === "Joined"', 60_000, 'A joined');
  await a.cmd('snapto:' + SPOT);
  await a.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'A built a named creature');
  // The snap must have LANDED before the probe means anything: the probe is the player's own
  // cell, and a snap sent a beat too early left A in Seyda Neen reading the peer's -2,-7 names.
  await a.waitFor('(function(){const n=Object.values(JSON.parse(window.omw.state.netObjects||"{}"));const p=JSON.parse(window.omw.state.actorProbe||"{}");return n.some((r)=>p[r]&&!p[r].dead);})()',
    60_000, 'A stands in the cell with a living named creature');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 30_000, 'A puppeted the cell actors');

  // Stand next to the creature: a bite has a reach, and the avatar follow-teleports with us.
  const names = Object.values(await netObjs(a));
  const probe = await probeOf(a);
  const victim = names.find((r) => probe[r] && !probe[r].dead);
  assert.ok(victim, `no living named creature in the probe: net=${JSON.stringify(names)} probe=${JSON.stringify(Object.keys(probe))}`);
  const p = probe[victim];
  await a.cmd(`snapto:${Math.round(p.x + 60)},${Math.round(p.y)},${Math.round(p.z + 8)}`);
  await ctx.sleep(3_000);
  ctx.log(`A stands beside the peer's "${victim}" at (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`);

  // Provoke it once (a scrib will not start a fight on its own) and wait for the bars the
  // PEER reports to drop below full. selfStats only ever moves on the peer path.
  const before = parseBars(await a.eval('window.omw.state.selfStats'));
  ctx.log(`selfStats before=${before ? before.c + '/' + before.b : 'none'}`);
  const deadline = Date.now() + 120_000;
  let bars = null, dropped = false, pokes = 0;
  while (Date.now() < deadline && !dropped) {
    if (pokes < 3) { await a.cmd(`hitn:${victim}:1`); pokes++; }
    await ctx.sleep(2_000);
    bars = parseBars(await a.eval('window.omw.state.selfStats'));
    dropped = !!bars && bars.c < bars.b;
  }
  ctx.log(`selfStats after=${bars ? bars.c + '/' + bars.b : 'none'} hitFwd=${await a.eval('window.omw.state.hitFwd')} probe=${JSON.stringify((await probeOf(a))[victim])}`);
  assert.ok(dropped, `the player's peer-reported health never dropped while standing in reach of a provoked "${victim}": `
    + 'either the peer creature does not attack avatars, or its damage never reached the owner as SelfStats');
  ctx.log(`ok: the peer's ${victim} hurt the player and the owner's bars followed (${bars.c}/${bars.b})`);
}
