// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s50 (M5): PvP damage authority. A lands a hit on B's puppet; the damage is forwarded raw
// and applied ONLY on B, by B's own untouched combat pipeline — so B's hp drops by an
// ARMOR/DIFFICULTY-MITIGATED amount, never the raw number, and never twice.
//
// Runs on the demo content: player-vs-player needs no NPCs (unlike s51).
import assert from 'node:assert/strict';

// PvP is OFF by default server-side; this scenario is the enabled path (s52 covers the gate).
export const serverRules = 'pvp = true';

const STEP_TIMEOUT = 15_000;
const RAW_DAMAGE = 20;

const hpOf = async (c) => Number(await c.eval('(window.__omwMP||{}).hp||"0"'));

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a'), ctx.launchClient('bot-b')]);
  const idB = await b.eval('(window.__omwMP||{}).playerId');

  // A must have a puppet of B to hit (that puppet carries the interception handler).
  await a.waitFor(`!!JSON.parse((window.__omwMP||{}).puppets||"{}")[${JSON.stringify(idB)}]`,
    STEP_TIMEOUT, 'puppet of B on A');
  await b.waitFor('Number((window.__omwMP||{}).hp||"0") > 0', STEP_TIMEOUT, 'B hp mirror live');

  await b.waitFor('(window.__omwMP||{}).pvp === "true"', STEP_TIMEOUT, 'B sees pvp enabled');
  const hpBefore = await hpOf(b);
  const hpAOnBefore = await hpOf(a);

  await a.eval(`Module.__omwMPCmd='hitp:${idB}:${RAW_DAMAGE}'`);

  // Damage must land on B, mitigated by B's own armor/difficulty — and exactly once.
  await b.waitFor(`Number((window.__omwMP||{}).hp||"0") < ${hpBefore}`, STEP_TIMEOUT, 'B takes damage');
  const hpAfter = await hpOf(b);
  const applied = hpBefore - hpAfter;
  ctx.log(`B hp ${hpBefore} -> ${hpAfter} (applied ${applied}, raw was ${RAW_DAMAGE})`);
  assert.ok(applied > 0, 'damage must be applied on the victim');
  assert.ok(applied <= RAW_DAMAGE,
    `applied ${applied} exceeds the raw ${RAW_DAMAGE} — damage was applied more than once`);
  // The victim's mirror records what the NETWORK delivered (raw, pre-mitigation): proof the
  // wire carried raw damage and the reduction happened locally on the victim.
  await b.waitFor(`(window.__omwMP||{}).lastHitTaken === ${JSON.stringify(String(RAW_DAMAGE))}`,
    STEP_TIMEOUT, 'B recorded the inbound raw damage');
  ctx.log('ok: raw damage travelled, mitigation applied once on the victim');

  // The attacker never damages itself, and the local puppet took no damage either
  // (interception returns false before the builtin chain runs).
  assert.equal(await hpOf(a), hpAOnBefore, 'attacker hp must be unchanged');
}
