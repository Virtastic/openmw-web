// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M5 combat relay: target routing matrix, holder/epoch guarding for actor targets, the
// PvP plugin gate, damage cap rejection, and cosmetic cell-scoped fan-out.

import test from 'node:test';
import assert from 'node:assert/strict';
// The sim peer holds the cells; players attack INTO a simulation they do not own.
const PEER_PASS = 'peer-secret-1';
import { startServer } from '../src/server';
import type { JsLike } from '../src/proto/lser';
import { TestClient, tmpDataDir } from './helpers';
import { onLog, type LogEntry } from '../src/log';

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

// #362: A HUMAN'S CombatHit INTO A CELL A SIMULATOR HOLDS IS REFUSED -- the peer's avatar swings
// for the player (Phase 4C) and combat.lua forwards only mpTest hits, so a relayed one is a
// modified client's declared damage. The routing machinery below (holder, epoch, proximity,
// parking, the refusal report) is therefore exercised with CombatSpellHit, which takes the same
// resolveOwner path; every caster learns the test spell in scenario(). CombatHit keeps its own
// shape checks and the degraded-mode (holderless) relay, asserted in the fatigue test.
const TEST_SPELL = 'mp_test_bolt';
function spellBody(target: JsLike, casterId: number, magnitude = 15) {
  return { target, spellId: TEST_SPELL, casterId, effects: [{ id: 'fire_damage', magnitude, duration: 3 }] };
}
async function learn(...cs: TestClient[]) {
  for (const c of cs) c.sendEvent('PlayerSpellbook', { add: [TEST_SPELL], remove: [] });
}

// Brings up a server plus three in-world clients: two in cell "0,0" (attacker + victim,
// attacker holds authority since it entered first) and one far away in "40,40".
async function scenario(t: { after(fn: () => unknown): void }, pvp: boolean) {
  const server = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    // Every client shares 127.0.0.1, so the per-IP cap must not gate the scenario.
    configOverride: { rules: { pvp }, limits: { maxConnsPerIp: 16 }, server: { password: PEER_PASS } },
  });
  t.after(() => server.close());

  // The PEER holds 0,0 (and, being a peer, the 3x3 around it — which covers nothing else
  // used here). Combatants are ordinary players addressing actors they do not own, which is
  // the real shape: a player never holds the cell it is fighting in.
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  peer.sendCellChange('0,0', 0, 0, 0);
  const grant = await peer.waitEvent('ActorAuthorityGrant',
    (v) => (v as { cellKey: string }).cellKey === '0,0');
  const epoch = (grant.value as { epoch: number }).epoch;

  const atk = await TestClient.connect(server.port);
  const { playerId: atkId, welcome } = await atk.joinAsNew('Attacker');
  await atk.waitEvent('PlayerList');
  atk.sendCellChange('0,0', 0, 0, 0);
  await atk.waitEvent('PlayerCellChange');
  await atk.waitEvent('ActorAuthorityInfo');

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
  // No grant, and no Info: 40,40 is far outside the peer's footprint, so that cell simply has
  // no holder. The point of `far` is that it is out of range, which is unchanged.
  await learn(atk, vic, far); // #362: the routing tests cast

  return { server, peer, atk, vic, far, atkId, vicId, epoch, welcome };
}

// Chat fences ride the same per-connection FIFO, so once a client sees the fence, any
// combat frame that was going to reach it already has.
async function fence(from: TestClient, ...watchers: TestClient[]) {
  // '!' = the GLOBAL tier. Plain say is proximity-scoped (Phase 2.5), and a fence whose
  // watchers stand in other cells must not depend on hearing a neighbour.
  const text = `fence-${Math.random().toString(36).slice(2)}`;
  from.sendEvent('ChatSend', { text: `!${text}` });
  for (const w of watchers) await w.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === text);
}

// UNARMED ATTACKS DAMAGE FATIGUE, NOT HEALTH, and the server used to require damage.health.
//
// The engine builds the damage table with EITHER health OR fatigue and never both
// (mwlua/luamanagerimp.cpp onHit: `if (isHealth) damageTable["health"] = damage; else
// damageTable["fatigue"] = damage;`). In Morrowind a hand-to-hand blow is a fatigue hit, so
// demanding health dropped EVERY unarmed swing in the game. It fails silently and total:
// puppet.lua's onHitIntercept has already cancelled the local damage chain by then, so the
// player swings through the target and nothing happens at all -- no damage, no miss, no sound.
// Reported from live play as "I cannot attack anything", with the server logging
// combat.dropped/"damage.health missing or over cap" once per swing.
test('a fatigue-only hit (hand-to-hand) is relayed, not dropped', async (t) => {
  const { vic, vicId, atk, atkId } = await scenario(t, true);
  // #362: the CombatHit relay survives only where no simulator holds the victim's cell
  // (degraded mode). Both walk to an unheld cell first.
  atk.sendCellChange('50,50', 0, 0, 0);
  await atk.waitEvent('PlayerCellChange', (v) => (v as { id?: number }).id === atkId && (v as { cellKey?: string }).cellKey === '50,50');
  vic.sendCellChange('50,50', 0, 0, 0);
  await vic.waitEvent('PlayerCellChange', (v) => (v as { id?: number }).id === vicId && (v as { cellKey?: string }).cellKey === '50,50');

  const fatigueOnly = {
    target: { playerId: vicId },
    damage: { fatigue: 12 },   // no health key at all — exactly what an unarmed hit sends
    strength: 0.8,
    sourceType: 'melee',
    successful: true,
  };
  atk.sendEvent('CombatHit', fatigueOnly);
  const got = await vic.waitEvent('CombatHit');
  const v = got.value as { damage: { fatigue: number; health?: number } };
  assert.equal(v.damage.fatigue, 12);
  assert.equal(v.damage.health, undefined);

  // A damage table with NO channel at all is still refused — this widened the rule, it did
  // not remove it. Asserted by silence: the victim must receive nothing more.
  const before = vic.inbox.events.filter((e) => e.name === 'CombatHit').length;
  atk.sendEvent('CombatHit', { ...fatigueOnly, damage: {} });
  await fence(atk, atk, vic);
  assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatHit').length, before);
});

test('combat routing with pvp enabled', async (t) => {
  const { server, peer, atk, vic, far, atkId, vicId, epoch, welcome } = await scenario(t, true);

  await t.test('a human melee hit into a held cell is refused (#362)', async () => {
    atk.sendEvent('CombatHit', hitBody({ playerId: vicId }));
    vic.sendEvent('CombatHit', hitBody({ ref: ACTOR_REF, cellKey: '0,0', epoch }));
    await fence(atk, vic, peer);
    await fence(vic, vic, peer);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatHit').length, 0, 'the peer resolves melee: a client hit on a player was relayed');
    assert.equal(peer.inbox.events.filter((e) => e.name === 'CombatHit').length, 0, 'the peer resolves melee: a client hit on an actor was relayed');
  });

  await t.test('player target reaches the victim only', async () => {
    atk.sendEvent('CombatSpellHit', spellBody({ playerId: vicId }, atkId));
    const got = await vic.waitEvent('CombatSpellHit');
    const v = got.value as { attackerId: number; spellId: string; target: { playerId: number } };
    assert.equal(v.attackerId, atkId); // server stamps the attacker
    assert.equal(v.spellId, TEST_SPELL);
    assert.equal(v.target.playerId, vicId);
    await fence(atk, atk, far);
    assert.equal(atk.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0); // no echo
    assert.equal(far.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0); // no bystander
  });

  // #35: PvP attribution. The relayed harmful hit stamps the victim's lastHitBy; a death
  // within 10 s of it logs killedBy, an older one does not.
  await t.test('a death within 10 s of a player hit is attributed to that player', async () => {
    const victim = server.roster.get(vicId)!;
    assert.deepEqual({ id: victim.lastHitBy?.id, name: victim.lastHitBy?.name }, { id: atkId, name: 'Attacker' });
    const deaths: LogEntry[] = [];
    const off = onLog((e) => { if (e.event === 'player.death') deaths.push(e); });
    try {
      vic.sendEvent('PlayerDeath', {});
      await fence(vic, vic);
      assert.deepEqual(deaths.at(-1)?.['killedBy'], { id: atkId, name: 'Attacker' });
      victim.lastHitBy!.at -= 11_000; // the hit is stale now
      vic.sendEvent('PlayerDeath', {});
      await fence(vic, vic);
      assert.equal(deaths.length, 2);
      assert.equal(deaths.at(-1)?.['killedBy'], undefined, 'an 11 s old hit is not the killer');
    } finally { off(); }
  });

  await t.test('actor target reaches the authority holder only', async () => {
    // A player attacks an actor; only the cell's holder — the sim peer — gets it. Both
    // combatants are non-holders now, which is the only shape that exists.
    vic.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: '0,0', epoch }, vicId));
    const got = await peer.waitEvent('CombatSpellHit');
    assert.equal((got.value as { attackerId: number }).attackerId, vicId);
    await fence(vic, vic, far);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0);
    assert.equal(far.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0);
  });

  await t.test('stale epoch and dormant cell are dropped', async () => {
    peer.inbox.events.length = 0;
    vic.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: '0,0', epoch: epoch + 99 }, vicId));
    vic.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: 'nobody-here', epoch: 1 }, vicId));
    await fence(vic, peer);
    assert.equal(peer.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0);
  });

  await t.test('non-holder may omit epoch; proximity is the presence proof', async () => {
    // The common case: a non-holder attacks an NPC in a cell someone else simulates.
    // It has no Grant, so it quotes no epoch — the hit must still reach the holder.
    vic.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: '0,0' }, vicId));
    const got = await peer.waitEvent('CombatSpellHit');
    assert.equal((got.value as { attackerId: number }).attackerId, vicId);
    // But a distant player cannot reach into the cell, epoch or not.
    peer.inbox.events.length = 0;
    far.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: '0,0' }, 0));
    far.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: '0,0', epoch }, 0));
    await fence(far, peer);
    assert.equal(peer.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0);
  });

  await t.test('ActorAuthorityInfo carries the live epoch', async () => {
    // Victim entered a cell already held by the attacker; its Info must let it address
    // actors there without ever receiving a Grant.
    const late = await TestClient.connect(server.port);
    await late.joinAsNew('Late');
    await late.waitEvent('PlayerList');
    late.sendCellChange('0,0', 0, 0, 0);
    const info = await late.waitEvent('ActorAuthorityInfo');
    assert.deepEqual(info.value, { cellKey: '0,0', holderId: peer.playerId, epoch });
    await learn(late);
    peer.inbox.events.length = 0;
    late.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: '0,0', epoch: (info.value as { epoch: number }).epoch }, late.playerId!));
    await peer.waitEvent('CombatSpellHit');
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
    // A valid one still lands afterwards (the session survives bad frames). #362: a cast --
    // melee into a held cell is refused whatever its shape.
    atk.sendEvent('CombatSpellHit', spellBody({ playerId: vicId }, atkId, 1000)); // exactly at cap
    assert.equal(((await vic.waitEvent('CombatSpellHit')).value as { effects: { magnitude: number }[] }).effects[0]!.magnitude, 1000);
  });

  await t.test('CombatSpellHit routes like CombatHit and caps effect magnitudes', async () => {
    const spell = (target: JsLike, magnitude = 15, spellId = 'fire_bite') => ({
      target, spellId, casterId: atkId,
      effects: [{ id: 'fire_damage', magnitude, duration: 3 }],
    });
    // THE CASTER MUST KNOW THE SPELL (backlog 252): before the spellbook says so, the same
    // hit is refused -- a modified client used to land any retail spell on anyone nearby.
    atk.sendEvent('CombatSpellHit', spell({ playerId: vicId }));
    await fence(atk, vic);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0,
      'a spell the caster does not know was routed');
    atk.sendEvent('PlayerSpellbook', { add: ['fire_bite'], remove: [] });
    atk.sendEvent('CombatSpellHit', { ...spell({ playerId: vicId }), indexes: [1, 0], ignoreReflect: true });
    const got = await vic.waitEvent('CombatSpellHit');
    assert.equal((got.value as { spellId: string }).spellId, 'fire_bite');
    // Which effects hit travels with the cast (backlog 250), and so does the reflect word (254).
    assert.deepEqual((got.value as { indexes: number[] }).indexes, [1, 0]);
    assert.equal((got.value as { ignoreReflect: boolean }).ignoreReflect, true);
    // An ITEM source (a scroll, a cast-when-used ring) counts when the inventory holds it.
    vic.inbox.events.length = 0;
    atk.sendEvent('CombatSpellHit', spell({ playerId: vicId }, 15, 'sc_fireball'));
    await fence(atk, vic);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0, 'a scroll the caster does not carry was routed');
    atk.sendEvent('PlayerInventory', { items: [{ id: 'sc_fireball', n: 1 }] });
    atk.sendEvent('CombatSpellHit', spell({ playerId: vicId }, 15, 'sc_fireball'));
    assert.equal(((await vic.waitEvent('CombatSpellHit')).value as { spellId: string }).spellId, 'sc_fireball');
    vic.inbox.events.length = 0;
    atk.sendEvent('CombatSpellHit', spell({ playerId: vicId }, 99999)); // over cap
    atk.sendEvent('CombatSpellHit', { ...spell({ playerId: vicId }), indexes: [0, 'x'] }); // malformed indexes
    atk.sendEvent('CombatSpellHit', { ...spell({ playerId: vicId }), indexes: [64] }); // out of range
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
    // Asserts the two fields this test is about, not the whole flags schema: flags is a
    // growing bag (render LOD joined it in G2) and a deep-equal here fails every time an
    // unrelated field is added, which says nothing about combat.
    assert.equal((welcome['flags'] as Record<string, unknown>).pvp, true);
    assert.equal((welcome['flags'] as Record<string, unknown>).difficulty, 0);
  });

  await t.test('SessionWelcome.flags carries the render-LOD contract', () => {
    // The client cannot tier avatars without these, and it deliberately falls back to full
    // fidelity when they are absent — so a server that quietly stopped sending them would
    // not fail anything, it would just cost every player ~1.3ms of frame time per avatar.
    // Assert the wire contract explicitly rather than relying on that fallback.
    const f = welcome['flags'] as Record<string, unknown>;
    assert.ok(f.renderLod === 'tiered' || f.renderLod === 'full', `bad renderLod ${String(f.renderLod)}`);
    assert.ok(Number(f.lodNearRadius) > 0 && Number(f.lodMidRadius) >= Number(f.lodNearRadius),
      `radii must be positive and ordered, got near=${String(f.lodNearRadius)} mid=${String(f.lodMidRadius)}`);
  });

  // LAST IN THIS SUITE ON PURPOSE. Delivering a parked swing requires moving the peer onto the
  // cell it was parked for, which takes it off '0,0' and bumps that cell's epoch — every test
  // above depends on the peer holding '0,0' at the epoch captured during setup. Placed here so
  // the side effect cannot reach them. (Learned by moving it: four unrelated tests went red.)
  await t.test('a swing into an unsimulated cell is PARKED, then delivered', async () => {
    // The attacker's client cancels its own damage before sending (puppet.lua's onHit
    // interceptor returns false), so discarding a hit costs the whole attack. A cell with no
    // holder is a MOMENTARY state — the sim peer is restarting, or has not picked the cell up
    // yet — so the swing is held rather than thrown away, and lands when the cell is granted.
    // '0,1' is adjacent to the attacker (so it passes proximity) and unheld.
    vic.inbox.events.length = 0;
    peer.inbox.events.length = 0;
    vic.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: '0,1' }, vicId));
    await fence(vic, peer);
    assert.equal(peer.inbox.events.filter((e) => e.name === 'CombatSpellHit').length, 0,
      'nothing to deliver to yet: the cell has no holder');
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatRefused').length, 0,
      'a parked swing must not be reported as refused — it has not failed yet');

    // The peer takes the cell. The parked swing must now land, with every ordinary guard still
    // applied to the delivery.
    peer.sendCellChange('0,1', 0, 0, 0);
    const landed = await peer.waitEvent('CombatSpellHit');
    assert.equal((landed.value as { attackerId: number }).attackerId, vicId,
      'the delivered hit lost its attacker');
    assert.equal((landed.value as { effects: { magnitude: number }[] }).effects[0]!.magnitude, 15,
      'the delivered hit lost its damage');
  });

  await t.test('a swing that genuinely cannot land is explained to the attacker', async () => {
    // A STALE epoch is not a momentary gap — the client is addressing a simulator generation
    // that is gone, and holding it would only deliver it to the wrong one. Refused, and said.
    vic.inbox.events.length = 0;
    // '0,1', because the test above moved the peer there — a stale epoch only means anything
    // for a cell that HAS a holder; without one the swing would be parked, not refused.
    vic.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: '0,1', epoch: epoch + 99 }, vicId));
    const stale = await vic.waitEvent('CombatRefused');
    assert.equal((stale.value as { reason: string }).reason, 'stale epoch');

    // But a malformed body is a CLIENT bug the player cannot act on, and an anti-cheat trip must
    // not tell the client which check it hit. Neither is reported back.
    vic.inbox.events.length = 0;
    vic.sendEvent('CombatHit', 'not a table' as never);
    await fence(vic, peer);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatRefused').length, 0);
  });

});

test('pvp gate blocks player targets but not actor targets', async (t) => {
  const { peer, atk, vic, epoch, vicId, welcome } = await scenario(t, false);

  await t.test('player-targeted hit is vetoed by the pvp plugin', async () => {
    atk.sendEvent('PlayerSpellbook', { add: ['fire_bite', 'hearth_heal'], remove: [] });
    atk.sendEvent('CombatHit', hitBody({ playerId: vicId }));
    atk.sendEvent('CombatSpellHit', {
      target: { playerId: vicId }, spellId: 'fire_bite', casterId: 1,
      effects: [{ id: 'fire_damage', magnitude: 10, duration: 1 }],
    });
    // A cast that calls itself beneficial while ONE of its hits is harmful is an attack
    // (backlog 249): the whole-cast word is every hit's, not the best one's.
    atk.sendEvent('CombatSpellHit', {
      target: { playerId: vicId }, spellId: 'fire_bite', casterId: 1, beneficial: true,
      effects: [{ id: 'restorehealth', magnitude: 10, duration: 1, beneficial: true },
        { id: 'firedamage', magnitude: 10, duration: 1, beneficial: false }],
    });
    await fence(atk, vic);
    assert.equal(vic.inbox.events.filter((e) => e.name === 'CombatHit' || e.name === 'CombatSpellHit').length, 0);
    // A heal on a friend still crosses.
    atk.sendEvent('CombatSpellHit', {
      target: { playerId: vicId }, spellId: 'hearth_heal', casterId: 1, beneficial: true,
      effects: [{ id: 'restorehealth', magnitude: 10, duration: 1, beneficial: true }],
    });
    assert.equal(((await vic.waitEvent('CombatSpellHit')).value as { beneficial: boolean }).beneficial, true);
  });

  await t.test('actor-targeted hit still routes to the holder', async () => {
    vic.sendEvent('CombatSpellHit', spellBody({ ref: ACTOR_REF, cellKey: '0,0', epoch }, vicId)); // #362: a cast, not melee
    const got = await peer.waitEvent('CombatSpellHit');
    assert.equal((got.value as { effects: { magnitude: number }[] }).effects[0]!.magnitude, 15);
  });

  await t.test('Welcome flags report pvp=false', () => {
    assert.equal((welcome['flags'] as Record<string, unknown>).pvp, false);
    assert.equal((welcome['flags'] as Record<string, unknown>).difficulty, 0);
  });
});
