// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3/4 content rules: quest items never deplete from a container (so a second
// player can still complete the same quest), and in a resetting public world a unique
// NPC's corpse is stripped (an infinite-respawn world must not mint artifacts).

import test from 'node:test';
const PEER_PASS = 'peer-secret-1'; // the peer's credential; players cannot hold cells
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContentTable } from '../src/core/content-table';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('content table: defaults classify, a file overrides, a missing file is permissive', async () => {
  const defaults = ContentTable.defaults();
  assert.ok(defaults.isQuestItem('Dwemer Puzzle Box'), 'case-insensitive vanilla default');
  assert.ok(defaults.isUniqueActor('vivec_god'));
  assert.ok(defaults.isNotableItem('Sunder'));
  assert.ok(!defaults.isQuestItem('iron_dagger'));

  const dir = tmpDataDir();
  writeFileSync(join(dir, 'content-table.json'), JSON.stringify({ questItems: ['my_mod_macguffin'] }));
  const loaded = await ContentTable.load(dir);
  assert.ok(loaded.isQuestItem('my_mod_macguffin'), 'a declared list is used');
  assert.ok(!loaded.isQuestItem('Dwemer Puzzle Box'), 'and REPLACES the default for that list');
  assert.ok(loaded.isUniqueActor('vivec_god'), 'undeclared lists keep their defaults');

  // A malformed file must not take the world down — rules degrade permissive.
  const bad = tmpDataDir();
  writeFileSync(join(bad, 'content-table.json'), '{not json');
  const fallback = await ContentTable.load(bad);
  assert.ok(fallback.isQuestItem('Dwemer Puzzle Box'));
});

test('quest items never deplete: two players can each take the Puzzle Box', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  // Establish canonical container state holding one quest item and one ordinary item.
  a.sendEvent('ContainerOpen', {
    ref: { __refnum: { index: 77, contentFile: 0 } },
    cellKey: '0,0',
    contents: [{ id: 'dwemer puzzle box', n: 1 }, { id: 'iron_dagger', n: 1 }],
  });
  await new Promise((r) => setTimeout(r, 200));

  // Alice takes the quest item: accepted, and NO ContainerUpdate is relayed (nothing
  // changed for anyone else — that is the whole point).
  a.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 77, contentFile: 0 } }, cellKey: '0,0',
    opId: 1, op: 'take', itemId: 'dwemer puzzle box', n: 1,
  });
  const r1 = await a.waitEvent('ContainerOpResult');
  assert.equal((r1.value as { ok: boolean }).ok, true, 'the taker gets their copy');

  // Bob takes the SAME quest item afterwards: still there.
  b.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 77, contentFile: 0 } }, cellKey: '0,0',
    opId: 2, op: 'take', itemId: 'dwemer puzzle box', n: 1,
  });
  const r2 = await b.waitEvent('ContainerOpResult');
  assert.equal((r2.value as { ok: boolean }).ok, true,
    'a quest item must still be there for the next eligible player (the TES3MP break)');

  // An ORDINARY item still depletes: the rule is narrow, not "containers are infinite".
  a.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 77, contentFile: 0 } }, cellKey: '0,0',
    opId: 3, op: 'take', itemId: 'iron_dagger', n: 1,
  });
  assert.equal(((await a.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true);
  b.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 77, contentFile: 0 } }, cellKey: '0,0',
    opId: 4, op: 'take', itemId: 'iron_dagger', n: 1,
  });
  const r4 = await b.waitEvent('ContainerOpResult');
  assert.equal((r4.value as { ok: boolean; reason?: string }).ok, false, 'ordinary loot is still finite');
  a.close();
  b.close();
});

test('public no-drop: a unique NPC corpse is stripped for the whole cell', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false,
    dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'public',
    configOverride: { economy: { noDrop: true }, server: { password: PEER_PASS } },
  });
  t.after(() => server.close());

  // Actor events are holder-only and epoch-guarded, and only the sim peer can hold — so the
  // sender of those events is the peer, not a player.
  const a = await TestClient.simPeer(server.port, PEER_PASS, 'Alice');
  a.sendCellChange('0,0', 0, 0, 0);
  const grant = await a.waitEvent('ActorAuthorityGrant');
  const epoch = (grant.value as { epoch: number }).epoch;
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  // A unique dies: everyone in the cell is told to strip the corpse.
  a.sendEvent('ActorDeath', {
    ref: { __refnum: { index: 5, contentFile: 0 } }, cellKey: '0,0', epoch,
    deathNo: 1, killedRecordId: 'vivec_god',
  });
  const strip = await b.waitEvent('ActorStripLoot');
  assert.equal((strip.value as { reason: string }).reason, 'unique');

  // An ordinary creature is untouched — the rule targets farmable uniques only.
  a.sendEvent('ActorDeath', {
    ref: { __refnum: { index: 6, contentFile: 0 } }, cellKey: '0,0', epoch,
    deathNo: 1, killedRecordId: 'rat',
  });
  await b.waitEvent('WorldKillCount', (v) => (v as { refId: string }).refId === 'rat');
  assert.equal(b.inbox.events.filter((e) => e.name === 'ActorStripLoot').length, 0,
    'ordinary creatures still drop their loot');
  a.close();
  b.close();
});

test("a merchant's purse is canonical and shared, and deltas from two traders both land", async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  // Alice opens the trader first, so her reading of the purse becomes canonical.
  a.sendEvent('ContainerOpen', {
    ref: { __refnum: { index: 91, contentFile: 0 } },
    cellKey: '0,0',
    contents: [{ id: 'iron_dagger', n: 1 }],
    gold: 500,
  });
  await new Promise((r) => setTimeout(r, 200));

  // Bob opens the SAME trader. Before this change he was told nothing about the purse and
  // his client kept its own full 500 -- the half of merchant duplication c58f5ad left open.
  b.sendEvent('ContainerOpen', {
    ref: { __refnum: { index: 91, contentFile: 0 } },
    cellKey: '0,0',
    contents: [{ id: 'iron_dagger', n: 1 }],
    gold: 500,
  });
  const bState = await b.waitEvent('ContainerState');
  assert.equal((bState.value as { gold?: number }).gold, 500,
    'the second opener is told the canonical purse rather than trusting his own');

  // Alice sells 200 worth: the purse drops for EVERYONE, not just her.
  a.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 91, contentFile: 0 } }, cellKey: '0,0',
    opId: 1, op: 'gold', goldDelta: -200,
  });
  assert.equal(((await a.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true);

  // Bob sells 200 too. A client sending an ABSOLUTE would send 300 here from its stale
  // view and erase Alice's trade; a delta composes, so the purse lands on 100.
  b.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 91, contentFile: 0 } }, cellKey: '0,0',
    opId: 2, op: 'gold', goldDelta: -200,
  });
  assert.equal(((await b.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true);

  // NEGATIVE CONTROL, sent BEFORE the only fresh observer opens: griefing is bounded, so a
  // client cannot move more gold in one op than any vendor in the game holds. It is a
  // POSITIVE delta on purpose -- a negative one would floor to 0 and read the same whether
  // the cap held or not, which is no control at all. An invalid body is logged and dropped,
  // never replied to, so there is nothing to await; the canonical purse is the observable.
  b.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 91, contentFile: 0 } }, cellKey: '0,0',
    opId: 3, op: 'gold', goldDelta: 100000000,
  });
  await new Promise((r) => setTimeout(r, 300));

  // A third opener, who has never seen this container, is the honest observer: an existing
  // client would replay its own buffered ContainerState from its first open. Her single
  // reading proves both properties at once -- both deltas composed, and the over-cap one
  // was refused. 500 would mean nothing applied; 300 would mean one trade erased the other;
  // anything enormous would mean the cap does not hold.
  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Cassia');
  await c.waitEvent('PlayerList');
  c.sendCellChange('0,0', 0, 0, 0);
  c.sendEvent('ContainerOpen', {
    ref: { __refnum: { index: 91, contentFile: 0 } },
    cellKey: '0,0', contents: [{ id: 'iron_dagger', n: 1 }], gold: 500,
  });
  const cState = await c.waitEvent('ContainerState');
  assert.equal((cState.value as { gold?: number }).gold, 100,
    'both deltas landed (500 - 200 - 200) and the over-cap delta moved nothing');

  // And the purse floors at zero rather than going negative.
  c.sendEvent('ContainerOpRequest', {
    ref: { __refnum: { index: 91, contentFile: 0 } }, cellKey: '0,0',
    opId: 4, op: 'gold', goldDelta: -9999,
  });
  assert.equal(((await c.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true);

  a.close(); b.close(); c.close();
});

test("a merchant restocks on the 24-hour rule, including across a month boundary", async (t) => {
  // The restock is fBarterGoldResetDelay: the purse comes back every 24 GAME hours. To
  // compare two readings the server collapses the calendar to a single hour count -- and
  // that collapse assumed twelve 28-day months while the clock that produces the readings
  // rolls the real Morrowind lengths (31/28/31/30/...). Crossing out of a 31-day month
  // therefore made the count go BACKWARDS by up to three days, and a merchant whose restock
  // fell due around the boundary stayed drained until the calendar caught up.
  //
  // Frozen scale: the only thing that may move the clock here is the explicit advance.
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { time: { scale: 0 }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const REF = { __refnum: { index: 92, contentFile: 0 } };

  // Sun's Height has 31 days. Park the clock on the last one, so one more day crosses over.
  server.api.world.advanceTime(351);
  const before = server.api.world.time();
  assert.deepEqual({ day: before.day, month: before.month }, { day: 31, month: 7 },
    'the fixture depends on landing on the last day of a 31-day month');

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Trader');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  a.sendEvent('ContainerOpen', {
    ref: REF, cellKey: '0,0', contents: [{ id: 'iron_dagger', n: 1 }], gold: 500,
  });
  assert.equal(((await a.waitEvent('ContainerState')).value as { gold?: number }).gold, 500);

  a.sendEvent('ContainerOpRequest', {
    ref: REF, cellKey: '0,0', opId: 1, op: 'gold', goldDelta: -200,
  });
  assert.equal(((await a.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true);
  // ...and buys the dagger and sells a yam. Stock used to be canonical-forever: the potions
  // and arrows bought on day one were gone from the world for good.
  a.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId: 2, op: 'take', itemId: 'iron_dagger', n: 1 });
  assert.equal(((await a.waitEvent('ContainerOpResult', (v) => (v as { opId: number }).opId === 2)).value as { ok: boolean }).ok, true);
  a.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId: 3, op: 'put', itemId: 'ash_yam', n: 1 });
  assert.equal(((await a.waitEvent('ContainerOpResult', (v) => (v as { opId: number }).opId === 3)).value as { ok: boolean }).ok, true);

  server.api.world.advanceTime(24);
  const after = server.api.world.time();
  assert.deepEqual({ day: after.day, month: after.month }, { day: 1, month: 8 },
    'one day past the 31st must be the first of the next month');

  // A fresh observer: an existing client would replay its own buffered ContainerState.
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Customer');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  b.sendEvent('ContainerOpen', { ref: REF, cellKey: '0,0', contents: [], gold: 500 });
  const state = (await b.waitEvent('ContainerState')).value as { gold?: number; items: { id: string; n: number }[] };
  assert.deepEqual(state.items.map((i) => i.id + ':' + i.n).sort(), ['ash_yam:1', 'iron_dagger:1'],
    'the bought dagger is back in stock and the sold yam stays');
  assert.equal(state.gold, 500,
    `exactly 24 game hours passed, so the purse must be back; 300 means the restock was`
    + ' skipped because the two halves of the server disagree about how long a month is');
  a.close();
  b.close();
});

// THE FARE. A travel service moves the player and closes its window in the same breath; the
// strider's purse delta goes out one frame after the cell change, from a cell the player is
// no longer near, and the reach gate dropped it -- every fare paid to a caravaner was lost
// to the world. The purse op alone may name the cell just left.
test("a travel fare lands on the caravaner's purse from the destination cell", async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const REF = { __refnum: { index: 93, contentFile: 0 } };
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Traveller');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  a.sendEvent('ContainerOpen', { ref: REF, cellKey: '0,0', contents: [], gold: 100 });
  await a.waitEvent('ContainerState');
  a.sendCellChange('40,40', 0, 0, 0); // Balmora is far away
  await a.waitEvent('PlayerCellChange', (v) => (v as { cellKey: string }).cellKey === '40,40');
  a.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId: 7, op: 'gold', goldDelta: 30 });
  const r = (await a.waitEvent('ContainerOpResult', (v) => (v as { opId: number }).opId === 7, 3000)).value as { ok: boolean };
  assert.equal(r.ok, true, 'the fare from the cell just left is accepted');
  // Anything else from afar is still refused (silently: no result, the old rule).
  a.inbox.events.length = 0;
  a.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId: 8, op: 'take', itemId: 'gold_001', n: 1 });
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal(a.inbox.events.filter((e) => e.name === 'ContainerOpResult').length, 0, 'a take from afar is still out of reach');
});

// A delta larger than the merchant's whole starting purse is not something the trade window
// can produce. The cap stands (it is not refused); it is NOTED against the account, so a client
// zeroing or filling a purse by hand shows on the moderation ledger (backlog 166).
test('a gold delta beyond the merchant\'s starting purse is counted as an anomaly, a real trade is not', async (t) => {
  const TOKEN = 'dash-token';
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { admin: { dashboardToken: TOKEN } } });
  t.after(() => server.close());
  const REF = { __refnum: { index: 94, contentFile: 0 } };
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  a.sendEvent('ContainerOpen', { ref: REF, cellKey: '0,0', contents: [], gold: 500 });
  await a.waitEvent('ContainerState');
  const anomalies = async () => {
    const overview = await (await fetch(`http://127.0.0.1:${server.port}/admin/api/overview`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json() as { players: { account: string; anomalies: Record<string, number> }[] };
    return overview.players.find((p) => p.account === 'alice')?.anomalies ?? {};
  };
  a.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId: 1, op: 'gold', goldDelta: -500 });
  assert.equal(((await a.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true);
  assert.deepEqual(await anomalies(), {}, 'selling the merchant out of his whole purse is a trade, not a flag');
  a.sendEvent('ContainerOpRequest', { ref: REF, cellKey: '0,0', opId: 2, op: 'gold', goldDelta: 5000 });
  assert.equal(((await a.waitEvent('ContainerOpResult')).value as { ok: boolean }).ok, true, 'the cap is unchanged: still applied');
  assert.equal((await anomalies()).merchant_gold_delta, 1, 'a delta ten times the purse is noted against the account');
});
