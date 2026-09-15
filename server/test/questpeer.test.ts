// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 4E: quests receive from the peer, and the peer's MWScript writes win.
//
// Under the one-peer model the peer runs every cell script authoritatively, but each
// client's engine runs its local copy on the same puppeted actors -- so the same global is
// written twice. Rule: a client write to a name the peer wrote within INPUT_DRIVING_MS is
// dropped (dialogue-only names the peer never writes are untouched); and the peer's
// character-global writes are relayed LIVE to everyone in-world, so local script copies do
// not hold a stale value until the next login. Member variables use the same gate keyed by
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

test("the peer's CHARACTER-global write is relayed live to every client in the world", async (t) => {
  const { peer, a, b } = await world(t);
  // Not in worldGlobals: a character (campaign) global. Before 4E these persisted to the
  // owner's doc and were never relayed.
  peer.sendEvent('GlobalVarUpdate', { name: 'mp_campaign_stage', value: 7 });
  const [ga, gb] = await Promise.all([
    a.waitEvent('GlobalVarUpdate', gv('mp_campaign_stage')),
    b.waitEvent('GlobalVarUpdate', gv('mp_campaign_stage')),
  ]);
  assert.equal((ga.value as { value: number }).value, 7);
  assert.equal((gb.value as { value: number }).value, 7);
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

// THE CAMPAIGN'S GLOBALS, FOR EVERYONE WHO RUNS ITS SCRIPTS. The peer simulates the host's
// world and a guest runs the host's quest scripts, and both were seeded from their OWN doc
// (the peer's empty ephemeral one; the guest's home campaign) -- so a script gated on a
// global the host set through dialogue ran the other way on the very engine that simulates
// it. And the host's write never reached the peer live at all (only peer writes were
// relayed). Now: a human's campaign write reaches the peer, and a joining peer or guest is
// seeded from the owner's doc.
test("the host's quest global reaches the peer live, and seeds a joining peer and guest", async (t) => {
  const { SocialStore } = await import('../src/core/socialstore');
  const dataDir = tmpDataDir();
  new SocialStore(dataDir).addFriend('host', 'guest', Date.now());
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host',
    configOverride: { server: { password: PEER_PASS }, login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const host = await TestClient.connect(server.port);
  t.after(() => host.close());
  await host.joinAsNew('Host', 'hunter22');
  await host.waitEvent('PlayerList');
  host.sendCellChange('0,0', 0, 0, 0);
  peer.inbox.events.length = 0;
  host.sendEvent('GlobalVarUpdate', { name: 'mp_campaign_gate', value: 2 }); // a dialogue result
  const live = await peer.waitEvent('GlobalVarUpdate', gv('mp_campaign_gate'), 3000);
  assert.equal((live.value as { value: number }).value, 2, 'the simulator hears the host\'s campaign write');
  await new Promise((r) => setTimeout(r, 100));

  // A guest joins the host's world: seeded from the HOST's campaign, not their own.
  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest', 'hunter22');
  const seeded = await guest.waitEvent('GlobalVarSync', () => true, 5000);
  assert.equal((seeded.value as { globals: Record<string, number> }).globals['mp_campaign_gate'], 2,
    'a guest runs the host\'s scripts on the host\'s globals');

  // A restarted peer (a fresh session) is seeded the same way.
  const peer2 = await TestClient.simPeer(server.port, PEER_PASS, 'simpeer-two');
  t.after(() => peer2.close());
  const seededPeer = await peer2.waitEvent('GlobalVarSync', () => true, 5000);
  assert.equal((seededPeer.value as { globals: Record<string, number> }).globals['mp_campaign_gate'], 2,
    'a fresh simulator starts from the campaign\'s globals');
});

// ONE CAMPAIGN, EVERY ENGINE. A human's dialogue-set quest global reached the peer and the
// doc, never the OTHER human live: the guest's Global filters and local script copies sat on
// the stale value until relog although the journal had advanced (backlog 224). The
// peer-owned window above is what guards against ping-pong; human-to-human is plain relay.
test("a human's campaign global reaches the other human live", async (t) => {
  const { a, b, peer } = await world(t);
  a.sendEvent('GlobalVarUpdate', { name: 'mp_dialogue_stage', value: 4 }); // not a world global: campaign-shadowed
  const [gb, gp] = await Promise.all([
    b.waitEvent('GlobalVarUpdate', gv('mp_dialogue_stage'), 3000),
    peer.waitEvent('GlobalVarUpdate', gv('mp_dialogue_stage'), 3000),
  ]);
  assert.equal((gb.value as { value: number }).value, 4, 'the other human hears the dialogue result');
  assert.equal((gp.value as { value: number }).value, 4, 'and so does the simulator');
});

// A QUEST RESTART IS THE OWNER'S TO MAKE. SetJournalIndex to a lower stage from the world's
// owner (or from the peer's scripts) was dropped by monotonic-max, so it came back on the next
// login and later advances below the old maximum were silently lost (backlog 225). A guest
// still cannot rewind the log.
test('the owner and the peer may regress a journal stage; a guest may not', async (t) => {
  const { SocialStore } = await import('../src/core/socialstore');
  const { readPlayerDoc } = await import('./helpers');
  const dataDir = tmpDataDir();
  new SocialStore(dataDir).addFriend('host', 'guest', Date.now());
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host',
    configOverride: { server: { password: PEER_PASS }, login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const host = await TestClient.connect(server.port);
  t.after(() => host.close());
  const hostChar = String((await host.joinAsNew('Host', 'hunter22')).welcome['characterId']);
  await host.waitEvent('PlayerList');
  host.sendCellChange('0,0', 0, 0, 0);
  const guest = await TestClient.connect(server.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Guest', 'hunter22');
  await guest.waitEvent('PlayerList');
  guest.sendCellChange('0,0', 0, 0, 0);
  const je = (v: unknown) => (v as { questId?: string })?.questId === 'mq_restart';
  const idx = (e: { value: unknown }) => (e.value as { index: number }).index;

  host.sendEvent('JournalEntry', { questId: 'mq_restart', index: 50 });
  assert.equal(idx(await guest.waitEvent('JournalEntry', je, 3000)), 50);
  host.sendEvent('JournalEntry', { questId: 'mq_restart', index: 10 }); // the owner restarts the quest
  assert.equal(idx(await guest.waitEvent('JournalEntry', je, 3000)), 10, "the owner's restart reaches the guest");
  host.sendEvent('JournalEntry', { questId: 'mq_restart', index: 20 }); // ...and a later advance below the old max lands
  assert.equal(idx(await guest.waitEvent('JournalEntry', je, 3000)), 20, 'an advance below the old maximum is not lost');
  peer.sendEvent('JournalEntry', { questId: 'mq_restart', index: 5 }); // the simulator's scripts may too
  assert.equal(idx(await guest.waitEvent('JournalEntry', je, 3000)), 5, "the peer's regress is authoritative");
  host.inbox.events.length = 0;
  guest.sendEvent('JournalEntry', { questId: 'mq_restart', index: 1 }); // a guest cannot rewind the campaign
  guest.sendEvent('JournalEntry', { questId: 'mq_restart', index: 30 }); // a fence: this one IS relayed
  assert.equal(idx(await host.waitEvent('JournalEntry', je, 3000)), 30);
  assert.equal(host.inbox.events.filter((e) => e.name === 'JournalEntry' && idx(e) === 1).length, 0, "a guest's regress is still blocked");

  await server.flush();
  const doc = readPlayerDoc(dataDir, hostChar) as { journal?: Record<string, number> };
  assert.equal(doc.journal?.['mq_restart'], 30, 'the campaign doc follows the log, restart included');
});

// ONE BODY'S STATE STAYS WITH THAT BODY. PCVampire/PCWerewolf and their counters are globals
// in the vanilla scripts, so they shadowed to the CAMPAIGN doc like every character global:
// a guest turning vampire made the host a vampire on the host's next login, and the peer's
// dummy a werewolf (backlog #151). They persist to the writer's own doc only, reach nobody
// live, and come back to the same character on a rejoin -- from its own doc, never the campaign's.
test("a guest's PCVampire stays on the guest: not the host doc, not the peer, restored on rejoin", async (t) => {
  const { SocialStore } = await import('../src/core/socialstore');
  const { readPlayerDoc } = await import('./helpers');
  const dataDir = tmpDataDir();
  new SocialStore(dataDir).addFriend('host', 'guest', Date.now());
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: 'party', worldOwner: 'host',
    configOverride: { server: { password: PEER_PASS }, login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const host = await TestClient.connect(server.port);
  t.after(() => host.close());
  const hostChar = String((await host.joinAsNew('Host', 'hunter22')).welcome['characterId']);
  await host.waitEvent('PlayerList');
  host.sendCellChange('0,0', 0, 0, 0);

  const guest = await TestClient.connect(server.port);
  const guestChar = String((await guest.joinAsNew('Guest', 'hunter22')).welcome['characterId']);
  await guest.waitEvent('PlayerList');
  guest.sendCellChange('0,0', 0, 0, 0);
  peer.inbox.events.length = 0;
  host.inbox.events.length = 0;
  guest.sendEvent('GlobalVarUpdate', { name: 'PCVampire', value: 1 });
  guest.sendEvent('GlobalVarUpdate', { name: 'mp_campaign_gate', value: 5 }); // a fence: this one IS relayed
  await peer.waitEvent('GlobalVarUpdate', gv('mp_campaign_gate'), 3000);
  assert.equal(peer.inbox.events.filter((e) => e.name === 'GlobalVarUpdate' && gv('PCVampire')(e.value)).length, 0,
    'the peer is never told a player is a vampire');
  assert.equal(host.inbox.events.filter((e) => e.name === 'GlobalVarUpdate' && gv('PCVampire')(e.value)).length, 0,
    'nor is the host');

  await server.flush();
  const hostDoc = readPlayerDoc(dataDir, hostChar) as { globals?: Record<string, number> };
  assert.equal(hostDoc.globals?.['PCVampire'], undefined, "the host's campaign doc does not gain the guest's vampirism");
  assert.equal(hostDoc.globals?.['mp_campaign_gate'], 5, 'the ordinary character global still shadows to the campaign');
  const guestDoc = readPlayerDoc(dataDir, guestChar) as { globals?: Record<string, number> };
  assert.equal(guestDoc.globals?.['PCVampire'], 1, "the guest's own doc has it");

  // Rejoin: the sync is seeded from the host's campaign, with the guest's own body state on top.
  guest.close();
  await guest.closed;
  const back = await TestClient.connect(server.port);
  t.after(() => back.close());
  await back.joinExisting('Guest', 'hunter22');
  const sync = await back.waitEvent('GlobalVarSync', () => true, 5000);
  const globals = (sync.value as { globals: Record<string, number> }).globals;
  assert.equal(globals['PCVampire'], 1, 'a rejoin restores the vampirism to the same character');
  assert.equal(globals['mp_campaign_gate'], 5, 'alongside the campaign globals');
});
