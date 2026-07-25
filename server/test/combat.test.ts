// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M5 combat relay: target routing matrix, holder/epoch guarding for actor targets, the
// PvP plugin gate, damage cap rejection, and cosmetic cell-scoped fan-out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import type { JsLike } from '../src/proto/lser';
import { TestClient, tmpDataDir } from './helpers';

const ACTOR_REF = { __refnum: { index: 42, contentFile: 0 } };

function hitBody(target: JsLike, health = 25) {
  return {
    target,
    damage: { health },
    strength: 0.8,
    sourceType: 'weapon',
    weaponId: 'iron_longsword',
    hitPos: { x: 1, y: 2, z: 3 },
    successful: true,
  };
}

// Brings up a server plus three in-world clients: two in cell "0,0" (attacker + victim,
// attacker holds authority since it entered first) and one far away in "40,40".
async function scenario(t: { after(fn: () => unknown): void }, pvp: boolean) {
  const server = await startServer({
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    // Every client shares 127.0.0.1, so the per-IP cap must not gate the scenario.
    configOverride: { rules: { pvp }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());

  const atk = await TestClient.connect(server.port);
  const { playerId: atkId, welcome } = await atk.joinAsNew('Attacker');
  await atk.waitEvent('PlayerList');
  atk.sendCellChange('0,0', 0, 0, 0);
  await atk.waitEvent('PlayerCellChange');
  const grant = await atk.waitEvent('ActorAuthorityGrant');
  const epoch = (grant.value as { epoch: number }).epoch;

  const vic = await TestClient.connect(server.port);
  const { playerId: vicId } = await vic.joinAsNew('Victim');
  await vic.waitEvent('PlayerList');
  vic.sendCellChange('0,0', 0, 0, 0);
  await vic.waitEvent('PlayerCellChange');
  await vic.waitEvent('ActorAuthorityInfo');

  const far = await TestClient.connect(server.port);
  await far.joinAsNew('Far');
  await far.waitEvent('PlayerList');
  far.sendCellChange('40,40', 0, 0, 0);
  await far.waitEvent('PlayerCellChange');
  await far.waitEvent('ActorAuthorityGrant');

  return { server, atk, vic, far, atkId, vicId, epoch, welcome };
}

// Chat fences ride the same per-connection FIFO, so once a client sees the fence, any
// combat frame that was going to reach it already has.
async function fence(from: TestClient, ...watchers: TestClient[]) {
  const text = `fence-${Math.random().toString(36).slice(2)}`;
  from.sendEvent('ChatSend', { text });
  for (const w of watchers) await w.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === text);
}

test('combat routing with pvp enabled', async (t) => {
  const { server, atk, vic, far, atkId, vicId, epoch, welcome } = await scenario(t, true);

  await t.test('player target reaches the victim only', async () => {
    atk.sendEvent('CombatHit', hitBody({ playerId: vicId }));
    const got = await vic.waitEvent('CombatHit');
    const v = got.value as { attackerId: number; damage: { health: number }; target: { playerId: number } };
    assert.equal(v.attackerId, atkId); // server stamps the attacker
    assert.equal(v.damage.health, 25); // raw pre-mitigation damage passes through
    assert.equal(v.target.playerId, vicId);
    await fence(atk, atk, far);
    assert.equal(atk.inbox.events.filter((e) => e.name === 'CombatHit').length, 0); // no echo
    assert.equal(far.inbox.events.filter((e) => e.name === 'CombatHit').length, 0); // no bystander
  });

  await t.test('actor target reaches the authority holder only', async () => {
    // Victim (a non-holder in 0,0) attacks an actor; only the holder (attacker) gets it.
    vic.sendEvent('CombatHit', hitBody({ ref: ACTOR_REF, cellKey: '0,0', epoch }));
    const got = await atk.waitEvent('CombatHit');
    assert.equal((got.value as { attackerId: number }).attackerId, vicId);
    await fence(vic, vic, far);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatHit').length, 0);
    assert.equal(far.inbox.events.filter((e) => e.name === 'CombatHit').length, 0);
  });

  await t.test('stale epoch and dormant cell are dropped', async () => {
    vic.sendEvent('CombatHit', hitBody({ ref: ACTOR_REF, cellKey: '0,0', epoch: epoch + 99 }));
    vic.sendEvent('CombatHit', hitBody({ ref: ACTOR_REF, cellKey: 'nobody-here', epoch: 1 }));
    await fence(vic, atk);
    assert.equal(atk.inbox.events.filter((e) => e.name === 'CombatHit').length, 0);
  });

  await t.test('non-holder may omit epoch; proximity is the presence proof', async () => {
    // The common case: a non-holder attacks an NPC in a cell someone else simulates.
    // It has no Grant, so it quotes no epoch — the hit must still reach the holder.
    vic.sendEvent('CombatHit', hitBody({ ref: ACTOR_REF, cellKey: '0,0' }));
    const got = await atk.waitEvent('CombatHit');
    assert.equal((got.value as { attackerId: number }).attackerId, vicId);
    // But a distant player cannot reach into the cell, epoch or not.
    far.sendEvent('CombatHit', hitBody({ ref: ACTOR_REF, cellKey: '0,0' }));
    far.sendEvent('CombatHit', hitBody({ ref: ACTOR_REF, cellKey: '0,0', epoch }));
    await fence(far, atk);
    assert.equal(atk.inbox.events.filter((e) => e.name === 'CombatHit').length, 0);
  });

  await t.test('ActorAuthorityInfo carries the live epoch', async () => {
    // Victim entered a cell already held by the attacker; its Info must let it address
    // actors there without ever receiving a Grant.
    const late = await TestClient.connect(server.port);
    await late.joinAsNew('Late');
    await late.waitEvent('PlayerList');
    late.sendCellChange('0,0', 0, 0, 0);
    const info = await late.waitEvent('ActorAuthorityInfo');
    assert.deepEqual(info.value, { cellKey: '0,0', holderId: atkId, epoch });
    late.sendEvent('CombatHit', hitBody({ ref: ACTOR_REF, cellKey: '0,0', epoch: (info.value as { epoch: number }).epoch }));
    await atk.waitEvent('CombatHit');
    late.close();
    await late.closed;
  });

  await t.test('unknown target player is dropped', async () => {
    atk.sendEvent('CombatHit', hitBody({ playerId: 60000 }));
    await fence(atk, vic);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatHit').length, 0);
  });

  await t.test('damage over the cap and malformed bodies are rejected', async () => {
    atk.sendEvent('CombatHit', hitBody({ playerId: vicId }, 5000)); // cap 1000
    atk.sendEvent('CombatHit', hitBody({ playerId: vicId }, Number.POSITIVE_INFINITY));
    atk.sendEvent('CombatHit', { ...hitBody({ playerId: vicId }), damage: { health: 10, fatigue: 99999 } });
    atk.sendEvent('CombatHit', { ...hitBody({ playerId: vicId }), successful: 'yes' }); // wrong type
    atk.sendEvent('CombatHit', { ...hitBody({ playerId: vicId }), hitPos: { x: 9e9, y: 0, z: 0 } });
    atk.sendEvent('CombatHit', { ...hitBody({ playerId: vicId }), weaponId: 'x'.repeat(65) });
    await fence(atk, vic);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatHit').length, 0);
    // A valid one still lands afterwards (the session survives bad frames).
    atk.sendEvent('CombatHit', hitBody({ playerId: vicId }, 1000)); // exactly at cap
    assert.equal(((await vic.waitEvent('CombatHit')).value as { damage: { health: number } }).damage.health, 1000);
  });

  await t.test('CombatSpellHit routes like CombatHit and caps effect magnitudes', async () => {
    const spell = (target: JsLike, magnitude = 15) => ({
      target, spellId: 'fire_bite', casterId: atkId,
      effects: [{ id: 'fire_damage', magnitude, duration: 3 }],
    });
    atk.sendEvent('CombatSpellHit', spell({ playerId: vicId }));
    const got = await vic.waitEvent('CombatSpellHit');
    assert.equal((got.value as { spellId: string }).spellId, 'fire_bite');
    atk.sendEvent('CombatSpellHit', spell({ playerId: vicId }, 99999)); // over cap
    await fence(atk, vic);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0);
  });

  await t.test('cast and projectile fan out cell-scoped, excluding the sender', async () => {
    atk.sendEvent('CombatCast', { spellId: 'fire_bite', casterId: atkId, kind: 'spell', target: { playerId: vicId } });
    const cast = await vic.waitEvent('CombatCast');
    assert.equal((cast.value as { fromId: number }).fromId, atkId);
    atk.sendEvent('CombatProjectile', {
      kind: 'arrow', recordId: 'iron_arrow', from: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 },
      speed: 900, casterId: atkId,
    });
    assert.equal(((await vic.waitEvent('CombatProjectile')).value as { kind: string }).kind, 'arrow');
    // Invalid kind is dropped.
    atk.sendEvent('CombatProjectile', {
      kind: 'banana', from: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, speed: 1, casterId: atkId,
    });
    await fence(atk, vic, far);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatProjectile').length, 0);
    assert.equal(atk.inbox.events.filter((e) => e.name === 'CombatCast').length, 0); // no self-echo
    assert.equal(far.inbox.events.filter((e) => e.name === 'CombatCast').length, 0); // far cell excluded
  });

  await t.test('SessionWelcome.flags carries pvp and difficulty', () => {
    assert.deepEqual(welcome['flags'], { pvp: true, difficulty: 0 });
  });
});

test('pvp gate blocks player targets but not actor targets', async (t) => {
  const { atk, vic, epoch, vicId, welcome } = await scenario(t, false);

  await t.test('player-targeted hit is vetoed by the pvp plugin', async () => {
    atk.sendEvent('CombatHit', hitBody({ playerId: vicId }));
    atk.sendEvent('CombatSpellHit', {
      target: { playerId: vicId }, spellId: 'fire_bite', casterId: 1,
      effects: [{ id: 'fire_damage', magnitude: 10, duration: 1 }],
    });
    await fence(atk, vic);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatHit' || e.name === 'CombatSpellHit').length, 0);
  });

  await t.test('actor-targeted hit still routes to the holder', async () => {
    vic.sendEvent('CombatHit', hitBody({ ref: ACTOR_REF, cellKey: '0,0', epoch }));
    const got = await atk.waitEvent('CombatHit');
    assert.equal((got.value as { damage: { health: number } }).damage.health, 25);
  });

  await t.test('Welcome flags report pvp=false', () => {
    assert.deepEqual(welcome['flags'], { pvp: false, difficulty: 0 });
  });
});
