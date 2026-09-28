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
export async function walkTo(ctx, c, getTarget, reach = 150, budgetMs = 20_000) {
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
  // A SHORT GAP IS NOT SNAPPED: under 256 u the jump is no teleport to the game (player.lua's
  // jump detector), the avatar stays, and reconciliation walks the client back -- s128 snapped
  // every 4 s for 3.5 minutes from 110-146 u short (#158). Within closeIn, swingUntil squares up.
  if (best < 256) return { ok: false, strides, snapped: false };
  ctx.log(`  (the walk stalled ${Math.round(best)} u short after ${strides} strides: snapping beside the mark)`);
  await c.cmd(`snapto:${Math.round(t.x + 60)},${Math.round(t.y)},${Math.round(t.z + 8)}`);
  // SAY IT when the avatar stays behind: the client then swings from beside the mark while the
  // body that actually fights -- the peer's avatar -- is wherever the walk stalled (#158 s157:
  // snapped 2013 u, then 102 swings "from 51 u" and not one hit line on the peer).
  await c.eval('window.omw.state.selfDivergence = null; 1'); // a fresh sample, not the pre-snap one
  const came = await c.waitFor('window.omw.state.selfDivergence != null && Number(window.omw.state.selfDivergence) < 60', 15_000, 'the avatar came along').then(() => true, () => false);
  if (!came) ctx.log(`  (the avatar did NOT follow the snap: divergence ${await c.eval('window.omw.state.selfDivergence')} u)`);
  return { ok: true, strides, snapped: true, came };
}

// Swing for real until `done()` says so (the mark died, it fought back, the bar moved) or the
// budget runs out: walk up when out of reach, face it, hold the mouse button.
// REACH 110, centre to centre: a longsword lands inside ~fCombatDistance (128). 170 swung at a
// standing NPC 150 u off for four minutes without one hit (#156 s118); a creature that comes
// at you closes the gap itself, which is why the outdoor fights passed anyway.
// CLOSE IN, DO NOT CHASE: a mark within closeIn is faced and met with a short step, the way a
// player squares up; only a far one gets the walk (and, blocked, the snap). Walking and snapping
// every time a fighting NPC stepped past reach cost s118 four minutes for ten swings (#158).
export async function swingUntil(ctx, c, getTarget, done, { reach = 110, closeIn = 300, holdMs = 1500, budgetMs = 180_000, maxSwings = Infinity } = {}) {
  const until = Date.now() + budgetMs;
  let swings = 0, snaps = 0, near = 0, lastMark = null;
  while (Date.now() < until && swings < maxSwings) {
    if (await done()) return { done: true, swings, snaps };
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
        continue;
      }
      const w = await walkTo(ctx, c, getTarget, reach - 30);
      if (w.snapped) snaps++;
      continue;
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
      ctx.log(`  swing ${swings}: ${Math.round(flat(t, me))} u from the mark (moved ${moved} u), its hp ${t.hp ?? '?'}, own avatar ${await c.eval('window.omw.state.selfDivergence')} u off, own fatigue ${await c.eval('window.omw.state.selfFt')}`);
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
