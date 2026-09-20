// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s147: A FALL HURTS ONCE. Two physics worlds see the same fall: the player's own engine
// (which draws the drop) and the peer's avatar (which rules the body). Both know how to
// compute fall damage. The player must land hurt -- a fall that costs nothing is a cheat --
// and hurt ONCE: a local hit plus the avatar's hit would be double damage, and a level-1
// character dies from a drop they should walk away from. The peer-reported bars (selfStats)
// are the truth; the client's own bar must agree with them once the dust settles.
import assert from 'node:assert/strict';

// THE SERVER'S OWN PEER, anchored on the players: a hand-started peer processes actors only
// within range of its parked avatar, and this spot is out of that range -- the avatar sat
// out of processing range and never drowned, never fell (the s149 probe: inRange=false).
export const managedPeer = true;

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
// No snap: the retail start (Seyda Neen, -2,-9) is dry land. The first draft dropped onto the
// s109 spot, whose ground turned out to be z=-133 -- the sea -- and a fall into water costs
// nothing, correctly.
const DROP = 450; // units above the ground: past fFallDamageDistanceMin (400 + 1.5 x Acrobatics). NOT 600: the avatar climbs on at ~400 u/s for the second it takes the dispel to reach it, topped at 1081 from a 600 release and the 1014 u fall KILLED a 35 hp character -- the respawn then read as 'cost nothing' (builder run after the peer's dummy moved aside). From ~650-850 a level-1 body loses 20-33 and lives.

const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };
const bars = async (c) => parseBars(await c.eval('window.omw.state.selfStats'));
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
  // THE POOL MUST FUND THE CAST (#391 priced this spell at mag x dur / 100 = 60): setmp: alone
  // is a raise claim the server caps at the BASE (~40 on a fresh character) and the peer's
  // avatar bar overwrites the local one at 4 Hz, so every press said 'not enough magicka'
  // (#105: three presses, nothing in actives). One legal base step (+60, playerstate
  // MAX_BASE_STEP) first, then the pool up to it.
  const peerMp = String(await c.eval('window.omw.state.selfMagicka||""')); // 'c/b' once the peer rules the bars
  const mpBase = Number(peerMp.split('/')[1]) || 40;
  await c.cmd(`setmpbase:${mpBase + 60}`);
  await ctx.sleep(1_500); // the base claim lands before the pool claim is capped against it
  await c.cmd('setmp:300');
  if (peerMp.includes('/')) await c.waitFor(`Number(String(window.omw.state.selfMagicka||"0/0").split("/")[0]) >= ${mpBase + 55}`, 30_000, 'the peer reports a pool that funds the cast');
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
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, 'the character is settled (the join-time restore is done)');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the cell is peer-held');
  await a.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', STEP, 'the peer reports the bars');
  // Let the landing from the snap settle and the bars stabilise.
  await ctx.sleep(5_000);
  const before = await bars(a);
  const at = await pose(a);
  const ground = at.z;
  ctx.log(`standing at ${at.x.toFixed(0)},${at.y.toFixed(0)} z=${ground.toFixed(0)} with ${before.c}/${before.b}`);
  assert.ok(ground > 0, `the start is under sea level (z=${ground.toFixed(0)}); a fall into water proves nothing`);

  // The drop -- a REAL one. The engine measures a fall from where the actor left the ground
  // and a teleport resets that (a 900-unit snapto costs nothing, measured). So climb on
  // Levitate, then dispel it mid-air: the body is in the air with no ground reference below
  // the point it was released, exactly as a fall from a ledge.
  const lev = await castSelf(a, ctx, 'levitate', 100, 60); // 100 pts: ~300 units/s of climb
  // A levitating body moves where it LOOKS (movementsolver: velocity = pitch x yaw x
  // movement); jump is zeroed while flying. Look steeply up, walk forward.
  await climbUp(a, ctx, 8000);
  await a.waitFor(`JSON.parse(window.omw.state.pose||"{}").z > ${ground + DROP}`, STEP, `climbed ${DROP} units`);
  const top = (await pose(a)).z;
  await a.cmd('walk:0,1,1'); // end the climb now
  await a.cmd(`dispel:${lev}`);
  ctx.log(`released at z=${top.toFixed(0)} (+${(top - ground).toFixed(0)})`);
  // Landed = the engine says on-ground again (the flight drifted, so the ground here is not
  // the ground we left). Poll the body mirror.
  const landedBy = Date.now() + 40_000;
  let onGround = false, bodyLine = '';
  while (Date.now() < landedBy && !onGround) {
    await ctx.sleep(1_000);
    await a.eval("if (window.omw.state) window.omw.state.body = null; 'c';"); await a.cmd('body');
    await a.waitFor("typeof window.omw.state.body === 'string'", 5_000, 'body');
    bodyLine = String(await a.eval('window.omw.state.body'));
    onGround = /ground=true/.test(bodyLine);
  }
  ctx.log(`after the release: ${bodyLine}`);
  assert.ok(onGround, `never landed: ${bodyLine} (the dispel did not reach the avatar, so reconciliation held the player up?)`);
  // Damage is applied on landing on both sides; give the peer a few reports to settle.
  let after = before;
  const by = Date.now() + 15_000;
  while (Date.now() < by) { await ctx.sleep(1_000); after = (await bars(a)) || after; }
  const local = Number(await a.eval('window.omw.state.hp'));
  ctx.log(`after the fall: peer says ${after.c}/${after.b}, the client's own bar says ${local}`);

  assert.ok(after.c < before.c, `the fall cost nothing (${before.c} -> ${after.c}): fall damage never reached the ruling body`);
  assert.ok(after.c > 0, 'a 900-unit drop must not kill a fresh character');
  const lost = before.c - after.c;
  // ONCE, not twice. The client's own bar must not sit a whole second hit below the peer's.
  assert.ok(Math.abs(local - after.c) <= Math.max(3, lost * 0.5),
    `the client and the peer disagree on the fall (client ${local}, peer ${after.c}, lost ${lost}): one side applied a second hit`);
  ctx.log(`PASS: the fall cost ${lost} health once, and both sides agree`);
}
