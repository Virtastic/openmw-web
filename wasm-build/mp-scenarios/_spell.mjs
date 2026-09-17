// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A REAL CAST from the harness: a retail spell learned and selected, the spell stance, the
// use key on THIS engine. That is the path a player's spell takes (spelleffects.cpp -> the
// puppet seam -> CombatSpellHit, or the active-spell mirror to the avatar); the castat:/
// castp:/healp:/selfcast: hooks park an effect directly and stay green with that path dead
// (backlog 242). Library, not a scenario (leading underscore).

// Retail ids (Morrowind.esm): every client and the peer can resolve them, which a spell
// minted on one client cannot promise.
export const FIRE_BITE = 'fire bite'; // touch, Fire Damage 15-30, cost 6
export const HEAL_COMPANION = 'heal companion'; // touch, Restore Health 6-15, cost 3
export const SUMMON_SCAMP = 'summon scamp'; // self, Conjuration

// Learn + select the spell, make the cast reliable (skill 100, a full pool), draw the stance.
export async function prepareCast(c, ctx, spellId, skill) {
  await c.cmd(`learnspell:${spellId}`);
  await c.cmd(`setskill:${skill}:100`); // a fresh character fizzles most casts; the fizzle is not the thing under test
  // A POOL THAT CAN PAY. The peer rules the bars and a magicka claim is capped at the BASE
  // (~40 on a fresh character), so setmp:300 alone bought nothing. Until 33abd991 that did not
  // matter: the old claim ladder re-pinned the avatar at its base on every claim, so casting
  // was free -- a bug, and s59 lived on it (20 casts in #114). With the spend claimed honestly
  // (461) the pool depletes as it should, and #115 drained after one cast (2 hits in 41).
  // s147's answer: one legal base step (+60, playerstate MAX_BASE_STEP), then the pool up to it;
  // castAt tops it up before every press.
  const peerMp = String(await c.eval('window.omw.state.selfMagicka||""')); // 'c/b' once the peer rules the bars
  const mpBase = (Number(peerMp.split('/')[1]) || 40) + 60;
  await c.cmd(`setmpbase:${mpBase}`);
  await ctx.sleep(1_500); // the base claim lands before the pool claim is capped against it
  await c.cmd(`setmp:${mpBase}`);
  c.mpPool = mpBase;
  await ctx.sleep(2_000); // skills + spellbook diff out (the avatar's copy must agree)
  await c.cmd('stance:spell');
  await c.waitFor('window.omw.state.stance === "spell"', 10_000, 'the spell stance is up');
}

// One cast at a point: face it (yaw + pitch, the hand's height is handled by face:), press.
export async function castAt(c, ctx, target) {
  // Refill first (a restore-magicka potion, in effect): the restore budget is 4 x base per
  // 10 s, far above a cast every two seconds.
  if (c.mpPool) await c.cmd(`setmp:${c.mpPool}`);
  await c.cmd(`face:${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z + 60)}`);
  await ctx.sleep(400);
  await c.cmd('press:500');
  await ctx.sleep(1_800); // the cast animation, the touch/flight, the report back
}
