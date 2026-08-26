// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3 client side: the in-game world browser, which the world proxies to the gateway on the
// player's behalf (the Lua client has no HTTP of its own).
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldBrowser } from '../src/core/worldbrowser';
import type { Player } from '../src/core/players';
import { loadConfig } from '../src/config';
import { tmpDataDir } from './helpers';

const player = (accountKey: string): Player => ({
  id: 1, name: accountKey, accountKey, charId: accountKey, rank: 0,
  peer: { sendEvent() {}, sendBinary: () => true, sendBinaryFrame: () => true, disconnect() {} },
  ip: '', inWorld: true, moveSeq: 0, poseVersion: 0,
});

function fakeGateway(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch;
}

test('world browser: disabled without a gateway, and says so rather than looking empty', async () => {
  const wb = new WorldBrowser({ gatewayUrl: '' });
  assert.equal(wb.enabled, false);
  const r = await wb.list(player('alice'));
  // 'no_gateway' is NOT the same as an empty list: the UI tells the player this is a
  // standalone world instead of implying the directory is broken or the lobby is deserted.
  assert.equal(r.error, 'no_gateway');
});

test('world browser: the account comes from the SESSION, never from the client', async () => {
  let sawUrl = '';
  let sawBody = '';
  const wb = new WorldBrowser({ serverToken: 'platform-secret',
    gatewayUrl: 'http://gw',
    fetchImpl: fakeGateway((url, init) => {
      sawUrl = url;
      sawBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ worlds: [] }), { status: 200 });
    }),
  });
  await wb.list(player('alice'));
  assert.match(sawUrl, /account=alice/, 'listing is scoped to the authenticated account');

  // Even though a malicious client could put anything in its message, create() takes the
  // account from the Player object the session authenticated.
  await wb.create(player('alice'), 'sess1', 'private');
  assert.match(sawBody, /"account":"alice"/, 'creation is attributed to the authenticated account');
});

test('world browser: a wedged gateway does not hang the player', async () => {
  const wb = new WorldBrowser({ serverToken: 'platform-secret',
    gatewayUrl: 'http://gw',
    timeoutMs: 50,
    // A gateway that answers far too slowly. The real AbortSignal.timeout must cut it off;
    // the timer is unref'd and cleared on abort so this test cannot outlive itself and
    // cancel its siblings (an earlier version left a promise pending forever and took the
    // rest of the file down with it).
    fetchImpl: (async (_u: unknown, init?: RequestInit) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response('{}', { status: 200 })), 5_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      });
    })) as unknown as typeof fetch,
  });
  const r = await wb.list(player('alice'));
  assert.equal(r.error, 'unreachable', 'a timeout is reported, not thrown into the session');
  assert.deepEqual(r.worlds, []);
});

test('world browser: gateway refusals are translated into reasons the UI can explain', async () => {
  const mk = (status: number) => new WorldBrowser({ serverToken: 'platform-secret',
    gatewayUrl: 'http://gw',
    fetchImpl: fakeGateway(() => new Response(JSON.stringify({ error: 'x' }), { status })),
  });
  assert.equal((await mk(429).create(player('a'), 'w', 'private')).error, 'too_many_sessions');
  assert.equal((await mk(503).create(player('a'), 'w', 'private')).error, 'platform_full');
  assert.equal((await mk(400).create(player('a'), 'w', 'private')).error, 'refused');
});

test('world browser: bad input is rejected before it reaches the gateway', async () => {
  let called = false;
  const wb = new WorldBrowser({ serverToken: 'platform-secret',
    gatewayUrl: 'http://gw',
    fetchImpl: fakeGateway(() => { called = true; return new Response('{}', { status: 200 }); }),
  });
  assert.equal((await wb.create(player('a'), '../../etc/passwd', 'private')).error, 'bad_id');
  assert.equal((await wb.create(player('a'), 'ok', 'public')).error, 'bad_mode',
    'a client must not be able to create a PUBLIC world');
  assert.equal(called, false, 'nothing invalid is forwarded to the gateway at all');
});

test('world browser: a successful list is passed through', async () => {
  const wb = new WorldBrowser({ serverToken: 'platform-secret',
    gatewayUrl: 'http://gw',
    ownPort: () => 1234,
    fetchImpl: fakeGateway(() => new Response(JSON.stringify({
      worlds: [{ id: 'vvardenfell', mode: 'public', name: 'Vvardenfell', host: 'h', port: 9000, playerCount: 3, maxPlayers: 32, up: true }],
    }), { status: 200 })),
  });
  const r = await wb.list(player('alice'));
  assert.equal(r.worlds.length, 1);
  assert.equal(r.worlds[0]!.playerCount, 3);
  assert.equal(wb.ownPort, 1234, 'the world reports its own port so the UI can mark "you are here"');
});

test('world browser: without a platform credential, creating a world fails CLOSED', async () => {
  // A world server proves it is part of the platform with a shared credential; the gateway
  // takes the account from the caller's identity and never from the body. If the credential
  // is not configured there is no trust path at all, and the honest answer is to refuse --
  // not to send an unauthenticated request the gateway will bounce with an opaque 401, which
  // is what a whole afternoon of triage went into diagnosing.
  let called = false;
  const wb = new WorldBrowser({
    gatewayUrl: 'http://gw.invalid',
    fetchImpl: (async () => { called = true; return new Response('{}', { status: 200 }); }) as typeof fetch,
  });
  const r = await wb.create({ accountKey: 'alice' } as never, 'my-session', 'private');
  assert.equal(r.error, 'no_server_token');
  assert.equal(called, false, 'and it must not even ask the gateway');
});

test('the gateway credential generates itself, and both halves get the SAME one', async () => {
  // Requiring an operator to invent and paste a secret means the feature is silently dead on
  // every deployment that forgets. The gateway and every world it spawns read the same shared
  // dir, so a file there is the one place both halves are guaranteed to agree.
  const shared = tmpDataDir();
  const gateway = loadConfig(tmpDataDir(), undefined, shared);
  assert.ok(gateway.gateway.serverToken.length > 20, 'a credential is minted on first load');

  // A WORLD the gateway spawned: its own data dir is empty, the shared dir is the same.
  const world = loadConfig(tmpDataDir(), undefined, shared);
  assert.equal(world.gateway.serverToken, gateway.gateway.serverToken,
    'the world must present the credential the gateway will recognise — a per-process secret '
    + 'would refuse every create, differently on each restart');

  // An operator who wants to manage it still wins.
  const explicit = loadConfig(tmpDataDir(), { gateway: { serverToken: 'mine' } }, shared);
  assert.equal(explicit.gateway.serverToken, 'mine', 'an explicit value overrides the minted one');
});
