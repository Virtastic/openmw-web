// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE WRONG CHARACTER IN THE RIGHT ACCOUNT IS STILL THE WRONG WORLD.
//
// Private world ids end with the last 8 of their character's id, but mayJoinWorld is
// owner-scoped — so the owner was admitted to ANY of their private worlds with ANY character,
// including the still-running world of a character they had deleted. A stale cache routed a
// real player exactly there, and the frozen chargen guard, the unsaved character and the dead
// Public button were all that one mistake downstream. The door now refuses it outright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { AccountStore } from '../src/core/accounts';

async function fixture(dataDir: string) {
  const accounts = new AccountStore(dataDir);
  const acct = await accounts.register('Owner', 'hunter22');
  assert.ok(typeof acct !== 'string');
  const char = accounts.createCharacter(acct, 'Hero');
  assert.ok(typeof char !== 'string');
  await accounts.flush();
  return char.id;
}

function world(dataDir: string, worldId: string) {
  process.env.OMW_WORLD_ID = worldId;
  return startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldId, worldMode: 'private', worldOwner: 'owner',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
}

test("the owner's character is admitted to the world made for it, and no other", async (t) => {
  t.after(() => { delete process.env.OMW_WORLD_ID; });
  const dataDir = tmpDataDir();
  const charId = await fixture(dataDir);

  // The RIGHT world: id ends with the character's last 8.
  const home = await world(dataDir, `priv-owner-${charId.slice(-8)}`);
  const a = await TestClient.connect(home.port);
  a.hello();
  await a.waitJson('SessionHelloOk');
  a.login('Owner', 'hunter22', { characterId: charId });
  await a.waitJson('SessionWelcome');
  a.close();
  await a.closed;
  await home.close();

  // A DIFFERENT world of the same owner — a deleted character's, a stale route, anything.
  const zombie = await world(dataDir, 'priv-owner-deadbeef');
  t.after(() => zombie.close());
  const b = await TestClient.connect(zombie.port);
  t.after(() => b.close());
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.login('Owner', 'hunter22', { characterId: charId });
  const refusal = await b.waitJson('SessionDisconnect');
  assert.match(String(refusal['detail'] ?? ''), /different character/,
    'the owner was admitted to a world that was not made for this character');
});

// A NAMED CHARACTER OUTRANKS THE AUTO-CREATE. An account with zero slots is exactly what a
// brand-new player mid-first-creation looks like — provisionals only become slots when
// chargen finishes — and the empty-account branch used to mint a server-side character for
// every auth, ignoring the characterId the client sent. The world had been built for the
// chosen character, so the guard refused the phantom: "belongs to a different character" on
// every attempt at creating a FIRST character. conn.auth_char named it: sent one id,
// resolved a stranger.
test('an auth naming a character resolves THAT character even on an empty account', async (t) => {
  const dataDir = tmpDataDir();
  const accounts = new AccountStore(dataDir);
  const acct = await accounts.register('Fresh', 'hunter22');
  assert.ok(typeof acct !== 'string');
  await accounts.flush(); // zero character slots — the first-creation state

  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const provisional = 'c' + 'a1b2c3d4e5f6a7b8c9d0e1f2'; // well-formed launcher-style id
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  a.hello();
  await a.waitJson('SessionHelloOk');
  a.login('Fresh', 'hunter22', { characterId: provisional });
  const w = await a.waitJson('SessionWelcome');
  assert.equal(String(w['characterId']), provisional,
    'the server minted its own character instead of honouring the one the client named');
});
