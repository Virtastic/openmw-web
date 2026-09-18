// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A resume after a drop must work for an account whose public HANDLE differs from its login
// name -- every real account. The parked resume ticket carried the player's display name
// (the handle once ProfileSetup has run) and the resume path looked the account up by it,
// so it answered 'account no longer available' and the client fell back to a full page
// reboot (s170 fresh65: 33 s instead of a 3 s redial; backlog 491). The suite's harness
// accounts have no handle, which is why nothing here ever caught it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('a resume token still finds the account once a handle is set', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  const { welcome } = await a.joinAsNew('Ada Lovelace');
  await a.waitEvent('PlayerList');
  a.sendJson({ t: 'ProfileSetup', email: 'a@example.com', username: 'ada' });
  await a.waitJson('ProfileResult');
  // A wifi blip: the socket goes, the ticket parks.
  a.close();
  await a.closed;

  const back = await TestClient.connect(server.port);
  back.hello();
  await back.waitJson('SessionHelloOk');
  back.sendJson({ t: 'SessionResume', token: welcome['sessionToken'] });
  const wr = await back.waitJson('SessionWelcome');
  assert.ok(wr['sessionToken'], 'resumed in place on the parked token');
  back.close();
  await back.closed;
});
