// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 2.5 chat tiers: '!' global, '@' world chat (everyone in this world), plain
// say world-wide by default and proximity-scoped where a deployment asks for it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

async function two(t: { after(fn: () => unknown): void }, override = {}, cellA = '0,0', cellB = '0,0') {
  const server = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 }, ...override },
  });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  a.sendCellChange(cellA, 0, 0, 0);
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  b.sendCellChange(cellB, 0, 0, 0);
  return { server, a, b };
}

const said = (c: TestClient, text: string) =>
  c.inbox.events.filter((e) => e.name === 'ChatMessage' && (e.value as { text?: string }).text === text);

test('plain say is world-wide by default, proximity when the deployment asks', async (t) => {
  // Far apart, default scope: still heard. A co-op group spread across the map must be
  // able to talk, which is what a self-hosted server almost always is.
  const world = await two(t, {}, '0,0', '40,40');
  world.a.sendEvent('ChatSend', { text: 'across the map' });
  await world.b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'across the map');
  world.a.close();
  world.b.close();

  // Same setup with proximity: not heard.
  const prox = await two(t, { rules: { sayScope: 'proximity' } }, '0,0', '40,40');
  prox.a.sendEvent('ChatSend', { text: 'too far' });
  prox.a.sendEvent('ChatSend', { text: '!but this is global' });
  await prox.b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'but this is global');
  assert.equal(said(prox.b, 'too far').length, 0, 'proximity say must not cross the province');
  prox.a.close();
  prox.b.close();
});

test('proximity say still reaches a neighbour in the same cell', async (t) => {
  const { a, b } = await two(t, { rules: { sayScope: 'proximity' } }, '5,5', '5,5');
  a.sendEvent('ChatSend', { text: 'right here' });
  await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'right here');
  a.close();
  b.close();
});

test("the '@' tier is world chat: everyone in this world hears it, no membership needed", async (t) => {
  const { a, b } = await two(t);
  a.sendEvent('ChatSend', { text: '@regroup at the tower' });
  const heard = await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'regroup at the tower');
  // The wire channel name predates the party removal; the semantics are per-world.
  assert.equal((heard.value as { channel: string }).channel, 'party', 'delivered on the world channel');
  a.close();
  b.close();
});

test('a bare tier prefix is treated as a typo, not an empty message', async (t) => {
  const { a, b } = await two(t);
  a.sendEvent('ChatSend', { text: '!' });
  a.sendEvent('ChatSend', { text: '@  ' });
  a.sendEvent('ChatSend', { text: '!real one' });
  await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'real one');
  assert.equal(said(b, '').length, 0, 'no empty lines are broadcast');
  a.close();
  b.close();
});

test('chat is rate limited, the flooder is told, and it refills', async (t) => {
  // Chat is the one tier where one client's message budget is spent on everybody else: a
  // single inbound line becomes one outbound event PER PLAYER. The general budget only
  // disconnects ABOVE 60/s, so a flooder sitting just under it sustained ~59 lines a second
  // at every player on the world, forever -- and PROTOCOL.md already promises the global
  // tier is rate limited. FLOOD stays under the general budget on purpose: this must be the
  // chat limiter refusing lines, not the connection limiter dropping the socket.
  const world = await two(t);
  const FLOOD = 40;
  for (let i = 0; i < FLOOD; i++) world.a.sendEvent('ChatSend', { text: `flood ${i}` });

  // 1. The flooder is TOLD. A line that silently vanishes reads as broken chat and gets
  //    retyped, which is the one thing that makes a flood worse.
  await world.a.waitEvent('ChatMessage', (v) => {
    const m = v as { channel?: string; text?: string };
    return m.channel === 'server' && /too quickly/i.test(m.text ?? '');
  });

  // 2. It REFILLS — a limiter with no way back is a mute. Retrying until a line lands both
  //    proves that and fences: everything sent before it has been delivered to Bob.
  const done = 'after the flood';
  const landed = world.b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === done);
  const retry = setInterval(() => world.a.sendEvent('ChatSend', { text: done }), 300);
  t.after(() => clearInterval(retry));
  await landed;
  clearInterval(retry);

  // 3. The control: the flood was CUT, not merely announced. Without the limiter every one
  //    of the 60 reaches Bob.
  const heard = world.b.inbox.events.filter((e) =>
    e.name === 'ChatMessage' && /^flood /.test((e.value as { text?: string }).text ?? '')).length;
  assert.ok(heard < FLOOD, `every one of the ${FLOOD} flooded lines reached the other player`);
  assert.ok(heard >= 20,
    `only ${heard} lines got through; the burst allowance must still cover a pasted paragraph`);
  world.a.close();
  world.b.close();
});
