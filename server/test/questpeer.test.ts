// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4E: quests receive from the peer, and the peer's MWScript writes win.
//
// Under the one-peer model the peer runs every cell script authoritatively, but each
// client's engine runs its local copy on the same puppeted actors -- so the same global is
// written twice. Rule: a client write to a name the peer wrote within INPUT_DRIVING_MS is
// dropped (dialogue-only names the peer never writes are untouched). Since OT3-51 the peer's
// character-global writes reach only the character they credit; world globals stay shared. Member variables use the same gate keyed by
// cell|ref|name (identical code path; the wire test here uses globals).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';

async function world(t: { after(fn: () => unknown): void }) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: {
      server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 },
      // Two relayed world globals so the gate is observable on the wire.
      sharing: { questVars: true, worldGlobals: ['mp_test_global', 'mp_dialogue_only'] },
    },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const wa = await a.joinAsNew('Scripter');
  a.playerId = wa['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Watcher');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);
  return { server, peer, a, b };
}

const gv = (name: string) => (v: unknown) => (v as { name?: string })?.name === name;

test("the peer's CHARACTER-global write with no character named reaches nobody (OT3-51)", async (t) => {
  const { peer, a, b } = await world(t);
  // Not in worldGlobals: a character (campaign) global. Per-character progression credits
  // only the character a peer write names; with none named it is nobody's story.
  peer.sendEvent('GlobalVarUpdate', { name: 'mp_campaign_stage', value: 7 });
  await new Promise((r) => setTimeout(r, 500));
  for (const c of [a, b]) {
    assert.equal(c.inbox.events.filter((e) => e.name === 'GlobalVarUpdate' && gv('mp_campaign_stage')(e.value)).length, 0);
  }
});

test("a client's write to a global the peer just wrote is dropped; after the window it lands", async (t) => {
  const { peer, a, b } = await world(t);
  peer.sendEvent('GlobalVarUpdate', { name: 'mp_test_global', value: 10, seq: 1 });
  await b.waitEvent('GlobalVarUpdate', (v) => gv('mp_test_global')(v) && (v as { value: number }).value === 10);

  // The client's local script copy "also" advances it -- with a newer seq, so only the
  // ownership gate can stop it.
  a.sendEvent('GlobalVarUpdate', { name: 'mp_test_global', value: 99, seq: 2 });
  const leaked = await Promise.race([
    b.waitEvent('GlobalVarUpdate', (v) => gv('mp_test_global')(v) && (v as { value: number }).value === 99)
      .then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 800)),
  ]);
  assert.equal(leaked, false, "the client's copy must not clobber the peer's write");

  // Once the peer has been quiet on that name longer than the driving window, a client
  // write is ordinary again (degraded mode: nobody else is going to advance it).
  await new Promise((r) => setTimeout(r, 5_300));
  a.sendEvent('GlobalVarUpdate', { name: 'mp_test_global', value: 100, seq: 3 });
  const late = await b.waitEvent('GlobalVarUpdate',
    (v) => gv('mp_test_global')(v) && (v as { value: number }).value === 100);
  assert.ok(late, 'a client write lands once the peer is no longer writing that name');
});

test('a dialogue-only global (never written by the peer) is untouched by the gate', async (t) => {
  const { a, b } = await world(t);
  a.sendEvent('GlobalVarUpdate', { name: 'mp_dialogue_only', value: 3, seq: 1 });
  const got = await b.waitEvent('GlobalVarUpdate', (v) => gv('mp_dialogue_only')(v));
  assert.equal((got.value as { value: number }).value, 3,
    'dialogue-driven quest state stays exactly as it was');
});

test("a human's campaign global reaches the simulator, not the other human (OT3-51)", async (t) => {
  const { a, b, peer } = await world(t);
  a.sendEvent('GlobalVarUpdate', { name: 'mp_dialogue_stage', value: 4 }); // not a world global: campaign-shadowed
  const gp = await peer.waitEvent('GlobalVarUpdate', gv('mp_dialogue_stage'), 3000);
  assert.equal((gp.value as { value: number }).value, 4, 'the simulator hears the dialogue result');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.inbox.events.filter((e) => e.name === 'GlobalVarUpdate' && gv('mp_dialogue_stage')(e.value)).length, 0,
    "the other human keeps their own campaign");
});


// OT3-19: under personal progression (the default) a peer quest write credits only the
// character it names, never every human in the world.
test("a peer journal write naming a character credits that character only", async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const { welcome } = await a.joinAsNew('Causer');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Bystander');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  const isQ = (v: unknown) => (v as { questId?: string })?.questId === 'mp_ot3_19';
  peer.sendEvent('JournalEntry', { questId: 'mp_ot3_19', index: 10, charId: welcome['characterId'] as string });
  const got = await a.waitEvent('JournalEntry', isQ);
  assert.equal((got.value as { index: number }).index, 10);
  const leaked = await Promise.race([
    b.waitEvent('JournalEntry', isQ).then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 800)),
  ]);
  assert.equal(leaked, false, 'the bystander is not credited with the causer\'s quest');
});
