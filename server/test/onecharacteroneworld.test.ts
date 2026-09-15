// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ONE CHARACTER, ONE WORLD. Inside a process the newcomer wins (SUPERSEDED). Across worlds
// nothing enforced it: the same character in two tabs, in two worlds, was two sessions
// flushing one doc last-writer-wins -- an inventory from one under a position from the
// other. The shared presence row is the arbiter: the world that sees another world's newer
// row for a player it holds drops that session on its next heartbeat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server';
import { DatabaseSync } from 'node:sqlite';
import { TestClient, tmpDataDir } from './helpers';

test('opening the character in a second world drops the session in the first', async (t) => {
  const sharedDir = mkdtempSync(join(tmpdir(), 'omw-shared-'));
  const opts = { requireGameData: false, port: 0, host: '127.0.0.1', sharedDir, presenceMs: 300,
    configOverride: { login: { allowHarnessAuth: true } } as never };
  const a = await startServer({ ...opts, dataDir: tmpDataDir(), worldId: 'world-a' });
  t.after(() => a.close());
  const b = await startServer({ ...opts, dataDir: tmpDataDir(), worldId: 'world-b' });
  t.after(() => b.close());

  const inA = await TestClient.connect(a.port);
  t.after(() => inA.close());
  await inA.joinAsNew('Twin', 'hunter22');
  await inA.waitEvent('PlayerList');
  await new Promise((r) => setTimeout(r, 400)); // a heartbeat: A's row is written

  const inB = await TestClient.connect(b.port);
  t.after(() => inB.close());
  await inB.joinExisting('Twin', 'hunter22');
  await inB.waitEvent('PlayerList');
  await inA.waitDisconnect('SUPERSEDED');
  // The newcomer keeps playing: B's own heartbeat must not read its own row as foreign.
  await new Promise((r) => setTimeout(r, 700));
  inB.sendEvent('ChatSend', { text: 'still here' });
  await inB.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'still here');
});

// Backlog 334: the presence row carries the CHARACTER. Two characters of one account in two
// worlds are two players; neither world's heartbeat kicks the other's session.
test('two characters of one account in two worlds are not a duplicate', async (t) => {
  const sharedDir = mkdtempSync(join(tmpdir(), 'omw-shared-'));
  const opts = { requireGameData: false, port: 0, host: '127.0.0.1', sharedDir, presenceMs: 300,
    configOverride: { login: { allowHarnessAuth: true } } as never };
  const a = await startServer({ ...opts, dataDir: tmpDataDir(), worldId: 'world-a' });
  t.after(() => a.close());
  const b = await startServer({ ...opts, dataDir: tmpDataDir(), worldId: 'world-b' });
  t.after(() => b.close());

  const inA = await TestClient.connect(a.port);
  t.after(() => inA.close());
  await inA.joinAsNew('Pair', 'hunter22');
  await inA.waitEvent('PlayerList');
  inA.sendJson({ t: 'CharacterCreate', name: 'Second' });
  const r = await inA.waitJson('CharacterResult');
  const second = (r['characters'] as { id: string; name: string }[]).find((x) => x.name === 'Second')!;
  await new Promise((res) => setTimeout(res, 400)); // a heartbeat: A's row is written

  const inB = await TestClient.connect(b.port);
  t.after(() => inB.close());
  inB.hello();
  await inB.waitJson('SessionHelloOk');
  inB.login('Pair', 'hunter22', { characterId: second.id });
  await inB.waitJson('SessionWelcome');
  inB.sendJson({ t: 'SessionReady' });
  await inB.waitEvent('PlayerList');
  await new Promise((res) => setTimeout(res, 1000)); // several beats in both worlds
  assert.ok(!inA.isClosed, 'char A in world A survives char B in world B');
  assert.ok(!inB.isClosed, 'and vice versa');
});

// A BAN REACHES EVERY WORLD. /ban in world A wrote the shared list and kicked A's roster; a
// guest sitting in world B played on until they next disconnected. Every world checks its
// roster against the shared list on its heartbeat.
test('an account banned in one world is dropped from another within a heartbeat', async (t) => {
  const { BanStore } = await import('../src/persist/banstore');
  const sharedDir = mkdtempSync(join(tmpdir(), 'omw-shared-'));
  const opts = { requireGameData: false, port: 0, host: '127.0.0.1', sharedDir, presenceMs: 300,
    configOverride: { login: { allowHarnessAuth: true } } as never };
  const b = await startServer({ ...opts, dataDir: tmpDataDir(), worldId: 'world-b' });
  t.after(() => b.close());
  const guest = await TestClient.connect(b.port);
  t.after(() => guest.close());
  await guest.joinAsNew('Pest', 'hunter22');
  await guest.waitEvent('PlayerList');
  new BanStore(sharedDir).banAccount('pest', 'admin', 'griefing'); // what /ban in world A writes
  await guest.waitDisconnect('BANNED');
});

// A GUEST IS PLACED BESIDE THE HOST, EVEN WHEN THE HOST HAS NOT MOVED YET. The spawn was
// one-shot at the guest's join: a host still loading (no pose) meant the guest stood at the
// engine's default start for good. And a guest booted again by the auth rescue already has
// a position in this world; yanking them back beside the host threw that away (backlog 280).
test('a guest joining before the host has a pose is teleported on the host\'s first cell', async (t) => {
  const { SocialStore } = await import('../src/core/socialstore');
  const dataDir = tmpDataDir();
  const social = new SocialStore(dataDir);
  social.addFriend('host', 'guest', Date.now());
  social.close();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldId: 'priv-host', worldMode: 'party', worldOwner: 'host',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const host = await TestClient.connect(server.port);
  t.after(() => host.close());
  await host.joinAsNew('Host', 'hunter22');
  await host.waitEvent('PlayerList');

  const guest = await TestClient.connect(server.port);
  const { playerId: guestId, welcome } = await guest.joinAsNew('Guest', 'hunter22');
  const charId = String(welcome['characterId']);
  await guest.waitEvent('PlayerList');
  const early = await guest.waitEvent('InviteAccepted', () => true, 300).then(() => true, () => false);
  assert.equal(early, false, 'nothing to place the guest beside yet: the host has no pose');

  host.sendCellChange('Balmora, South Wall Cornerclub', 10, 20, 30);
  const at = (await guest.waitEvent('InviteAccepted', () => true, 3000)).value as { cellKey: string; x: number };
  assert.equal(at.cellKey, 'Balmora, South Wall Cornerclub', 'the deferred spawn lands beside the host');
  assert.equal(at.x, 10);
  // #394: the teleport it asks for is explained, or #361 refuses the guest's own snap there.
  const stamped = server.roster.get(guestId)!.lastDoorAt;
  assert.ok(stamped !== undefined && Date.now() - stamped < 3000, 'the deferred InviteAccepted stamps lastDoorAt');

  // The guest walks off and reboots (the auth rescue: a fresh ticket, not a resume). They
  // keep their own position; a second InviteAccepted would put them back beside the host.
  guest.sendCellChange('Seyda Neen, Census and Excise Office', 1, 2, 3);
  await new Promise((r) => setTimeout(r, 100));
  guest.close();
  await guest.closed;
  const again = await TestClient.connect(server.port);
  t.after(() => again.close());
  await again.joinExisting('Guest', 'hunter22');
  await again.waitEvent('PlayerList');
  const moved = await again.waitEvent('InviteAccepted', () => true, 1500).then(() => true, () => false);
  assert.equal(moved, false, 'a guest rebooted moments after flushing a position here is not re-spawned beside the host');

  // #395: but a guest who stood here YESTERDAY is a returning guest (s154), not a reboot, and
  // lands beside the host again. Everyone logs off, the flushed position is aged on disk, and
  // the world comes up again the next day.
  again.close();
  host.close();
  await server.close();
  const db = new DatabaseSync(join(dataDir, 'players.db'));
  const doc = JSON.parse((db.prepare('SELECT doc FROM players WHERE key = ?').get(charId) as { doc: string }).doc) as
    { positions: Record<string, { at: string }> };
  doc.positions['priv-host']!.at = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare('UPDATE players SET doc = ? WHERE key = ?').run(JSON.stringify(doc), charId);
  db.close();
  const server2 = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldId: 'priv-host', worldMode: 'party', worldOwner: 'host',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server2.close());
  const host2 = await TestClient.connect(server2.port);
  t.after(() => host2.close());
  await host2.joinExisting('Host', 'hunter22');
  await host2.waitEvent('PlayerList');
  host2.sendCellChange('Balmora, South Wall Cornerclub', 10, 20, 30);
  const later = await TestClient.connect(server2.port);
  t.after(() => later.close());
  await later.joinExisting('Guest', 'hunter22');
  await later.waitEvent('PlayerList');
  const back = (await later.waitEvent('InviteAccepted', () => true, 3000)).value as { cellKey: string };
  assert.equal(back.cellKey, 'Balmora, South Wall Cornerclub', 'a returning guest is placed beside the host');
});
