// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4A: the peer reports each avatar's dynamic bars; the server owns the doc and hands
// the OWNER their own bars (MP_SelfStats). One writer: while peer reports are fresh, the
// client's own PlayerStatsDynamic assertion is ignored — and a player not driving the input
// tier keeps asserting their own (per-player degraded mode, same rule as avatar poses).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';

const bars = (hp: number) => ({
  hp: { c: hp, b: 100 }, mp: { c: 50, b: 50 }, ft: { c: 80, b: 100 },
});

async function world(t: { after(fn: () => unknown): void }) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const welcome = await a.joinAsNew('Runner');
  a.playerId = welcome['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  return { server, peer, a };
}

test('a driving player gets MP_SelfStats from the peer report, and observers see the relay', async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  // Arm the input tier: the peer's answers only rule a player who is driving.
  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));

  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', {
    entries: [{ id: a.playerId, ...bars(42) }],
  }), 100);
  t.after(() => clearInterval(reporter));

  const self = await a.waitEvent('SelfStats',
    (v) => (v as { hp?: { c?: number } })?.hp?.c === 42);
  assert.ok(self, 'the owner must receive their own bars');
  const seen = await b.waitEvent('PlayerStatsDynamic',
    (v) => (v as { id?: number; hp?: { c?: number } })?.id === a.playerId
      && (v as { hp?: { c?: number } }).hp?.c === 42);
  assert.ok(seen, 'observers render the peer-simulated bars');
});

// Backlog 73: knockdown is not in the engine's stream, so it rides the bars.
test('a knocked-down report reaches the owner as SelfStats.kd', async (t) => {
  const { server, peer, a } = await world(t);
  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', {
    entries: [{ id: a.playerId, ...bars(42), kd: true }],
  }), 100);
  t.after(() => clearInterval(reporter));
  const self = await a.waitEvent('SelfStats', (v) => (v as { kd?: unknown })?.kd === true);
  assert.ok(self, 'the owner must learn they are knocked down');
  void server;
});

test("while peer reports are fresh the client's own assertion is ignored", async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher2');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', {
    entries: [{ id: a.playerId, ...bars(42) }],
  }), 100);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfStats'); // the peer's stream is established

  // The forged full-health claim while the avatar says 42.
  a.sendEvent('PlayerStatsDynamic', bars(100));
  const relayed = await Promise.race([
    b.waitEvent('PlayerStatsDynamic',
      (v) => (v as { id?: number; hp?: { c?: number } })?.id === a.playerId
        && (v as { hp?: { c?: number } }).hp?.c === 100).then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 800)),
  ]);
  assert.equal(relayed, false, 'the client claim must not interleave with the peer stream');
});

test('an input-less player keeps asserting their own bars (per-player degraded mode)', async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher3');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  // NO input from a. The peer's report for them must be ignored...
  peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(1) }] });
  await new Promise((r) => setTimeout(r, 300));
  // ...and their own assertion still rules.
  a.sendEvent('PlayerStatsDynamic', bars(77));
  const seen = await b.waitEvent('PlayerStatsDynamic',
    (v) => (v as { id?: number; hp?: { c?: number } })?.id === a.playerId
      && (v as { hp?: { c?: number } }).hp?.c === 77);
  assert.ok(seen, 'client-authored bars stay live for a player the input tier is not serving');
});

test('a CLIENT sending AvatarStatsBatch is ignored', async (t) => {
  const { server, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  const wb = await b.joinAsNew('Forger');
  b.playerId = wb['playerId'] as number;
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));

  b.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(0) }] });
  const got = await Promise.race([
    a.waitEvent('SelfStats').then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 800)),
  ]);
  assert.equal(got, false, 'only the world peer may author avatar bars');
});

// HEALING while the peer owns your bars. Potions, rest and self-cast healing all still happen
// on the CLIENT's engine (the avatar drinks nothing until the discrete-intent tier), so a
// client claim that RAISES a bar has to reach the avatar -- otherwise every potion did nothing,
// overwritten by the un-restored avatar a moment later. That opening is budgeted: "a raise is a
// restoration" is an immortality exploit without one.
test('a client heal reaches the peer, and sustained fake healing is refused', async (t) => {
  const { peer, a } = await world(t);
  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  // The peer owns the bars and has hurt this player.
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', {
    entries: [{ id: a.playerId, ...bars(20) }],
  }), 150);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfStats', (v) => (v as { hp?: { c?: number } })?.hp?.c === 20);

  // A potion-sized restoration is accepted and forwarded to the avatar.
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', bars(60));
  const restore = await peer.waitEvent('AvatarRestore',
    (v) => (v as { id?: number })?.id === a.playerId);
  assert.equal((restore.value as { hp?: { c?: number } }).hp?.c, 60,
    'a legitimate heal must reach the avatar, or potions do nothing');

  // MAGICKA GOES DOWN TOO. The avatar never casts, so the client is the only thing that spends
  // magicka; a cast's cost is a LOWER claim, and under raise-only it was thrown away and then
  // refilled by the avatar's full bar -- every spell was free. A spend must reach the avatar.
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', { ...bars(60), mp: { c: 10, b: 50 } });
  const spend = await peer.waitEvent('AvatarRestore',
    (v) => (v as { id?: number; mp?: unknown })?.id === a.playerId && (v as { mp?: unknown }).mp !== undefined);
  assert.equal((spend.value as { mp?: { c?: number } }).mp?.c, 10,
    'a magicka spend must reach the avatar, or casting is free while the peer owns the bars');

  // A LEVEL-UP RAISES THE MAXIMUM. The base is client-authored (nothing on the peer levels
  // anyone), so a plausibly stepped new base reaches the avatar with the current preserved --
  // while the peer ruled the bars it used to be dropped with the rest of the claim, and the
  // player who levelled mid-session fought on with the old pool.
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', { ...bars(60), hp: { c: 60, b: 115 } });
  const levelUp = await peer.waitEvent('AvatarRestore',
    (v) => (v as { id?: number; hp?: { b?: number } })?.id === a.playerId && (v as { hp?: { b?: number } }).hp?.b === 115);
  assert.equal((levelUp.value as { hp?: { c?: number } }).hp?.c, 60, 'the current bar is preserved across a raised maximum');
  // ...within reason. A jump the game cannot produce is the modified-client shape: refused.
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', { ...bars(60), hp: { c: 60, b: 900 } });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!peer.inbox.events.some((e) => e.name === 'AvatarRestore' && (e.value as { hp?: { b?: number } })?.hp?.b === 900),
    'a 785-point jump in maximum health was forwarded to the avatar');

  // Now the cheat: claim full health over and over. The budget (2x max health per 10s) runs
  // out and further claims are ignored -- the peer's bars stand.
  peer.inbox.events.length = 0;
  for (let i = 0; i < 40; i++) a.sendEvent('PlayerStatsDynamic', bars(100));
  await new Promise((r) => setTimeout(r, 600));
  const restores = peer.inbox.events.filter((e) => e.name === 'AvatarRestore').length;
  assert.ok(restores < 8,
    `sustained fake healing was accepted ${restores} times -- a modified client would be `
    + 'immortal while the peer owns its bars');

  // MAGICKA HAS THE SAME BUDGET (backlog 253). A spend is accepted like a restore, so the
  // raise direction was unbounded: a modified client refilled its pool at will. The peer
  // reports 50/50 here; claim 5 then 50 over and over -- each pair is a 45-point "restore".
  peer.inbox.events.length = 0;
  for (let i = 0; i < 40; i++) {
    a.sendEvent('PlayerStatsDynamic', { ...bars(20), mp: { c: 5, b: 50 } });
    a.sendEvent('PlayerStatsDynamic', { ...bars(20), mp: { c: 50, b: 50 } });
  }
  await new Promise((r) => setTimeout(r, 600));
  const refills = peer.inbox.events.filter((e) => e.name === 'AvatarRestore'
    && (e.value as { mp?: { c?: number } })?.mp?.c === 50).length;
  assert.ok(refills < 8,
    `sustained fake magicka refills were accepted ${refills} times -- casting would be free`);
});

// THE GAIN, NOT THE BAR (backlog 461, s165 +6..+10 of 50; s150 +0). The client's `c` is
// `last peer report + what it healed since`, and that report is a round trip stale after every
// raise this handler applies: the next claim computed `old report + small gain`, sat BELOW the
// doc, and was ignored as an echo -- while the client had already zeroed the gain. With `d`
// the gain is applied on top of whatever the doc holds, so a heal that ticks across several
// claims lands whole; a peer-authored drop between claims still stands.
test('a claim carrying its gain as `d` lands on top of the doc, not on the stale bar it was built from', async (t) => {
  const { peer, a } = await world(t);
  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  // The peer's report is pinned at 20 for the whole test: it never reflects the raises, which
  // is exactly the window the ladder lost (the report that would is still in flight).
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', {
    entries: [{ id: a.playerId, ...bars(20) }],
  }), 150);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfStats', (v) => (v as { hp?: { c?: number } })?.hp?.c === 20);
  clearInterval(reporter); // the doc keeps the last report (20) while the raises stack
  await new Promise((r) => setTimeout(r, 200));

  const restore = (want: number) => peer.waitEvent('AvatarRestore',
    (v) => (v as { id?: number; hp?: { c?: number } })?.id === a.playerId && (v as { hp?: { c?: number } }).hp?.c === want);
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 30, b: 100, d: 10 } });
  await restore(30);
  // The old shape: `c` computed on the stale report is BELOW the doc (30) -- with `d` it lands.
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 25, b: 100, d: 5 } });
  await restore(35);
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 22, b: 100, d: 2.5 } });
  await restore(37.5);
  // Gains only for health: a negative `d` is the peer's business and changes nothing.
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 5, b: 100, d: -20 } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(peer.inbox.events.filter((e) => e.name === 'AvatarRestore').length, 0, 'a negative health gain was applied');
  // A client without `d` still lands its absolute bar.
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 60, b: 100 } });
  await restore(60);
  // Magicka takes the net change both ways on top of the doc (the report said 50/50).
  a.sendEvent('PlayerStatsDynamic', { mp: { c: 45, b: 50, d: -20 } });
  const spend = await peer.waitEvent('AvatarRestore',
    (v) => (v as { id?: number; mp?: unknown })?.id === a.playerId && (v as { mp?: unknown }).mp !== undefined);
  assert.equal((spend.value as { mp?: { c?: number } }).mp?.c, 30, 'a spend as `d` lands on the doc, not on the stale bar');
  // Capped at the base, and still budgeted: `d` widens nothing.
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 60, b: 100, d: 5000 } });
  await restore(100);
  peer.inbox.events.length = 0;
  for (let i = 0; i < 40; i++) {
    a.sendEvent('PlayerStatsDynamic', { hp: { c: 100, b: 100, d: -90 } });
    a.sendEvent('PlayerStatsDynamic', { mp: { c: 50, b: 50, d: -45 } });
    a.sendEvent('PlayerStatsDynamic', { mp: { c: 50, b: 50, d: 45 } });
  }
  await new Promise((r) => setTimeout(r, 600));
  const refills = peer.inbox.events.filter((e) => e.name === 'AvatarRestore'
    && (e.value as { mp?: { c?: number } })?.mp?.c === 50).length;
  assert.ok(refills < 8, `sustained fake magicka refills through \`d\` were accepted ${refills} times`);
});

// s150 ON THE WIRE (backlog 460, #115 `35 -> 35` with the client's own bar at 59 and the claim
// `59+24.0`). The exact ladder the scenario walks, in both shapes identity.lua can send it:
// the peer reports 35/35; sethpbase steps the maximum (a claim with `d: 0`, base moved); the
// peer confirms 35/95; the queued 8 h rest heals +24 and the claim says so -- as the peer-rules
// branch's bare `{hp}` or, when the report went stale on the client, the full triple with `d`
// on hp only. Either must reach the avatar as 59/95, inside the base-step window and all.
test('the s150 ladder: a base step then a rest gain, in both claim shapes, land 59/95 on the avatar', async (t) => {
  const { peer, a } = await world(t);
  let seq = 0;
  a.sendInput({ move: 1 }, ++seq);
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  let report = { hp: { c: 35, b: 35 }, mp: { c: 50, b: 50 }, ft: { c: 80, b: 100 } };
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...report }] }), 150);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfStats', (v) => (v as { hp?: { b?: number } })?.hp?.b === 35);
  const restore = (c: number, b: number) => peer.waitEvent('AvatarRestore',
    (v) => (v as { id?: number; hp?: { c?: number; b?: number } })?.id === a.playerId
      && (v as { hp?: { c?: number } }).hp?.c === c && (v as { hp?: { b?: number } }).hp?.b === b);
  // sethpbase:95 -- the peer-rules branch claims the moved base with no gain.
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 35, b: 95, d: 0 } });
  await restore(35, 95);
  report = { ...report, hp: { c: 35, b: 95 } };
  await a.waitEvent('SelfStats', (v) => (v as { hp?: { b?: number } })?.hp?.b === 95);
  // The rest: +24 banked, claimed on top of the peer's 35 (the shape #115 printed).
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 59, b: 95, d: 24 } });
  await restore(59, 95);
  // The same rest said from the stale-peer branch: the full snapshot, gain on hp only, the
  // client's own fatigue and magicka riding along (the peer never healed: report still 35).
  peer.inbox.events.length = 0;
  await new Promise((r) => setTimeout(r, 400)); // the pinned report puts the doc back at 35
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 59, b: 95, d: 24 }, mp: { c: 50, b: 50 }, ft: { c: 100, b: 100 } });
  await restore(59, 95);
});

// ACTIVE EFFECTS reach the avatar. Levitate, Water Walking, a potion: cast or drunk on the
// client, applied to that body only -- and the peer's avatar is what physics and NPC awareness
// run against. The client diffs its temporary effects; the server checks the shape and forwards.
test("a client's active effects are forwarded to the peer for the avatar, and garbage is not", async (t) => {
  const { peer, a } = await world(t);
  peer.inbox.events.length = 0;
  // #359: an add needs a source the player has -- a spell in the book or an item in the bag.
  a.sendEvent('PlayerActiveSpells', { add: [{ key: '6', id: 'levitate', effects: [0] }], remove: [] });
  a.sendEvent('PlayerSpellbook', { add: ['levitate', 'fortify_speed'] });
  a.sendEvent('PlayerInventory', { items: [{ id: 'p_water_walking_s', n: 1 }] });
  a.sendEvent('ChatSend', { text: 'srcfence' });
  await peer.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'srcfence');
  assert.equal(peer.inbox.events.filter((e) => e.name === 'AvatarActiveSpells').length, 0,
    'an effect from a source the player does not have reached the avatar (#359)');
  a.sendEvent('PlayerActiveSpells', {
    add: [{ key: '7', id: 'levitate', effects: [0] }, { key: '8', id: 'p_water_walking_s', effects: [0, 1] }],
    remove: [{ key: '3', id: 'chameleon' }],
  });
  const got = await peer.waitEvent('AvatarActiveSpells', (v) => (v as { id?: number })?.id === a.playerId);
  const body = got.value as { add: { id: string; effects: number[] }[]; remove: { id: string }[] };
  assert.deepEqual(body.add.map((s) => s.id), ['levitate', 'p_water_walking_s'], 'both adds reach the peer');
  assert.deepEqual(body.add[1]!.effects, [0, 1], 'effect indexes travel whole');
  assert.equal(body.remove[0]!.id, 'chameleon', 'the removal reaches the peer');

  // Malformed: an effect index out of any spell's range is refused as a whole message.
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerActiveSpells', { add: [{ key: '9', id: 'levitate', effects: [99] }], remove: [] });
  a.sendEvent('PlayerActiveSpells', { add: [{ key: '10', id: 'fortify_speed', effects: [0] }], remove: [] });
  const next = await peer.waitEvent('AvatarActiveSpells', (v) => (v as { id?: number })?.id === a.playerId);
  assert.equal((next.value as { add: { id: string }[] }).add[0]!.id, 'fortify_speed',
    'the malformed message was dropped, the well-formed one after it was forwarded');
});

// WHAT THE WORLD DID TO THE AVATAR comes back. A bite on the peer puts a disease in the avatar's
// spell list; a hostile Paralyze lands on it as an effect. Both must reach the owner's own body,
// the disease persisted; and no client may curse another by sending the batch itself.
test("the peer's report of a disease and a hostile effect reaches the owner; a client's does not", async (t) => {
  const { server, peer, a } = await world(t);
  a.inbox.events.length = 0;
  peer.sendEvent('AvatarEffectsBatch', { entries: [{
    id: a.playerId, spellsAdd: ['ataxia'],
    effectsAdd: [{ id: 'paralyze', effects: [0] }], effectsRemove: [{ id: 'burden' }],
  }] });
  const spells = await a.waitEvent('SelfSpells');
  assert.deepEqual((spells.value as { add: string[] }).add, ['ataxia'], 'the disease reaches the owner');
  const fx = await a.waitEvent('SelfActiveSpells');
  const v = fx.value as { add: { id: string; effects: number[] }[]; remove: { id: string }[] };
  assert.equal(v.add[0]!.id, 'paralyze'); assert.deepEqual(v.add[0]!.effects, [0]);
  assert.equal(v.remove[0]!.id, 'burden');
  // Persisted: a rejoin restores the disease (the record the welcome carries lists it).
  await server.flush();

  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Curser');
  await b.waitEvent('PlayerList');
  a.inbox.events.length = 0;
  b.sendEvent('AvatarEffectsBatch', { entries: [{ id: a.playerId, spellsAdd: ['corprus'] }] });
  b.sendEvent('ChatSend', { text: 'cursefence' });
  await a.waitEvent('ChatMessage', (vv) => (vv as { text?: string }).text === 'cursefence');
  assert.equal(a.inbox.events.filter((e) => e.name === 'SelfSpells').length, 0, 'a client cursed another player');
});

// WHAT OTHERS SEE. Invisibility and Chameleon exist for other people's eyes, and the op went
// to the peer alone: a friend who cast it stayed solid on every screen. Every other client
// now gets the same op (and keeps the visible part for the puppet), and a late joiner is
// handed what each player is under right now.
test("a player's active effects reach the other clients, and a late joiner is caught up", async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher');
  await b.waitEvent('PlayerList');
  b.inbox.events.length = 0;
  a.sendEvent('PlayerSpellbook', { add: ['invisibility'] }); // #359: the source must be known
  a.sendEvent('PlayerActiveSpells', { add: [{ key: '7', id: 'invisibility', effects: [0] }], remove: [] });
  const seen = await b.waitEvent('AvatarActiveSpells', (v) => (v as { id?: number })?.id === a.playerId);
  assert.equal((seen.value as { add: { id: string }[] }).add[0]!.id, 'invisibility', 'the observer gets the op');
  await peer.waitEvent('AvatarActiveSpells', (v) => (v as { id?: number })?.id === a.playerId);

  const c = await TestClient.connect(server.port);
  t.after(() => c.close());
  await c.joinAsNew('Latecomer');
  const catchUp = await c.waitEvent('AvatarActiveSpells', (v) => (v as { id?: number })?.id === a.playerId);
  assert.deepEqual((catchUp.value as { add: { key: string; id: string }[] }).add.map((s) => s.id), ['invisibility'],
    'a late joiner is told what A is under');

  // Gone means gone: after the removal a newer joiner hears nothing about it.
  a.sendEvent('PlayerActiveSpells', { add: [], remove: [{ key: '7', id: 'invisibility' }] });
  await b.waitEvent('AvatarActiveSpells', (v) => ((v as { remove?: unknown[] })?.remove?.length ?? 0) > 0);
  const d = await TestClient.connect(server.port);
  t.after(() => d.close());
  await d.joinAsNew('Later');
  await d.waitEvent('PlayerList');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(d.inbox.events.filter((e) => e.name === 'AvatarActiveSpells').length, 0, 'nothing to catch up on');
});

// A DEATH THE PEER DOES NOT CONFIRM IS NOT A DEATH. The raise-only path already refuses a
// client's hp claim while the peer rules -- but the death EVENT was taken on faith, and a
// respawn is a free full heal and a teleport. With the peer reporting a living body the
// event is dropped and counted; once the peer reports zero it is honoured.
test("a client's PlayerDeath is ignored while the peer reports it alive, honoured once the peer reports 0", async (t) => {
  const { peer, a } = await world(t);
  let seq = 0;
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  let hp = 42;
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(hp) }] }), 100);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfStats', (v) => (v as { hp?: { c?: number } })?.hp?.c === 42);

  a.inbox.events.length = 0;
  a.sendEvent('PlayerDeath', {});
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(a.inbox.events.filter((e) => e.name === 'PlayerResurrect').length, 0, 'a free respawn on a client\'s say-so');

  hp = 0;
  await a.waitEvent('SelfStats', (v) => (v as { hp?: { c?: number } })?.hp?.c === 0);
  a.sendEvent('PlayerDeath', {});
  await a.waitEvent('PlayerResurrect', () => true, 3000);
});

// A REST THAT WAS REFUSED HEALED NOBODY. A guest's wait dialog restores their local body for
// the hours it asked for; the server refuses the hours (timeSkip=owner) and the clock never
// moves -- but the raise that followed was claimed like a potion: a full heal in zero world
// time, repeatable. The claim behind a refused rest is dropped.
test('the heal behind a refused rest does not reach the avatar', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 }, rules: { timeSkip: 'off' } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const welcome = await a.joinAsNew('Sleeper');
  a.playerId = welcome['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  let seq = 0;
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(35) }] }), 100);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfStats', (v) => (v as { hp?: { c?: number } })?.hp?.c === 35);

  a.sendEvent('WorldTimeRequest', { advanceHours: 8, reason: 'rest' });
  await a.waitEvent('WorldTimeRefused');
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 95, b: 100 } }); // the rest's healing, claimed
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(peer.inbox.events.filter((e) => e.name === 'AvatarRestore').length, 0, 'the refused rest\'s heal reached the avatar');

  // A potion after the window is still a heal.
  await new Promise((r) => setTimeout(r, 4_000));
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 60, b: 100 } });
  await peer.waitEvent('AvatarRestore', (v) => (v as { id?: number })?.id === a.playerId, 3000);
});

test('a base raise behind a refused rest lands the base without the heal', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 }, rules: { timeSkip: 'off' } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const welcome = await a.joinAsNew('Leveller');
  a.playerId = welcome['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  let seq = 0;
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(35) }] }), 100);
  t.after(() => clearInterval(reporter));
  await a.waitEvent('SelfStats', (v) => (v as { hp?: { c?: number } })?.hp?.c === 35);

  a.sendEvent('WorldTimeRequest', { advanceHours: 8, reason: 'rest' });
  await a.waitEvent('WorldTimeRefused');
  peer.inbox.events.length = 0;
  a.sendEvent('PlayerStatsDynamic', { hp: { c: 110, b: 110 } }); // levelled up inside the window
  const restore = (await peer.waitEvent('AvatarRestore', (v) => (v as { id?: number })?.id === a.playerId, 3000)).value as { hp?: { c: number; b: number } };
  assert.equal(restore.hp?.b, 110, 'the level-up base was dropped with the refused rest');
  assert.equal(restore.hp?.c, 35, 'the refused rest\'s heal reached the avatar');
});

// Backlog 92 -- pins playerstate.ts handleAvatarStatsBatch's `&& hp.c > 0` on the not-driving
// gate (commit 2cb3dc66): a peer DEATH report lands for an input-less (alt-tabbed) player;
// a living report for the same player is still gated.
test('backlog 92: a peer hp-0 report lands for a non-driving player, hp 1 stays gated', async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher92');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  // NO input from a, ever: lastInputAt is undefined, so the peer's answer does not rule.
  peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(1) }] });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.inbox.events.filter((e) => e.name === 'SelfStats').length, 0, 'a living report for a non-driver is gated');
  assert.equal(b.inbox.events.filter((e) => e.name === 'PlayerStatsDynamic' && (e.value as { id?: number }).id === a.playerId).length, 0);

  peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(0) }] });
  const self = await a.waitEvent('SelfStats', (v) => (v as { hp?: { c?: number } })?.hp?.c === 0);
  assert.ok(self, 'the avatar died in the world: the death reaches its owner even while not driving');
  await b.waitEvent('PlayerStatsDynamic',
    (v) => (v as { id?: number; hp?: { c?: number } })?.id === a.playerId && (v as { hp?: { c?: number } }).hp?.c === 0);
});

// Backlog 134 -- pins playerstate.ts `speed: baseSpeed(ctx, p)` on the peer relay (commit
// 5c0c177f): the owner's base Speed from the doc rides PlayerStatsDynamic to observers.
test('backlog 134: PlayerStatsDynamic carries the owner\'s base Speed from the doc', async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher134');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  a.sendEvent('PlayerAttributes', { speed: 73 }); // first declaration: accepted as chargen's
  await new Promise((r) => setTimeout(r, 200));

  let seq = 0;
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(42) }] }), 100);
  t.after(() => clearInterval(reporter));
  const seen = await b.waitEvent('PlayerStatsDynamic',
    (v) => (v as { id?: number; hp?: { c?: number } })?.id === a.playerId && (v as { hp?: { c?: number } }).hp?.c === 42);
  assert.equal((seen.value as { speed?: number }).speed, 73, 'the puppet must run at the owner\'s Speed, not the template\'s');
});

// Backlog 312 -- pins playerstate.ts's `/^(Light|Medium|Heavy) Armor Hit$/` whitelist on
// SelfStats.blk (commit cfb2a83f): one shield sound name passes, anything else is dropped.
test('backlog 312: SelfStats.blk relays a whitelisted armor hit sound and drops anything else', async (t) => {
  const { peer, a } = await world(t);
  let seq = 0;
  const timer = setInterval(() => a.sendInput({ move: 1 }, ++seq), 100);
  t.after(() => clearInterval(timer));
  let blk = 'Medium Armor Hit';
  const reporter = setInterval(() => peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(42), blk }] }), 100);
  t.after(() => clearInterval(reporter));
  const ok = await a.waitEvent('SelfStats', (v) => (v as { blk?: unknown })?.blk !== undefined);
  assert.equal((ok.value as { blk: string }).blk, 'Medium Armor Hit');

  blk = 'Foo Hit'; // not a shield sound: the client would play whatever name it is handed
  await new Promise((r) => setTimeout(r, 250));
  a.inbox.events.length = 0;
  const selfs = () => a.inbox.events.filter((e) => e.name === 'SelfStats');
  await a.waitUntil(() => selfs().length >= 2, 'two SelfStats after the switch');
  for (const e of selfs()) {
    assert.equal((e.value as { blk?: unknown }).blk, undefined, 'a non-whitelisted blk must not reach the owner');
  }
});

// #106 -- pins playerstate.ts drivingWindowMs on the harness seam: a streamed retail harness
// client renders at ~1 fps, so its input frames arrive up to 8 s apart (measured:
// `simpeer.avatar_stats_gated` lastInputAgoMs 5895 in s149, 8065 in s143) and every bar the
// peer simulated was dropped as "not driving" -- the drowning s149 measures never reached the
// screen and the base it claimed never reached the avatar. A real client keeps the 5 s rule.
test("#106: a stuttering harness client still gets the peer's bars; a real one does not", async (t) => {
  for (const harness of [true, false]) {
    const server = await startServer({
      requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
      configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16, harness } },
    });
    t.after(() => server.close());
    const peer = await TestClient.simPeer(server.port, PEER_PASS);
    t.after(() => peer.close());
    const a = await TestClient.connect(server.port);
    t.after(() => a.close());
    const welcome = await a.joinAsNew(harness ? 'Stutterer' : 'Smooth');
    a.playerId = welcome['playerId'] as number;
    await a.waitEvent('PlayerList');
    a.sendCellChange('0,0', 0, 0, 0);
    a.sendInput({ move: 1 }, 1); // ONE input frame, then a long silence: the 1 fps bot's gap
    await new Promise((r) => setTimeout(r, 5_600)); // past INPUT_DRIVING_MS (5 s)
    a.inbox.events.length = 0;
    peer.sendEvent('AvatarStatsBatch', { entries: [{ id: a.playerId, ...bars(42) }] });
    if (harness) {
      const seen = await a.waitEvent('SelfStats', (v) => (v as { hp?: { c?: number } })?.hp?.c === 42, 3000);
      assert.ok(seen, "the harness seam must keep the peer's bars flowing to a stuttering bot");
    } else {
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(a.inbox.events.filter((e) => e.name === 'SelfStats').length, 0,
        'an input-less client outside the harness must keep asserting its own bars');
    }
  }
});
