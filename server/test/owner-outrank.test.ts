// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-20: a moderator cannot ban, mute or otherwise sanction the dashboard owner, or a fellow
// staff member of equal rank, through the dashboard's /action route -- and the refusal says
// why. The owner usually plays at in-game rank 0, so the target's DASHBOARD role must count.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';

const OWNER = { name: 'owner@example.com', password: 'a-long-enough-passphrase' };
const PASS = 'a-sufficiently-long-password';

test('a moderator cannot sanction the owner or an equal, and a real ban sticks', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const call = async (path: string, token: string | undefined, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${server.port}/admin/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) as { ok?: boolean; message?: string; token?: string } };
  };
  const ownerToken = (await call('/setup/owner', undefined, OWNER)).body.token!;
  assert.ok(ownerToken);
  for (const name of ['Mod2', 'Mod3']) {
    await server.accounts.register(name, PASS);
    await call('/accounts/role', ownerToken, { name, role: 'moderator' });
    server.accounts.setRank(name, 2); // an admin-tier moderator: allowed to ban at all
  }
  await server.accounts.register('Griefer', PASS);
  const modToken = (await call('/login', undefined, { name: 'Mod2', password: PASS })).body.token!;
  assert.ok(modToken);
  const act = (kind: string, target: string, detail = 'abuse') => call('/action', modToken, { kind, target, detail });

  for (const kind of ['ban', 'mute']) {
    const r = await act(kind, OWNER.name);
    assert.notEqual(r.body.ok, true, `${kind} of the owner must be refused`);
    assert.match(r.body.message ?? '', /not below your rank: they are the owner/, `${kind}: ${r.body.message}`);
  }
  const owner = await server.accounts.get(server.accounts.keyForUsername(OWNER.name) ?? OWNER.name);
  assert.notEqual(owner?.banned, true, 'the owner account must not be flagged banned');
  assert.equal((await call('/login', undefined, OWNER)).status, 200, 'the owner can still sign in');

  // A co-owner promoted through /accounts/role keeps in-game rank 0: only the dashboard role
  // says they are the owner, and that alone must stop the ban (the pre-OT3-20 check missed it).
  await server.accounts.register('CoOwner', PASS);
  assert.equal((await call('/accounts/role', ownerToken, { name: 'CoOwner', role: 'owner' })).status, 200);
  const co = await act('ban', 'CoOwner');
  assert.notEqual(co.body.ok, true, 'a rank-0 co-owner must not be bannable by a moderator');
  assert.match(co.body.message ?? '', /they are the owner/);
  assert.notEqual((await server.accounts.get('coowner'))?.banned, true);

  const peer = await act('ban', 'Mod3');
  assert.notEqual(peer.body.ok, true, 'an equal-rank moderator must be refused');
  assert.match(peer.body.message ?? '', /not below your rank: they are an admin/);

  const ok = await act('ban', 'Griefer');
  assert.equal(ok.body.ok, true, ok.body.message);
  assert.equal((await server.accounts.get('griefer'))?.banned, true, 'a ban sets account.banned');
});
