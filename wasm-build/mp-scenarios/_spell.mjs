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
  await c.cmd('setmp:300');
  await ctx.sleep(2_000); // skills + spellbook diff out (the avatar's copy must agree)
  await c.cmd('stance:spell');
  await c.waitFor('window.omw.state.stance === "spell"', 10_000, 'the spell stance is up');
}

// One cast at a point: face it (yaw + pitch, the hand's height is handled by face:), press.
export async function castAt(c, ctx, target) {
  await c.cmd(`face:${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z + 60)}`);
  await ctx.sleep(400);
  await c.cmd('press:500');
  await ctx.sleep(1_800); // the cast animation, the touch/flight, the report back
}
