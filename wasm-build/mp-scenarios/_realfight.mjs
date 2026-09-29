// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A REAL FIGHT from the harness: the pointer taken like a player takes it, W held to walk up,
// the mouse button held to swing. The hitn:/hitp:/attack: hooks put a blow on the wire (or the
// use bit on the stream) without a key or a button, and stayed green while the input path they
// skip could be dead -- which is how a player could press and nothing happened (s171).
// Aim is face: (turning with a mouse under pointer lock has no absolute coordinate to aim at);
// everything the player's HANDS do is real. Library, not a scenario (leading underscore).

export const W = { key: 'w', code: 'KeyW', keyCode: 87 };
export const S = { key: 's', code: 'KeyS', keyCode: 83 };
export const WEAPON = 'iron longsword';

export const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));
export const probeOf = async (c, rec) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'))[rec] || null;
const flat = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

// FOCUS LIKE A PLAYER (s64, s171): click into the canvas, close the first-join tour, take the
// pointer lock, keep the keyboard on the canvas.
export async function focus(c) {
  await c.mouseHold(60);
  await c.dismissTour(3000).catch(() => {});
  await c.evalGesture("(function(){var c=document.querySelector('canvas'); try { var p=c.requestPointerLock(); return p&&p.then?p.then(function(){return 'locked'},function(e){return 'rejected:'+e}):'requested'; } catch(e){ return 'threw:'+e; }})()");
  await c.eval("(function(){var c=document.querySelector('canvas'); if(c) c.focus(); return 1;})()");
}

// The sword, the skill to land it (a fresh character misses most swings; the miss is not the
// thing under test), the weapon drawn.
// `skill` middling (40) for a fight that must be STARTED, not ended: it sets the chance to HIT (at
// 5 most swings miss, #158 s166), the weapon sets the damage; stop at the first wound. A kill
// proves nothing about what it does next.
export async function armMelee(c, weapon = WEAPON, skill = 100) {
  await c.cmd(`equip:${weapon}:16`);
  await c.waitFor(`(window.omw.state.equippedIds||"").indexOf(${JSON.stringify(weapon)}) >= 0`, 15_000, 'the weapon is in hand');
  await c.cmd(`setskill:longblade:${skill}`);
  await c.cmd('stance:weapon');
  await c.waitFor('window.omw.state.stance === "weapon"', 10_000, 'the weapon is drawn');
}

// Walk up to a target with W held, re-aiming each stride. A target across water or a wall does
// not get closer: after a few strides without progress the approach snaps beside it and SAYS so
// (counted in the result), so a blocked path cannot pass for a walk.
// `side` (radians): where around the mark a snap lands. Two fighters snapped to one spot put
// each other's avatar first in the swing's arc, and that player took the blow (#159 s128: the
// guest's avatar struck the host's, PvP off, wasted) -- give each its own side.
export async function walkTo(ctx, c, getTarget, reach = 150, budgetMs = 20_000, side = 0) {
  const until = Date.now() + budgetMs;
  let best = Infinity, stuck = 0, strides = 0;
  while (Date.now() < until) {
    const [t, me] = [await getTarget(), await poseOf(c)];
    if (!t || !me) return { ok: false, strides, snapped: false };
    const d = flat(t, me);
    if (d <= reach) return { ok: true, strides, snapped: false };
    if (d < best - 20) { best = d; stuck = 0; } else if (++stuck >= 4) break;
    await c.eval(`window.omw.send('face:${Math.round(t.x)},${Math.round(t.y)},${Math.round(t.z + 30)}'); 1`);
    await c.keyHold(W, Math.min(900, Math.max(250, (d - reach) * 3)));
    strides++;
  }
  const t = await getTarget();
  if (!t) return { ok: false, strides, snapped: false };
  ctx.log(`  (the walk stalled ${Math.round(best)} u short after ${strides} strides: snapping beside the mark)`);
  const came = await snapBeside(ctx, c, t, side);
  return { ok: true, strides, snapped: true, came };
}

// Put the player 60 u from the mark (on `side`) with jumps the peer's avatar FOLLOWS. A
// same-cell hop under 256 u is walking to the game (player.lua SNAP_DIST, global.lua's
// follow-teleport): the avatar stayed and the client was reconciled back (s128 #158: a snap every
// 4 s from 110-146 u short). Refusing short snaps instead left a fight blocked by the room stuck
// for good (#172 s157: 0 swings). From close by, hop 400 u straight away from the mark first,
// let the avatar follow, then in: two real jumps.
export async function snapBeside(ctx, c, t, side = 0) {
  const spot = { x: Math.round(t.x + 60 * Math.cos(side)), y: Math.round(t.y + 60 * Math.sin(side)), z: Math.round(t.z + 8) };
  const me = await poseOf(c);
  if (me && flat(spot, me) < 300) {
    const away = Math.atan2(me.y - t.y, me.x - t.x);
    const out = { x: Math.round(me.x + 400 * Math.cos(away)), y: Math.round(me.y + 400 * Math.sin(away)), z: Math.round(me.z + 40) };
    await c.cmd(`snapto:${out.x},${out.y},${out.z}`);
    await c.eval('window.omw.state.selfDivergence = null; 1');
    await c.waitFor('window.omw.state.selfDivergence != null && Number(window.omw.state.selfDivergence) < 60', 15_000, 'the avatar followed the hop out').catch(() => {});
  }
  await c.cmd(`snapto:${spot.x},${spot.y},${spot.z}`);
  // SAY IT when the avatar stays behind: the client then swings from beside the mark while the
  // body that actually fights -- the peer's avatar -- is wherever the walk stalled (#158 s157).
  await c.eval('window.omw.state.selfDivergence = null; 1'); // a fresh sample, not the pre-snap one
  const came = await c.waitFor('window.omw.state.selfDivergence != null && Number(window.omw.state.selfDivergence) < 60', 15_000, 'the avatar came along').then(() => true, () => false);
  if (!came) ctx.log(`  (the avatar did NOT follow the snap: divergence ${await c.eval('window.omw.state.selfDivergence')} u)`);
  return came;
}

// Swing for real until `done()` says so (the mark died, it fought back, the bar moved) or the
// budget runs out: walk up when out of reach, face it, hold the mouse button.
// REACH 110, centre to centre: a longsword lands inside ~fCombatDistance (128). 170 swung at a
// standing NPC 150 u off for four minutes without one hit (#156 s118); a creature that comes
// at you closes the gap itself, which is why the outdoor fights passed anyway.
// CLOSE IN, DO NOT CHASE: a mark within closeIn is faced and met with a short step, the way a
// player squares up; only a far one gets the walk (and, blocked, the snap). Walking and snapping
// every time a fighting NPC stepped past reach cost s118 four minutes for ten swings (#158).
export async function swingUntil(ctx, c, getTarget, done, { reach = 110, closeIn = 300, holdMs = 1500, budgetMs = 180_000, maxSwings = Infinity, side = 0 } = {}) {
  const until = Date.now() + budgetMs;
  let swings = 0, snaps = 0, near = 0, lastMark = null;
  while (Date.now() < until && swings < maxSwings) {
    if (await done()) return { done: true, swings, snaps };
    // A DEAD SWINGER SWINGS AT NOTHING: say so and stop (#172 s118: both players died to the mark
    // and its summon, and B went on "swinging" 110 times with its bars frozen).
    if (Number(String(await c.eval('window.omw.state.selfStats') || '1/1').split('/')[0]) <= 0) {
      ctx.log(`  the swinger died after ${swings} swing(s)`);
      return { done: false, swings, snaps, died: true };
    }
    const [t, me] = [await getTarget(), await poseOf(c)];
    if (!t || !me) { await ctx.sleep(500); continue; }
    const d = flat(t, me);
    // TOO CLOSE TO HIT: two bodies overlapping put the mark's centre off to the side, and the
    // engine's own arc check refuses it (#159 s66: both players spawned on one spot, the swing
    // reached the hit test nine times, 'angleXY' every time). A player steps back.
    if (d < 40) {
      await c.eval(`window.omw.send('face:${Math.round(t.x)},${Math.round(t.y)},${Math.round(t.z + 30)}'); 1`);
      await c.keyHold(S, 250);
      continue;
    }
    if (d > reach) {
      if (d <= closeIn) {
        await c.eval(`window.omw.send('face:${Math.round(t.x)},${Math.round(t.y)},${Math.round(t.z + 30)}'); 1`);
        if (++near % 3 === 0) await c.keyHold(W, 300); else await ctx.sleep(400);
        // Squaring up that never gets there is a wall or a counter between: snap in (#172 s157).
        if (near % 30 === 0) { ctx.log(`  (${Math.round(d)} u off after ${near} close-in steps: snapping beside the mark)`); await snapBeside(ctx, c, t, side); snaps++; }
        continue;
      }
      const w = await walkTo(ctx, c, getTarget, reach - 30, 20_000, side);
      if (w.snapped) snaps++;
      continue;
    }
    // CATCH BREATH, as a player does: every swing costs fatigue, and nonstop swinging drained it
    // to 0 -- the body staggered and every blow after whiffed (#174 s120: 200 -> 0 over 91 swings,
    // the mark stuck at 47 hp). Below 30% of the bar, wait (up to 20 s) for it to reach 60%.
    const ftOf = async () => String(await c.eval('window.omw.state.selfFt') || '').split('/').map(Number);
    const [ft, ftMax] = await ftOf();
    if (ftMax > 0 && ft < 0.3 * ftMax) {
      ctx.log(`  (fatigue ${Math.round(ft)}/${ftMax}: catching breath)`);
      for (const until = Date.now() + 20_000; Date.now() < until;) {
        const [f] = await ftOf();
        if (f >= 0.6 * ftMax || (await done())) break;
        await ctx.sleep(1_000);
      }
    }
    await c.eval(`window.omw.send('face:${Math.round(t.x)},${Math.round(t.y)},${Math.round(t.z + 30)}'); 1`);
    await c.mouseHold(holdMs);
    swings++;
    // The mark's health beside the range: whether real blows LAND is the question when a fight
    // does not end (#158: NPCs outlived 171 swings from 60 u while every creature died).
    // Whether the mark MOVES between samples (a fleeing NPC seen a second late is swung at
    // where it was) and the swinger's own fatigue (the peer's bar: at 0 a body collapses and
    // cannot swing) -- #159 s128: Fargoth 41 -> 22 in ten swings, then 22 for ninety more.
    if (swings === 1 || swings % 10 === 0) {
      const moved = lastMark ? Math.round(flat(t, lastMark)) : 0;
      lastMark = { x: t.x, y: t.y };
      ctx.log(`  swing ${swings}: ${Math.round(flat(t, me))} u from the mark (moved ${moved} u), its hp ${t.hp ?? '?'}, own avatar ${await c.eval('window.omw.state.selfDivergence')} u off, own fatigue ${await c.eval('window.omw.state.selfFt')}, uiMode ${await c.eval('window.omw.state.uiMode')}, bounty ${await c.eval('window.omw.state.bounty')}`);
    }
    // ARRESTED, NOT FIGHTING (#184 s120: bounty 40, a guard's arrest dialogue open, 5 of 51 swings reached
    // the avatar): a menu holds no use bit, so the rest of the budget is five minutes of nothing. Say what
    // happened and stop -- the target was a crime, not a fight.
    if (swings % 5 === 0 && String(await c.eval('window.omw.state.uiMode')) === 'Dialogue' && Number(await c.eval('window.omw.state.bounty')) > 0) {
      ctx.log(`  ARRESTED after ${swings} swing(s): bounty ${await c.eval('window.omw.state.bounty')}, an arrest dialogue is open -- this mark was a crime (a named NPC in a guarded town), not a fight`);
      return { done: false, swings, snaps, arrested: true };
    }
    await ctx.sleep(400);
  }
  const ended = await done();
  if (!ended && swings > 0) {
    // WHAT THE PEER SAW (companion.lua logs every hit an actor takes on the peer): whether the
    // avatar's blows connected at all, or never reached the mark (#158: NPCs indoors outlived
    // 100+ swings from 51 u while every creature outdoors died).
    // Both places a peer's lines land: the server log (a peer the server spawned) and the harness's
    // own buffer (a peer the scenario started with ctx.startSimPeer).
    // ...and a gateway's (s128: the host world's managed peer narrates through the gateway).
    const tail = [ctx.serverLogTail ? ctx.serverLogTail(20000) : '', ctx.peerLogTail ? ctx.peerLogTail(20000) : '',
      ctx.childLogTail ? ctx.childLogTail('gateway', 20000) : ''].join(String.fromCharCode(10)).split(String.fromCharCode(10));
    const empty = tail.filter((l) => /avatar swing found nothing/.test(l));
    if (empty.length) ctx.log(`  the peer's avatar swung at nothing ${empty.length} time(s) -- last: ${empty.slice(-2).map((l) => l.replace(/^.*found nothing: /, '').slice(0, 300)).join(' | ')}`);
    const presses = tail.filter((l) => /avatar use (press|\+0\.3s):/.test(l));
    if (presses.length) ctx.log(`  the avatar's state at the presses (${presses.length} lines) -- last: ${presses.slice(-4).map((l) => l.replace(/^.*avatar use /, '').replace(/"}?$/, '').slice(0, 200)).join(' | ')}`);
    // COUNTED, NOT TAILED (#178): presses, releases and where each avatar blow ended, over the
    // whole retained log -- 'avatar blow: ... -> applied|out of reach|victim dead|no victim'.
    const count = (re) => tail.filter((l) => re.test(l)).length;
    ctx.log(`  the avatar over the whole fight: ${count(/avatar use press:/)} presses, ${count(/avatar use release:/)} releases, ${count(/avatar use held /)} held-lines; blows: ${count(/avatar blow:.*-> applied/)} applied, ${count(/avatar blow:.*-> out of reach/)} out of reach, ${count(/avatar blow:.*-> victim dead/)} victim dead, ${count(/avatar blow:.*-> no victim/)} no victim`);
    const blows = tail.filter((l) => /avatar blow:/.test(l));
    if (blows.length) ctx.log(`  last avatar blows: ${blows.slice(-3).map((l) => l.replace(/^.*avatar blow: /, '').replace(/"}?$/, '').slice(0, 160)).join(' | ')}`);
    // A MENU HOLDS THE USE BIT (player.lua inputTick inMenu): an arrest dialogue (global.lua avatarArrestTick -> MP_OpenDialogue) swallows every later swing (#181 s157).
    ctx.log(`  the swinger's window at the end: uiMode ${await c.eval('window.omw.state.uiMode')}, bounty ${await c.eval('window.omw.state.bounty')}; peer arrests: ${count(/\[mp\] arrest: /)}`);
    const hits = tail.filter((l) => /hit on peer:/.test(l)).map((l) => { try { return JSON.parse(l).text.replace(/^.*hit on peer: /, ''); } catch { return l.slice(0, 160); } });
    ctx.log(`  the fight did not end after ${swings} swing(s); hits the peer logged: ${hits.length}` + (hits.length ? ' -- last: ' + hits.slice(-4).join(' | ') : ''));
  }
  return { done: ended, swings, snaps };
}

// START A FIGHT THE WAY A PLAYER DOES: one weak swing, then wait for it to fight back; not yet,
// swing again. One wound is not always enough -- s112 hurt a creature with its first swing,
// stopped, and waited two minutes for a bite that never came (#157). Arm weakly first
// (armMelee skill 5) so the provocation does not kill the mark.
export async function provoke(ctx, c, getTarget, foughtBack, { rounds = 5, waitMs = 20_000 } = {}) {
  let swings = 0;
  for (let r = 0; r < rounds; r++) {
    const t = await getTarget();
    if (!t || t.dead) break;
    const hit = await swingUntil(ctx, c, getTarget, foughtBack, { maxSwings: 1, budgetMs: 45_000 });
    swings += hit.swings;
    const until = Date.now() + waitMs;
    while (Date.now() < until) { if (await foughtBack()) return { ok: true, swings }; await ctx.sleep(1_000); }
  }
  return { ok: await foughtBack(), swings };
}
