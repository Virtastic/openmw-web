// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s156: AN INVISIBLE FRIEND IS INVISIBLE ON YOUR SCREEN. The owner's temporary effects were
// forwarded to the world peer only (the avatar is the body that matters), so a friend who
// cast Invisibility or Chameleon stayed a solid, walking figure to everyone else -- the one
// effect whose whole point is what OTHERS see. Now every client gets the op and keeps the
// visible part of it for the puppet. Asserted on B's puppet of A: no temporary effect before
// the cast, the cast's record after, and gone when A dispels it.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

async function actives(c) {
  await c.eval("if (window.omw.state) window.omw.state.actives = null; 'cleared';");
  await c.cmd('actives');
  await c.waitFor("typeof window.omw.state.actives === 'string'", 10_000, 'actives answered');
  return String(await c.eval('window.omw.state.actives')).split(',').filter(Boolean);
}
// s148's cast path: a minted one-effect self spell, learned + selected, the spell stance and
// the use key on THIS engine. Returns the spell's local id on the caster.
async function castSelf(c, ctx, effect, magnitude, seconds) {
  await c.eval("if (window.omw.state) { window.omw.state.mintedSpell = null; window.omw.state.actives = null; } 'cleared';");
  await c.cmd(`mintspell:${effect}:${magnitude}:${seconds}`);
  await c.waitFor("typeof window.omw.state.mintedSpell === 'string'", 10_000, 'the spell was minted and selected');
  const id = await c.eval('window.omw.state.mintedSpell');
  await c.waitFor(`Object.values(JSON.parse(window.omw.state.netRecords||"{}")).includes(${JSON.stringify(id)})`, 20_000, 'the minted spell is registered with the server');
  await c.cmd('setskill:illusion:65');
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
  await c.cmd('press:500');
  await ctx.sleep(1_800);
  let now = [];
  for (let attempt = 0; attempt < 3 && !now.includes(id); attempt++) {
    now = await actives(c);
    if (now.includes(id)) break;
    ctx.log(`cast ${id} did not take yet (actives [${now}]); pressing again`);
    await c.cmd('press:500');
    await ctx.sleep(1_800);
  }
  if (!now.includes(id)) throw new Error(`the cast of ${id} did not take (actives: ${now})`);
  return id;
}

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, 'A is settled');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the cell is peer-held');
  const idA = await a.eval('window.omw.state.playerId');
  const rowOf = `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(String(idA))}]||{})`;
  await b.waitFor(`${rowOf}.x !== undefined`, STEP, 'B has a puppet of A');
  const seenOnB = async () => JSON.parse(await b.eval(`JSON.stringify(${rowOf}.actives||[])`));
  await ctx.sleep(2_000);
  const ownBefore = await actives(b); // B's own list carries racial abilities (resist fire); compare, never assume empty
  const before = await seenOnB();
  ctx.log(`B's puppet of A before the cast: [${before}]`);
  assert.equal(before.length, 0, `B's puppet of A already carries effects [${before}]`);

  // A turns invisible. B's puppet must carry the effect (its own local id for the same
  // record: B cannot name A's Generated id, so assert on count, not the string).
  const spell = await castSelf(a, ctx, 'invisibility', 100, 60);
  let seen = [];
  const by = Date.now() + 15_000;
  while (Date.now() < by && seen.length === 0) { await ctx.sleep(500); seen = await seenOnB(); }
  ctx.log(`B's puppet of A after the cast: [${seen}]`);
  assert.equal(seen.length, 1, 'B does not see A\'s invisibility: the effect op reached the peer only');

  // A dispels it: B's puppet is solid again.
  await a.cmd(`dispel:${spell}`);
  const by2 = Date.now() + 15_000;
  while (Date.now() < by2 && seen.length > 0) { await ctx.sleep(500); seen = await seenOnB(); }
  ctx.log(`B's puppet of A after the dispel: [${seen}]`);
  assert.equal(seen.length, 0, 'B still sees A as invisible after A dispelled it');
  // And B's own body was never touched.
  // As SETS: the engine lists an innate ability twice for a while after a record apply and
  // collapses it later (#116: [resist fire_75, resist fire_75] -> [resist fire_75]); that is
  // not A's effect arriving. What must not appear is anything that was not there before.
  const own = await actives(b);
  const uniq = (l) => [...new Set(l)].sort();
  assert.deepEqual(uniq(own), uniq(ownBefore), `B's own body changed with A's effect: [${ownBefore}] -> [${own}]`);
  ctx.log('PASS: an invisible friend is invisible on the other screen, and solid again when dispelled');
}
