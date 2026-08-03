// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 2.5 chat tiers: '!' global, '@' party (members only, wherever they stand), plain
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

test('party chat reaches members only, and refuses when you have no party', async (t) => {
  const { a, b } = await two(t);
  // Not in a party yet: a helpful refusal, not silence.
  // (the join MOTD is also a 'server' line, so match on the text we are asserting about)
  a.sendEvent('ChatSend', { text: '@anyone there?' });
  await a.waitEvent('ChatMessage', (v) => /not in a party/i.test(String((v as { text?: string }).text ?? '')));

  a.sendEvent('PartyInvite', { acct: 'bob' });
  await b.waitEvent('PartyInviteReceived');
  b.sendEvent('PartyAccept', { acct: 'alice' });
  await b.waitEvent('PartyUpdate');

  a.sendEvent('ChatSend', { text: '@regroup at the tower' });
  const heard = await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'regroup at the tower');
  assert.equal((heard.value as { channel: string }).channel, 'party', 'delivered on the party channel');
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
