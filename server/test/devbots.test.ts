// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// DEV/TEST BOTS: a friend request and a party invite must be ACCEPTED, through the same
// social path a human uses — and the feature must stay off unless asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { AccountStore } from '../src/core/accounts';
import { PlayerStore } from '../src/persist/playerstore';

// Real Morrowind record ids, taken from characters that actually exist on the dev server —
// not invented, because a wrong content id produces a broken puppet.
const LOOK = {
  botRace: 'dark elf', botHead: 'b_n_dark elf_m_head_01',
  botHair: 'b_n_dark elf_m_hair_01', botClass: 'acrobat',
};
const BOTS = {
  dev: { bots: 2, botPrefix: 'Bot', ...LOOK },
  rules: { respawnCellKey: '-2,-9', respawnX: -10350, respawnY: -71235, respawnZ: 167 },
  login: { allowHarnessAuth: true },
};

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

// AN ACCOUNT IS A PRECONDITION, NOT A SIDE EFFECT. Account creation used to be fire-and-forget
// while the bot joined the roster immediately, so for the first moments after boot a bot was
// visible but unreachable: a friend request resolves a typed NAME through the account index.
// That race would only ever surface as "the bot ignored me". And register() answers 'exists'
// on the second boot, which skipped the username — leaving a bot whose first attempt failed
// permanently without a handle.
test('every bot has a real account and public handle, and a restart reuses it', async (t) => {
  const dataDir = tmpDataDir();
  const opts = {
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: BOTS as never,
  };

  const first = await startServer(opts);
  // Closed BEFORE reading: the account store is write-behind, so a fresh reader would see
  // whatever had reached disk rather than what the bots actually have.
  await first.close();

  const seen = new AccountStore(dataDir);
  for (const name of ['Bot1', 'Bot2']) {
    const acct = await seen.get(name);
    assert.ok(acct, `${name} joined the roster with no account — unreachable by name`);
    assert.equal(acct.username, name, `${name} has no public handle`);
  }
  const createdAt = (await seen.get('Bot1'))!.createdAt;

  // Second boot: the same account, not a duplicate or a fresh one.
  const second = await startServer(opts);
  t.after(() => second.close());
  const after = new AccountStore(dataDir);
  assert.equal((await after.get('Bot1'))?.createdAt, createdAt, 'the bot account was recreated');
  assert.equal((await after.get('Bot1'))?.username, 'Bot1');
});

// A BOT IS A CHARACTER, NOT JUST AN ACCOUNT — and it stands where players begin. An account
// with no character has no slot, no doc and no position, so nothing that reads a character
// (the Players panel, a party row, the world) has anything to show.
test('each bot has a completed character standing in the starter village', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: BOTS as never,
  });
  await server.close(); // write-behind stores: read what they actually hold

  const accounts = new AccountStore(dataDir);
  const acct = await accounts.get('Bot1');
  assert.ok(acct, 'Bot1 has no account');
  const slot = (acct.characters ?? [])[0];
  assert.ok(slot, 'Bot1 has an account but no character');
  assert.equal(slot.name, 'Bot1');
  assert.equal(slot.completed, true, 'an incomplete slot reads as creation-in-progress');

  const players = new PlayerStore(dataDir, 'default');
  const doc = await players.get(slot.id);
  assert.equal(doc?.position?.cellKey, '-2,-9', 'the bot is not in the starter village');
  // Appearance is what spawns a puppet for other clients; handleAppearance refuses a partial
  // one, so all four required fields must be present or none.
  assert.equal(doc?.appearance?.name, 'Bot1');
  assert.equal(doc?.appearance?.race, 'dark elf');
});

// Content ids are deployment-specific, so an unconfigured server must NOT invent them: a
// broken puppet is worse than no puppet.
test('without configured content ids a bot is social-only, never half-dressed', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { dev: { bots: 1, botPrefix: 'Bot' }, login: { allowHarnessAuth: true } } as never,
  });
  await server.close();

  const accounts = new AccountStore(dataDir);
  const slot = ((await accounts.get('Bot1'))?.characters ?? [])[0];
  assert.ok(slot, 'the bot should still have a character');
  const doc = await new PlayerStore(dataDir, 'default').get(slot.id);
  assert.equal(doc?.appearance, undefined, 'a partial appearance would withhold the record');
  assert.ok(doc?.position, 'it still stands somewhere');
});
