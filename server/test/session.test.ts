// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// End-to-end session tier over real ws clients against a server on an ephemeral port.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../src/server';
import { TestClient, tmpDataDir, MANIFEST } from './helpers';

test('session flow end to end', async (t) => {
  const dataDir = tmpDataDir();
  let server: RunningServer = await startServer({ requireGameData: false,
    dataDir,
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { helloTimeoutMs: 500 } },
  });
  t.after(() => server.close());

  // Note: nested subtests must use the SUBTEST's context (tt), not the outer t —
  // t.test() from inside a running subtest deadlocks the runner.
  await t.test('happy path: Hello -> Register -> Welcome -> Ready -> IN_WORLD', async (tt) => {
    const a = await TestClient.connect(server.port);
    a.hello();
    const helloOk = await a.waitJson('SessionHelloOk');
    assert.equal(helloOk['serverName'], 'OpenMW-Web server');
    assert.equal(helloOk['contentPolicy'], 'names');
    a.register('Alice', 'correct horse');
    const w = await a.waitJson('SessionWelcome');
    assert.equal(typeof w['playerId'], 'number');
    assert.match(w['sessionToken'] as string, /^[0-9a-f]{32}$/);
    assert.equal(w['playerRecord'], null);
    assert.equal(w['serverSeq'], 0);
    a.sendJson({ t: 'SessionReady' });
    const join = await a.waitEvent('PlayerJoinWorld');
    assert.deepEqual(join.value, { id: w['playerId'], name: 'Alice' });
    const list = await a.waitEvent('PlayerList');
    assert.deepEqual(list.value, { players: [{ id: w['playerId'], name: 'Alice' }] });
    // motd plugin proves the hook bus.
    const motd = await a.waitEvent('ChatMessage');
    assert.deepEqual(motd.value, { channel: 'server', text: 'Welcome.' });

    await tt.test('second player joins; chat round-trips as LSER events', async () => {
      const b = await TestClient.connect(server.port);
      const { playerId: bId } = await b.joinAsNew('Bob');
      const seenByA = await a.waitEvent('PlayerJoinWorld');
      assert.deepEqual(seenByA.value, { id: bId, name: 'Bob' });
      const seenByB = await b.waitEvent('PlayerJoinWorld', (v) => (v as { id: number }).id === bId);
      assert.deepEqual(seenByB.value, { id: bId, name: 'Bob' });
      const bList = await b.waitEvent('PlayerList');
      assert.deepEqual((bList.value as { players: unknown[] }).players.length, 2);

      a.sendEvent('ChatSend', { text: 'hello world' });
      const expect = { channel: 'say', from: 'Alice', fromId: w['playerId'], text: 'hello world' };
      assert.deepEqual((await a.waitEvent('ChatMessage', (v) => (v as { channel: string }).channel === 'say')).value, expect);
      const bChat = await b.waitEvent('ChatMessage', (v) => (v as { channel: string }).channel === 'say');
      assert.deepEqual(bChat.value, expect);
      assert.ok(bChat.seq >= 1); // server binary seq is monotonic from 1

      b.sendEvent('ChatSend', { text: '/list' });
      // M8 rewrote /list: one line per player, "#<id> <name> [<rank>] <cell>". b's own
      // motd is still queued on the server channel, so match the roster lines themselves.
      const aliceLine = await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text?.includes('Alice') === true);
      assert.match((aliceLine.value as { text: string }).text, /^#\d+ Alice \[player\] /);
      const bobLine = await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text?.includes('Bob') === true);
      assert.match((bobLine.value as { text: string }).text, /^#\d+ Bob \[player\] /);
      b.close();
      await b.closed;
      const leave = await a.waitEvent('PlayerLeaveWorld');
      assert.deepEqual(leave.value, { id: bId });
    });

    await tt.test('duplicate account login supersedes the first session', async () => {
      const a2 = await TestClient.connect(server.port);
      a2.hello();
      await a2.waitJson('SessionHelloOk');
      a2.login('Alice', 'correct horse');
      await a2.waitJson('SessionWelcome');
      const superseded = await a.waitDisconnect('SUPERSEDED');
      assert.equal(superseded['code'], 'SUPERSEDED');
      await a.closed;
      a2.close();
      await a2.closed;
    });
  });

  await t.test('bad subprotocol is rejected', async () => {
    await assert.rejects(TestClient.connect(server.port, 'omw-mp.999')); // handshake refused (400)
    // Offering no subprotocol passes the ws handshake but must be closed immediately.
    const bare = await TestClient.connect(server.port, null);
    const { code } = await bare.closed;
    assert.equal(code, 1002);
  });

  await t.test('Hello timeout closes the socket', async () => {
    const c = await TestClient.connect(server.port);
    await c.waitDisconnect('BAD_PROTO', 2000);
    await c.closed;
  });

  await t.test('wrong password -> AUTH_FAILED', async () => {
    const c = await TestClient.connect(server.port);
    c.hello();
    await c.waitJson('SessionHelloOk');
    c.login('Alice', 'wrong password');
    await c.waitDisconnect('AUTH_FAILED');
    await c.closed;
  });

  await t.test('content mismatch -> BAD_CONTENT naming the file', async () => {
    // Alice's manifest is canonical while her earlier logins kept holds; connect a holder first.
    const holder = await TestClient.connect(server.port);
    await holder.joinAsNew('Holder');
    const c = await TestClient.connect(server.port);
    c.hello([{ name: 'Tribunal.esm', size: 1, idx: 0 }]);
    const d = await c.waitDisconnect('BAD_CONTENT');
    assert.match(d['detail'] as string, /Morrowind\.esm/);
    await c.closed;
    holder.close();
    await holder.closed;
  });

  await t.test('ping works pre-auth', async () => {
    const c = await TestClient.connect(server.port);
    c.sendJson({ t: 'SessionPing', clientTime: 123 });
    const p = await c.waitJson('SessionPong');
    assert.equal(p['clientTime'], 123);
    assert.equal(typeof p['serverTime'], 'number');
    c.close();
    await c.closed;
  });

  await t.test('accounts persist across a server restart', async () => {
    await server.close();
    server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
    const c = await TestClient.connect(server.port);
    c.hello(MANIFEST);
    await c.waitJson('SessionHelloOk');
    c.login('Alice', 'correct horse');
    const w = await c.waitJson('SessionWelcome');
    assert.equal(typeof w['playerId'], 'number');
    c.close();
    await c.closed;
  });
});
