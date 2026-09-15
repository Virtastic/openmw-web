// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s148: LEVITATE AND LIGHT A TORCH -- two things a player does to their own body that the
// other screen must respect. Levitation is the sharpest test of the effect mirror: the peer
// rules the body, and if the avatar is not levitating too, reconciliation drags the floating
// player back to the ground every frame (the Sep-11 fix, never proven live). A torch is the
// simplest equipment change: a friend's puppet must be holding it.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
// Both boot at the retail start (Seyda Neen, -2,-9): dry land. The s109 spot's ground is the
// sea (z=-133), no place to prove a float.
const TORCH = 'light_torch_01'; // retail light id
const CARRIED_LEFT = 17; // MWWorld::InventoryStore::Slot_CarriedLeft

const pose = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));
// Climb on levitation: look steeply up (the face hook sets yaw and pitch toward a point),
// then walk forward for `ms`; a flying body moves along its view direction.
async function climbUp(c, ctx, ms) {
  const p = await pose(c);
  await c.cmd(`face:${p.x},${p.y + 60},${p.z + 100 + 2000}`);
  await ctx.sleep(600);
  await c.cmd(`walk:0,1,${ms}:run`);
}
// The player's own cast path with a minted spell: one effect, cheap, always lands. Learned
// and selected by the engine, then the spell stance and the use key on THIS engine -- a real
// cast is what the effect mirror forwards to the avatar. Returns the spell id.
async function castSelf(c, ctx, effect, magnitude, seconds) {
  await c.eval("if (window.omw.state) { window.omw.state.mintedSpell = null; window.omw.state.actives = null; } 'cleared';");
  await c.cmd(`mintspell:${effect}:${magnitude}:${seconds}`);
  await c.waitFor("typeof window.omw.state.mintedSpell === 'string'", 10_000, 'the spell was minted and selected');
  const id = await c.eval('window.omw.state.mintedSpell');
  // Registered with the server (netRecords maps net id -> local id): the avatar can only
  // receive an effect whose spell it can name.
  await c.waitFor(`Object.values(JSON.parse(window.omw.state.netRecords||"{}")).includes(${JSON.stringify(id)})`, 20_000, 'the minted spell is registered with the server');
  // A fresh character fizzles most self-spells (chance ~ 2 x Alteration + a little - cost);
  // a fizzle is the spell system working, not the thing under test. Within the server's
  // legal base step so the avatar's copy agrees.
  await c.cmd('setskill:alteration:65');
  await c.cmd('setmp:300');
  await c.cmd('stance:spell');
  await ctx.sleep(700);
  await c.cmd('press:500'); // the use key on THIS engine: the cast
  await ctx.sleep(1_800);
  let actives = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    await c.eval("if (window.omw.state) window.omw.state.actives = null; 'cleared';");
    await c.cmd('actives');
    await c.waitFor("typeof window.omw.state.actives === 'string'", 10_000, 'actives answered');
    actives = await c.eval('window.omw.state.actives');
    if (String(actives).split(',').includes(id)) break;
    ctx.log(`cast ${id} did not take yet (actives [${actives}]); pressing again`);
    await c.cmd('press:500');
    await ctx.sleep(1_800);
  }
  ctx.log(`cast ${id}: active spells now [${actives}]`);
  if (!String(actives).split(',').includes(id)) throw new Error(`the cast of ${id} did not take (actives: ${actives})`);
  return id;
}

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, 'the character is settled (the join-time restore is done)');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the cell is peer-held');
  const idA = await a.eval('window.omw.state.playerId');
  const rowOf = `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(String(idA))}]||{})`;
  await b.waitFor(`${rowOf}.x !== undefined`, STEP, 'B has a puppet of A');
  await ctx.sleep(4_000);
  const ground = (await pose(a)).z;
  ctx.log(`A on the ground at z=${ground.toFixed(0)}`);
  assert.ok(ground > 0, `A is under sea level (z=${ground.toFixed(0)})`);

  // LEVITATE, then climb (jump held) for six seconds.
  await castSelf(a, ctx, 'levitate', 20, 60); // 20 pts: a gentle ~65 units/s climb, long enough to hold
  // A levitating body moves where it LOOKS (movementsolver: velocity = pitch x yaw x
  // movement); jump is zeroed while flying. Look steeply up, walk forward.
  await climbUp(a, ctx, 6000);
  for (let i = 0; i < 6; i++) { await ctx.sleep(1000); await a.eval("if (window.omw.state) window.omw.state.body = null; 'c';"); await a.cmd('body'); await a.waitFor("typeof window.omw.state.body === 'string'", 5000, 'body'); ctx.log(`climb t+${i + 1}s: ${await a.eval('window.omw.state.body')} div=${await a.eval('window.omw.state.selfDivergence')}`); }
  await a.waitFor(`JSON.parse(window.omw.state.pose||"{}").z > ${ground + 150}`, 5_000, 'A is climbing');
  const high = (await pose(a)).z;
  ctx.log(`A rose to z=${high.toFixed(0)} (+${(high - ground).toFixed(0)})`);
  // The proof is what happens NEXT: with the avatar levitating too, A stays up. Without it,
  // reconciliation (or the avatar's own gravity) pulls A back to the ground within seconds.
  await ctx.sleep(8_000);
  const held = (await pose(a)).z;
  const div = Number(await a.eval('window.omw.state.selfDivergence||0'));
  ctx.log(`8 s later A is at z=${held.toFixed(0)}, divergence from the avatar ${div.toFixed(0)}`);
  assert.ok(held > ground + 100, `A was dragged back down (${high.toFixed(0)} -> ${held.toFixed(0)}): the avatar is not levitating`);
  assert.ok(div < 256, `A and their avatar disagree by ${div.toFixed(0)} units: the effect did not reach the peer`);
  // And B sees A up there.
  await b.waitFor(`${rowOf}.z > ${ground + 100}`, STEP, "B's puppet of A is in the air");
  ctx.log('ok: B sees A hovering');

  // THE TORCH: equipped in the left hand; B's puppet holds it.
  await a.cmd(`equip:${TORCH}:${CARRIED_LEFT}`);
  await a.waitFor(`String(window.omw.state.equippedIds||"").indexOf(${JSON.stringify(TORCH)}) >= 0`, STEP, 'A holds the torch');
  await b.waitFor(`(${rowOf}.eq||[]).indexOf(${JSON.stringify(TORCH)}) >= 0`, STEP, "B's puppet of A holds the torch");
  ctx.log('PASS: a levitating player stays up (the avatar levitates too), a friend sees them float, and sees the torch in their hand');
}
