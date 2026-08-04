// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// DEV/TEST BOTS: a friend request and a party invite must be ACCEPTED, through the same
// social path a human uses — and the feature must stay off unless asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const BOTS = { dev: { bots: 2, botPrefix: 'Bot' }, login: { allowHarnessAuth: true } };

async function boot(t: { after(fn: () => unknown): void }, override: unknown) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: override as never,
  });
  t.after(() => server.close());
  return server;
}

test('a bot accepts a friend request, then a party invite', async (t) => {
  const server = await boot(t, BOTS);

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Human', 'hunter22');

  // The bots are in the roster like anyone else — that is what makes them useful for a video.
  const names = server.api.players().map((p) => p.name);
  assert.ok(names.includes('Bot1'), `expected Bot1 in the roster, got ${names.join(', ')}`);

  // FRIEND. The client sends a NAME (what a player types/clicks); the bot answers FriendAccept.
  a.sendEvent('FriendRequest', { name: 'Bot1' });
  const friends = await a.waitEvent('FriendList',
    (v) => ((v as { friends?: { acct: string }[] }).friends ?? []).some((f) => f.acct === 'bot1'));
  assert.ok(friends, 'the bot never became a friend');

  // PARTY. Same shape: invite by name, the bot answers PartyAccept and appears as a member.
  a.sendEvent('PartyInvite', { name: 'Bot1' });
  const party = await a.waitEvent('PartyUpdate',
    (v) => ((v as { members?: { acct: string }[] }).members ?? []).some((m) => m.acct === 'bot1'));
  assert.ok(party, 'the bot never joined the party');
});

test('bots are OFF unless asked for', async (t) => {
  const server = await boot(t, { login: { allowHarnessAuth: true } });
  const names = server.api.players().map((p) => p.name);
  assert.deepEqual(names.filter((n) => n.startsWith('Bot')), [],
    'dev bots must never appear on a server that did not enable them');
});
