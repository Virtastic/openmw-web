// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s164: A REAL SWORD KILLS THE PEER'S CREATURE. Every melee kill in the suite (s51/s58/s109/
// s111/s118/s119/s120/s128/s157) goes through the hitn: relay hook, which combat.lua forwards
// only because it is a test hit -- a player's own swing is cancel-only, and the AVATAR on the
// peer swings for them (Phase 4C: stance and use bit ride the input tier; s67 proves the
// swing, s138 the same chain with a bow). Nothing killed anything that way (backlog 238).
// So: a sword equipped, the blade skill raised, the stance drawn, standing beside a weak
// wild creature and holding the use bit until the probe says it is dead -- with hitFwd
// never set (the owner's copy sent nothing; the peer did it), and the death on B's screen.
import assert from 'node:assert/strict';

export const managedPeer = true; // the avatar swings on the server's own peer, anchored on us
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPOT = '-12500,-53100,512'; // inside -2,-7, where the peer names scrib / kwama forager (s109)
const WEAPON = 'iron longsword';
const REACH = 110; // a longsword's swing lands inside ~fCombatDistance (128)

const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));
const probeOf = async (c, rec) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'))[rec];
const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"{}"'));

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.cmd('snapto:' + SPOT);
  await b.cmd('snapto:-12300,-53100,512');
  await a.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'the peer named a creature');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', STEP, 'the cell is puppeted (the peer holds it)');
  // THE PROBE IS A MIRROR, NOT A READ. actorProbe is rewritten on actors.lua's tick from the
  // own cell's actors; `netObjects > 0` is true the moment the peer's spawn is netted, a tick
  // or a cell change before the probe lists it (#111 s164: "no living named creature in the
  // probe: []" with three scribs netted in -2,-7). Wait for a living netted record IN the probe.
  await a.waitFor(`(function(){var pr=JSON.parse(window.omw.state.actorProbe||"{}");return Object.values(JSON.parse(window.omw.state.netObjects||"{}")).some(function(r){var p=pr[r];return p&&!p.dead;});})()`,
    STEP, 'the peer\'s creature is in the probe, alive');
  // The nearest living mark, by record (the probe is keyed by record; s138).
  const me = await poseOf(a);
  const probe = JSON.parse(await a.eval('window.omw.state.actorProbe||"{}"'));
  const dist = (r) => { const p = probe[r]; return p && !p.dead ? Math.hypot(p.x - me.x, p.y - me.y) : Infinity; };
  const [netId, victim] = Object.entries(await netObjs(a)).sort((x, y) => dist(x[1]) - dist(y[1]))[0];
  assert.ok(Number.isFinite(dist(victim)), `no living named creature in the probe: ${JSON.stringify(Object.keys(probe))}`);
  ctx.log(`the mark: the peer's "${victim}" (net ${netId}) at ${dist(victim).toFixed(0)} units`);
  await b.waitFor(`Object.prototype.hasOwnProperty.call(JSON.parse(window.omw.state.actorProbe||"{}"), ${JSON.stringify(victim)})`, STEP, `B sees the ${victim} too`);

  // Kit: the sword and the skill to use it; the avatar gets both (equipment + skills diff).
  await a.cmd(`equip:${WEAPON}:16`);
  await a.waitFor(`(window.omw.state.equippedIds||"").indexOf(${JSON.stringify(WEAPON)}) >= 0`, 15_000, 'the sword is in hand');
  await a.cmd('setskill:longblade:100');
  await ctx.sleep(3_000);
  await a.cmd('stance:weapon');
  await a.waitFor('window.omw.state.stance === "weapon"', 10_000, 'the sword is drawn');

  // Beside it, and provoked with ONE relay sting (s138's idiom: a stung creature comes at
  // you, a wandering one walks out of reach mid-swing). The sting goes out under our name;
  // the mirror is cleared after it, and the KILL must not.
  const p0 = await probeOf(a, victim);
  // A SNAP UNDER 256 u IS NEVER ANNOUNCED (player.lua sends PlayerCellChange for a same-cell
  // jump past SNAP_DIST only), so the avatar stays put and reconciliation drags the body back
  // before it ever "arrives" (#120: the mark 246 u away, 60 s without a settled divergence).
  // From closer than 300 u, step 300 u away first so the approach is a jump the server sees.
  {
    const me0 = await poseOf(a);
    const d0 = Math.hypot(p0.x - me0.x, p0.y - me0.y);
    if (d0 < 300) {
      const bx = Math.round(me0.x - ((p0.x - me0.x) / d0) * 300), by = Math.round(me0.y - ((p0.y - me0.y) / d0) * 300);
      ctx.log(`  the mark is ${d0.toFixed(0)} u away: stepping back 300 first so the approach is announced`);
      await a.cmd(`snapto:${bx},${by},${Math.round(me0.z + 8)}`);
      await a.eval("if (window.omw.state) window.omw.state.selfDivergence = null; 'cleared';");
      await a.waitFor('typeof window.omw.state.selfDivergence === "string" && Number(window.omw.state.selfDivergence) < 96', 60_000, 'the avatar followed the step back');
    }
  }
  await a.cmd(`snapto:${Math.round(p0.x + 60)},${Math.round(p0.y)},${Math.round(p0.z + 8)}`);
  // THE AVATAR MUST RULE before a swing means anything (s138): after a teleport the server
  // ignores the peer's poses until the avatar has followed; selfDivergence is written only
  // from an accepted peer pose.
  await a.eval("if (window.omw.state) window.omw.state.selfDivergence = null; 'cleared';");
  await a.waitFor('typeof window.omw.state.selfDivergence === "string" && Number(window.omw.state.selfDivergence) < 96', 60_000, 'the avatar rules our pose beside the mark');
  await a.cmd(`hitn:${victim}:1`);
  await ctx.sleep(2_000);
  // The mirror cannot be cleared from the page (re-read from the engine each frame): count
  // forwards instead, and require the count not to move while the avatar does the killing.
  const fwdBefore = String(await a.eval('window.omw.state.hitFwdCount'));

  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  // 90 s bought 27 swings in #114 and the forager sat at 3 hp (31 -> 3: the hits land, a
  // level-1 swing just misses often). Three minutes is the budget a kill needs, not a hit.
  const deadline = Date.now() + 180_000;
  let swings = 0, died = false, resnaps = 0;
  while (Date.now() < deadline && !died) {
    const p = (await probeOf(a, victim)) || p0;
    const now = await poseOf(a);
    const range = Math.hypot(p.x - now.x, p.y - now.y);
    if (range > REACH) {
      // It walked off (or fled): step back beside it, at most a few times.
      // ...and wait for the AVATAR to get there too: it is the body that swings, and #119 had
      // it 197 u behind a client that had re-snapped after a walking scrib -- eight swings in
      // three minutes, all into air.
      if (resnaps++ < 6) {
        await a.cmd(`snapto:${Math.round(p.x + 60)},${Math.round(p.y)},${Math.round(p.z + 8)}`);
        await a.waitFor("Number(window.omw.state.selfDivergence||999) < 60", 15_000, 'the avatar came along').catch(() => {});
      }
      else { await ctx.sleep(1_000); }
      continue;
    }
    await a.cmd(`face:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z + 20)}`);
    await a.cmd('stance:weapon'); // the avatar mirrors OUR stance bit
    await ctx.sleep(200);
    await a.cmd('attack:1500'); swings++;
    if (swings === 1) {
      // The first swing must come back on the authoritative stream (s67's proof).
      await a.waitFor('(Number(window.omw.state.selfFlags||0) & 8) === 8', 10_000, 'the avatar reports swinging (use bit on the state stream)');
    }
    await ctx.sleep(2_000); // swing + the peer's report back
    died = (await a.eval(deadExpr)) === true;
    if (swings % 4 === 1) {
      const q = (await probeOf(a, victim)) || {};
      ctx.log(`swing ${swings}: range ${range.toFixed(0)} mark=(${Math.round(q.x)},${Math.round(q.y)}) dead=${q.dead} div=${await a.eval('window.omw.state.selfDivergence')} flags=${await a.eval('window.omw.state.selfFlags')} hp=${await a.eval('window.omw.state.hp')}`);
    }
  }
  const fwd = String(await a.eval('window.omw.state.hitFwdCount'));
  ctx.log(`${swings} swing(s) by the avatar; dead=${died}; forwards ${fwdBefore} -> ${fwd}`);
  assert.ok(died, `the ${victim} never died after ${swings} swings: the avatar did not swing, missed every time, or its hits are not applied by the peer`);
  assert.equal(fwd, fwdBefore, `a real melee hit went out under the OWNER's name (forwards ${fwdBefore} -> ${fwd}); the peer's avatar must be the one killing`);
  await b.waitFor(deadExpr, STEP, "the creature is dead on B's screen too");
  ctx.log(`PASS: the peer's avatar swung and killed the ${victim} with ${swings} swing(s); B saw it die; the owner's copy sent no hit`);
}
