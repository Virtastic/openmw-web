// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4: scripted-spawn replay and the unstick tool. Morrowind fires a one-shot
// encounter once; the player who was not there stands in an empty room with an active
// quest entry, which is the most reported co-op quest break there is.

import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestRepair, DEFAULT_QUEST_WHITELIST, type SpawnRule } from '../src/core/quest-repair';
import { PlayerStore } from '../src/persist/playerstore';
import type { Player, Roster } from '../src/core/players';
import { tmpDataDir } from './helpers';

const RULE: SpawnRule = {
  questId: 'da_azura', minIndex: 10, maxIndex: 40,
  cellKey: 'Shrine', recordId: 'staada', cooldownSec: 900,
};

function harness() {
  const players = new PlayerStore(tmpDataDir(), 'w1');
  const list: Player[] = [];
  const add = (charId: string): Player => {
    const p = { id: list.length + 1, name: charId, accountKey: charId, charId, rank: 0, inWorld: true,
      peer: { sendEvent: () => {} } } as unknown as Player;
    list.push(p);
    return p;
  };
  const repair = new QuestRepair({
    roster: { inWorld: () => list } as unknown as Roster,
    players,
    spawnRules: [RULE],
  });
  return { repair, players, add, close: () => players.close() };
}

test('a one-shot encounter is replayed only for a character whose own stage wants it', async () => {
  const w = harness();
  const onStage = w.add('onstage');
  const notStarted = w.add('notstarted');
  const past = w.add('past');
  w.players.update('onstage', (d) => { (d.journal ??= {}).da_azura = 20; });
  w.players.update('past', (d) => { (d.journal ??= {}).da_azura = 90; });

  assert.deepEqual(
    w.repair.onCellEntry(onStage, 'Shrine').map((s) => s.recordId), ['staada'],
    'the player who needs the encounter gets it');
  assert.deepEqual(w.repair.onCellEntry(notStarted, 'Shrine'), [],
    'a player who never started the quest is not shown an encounter they have no context for');
  assert.deepEqual(w.repair.onCellEntry(past, 'Shrine'), [],
    'a player past the stage does not fight it again');
  await w.close();
});

test('re-entering does not stack copies, and the wrong cell spawns nothing', async () => {
  const w = harness();
  const p = w.add('alice');
  w.players.update('alice', (d) => { (d.journal ??= {}).da_azura = 20; });

  assert.equal(w.repair.onCellEntry(p, 'Shrine', 1000).length, 1);
  assert.equal(w.repair.onCellEntry(p, 'Shrine', 2000).length, 0, 'cooldown prevents a second copy');
  assert.equal(w.repair.onCellEntry(p, 'Shrine', 1000 + 901_000).length, 1, 'available again later');
  assert.equal(w.repair.onCellEntry(p, 'Somewhere Else', 9_000_000).length, 0);
  await w.close();
});

test('the unstick tool reads state, forces a stage (including backwards) and clears cooldowns', async () => {
  const w = harness();
  const p = w.add('alice');
  w.players.update('alice', (d) => { (d.journal ??= {}).da_azura = 20; });

  assert.deepEqual(w.repair.inspect('alice').journal, { da_azura: 20 });

  // Backwards is ALLOWED: the common stuck case is a stage that advanced past a step the
  // player never completed, and refusing to rewind makes the tool useless exactly then.
  assert.equal(w.repair.setStage('alice', 'da_azura', 10, 'moderator'), true);
  assert.equal(w.repair.inspect('alice').journal.da_azura, 10);
  assert.equal(w.repair.setStage('alice', 'da_azura', -1, 'moderator'), false, 'nonsense is refused');
  assert.equal(w.repair.setStage('alice', 'da_azura', 1.5, 'moderator'), false);

  // Cooldown cleared means the encounter can be re-triggered — the other half of
  // "my quest NPC never appeared".
  w.repair.onCellEntry(p, 'Shrine', 1000);
  assert.equal(w.repair.onCellEntry(p, 'Shrine', 1100).length, 0);
  w.repair.clearSpawnCooldowns('alice', 'moderator');
  assert.equal(w.repair.onCellEntry(p, 'Shrine', 1200).length, 1);
  await w.close();
});

test('the whitelist is an honest allowlist, not a blanket claim', async () => {
  const w = harness();
  assert.ok(DEFAULT_QUEST_WHITELIST.length > 0);
  assert.equal(w.repair.isWhitelisted('MS_Corprus'), true, 'case-insensitive');
  assert.equal(w.repair.isWhitelisted('some_random_mod_quest'), false,
    'unlisted quests still play — they just do not claim the per-character guarantees');
  await w.close();
});

// WHERE A SCRIPTED SPAWN LANDS (backlog 214: the Staada rule became the generic path -- a
// client's PlaceAtPC actor travels as an actor ObjectSpawnRequest). With a sim peer the actor
// is spawned on the PEER, so it is a simulated actor everyone fights -- not a local actor the
// client's non-holder sweep turns into a statue. Without a peer, back on the client.
import { startServer } from '../src/server';
import { TestClient } from './helpers';
const PEER_PASS = 'peer-secret-1';

test('a scripted actor spawn is placed by the peer when there is one, else by the client', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS } },
  });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const { playerId: aId } = await a.joinAsNew('Pilgrim');
  await a.waitEvent('PlayerList');
  a.sendCellChange("azura's coast region", 0, 0, 0);
  await a.waitEvent('PlayerCellChange');
  const req = { tempId: 0, actor: true, recordId: 'staada', cellKey: "azura's coast region", x: 10, y: 20, z: 0, rotZ: 0, count: 1 };

  // No peer: the client is told to build it itself.
  a.sendEvent('ObjectSpawnRequest', req);
  const local = await a.waitEvent('QuestSpawn');
  assert.equal((local.value as { recordId?: string }).recordId, 'staada');
  assert.equal((local.value as { forId?: unknown }).forId, aId);

  // With a peer holding the cell: the peer is told, for this player, and the client is not.
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  peer.sendCellChange("azura's coast region", 0, 0, 0);
  await peer.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === "azura's coast region");
  a.inbox.events.length = 0;
  a.sendEvent('ObjectSpawnRequest', req);
  const onPeer = await peer.waitEvent('QuestSpawn');
  assert.equal((onPeer.value as { recordId?: string }).recordId, 'staada');
  assert.equal((onPeer.value as { forId?: number }).forId, aId, 'the peer is told whose encounter it is');
  a.sendEvent('ChatSend', { text: 'spawnfence' });
  await a.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'spawnfence');
  assert.equal(a.inbox.events.filter((e) => e.name === 'QuestSpawn').length, 0,
    'the client was ALSO told, and would spawn a second local statue');
});

