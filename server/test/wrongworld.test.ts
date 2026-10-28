// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { AccountStore } from '../src/core/accounts';

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
