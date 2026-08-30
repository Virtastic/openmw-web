// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.6/3.8: the web dashboard's auth boundary and actions, persistent mutes being
// enforced at delivery, the plausible-speed anomaly counter, and the shipped harness
// password being refused unless an operator opts in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { SocialStore } from '../src/core/socialstore';
import { TestClient, tmpDataDir } from './helpers';

const TOKEN = 'dash-token-under-test';

async function boot(t: { after(fn: () => unknown): void }, override = {}) {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false,
    dataDir, port: 0, host: '127.0.0.1',
    configOverride: { admin: { dashboardToken: TOKEN }, ...override },
  });
  t.after(() => server.close());
  return { server, dataDir, base: `http://127.0.0.1:${server.port}` };
}

test('dashboard: page is public, api needs the bearer, unknown action refused', async (t) => {
  const { base } = await boot(t);

  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200, 'the page itself does nothing without a token, so it is servable');
  assert.match(await page.text(), /OpenMW-Web admin/);

  assert.equal((await fetch(`${base}/admin/api/overview`)).status, 401, 'no token');
  assert.equal((await fetch(`${base}/admin/api/overview`, {
    headers: { authorization: 'Bearer wrong-token-same-len' },
  })).status, 401, 'wrong token');

  const ok = await fetch(`${base}/admin/api/overview`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
  const body = await ok.json() as { players: unknown[]; world: { mode: string } };
  assert.ok(Array.isArray(body.players));
  assert.equal(body.world.mode, 'public');

  const bad = await fetch(`${base}/admin/api/action`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'launch_missiles', target: 'x' }),
  });
  assert.equal(bad.status, 400);
});

test('with no token configured the page still serves, but the api stays shut', async (t) => {
  // This REVERSED a previous rule ("no token = no dashboard at all"). Accounts are now the
  // way in, and first-run setup happens in the browser, so a server with no token must still
  // serve the page — otherwise a fresh install has no route to configuring itself. The page
  // is inert without a credential, which is what made hiding it unnecessary.
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  assert.equal((await fetch(`${base}/admin`)).status, 200, 'the setup page has to be reachable');
  assert.equal((await fetch(`${base}/admin/api/overview`)).status, 401, 'data still requires a credential');

  const state = await (await fetch(`${base}/admin/api/state`)).json() as { firstRun: boolean; authed: boolean };
  assert.equal(state.firstRun, true, 'a server nobody has set up reports itself as first-run');
  assert.equal(state.authed, false);

  // An empty shared token must never authenticate an empty Authorization header.
  assert.equal((await fetch(`${base}/admin/api/overview`, {
    headers: { authorization: 'Bearer ' },
  })).status, 401, 'an unconfigured token is not a blank password');
});

test('dashboard kick and ban act on a live player; anomalies surface per account', async (t) => {
  const { server, base } = await boot(t);
  const act = (kind: string, target: string, detail = '') => fetch(`${base}/admin/api/action`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind, target, detail }),
  });

  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');

  const overview = await (await fetch(`${base}/admin/api/overview`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json() as { players: { account: string; anomalies: Record<string, number> }[] };
  assert.equal(overview.players[0]?.account, 'alice');
  assert.deepEqual(overview.players[0]?.anomalies, {}, 'a well-behaved player has no flags');

  const kicked = await act('kick', 'alice', 'testing');
  assert.equal(kicked.status, 200);
  await a.waitDisconnect('KICKED');

  const banned = await act('ban', 'nobody-here', 'spam');
  assert.equal(banned.status, 200, 'banning an offline account is legitimate');
  const b = await TestClient.connect(server.port);
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.register('nobody-here', 'hunter22');
  await b.waitDisconnect('BANNED');
});

test('mutes persist and are enforced at delivery, including moderator mutes', async () => {
  const dir = tmpDataDir();
  const store = new SocialStore(dir);
  store.addMute('alice', 'bob', Date.now());
  assert.equal(store.isMuted('alice', 'bob'), true);
  assert.equal(store.isMuted('bob', 'alice'), false, 'mute is directional');
  assert.equal(store.isMuted('carol', 'bob'), false, "one player's mute is not everyone's");

  // Moderator mute: one row, every listener sees the effect.
  store.addMute(SocialStore.SERVER_MUTER, 'bob', Date.now());
  assert.equal(store.isMuted('carol', 'bob'), true, 'a server mute applies to everyone');
  store.removeMute(SocialStore.SERVER_MUTER, 'bob');
  assert.equal(store.isMuted('carol', 'bob'), false);
  assert.equal(store.isMuted('alice', 'bob'), true, 'lifting the server mute keeps a personal one');
  store.close();

  // Persistence: a fresh store over the same dir still knows.
  const again = new SocialStore(dir);
  assert.equal(again.isMuted('alice', 'bob'), true, 'a mute that evaporates on relog is not a mute');
  again.close();
});

test('muted chat is never delivered to the muter', async (t) => {
  const { server } = await boot(t);
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  b.sendCellChange('0,0', 0, 0, 0);

  a.sendEvent('MuteAdd', { acct: 'bob' });
  await a.waitEvent('SocialResult', (v) => (v as { op: string }).op === 'MuteAdd');

  b.sendEvent('ChatSend', { text: 'hello everyone' });
  await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'hello everyone');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    a.inbox.events.filter((e) => e.name === 'ChatMessage' && (e.value as { text?: string }).text === 'hello everyone').length,
    0,
    'the muter must not receive the line at all — enforcement is server-side',
  );
  a.close();
  b.close();
});

test('the shipped harness password is refused unless the operator opts in', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' }); // allowHarnessAuth defaults false
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.register('Someone', 'harness-pass-1');
  const refusal = await c.waitDisconnect('AUTH_FAILED');
  assert.match(String(refusal['detail']), /harness/i);

  // With the opt-in it works — which is what the browser harness relies on.
  const dataDir2 = tmpDataDir();
  const server2 = await startServer({ requireGameData: false,
    dataDir: dataDir2, port: 0, host: '127.0.0.1',
    configOverride: { login: { allowHarnessAuth: true } },
  });
  t.after(() => server2.close());
  const c2 = await TestClient.connect(server2.port);
  await c2.joinAsNew('Someone', 'harness-pass-1');
  c2.close();
});
