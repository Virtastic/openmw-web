// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s138: AN ARCHER KILLS THE PEER'S CREATURE. Every combat scenario so far swings a blade. A
// marksman's game runs the same way melee does under Phase 4C: the owner's stance, yaw, pitch
// and use bit ride the input tier to the AVATAR, and the avatar's engine on the peer draws the
// bow, releases, flies the arrow and resolves the hit natively against the creature it holds.
// The owner's own projectile is cancel-only (combat.lua: a real hit on a puppet is never
// forwarded -- the peer already landed it). MP-COVERAGE-MAP listed ranged as FIXED by code
// trace only; the first draft of this scenario launched arrows on the OWNER's engine and proved
// exactly nothing, because that is the copy that is meant to do nothing.
//
// So: bow and arrows equipped (equipment syncs to the avatar), marksman raised so the avatar
// actually hits, weapon stance drawn, face the creature (the avatar aims with our yaw/pitch),
// and hold the use bit long enough to draw and release. The creature must die on our screen,
// and no hit may have gone out under our own name (hitFwd stays unset: the peer did it).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const docInventory = (ctx) => {
  try {
    const db = new DatabaseSync(join(ctx.serverDataDir, 'players.db'), { readOnly: true });
    const rows = db.prepare('SELECT key, doc FROM players').all();
    db.close();
    return rows.map((r) => { const d = JSON.parse(r.doc); return `${r.key.slice(0, 6)}: inv=${JSON.stringify((d.inventory || []).map((i) => `${i.id}x${i.n}`))} eq=${JSON.stringify(d.equipment || {})}`; }).join(' ; ');
  } catch (e) { return 'db: ' + e.message; }
};

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPOT = '-12500,-53100,512'; // inside -2,-7, where the peer names scrib / kwama forager (s109)
const BOW = 'long bow', ARROW = 'iron arrow';

const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));
const probeOf = async (c, rec) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'))[rec];

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-7');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.cmd('snapto:' + SPOT);
  await a.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'the peer named a creature');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', STEP, 'the cell is puppeted (the peer holds it)');
  const named = Object.entries(await netObjs(a));
  // The NEAREST mark: an arrow is a physical projectile and a wandering creature walks out
  // of a long shot's flight time. Probe positions are keyed by record, so pick by record.
  const me = JSON.parse(await a.eval('window.omw.state.pose||"{}"'));
  const probe = JSON.parse(await a.eval('window.omw.state.actorProbe||"{}"'));
  const dist = (r) => { const p = probe[r]; return p ? Math.hypot(p.x - me.x, p.y - me.y) : Infinity; };
  const [netId, victim] = [...named].sort((x, y) => dist(x[1]) - dist(y[1]))[0];
  ctx.log(`the archer's mark: the peer's "${victim}" (net ${netId}) at ${dist(victim).toFixed(0)} units, of ${named.map(([, r]) => `${r}@${dist(r).toFixed(0)}`).join(', ')}`);

  // Kit: a real bow, a quiver, and the skill to use them; the avatar gets all three. One
  // quiver: the avatar's equipped stack is what it looses from, and re-equipping per shot
  // would sheathe it (an equipment change resets the draw state).
  await a.cmd(`equip:${BOW}:16`);
  await a.waitFor(`(window.omw.state.equippedIds||"").indexOf(${JSON.stringify(BOW)}) >= 0`, 15_000, 'the bow is in hand');
  for (let i = 0; i < 24; i++) { await a.cmd(`equip:${ARROW}:18`); await ctx.sleep(150); } // the equip hook holds one pending item at a time
  await a.waitFor(`(window.omw.state.equippedIds||"").indexOf(${JSON.stringify(ARROW)}) >= 0 && (window.omw.state.equippedIds||"").indexOf(${JSON.stringify(BOW)}) >= 0`, 15_000, 'bow and quiver both equipped');
  await a.cmd('setskill:marksman:100');
  await ctx.sleep(3_000); // equipment + skills diff out to the server and on to the avatar
  await a.cmd('stance:weapon');
  await a.waitFor('window.omw.state.stance === "weapon"', 10_000, 'the bow is drawn');

  // Shoot from the known spot -- the one place the avatar demonstrably follows us to (s109,
  // s137). Placing the archer relative to the creature put the client under the terrain twice
  // (a slope, then an unloaded chunk: pose z=-140 with the creature at 1716). THE AVATAR MUST
  // RULE before a shot means anything: after a teleport the server ignores the peer's poses
  // until the avatar has followed us (connection.ts teleport grace), and until then no input
  // of ours reaches a body that can shoot. selfDivergence is written only from an ACCEPTED
  // peer pose, so a fresh small value is the proof.
  for (let attempt = 0; ; attempt++) {
    await a.eval("if (window.omw.state) window.omw.state.selfDivergence = null; 'cleared';");
    try {
      await a.waitFor('typeof window.omw.state.selfDivergence === "string" && Number(window.omw.state.selfDivergence) < 96', 60_000, 'the avatar rules our pose at the spot');
      break;
    } catch (e) {
      // The follow-teleport can lose the race with the region load (the avatar arrives, the
      // server's arrival gate never sees a pose past the teleport seq). Announce the spot
      // again; the second teleport lands on a loaded region.
      if (attempt >= 2) throw e;
      ctx.log('the avatar did not follow yet; re-announcing the spot');
      await a.cmd('snapto:' + SPOT);
      await ctx.sleep(3_000);
    }
  }
  const p0 = await probeOf(a, victim);
  assert.ok(p0, `no probe position for ${victim}`);
  ctx.log(`in position: pose=${await a.eval('window.omw.state.pose')} divergence=${await a.eval('window.omw.state.selfDivergence')} baselineReady=${await a.eval('window.omw.state.baselineReady')} chargenDone=${await a.eval('window.omw.state.chargenDone')}`);
  ctx.log(`server doc: ${docInventory(ctx)}`);
  // PROVOKE IT. A wandering scrib aimed at through a lagging puppet is a coin flip at 500
  // units (measured: 0.1-0.2 rad off, arrows sail past); a scrib that has been stung comes
  // straight at the archer, and an arrow into a charging creature at 100-300 units lands.
  // The sting is the relay test hit (1 point) -- the same aggro a real player's first
  // arrow would cause. The KILL still has to be the avatar's arrows.
  await a.cmd(`hitn:${victim}:1`);
  {
    const by = Date.now() + 60_000;
    let range = Infinity;
    while (Date.now() < by) {
      const q = (await probeOf(a, victim)) || p0;
      const meNow = JSON.parse(await a.eval('window.omw.state.pose||"{}"'));
      range = Math.hypot(q.x - meNow.x, q.y - meNow.y);
      if (range < 140) break;
      await ctx.sleep(1_000);
    }
    ctx.log(`the stung ${victim} is ${range.toFixed(0)} units off`);
  }
  // The sting itself went out under our name (it is the relay hook); the KILL must not.
  await a.eval("if (window.omw.state) window.omw.state.hitFwd = undefined; 'cleared';");
  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  const deadline = Date.now() + 180_000;
  let shots = 0, died = false;
  let skipped = 0;
  while (Date.now() < deadline && !died && shots < 24) {
    // The mark wanders. Aim at where it is NOW, and hold fire while it is out of a fair
    // shot's reach: a physical arrow into a walking scrib 1000 units off is a coin the
    // scenario should not be flipping.
    const p = (await probeOf(a, victim)) || p0;
    const meNow = JSON.parse(await a.eval('window.omw.state.pose||"{}"'));
    const range = Math.hypot(p.x - meNow.x, p.y - meNow.y);
    if (range > 260) { skipped++; if (skipped % 5 === 1) ctx.log(`holding fire: ${victim} is ${range.toFixed(0)} units off`); await ctx.sleep(2_000); continue; }
    // Bracket the height: the arrow leaves the drawn hand, whose exact height on the peer's
    // body this test does not know to the unit, and a scrib is forty units tall.
    const aimZ = [20, 40, 60][shots % 3];
    await a.cmd(`face:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z + aimZ)}`);
    await a.cmd('stance:weapon'); // the avatar mirrors OUR stance bit
    await ctx.sleep(300);
    if (shots === 0) ctx.log(`after facing: pose=${await a.eval('window.omw.state.pose')} div=${await a.eval('window.omw.state.selfDivergence')}`);
    await a.cmd('attack:1500'); // draw for 1.5 s, then the release is the shot
    shots++;
    // TRACK THE MARK THROUGH THE DRAW, as an archer does: a scrib walks 100 units a second
    // and an aim taken before a 1.5 s draw is a shot at where it was.
    await ctx.sleep(900);
    const p2 = (await probeOf(a, victim)) || p;
    await a.cmd(`face:${Math.round(p2.x)},${Math.round(p2.y)},${Math.round(p2.z + aimZ)}`);
    if (shots === 1) {
      // The first draw must come back on the authoritative stream (s67's proof), or every
      // later "miss" is really an avatar that never raised the bow.
      try {
        await a.waitFor('(Number(window.omw.state.selfFlags||0) & 8) === 8', 10_000, 'the avatar reports drawing the bow (use bit on the state stream)');
      } catch (e) {
        ctx.log(`no draw seen: pose=${await a.eval('window.omw.state.pose')} selfFlags=${await a.eval('window.omw.state.selfFlags')} stance=${await a.eval('window.omw.state.stance')} divergence=${await a.eval('window.omw.state.selfDivergence')} equipped=${await a.eval('window.omw.state.equippedIds')}`);
        const t = (a.logTail ? a.logTail(400) : '').split(String.fromCharCode(10)).filter((l) => /\[mp\]/.test(l) && !/Local map|RigGeometry/.test(l)).slice(-8);
        ctx.log('A [mp] tail: ' + t.join(' || '));
        throw e;
      }
      ctx.log(`ok: the avatar is drawing (selfFlags=${await a.eval('window.omw.state.selfFlags')})`);
    }
    await ctx.sleep(3_000); // draw + flight + the peer's report back
    died = (await a.eval(deadExpr)) === true;
    if (shots % 3 === 1) {
      const q = (await probeOf(a, victim)) || {};
      ctx.log(`shot ${shots}: me=${await a.eval('window.omw.state.pose')} mark=(${Math.round(q.x)},${Math.round(q.y)},${Math.round(q.z)}) dead=${q.dead} div=${await a.eval('window.omw.state.selfDivergence')} flags=${await a.eval('window.omw.state.selfFlags')} batchesIn=${await a.eval('window.omw.state.actorBatchesIn')} hp=${await a.eval('window.omw.state.hp')}`);
    }
  }
  const fwd = String(await a.eval('window.omw.state.hitFwd'));
  ctx.log(`${shots} shot(s) loosed by the avatar; dead=${died}; hitFwd=${fwd}; selfFlags=${await a.eval('window.omw.state.selfFlags')}`);
  assert.ok(died, `the ${victim} never died after ${shots} shots: the avatar did not draw, did not release, missed every time, or its hits are not applied by the peer`);
  assert.equal(fwd, 'undefined', `a real ranged hit went out under the OWNER's name (hitFwd=${fwd}); the peer's avatar must be the one shooting`);
  await a.waitFor(deadExpr, STEP, "the creature is dead on the archer's screen");
  ctx.log(`PASS: the peer's avatar drew, loosed and killed the ${victim} with ${shots} shot(s); the owner's copy only aimed`);
}
