// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// CHAT SCROLLBACK. The feed lives in the page and a world change RELOADS the page, so every
// switch wiped the conversation — a player arriving anywhere saw an empty box with no idea
// what was being discussed. History is shared, like parties and presence, so stepping into
// your own world and back does not lose the room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { SocialStore } from '../src/core/socialstore';

const CFG = { login: { allowHarnessAuth: true } };

test('a player who joins later is handed what was already said', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: CFG as never,
  });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Ann', 'hunter22');
  a.sendEvent('ChatSend', { channel: 'global', text: 'anyone selling a silver sword' });
  await a.waitEvent('ChatMessage', (v) => String((v as { text?: string }).text ?? '').includes('silver sword'));

  // Bob arrives AFTER the line was said. He should still see it.
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Bob', 'hunter22');
  const seen = await b.waitEvent('ChatMessage',
    (v) => String((v as { text?: string }).text ?? '').includes('silver sword'), 10000).catch(() => null);
  assert.ok(seen, 'a newcomer got an empty chat box — no idea what the room is talking about');
  assert.equal((seen!.value as { from?: string }).from, 'Ann', 'history must keep who said it');
});

test('history survives the world the line was said in going away', async (t) => {
  const dataDir = tmpDataDir();
  const first = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', configOverride: CFG as never,
  });
  const a = await TestClient.connect(first.port);
  await a.joinAsNew('Ann', 'hunter22');
  a.sendEvent('ChatSend', { channel: 'global', text: 'meet me in balmora' });
  await a.waitEvent('ChatMessage', (v) => String((v as { text?: string }).text ?? '').includes('balmora'));
  a.close();
  await first.close(); // the world process ends, exactly as it does on an idle reap

  // A DIFFERENT world process over the same shared dir — the switch case.
  const second = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', configOverride: CFG as never,
  });
  t.after(() => second.close());
  const b = await TestClient.connect(second.port);
  t.after(() => b.close());
  await b.joinAsNew('Bob', 'hunter22');
  const seen = await b.waitEvent('ChatMessage',
    (v) => String((v as { text?: string }).text ?? '').includes('balmora'), 10000).catch(() => null);
  assert.ok(seen, 'the conversation died with the world — a switch would lose all of it');
});

// A mute is enforced at delivery, so it must be enforced on REPLAY too: history is the
// cheapest possible back door around one.
test('a muted speaker stays muted in the scrollback', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: CFG as never,
  });
  t.after(() => server.close());

  const loud = await TestClient.connect(server.port);
  t.after(() => loud.close());
  await loud.joinAsNew('Loud', 'hunter22');
  const quiet = await TestClient.connect(server.port);
  t.after(() => quiet.close());
  await quiet.joinAsNew('Quiet', 'hunter22');

  quiet.sendEvent('MuteAdd', { name: 'Loud' });
  await quiet.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'MuteAdd');
  loud.sendEvent('ChatSend', { channel: 'global', text: 'buy my potions' });
  await loud.waitEvent('ChatMessage', (v) => String((v as { text?: string }).text ?? '').includes('potions'));

  // Quiet rejoins: the muted line must not arrive as history.
  quiet.close();
  const again = await TestClient.connect(server.port);
  t.after(() => again.close());
  await again.joinExisting('Quiet', 'hunter22');
  const leaked = await again.waitEvent('ChatMessage',
    (v) => String((v as { text?: string }).text ?? '').includes('potions'), 4000).catch(() => null);
  assert.equal(leaked, null, 'a muted speaker reached the listener through the scrollback');
});

// P6: a block silences LIVE chat in both directions, not only the replay on the next join.
test('a block stops live chat both ways', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: CFG as never,
  });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Pest', 'hunter22');
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Blocker', 'hunter22');

  b.sendEvent('BlockAdd', { name: 'Pest' });
  await b.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'BlockAdd');
  const said = (who: TestClient, text: string) => (v: unknown) => String((v as { text?: string }).text ?? '') === text;

  a.sendEvent('ChatSend', { channel: 'global', text: 'pest says hi' });
  await a.waitEvent('ChatMessage', said(a, 'pest says hi'));
  assert.equal(await b.waitEvent('ChatMessage', said(b, 'pest says hi'), 1500).catch(() => null), null,
    'the blocker still heard the blocked player live');

  b.sendEvent('ChatSend', { channel: 'global', text: 'blocker says hi' });
  await b.waitEvent('ChatMessage', said(b, 'blocker says hi'));
  assert.equal(await a.waitEvent('ChatMessage', said(a, 'blocker says hi'), 1500).catch(() => null), null,
    'the blocked player still heard the blocker live');
});

// OT3-46: history is scoped by channel, not world id. Rows from the old world-id scope are
// dropped on open (old private worlds' chat must not replay on the one world); server-wide
// rows move under their channel.
test('chat history migrates from world-id scope to channel scope', () => {
  const dir = tmpDataDir();
  const old = new SocialStore(dir);
  const now = Date.now();
  old.appendChat({ ts: now, channel: 'global', scope: '', acct: 'a', name: 'A', text: 'server-wide' }, 200);
  old.appendChat({ ts: now, channel: 'party', scope: 'priv-someone', acct: 'a', name: 'A', text: 'private' }, 200);
  old.close();
  const s = new SocialStore(dir);
  assert.deepEqual(s.recentChat('global', 10).map((r) => r.text), ['server-wide']);
  assert.equal(s.recentChat('party', 10).length, 0, 'a private world line must not reach world chat');
  assert.equal(s.recentChat('priv-someone', 10).length, 0);
  s.close();
});

test('the replay window equals the client buffer and keeps the newest lines (OT3-127)', async () => {
  const { replayWindow, CHAT_REPLAY_LINES } = await import('../src/core/chat');
  const a = Array.from({ length: 60 }, (_, i) => ({ ts: i * 2, n: i }));
  const b = Array.from({ length: 60 }, (_, i) => ({ ts: i * 2 + 1, n: 1000 + i }));
  const out = replayWindow(a, b);
  assert.equal(CHAT_REPLAY_LINES, 50);
  assert.equal(out.length, CHAT_REPLAY_LINES);
  assert.equal(out[out.length - 1]!.n, 1059, 'newest line survives');
  assert.ok(out.every((l, i) => i === 0 || out[i - 1]!.ts <= l.ts), 'oldest first');
});
