// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// WHAT THE SERVER CAN ACTUALLY ENFORCE ABOUT COMBAT.
//
// It cannot compute damage: armour, resistances and difficulty all live in game data the
// server process does not load, which is why the VICTIM's client applies the hit. So the
// attacker declares rather than authors — and what the server can bound is the shape (already
// capped by maxHitDamage), the RATE, and the PROXIMITY.
//
// Both of those were missing. maxHitDamage refuses one absurd blow but nothing stopped a
// modified client sending a capped hit every frame, which is the same kill with more messages;
// and resolveOwner checked cellsVisible for actor targets but not for player targets, so a
// player could be hit from anywhere in the world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Combat } from '../src/core/combat';
import type { Player, Roster } from '../src/core/players';

function fakePlayer(id: number, cellKey: string): Player {
  const sent: { name: string; body: unknown }[] = [];
  return {
    id, name: `P${id}`, accountKey: `p${id}`, inWorld: true, cellKey,
    peer: { sendEvent: (name: string, body: unknown) => sent.push({ name, body }), sent },
  } as unknown as Player;
}
const sentOf = (p: Player): { name: string }[] =>
  (p.peer as unknown as { sent: { name: string }[] }).sent;

function harness(attackerCell: string, victimCell: string) {
  const attacker = fakePlayer(1, attackerCell);
  const victim = fakePlayer(2, victimCell);
  const roster = { get: (id: number) => (id === 2 ? victim : undefined) } as unknown as Roster;
  const combat = new Combat({
    roster, maxHitDamage: 1000,
    holderOf: () => 2, epochOf: () => 1,
    allowPlayerHit: () => true,
  });
  return { combat, attacker, victim };
}

const hitBody = (): Map<string, unknown> => new Map<string, unknown>([
  ['target', new Map<string, unknown>([['playerId', 2]])],
  ['damage', new Map<string, unknown>([['health', 10]])],
  ['strength', 1],
  ['sourceType', 'weapon'],
  ['successful', true],
]);

test('a hit lands when the attacker is near the victim', () => {
  const h = harness('0,0', '0,0');
  h.combat.handleEvent(h.attacker, 'CombatHit', hitBody() as never);
  assert.equal(sentOf(h.victim).filter((e) => e.name === 'CombatHit').length, 1);
});

test('a player cannot be hit from across the map', () => {
  const h = harness('0,0', '90,90');
  h.combat.handleEvent(h.attacker, 'CombatHit', hitBody() as never);
  assert.equal(sentOf(h.victim).length, 0,
    'a player was hit from a cell the attacker cannot even see');
});

test('hits are rate limited above anything a real client sends', () => {
  const h = harness('0,0', '0,0');
  for (let i = 0; i < 200; i++) h.combat.handleEvent(h.attacker, 'CombatHit', hitBody() as never);
  const landed = sentOf(h.victim).filter((e) => e.name === 'CombatHit').length;
  assert.ok(landed < 200, 'every one of 200 instant hits was relayed');
  // The burst must still be generous enough that a real flurry is never clipped.
  assert.ok(landed >= 20, `only ${landed} hits allowed; a real attack sequence would be cut off`);
});
