// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The multiplayer server's dashboard, and the wizard that starts the server you chose.
//
// Choosing multiplayer in the wizard used to record a setting and leave the single-game
// program running; and the multiplayer server served no /admin at all, so an operator who
// switched the marker by hand was signed out of the thing they had switched with. Both halves
// here: the wizard writes the marker, and the multiplayer server serves the same dashboard,
// people first, with every per-game page reached through a proxy under one sign-in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';

import { WorldSupervisor, type WorldDeps } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';
import { gatewayAdminRoutes, platformMaintenance } from '../src/gateway/admin';
import { gatewayPrincipal, GATEWAY_ACTOR_HEADERS } from '../src/net/admin/auth';
import { GATEWAY_ONLY, SECTION_GROUPS, settingsView } from '../src/net/admin/api-settings';
import { MODE_FILE } from '../src/net/admin/routes';
import { AccountStore } from '../src/core/accounts';
import { AdminSessionStore } from '../src/auth/identities';
import { loadConfig } from '../src/config';
import { startServer } from '../src/server';
import { tmpDataDir } from './helpers';

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8');
const OWNER = { name: 'owner@example.com', password: 'a-long-enough-passphrase' };
const H = GATEWAY_ACTOR_HEADERS;

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill(sig: string): boolean {
    queueMicrotask(() => { this.exitCode = 0; this.emit('exit', 0, sig); });
    return true;
  }
}

function supervisor(worldsDir: string, extra: Partial<WorldDeps> = {}): WorldSupervisor {
  return new WorldSupervisor({
    settings: {
      worldsDir, gatewayPort: 8080, serverEntry: '/fake/s.mjs', nodeBin: '/fake/node',
      basePort: 43000, maxWorlds: 4, idleReapMs: 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 1000, sharedDir: mkdtempSync(join(tmpdir(), 'omw-mpd-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    ...extra,
  });
}

// --- the supervisor: the roster it always had, and discard by id -------------------------------

test('the supervisor keeps the roster its games already report', async () => {
  const worlds = supervisor(mkdtempSync(join(tmpdir(), 'omw-mpd-')), {
    fetchStatus: async () => ({
      playerCount: 1, connectedCount: 2, peerCount: 1, maxPlayers: 8, name: 'w',
      players: [{ id: 7, name: 'Runner', cellKey: '0,0', level: 3 }],
    }),
  });
  worlds.ensure('alpha', 'private', 'owner-a');
  await worlds.poll();
  const g = worlds.get('alpha')!;
  // The one question the multiplayer dashboard exists to answer: WHO, not how many.
  assert.deepEqual(g.players, [{ id: 7, name: 'Runner', cellKey: '0,0', level: 3 }]);
  assert.equal(g.connectedCount, 2);
  assert.equal(g.peerCount, 1);
  assert.equal(g.pid, 4242);
  assert.ok(g.startedAt > 0);
  assert.equal(g.everConnected, true);
  worlds.stopAll();
});

test('discard(id) stops a game and removes its data, and says when there was nothing', async () => {
  const wdir = mkdtempSync(join(tmpdir(), 'omw-mpd-'));
  const worlds = supervisor(wdir);
  worlds.ensure('priv-someone-abcd1234', 'private', 'someone');
  assert.ok(existsSync(join(wdir, 'priv-someone-abcd1234')), 'the world dir is created on start');
  assert.equal(await worlds.discard('priv-someone-abcd1234', { by: 'test' }), true);
  assert.ok(!existsSync(join(wdir, 'priv-someone-abcd1234')), 'the data is gone');
  assert.equal(worlds.get('priv-someone-abcd1234'), undefined, 'the process is gone');
  // On disk but not running: a world nobody rejoined after a restart.
  mkdirSync(join(wdir, 'priv-ghost-00000000'));
  assert.equal(await worlds.discard('priv-ghost-00000000'), true);
  assert.equal(await worlds.discard('priv-nothing-00000000'), false);
});

// --- the third principal ------------------------------------------------------------------------

test('the gateway principal: loopback plus the platform token plus a named operator', () => {
  const req = (remoteAddress: string, headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress } });
  const good = { authorization: 'Bearer tok', [H.key]: 'Owner@Example.com', [H.name]: 'Owner', [H.role]: 'owner' };

  const ctx = gatewayPrincipal(req('127.0.0.1', good), 'tok');
  assert.ok(ctx, 'accepted from loopback');
  assert.equal(ctx.accountKey, 'owner@example.com');
  assert.equal(ctx.accountName, 'Owner');
  assert.equal(ctx.role, 'owner');
  assert.equal(ctx.viaGateway, true);
  assert.equal(ctx.viaSharedToken, false);
  assert.ok(gatewayPrincipal(req('::ffff:127.0.0.1', good), 'tok'), 'IPv4-mapped loopback too');

  // THE TOKEN IS A FILE IN THE SHARED DIR. From anywhere but this machine it must buy nothing,
  // or it is an internet-facing admin credential.
  assert.equal(gatewayPrincipal(req('10.0.0.5', good), 'tok'), null, 'refused off loopback');
  assert.equal(gatewayPrincipal(req('172.18.0.2', good), 'tok'), null, 'a private peer is not loopback');
  assert.equal(gatewayPrincipal(req('127.0.0.1', { ...good, authorization: 'Bearer nope' }), 'tok'), null);
  assert.equal(gatewayPrincipal(req('127.0.0.1', good), ''), null, 'no token configured, no principal');
  assert.equal(gatewayPrincipal(req('127.0.0.1', { ...good, [H.role]: 'root' }), 'tok'), null, 'unknown role');
  assert.equal(gatewayPrincipal(req('127.0.0.1', { ...good, [H.key]: '' }), 'tok'), null, 'unnamed operator');
});

test('a game honours the principal from loopback, at the forwarded role', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { gateway: { serverToken: 'platform-token' } },
  });
  t.after(() => server.close());
  const call = (path: string, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${server.port}/admin/api${path}`, { headers });
  const asOwner = { authorization: 'Bearer platform-token', [H.key]: 'op@example.com', [H.name]: 'Op', [H.role]: 'owner' };
  assert.equal((await call('/overview', asOwner)).status, 200);
  // The token alone is not an identity.
  assert.equal((await call('/overview', { authorization: 'Bearer platform-token' })).status, 401);
  // The forwarded role is the role: a viewer proxied through is still a viewer.
  assert.equal((await call('/reports', { ...asOwner, [H.role]: 'viewer' })).status, 403);
});

// --- the wizard starts the server you chose ---------------------------------------------------

test('finishing the wizard writes the mode marker the entrypoint reads', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}/admin/api`;
  const post = (path: string, body: unknown, token = '') => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const owner = await post('/setup/owner', OWNER);
  assert.equal(owner.status, 200);
  const token = (await owner.json() as { token: string }).token;
  const marker = () => (existsSync(join(dataDir, MODE_FILE)) ? readFileSync(join(dataDir, MODE_FILE), 'utf8').trim() : null);

  // No environment flag: the answer is simply accepted.
  assert.equal((await post('/setup', { deploymentMode: 'multiplayer', completed: true }, token)).status, 200);
  assert.equal(marker(), 'gateway', 'multiplayer starts the multiplayer server');
  // A half-finished run must not flip the process.
  assert.equal((await post('/setup', { deploymentMode: 'single' }, token)).status, 200);
  assert.equal(marker(), 'gateway', 'an unfinished wizard writes nothing');
  assert.equal((await post('/setup', { deploymentMode: 'single', completed: true }, token)).status, 200);
  assert.equal(marker(), 'single', 'and back again, from the same page');

  const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
  assert.equal(state.platform, false, 'a game says it is a game');
  assert.ok(!('experimental' in state), 'the gate is gone from the bootstrap too');
});

// --- the multiplayer server serves the dashboard ----------------------------------------------

/** A stand-in game: answers /status like a real one and records what the proxy sends it. */
function fakeGame(name: string, seen: { headers: IncomingMessage['headers'][]; maintenance: unknown[] }):
Promise<{ port: number; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    const reply = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/status') {
      return reply(200, {
        name, playerCount: 1, connectedCount: 1, peerCount: 1, maxPlayers: 8,
        players: [{ id: 3, name: 'Runner', cellKey: '0,0', level: 5 }],
      });
    }
    if (req.url?.startsWith('/admin/api/')) {
      seen.headers.push(req.headers);
      if (req.url === '/admin/api/maintenance') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { seen.maintenance.push(JSON.parse(body)); reply(200, { ok: true }); });
        return;
      }
      return reply(200, { proxied: req.url, via: name });
    }
    reply(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      port: (srv.address() as { port: number }).port,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    }));
  });
}

test('the multiplayer server serves the dashboard: people first, games by proxy', async (t) => {
  const seen = { headers: [] as IncomingMessage['headers'][], maintenance: [] as unknown[] };
  const alpha = await fakeGame('alpha', seen);
  t.after(() => alpha.close());

  const sharedDir = mkdtempSync(join(tmpdir(), 'omw-mpd-shared-'));
  const worldsDir = join(sharedDir, 'worlds');
  mkdirSync(worldsDir);
  // The platform credential mints itself into the shared dir, as it does at boot.
  const config = loadConfig(sharedDir, undefined, sharedDir);
  assert.ok(config.gateway.serverToken, 'the platform token exists');

  const worlds = new WorldSupervisor({
    settings: {
      worldsDir, gatewayPort: 8080, serverEntry: '/fake/s.mjs', nodeBin: '/fake/node',
      basePort: 44000, maxWorlds: 4, idleReapMs: 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 1000, sharedDir,
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    // No fetchStatus: the real poller runs against the fake, roster parsing included.
  });
  worlds.ensure('alpha', 'party', 'owner-a');
  (worlds as unknown as { worlds: Map<string, { port: number }> }).worlds.get('alpha')!.port = alpha.port;
  await worlds.poll();
  mkdirSync(join(worldsDir, 'beta')); // on disk, not running: discardable all the same

  const accounts = new AccountStore(sharedDir);
  const maintenance = platformMaintenance({ worlds, sharedDir, worldsDir, token: () => config.gateway.serverToken });
  let rolls = 0;
  const admin = gatewayAdminRoutes({
    worlds, sharedDir, config: () => config, accounts, sessions: new AdminSessionStore(),
    version: 'test', publicBase: () => 'http://test',
    restart: () => {}, rollingRestart: () => { rolls++; return Promise.resolve({ restarted: [], failed: [] }); },
    maintenance,
  });
  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, maxPerOwner: 4, worldsDir,
    admin, maintenance: () => maintenance.get(),
  });
  t.after(async () => { await dir.close(); worlds.stopAll(); await accounts.close(); });
  const base = `http://127.0.0.1:${dir.port}`;
  const j = async (r: Response): Promise<Record<string, unknown>> => r.json() as Promise<Record<string, unknown>>;

  // THE CHECK THAT PRODUCED THE RECORDED 404.
  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200, 'the multiplayer server serves the dashboard');
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const state = await j(await fetch(`${base}/admin/api/state`));
  assert.equal(state.platform, true, 'and says which server it is');
  assert.equal(state.firstRun, true);

  // Same sign-in as a game's, against the shared store.
  const owner = await fetch(`${base}/admin/api/setup/owner`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
  });
  assert.equal(owner.status, 200);
  const token = (await j(owner)).token as string;
  const auth = { authorization: `Bearer ${token}` };
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/admin/api${path}`, { ...init, headers: { ...auth, 'content-type': 'application/json', ...(init.headers ?? {}) } });

  // PEOPLE FIRST: who is playing, and in whose game.
  const o = await j(await api('/overview'));
  assert.equal(o.platform, true);
  const players = o.players as { name: string; game: string; gameLabel: string; level: number }[];
  assert.equal(players.length, 1);
  assert.equal(players[0]!.name, 'Runner');
  assert.equal(players[0]!.game, 'alpha');
  assert.equal(players[0]!.gameLabel, "owner-a's game", 'a game is named after its owner');
  const health = o.health as { games: number; peers: number; capacityReason: string };
  assert.equal(health.games, 1);
  assert.equal(health.peers, 1);
  assert.ok(['count', 'memory'].includes(health.capacityReason));
  assert.ok(o.system, 'the machine reading is on the page where pressure matters');

  // THE PROXY: one sign-in reaches the game, which sees the platform token plus the operator.
  const proxied = await j(await api('/games/alpha/overview'));
  assert.deepEqual(proxied, { proxied: '/admin/api/overview', via: 'alpha' });
  const fwd = seen.headers.at(-1)!;
  assert.equal(fwd.authorization, `Bearer ${config.gateway.serverToken}`);
  assert.equal(fwd[H.key], 'owner@example.com');
  assert.equal(fwd[H.role], 'owner');
  assert.equal((await api('/games/nope/overview')).status, 502, 'an unknown game is not a crash');
  // A viewer cannot promote themselves by sending the actor headers: they are replaced.
  await api('/games/alpha/overview', { headers: { [H.role]: 'owner', [H.key]: 'somebody-else' } });
  assert.equal(seen.headers.at(-1)![H.key], 'owner@example.com');

  // The public listing does NOT carry the roster the supervisor now keeps.
  const pub = await j(await fetch(`${base}/worlds/alpha`));
  assert.equal(pub.id, 'alpha');
  assert.ok(!('players' in pub), 'names stay off the public directory');
  assert.ok(!('pid' in pub));

  // PLATFORM MAINTENANCE: doors close everywhere, and every running game is told.
  assert.equal((await api('/maintenance', { method: 'POST', body: JSON.stringify({ on: true, message: 'brb' }) })).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(seen.maintenance, [{ on: true, message: 'brb' }], 'the game got the same switch');
  assert.ok(existsSync(join(sharedDir, 'maintenance')), 'persisted, so a restart does not reopen the doors');
  const create = await fetch(`${base}/worlds`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer none' },
    body: JSON.stringify({ mode: 'party', id: 'new-one' }),
  });
  assert.equal(create.status, 503, 'nobody starts a game while the platform is closed');
  assert.equal((await api('/maintenance', { method: 'POST', body: JSON.stringify({ on: false, message: '' }) })).status, 200);
  assert.ok(!existsSync(join(sharedDir, 'maintenance')));

  // ACTIONS. Discard is type-to-confirm; a game on disk but not running is discardable too.
  assert.equal((await api('/games/beta/discard', { method: 'POST', body: JSON.stringify({ confirm: 'wrong' }) })).status, 400);
  assert.equal((await api('/games/beta/discard', { method: 'POST', body: JSON.stringify({ confirm: 'beta' }) })).status, 200);
  assert.ok(!existsSync(join(worldsDir, 'beta')));
  assert.equal((await api('/rolling-restart', { method: 'POST' })).status, 200);
  assert.equal(rolls, 1);
  assert.equal((await api('/games/alpha/stop', { method: 'POST' })).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(worlds.get('alpha'), undefined, 'stopped');
});

// --- settings live where they are read ---------------------------------------------------------

test('only [worlds] is hidden in a game: the rest of the platform group does something there', () => {
  // [simPeer] and [gateway] look like platform settings and are read by every game process.
  assert.deepEqual(GATEWAY_ONLY, ['worlds']);
  const known = new Set(SECTION_GROUPS.flatMap((g) => g.sections));
  assert.deepEqual(GATEWAY_ONLY.filter((s) => !known.has(s)), [], 'a typo here hides nothing');
  assert.ok(known.has('engine'), '[engine] was in no group and so had no sidebar entry');
  const v = settingsView(mkdtempSync(join(tmpdir(), 'set-')), { setup: { deploymentMode: 'multiplayer' } });
  assert.deepEqual(v.gatewayOnly, ['worlds'], 'the page reads the list from the server');
});

// --- the page ----------------------------------------------------------------------------------

test('every settings group has a sidebar entry, and the orphaned pages are reachable', () => {
  for (const g of SECTION_GROUPS) {
    const hash = `#set-${g.group.toLowerCase().split(' ')[0]}`;
    assert.match(app, new RegExp(`hash: '${hash}', label: '${g.group.replace(/[()]/g, '\\$&')}'`), `${g.group} is not in the nav`);
    assert.ok(app.includes(`'${hash}': () => pageSettings('${g.group}')`), `${hash} does not route to ${g.group}`);
  }
  assert.match(app, /hash: '#metrics', label: 'Metrics'/);
  assert.match(app, /hash: '#rolling', label: 'Rolling restart'/);
});

test('the console renders the fields the server actually sends', () => {
  // Reports: ts/reporter/target/reason. The page read at/by/about/text, so every column was
  // blank whenever a report existed.
  assert.match(app, /r\.ts \|\| ''/);
  assert.match(app, /<td>\$\{r\.reporter\}<\/td><td>\$\{r\.target \|\| '-'\}<\/td><td class="small">\$\{r\.reason\}<\/td>/);
  const console_ = /async function pageConsole\(\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.doesNotMatch(console_[0], /r\.at \|\| ''|\$\{r\.by\}|\$\{r\.about|\$\{r\.text\}/);
  // Anomalies and the muted state: computed, sent, never drawn.
  assert.match(app, /function playerFlags\(p\)/);
  assert.match(app, /p\.anomalies/);
  assert.match(app, /p\.muted/);
  assert.doesNotMatch(app, /Nobody is in the world right now/, 'one world is not the shape here');
});

test('the multiplayer server page is people first, with games reached by proxy', () => {
  const fn = /function renderPlatformOverview\([\s\S]*?\n\}/.exec(app);
  assert.ok(fn, 'no platform overview');
  assert.match(fn[0], /In whose game/);
  assert.match(fn[0], /sysCards\(o\.system\)/);
  assert.doesNotMatch(fn[0], /o\.world\.id|maxPlayers/, 'one world and one cap are the wrong shape');
  assert.match(fn[0], /data-game-act="stop"/);
  assert.match(fn[0], /data-game-act="discard"/);
  // Per-game calls carry the game; the platform's own calls do not.
  assert.match(app, /`\/games\/\$\{gameId\}\$\{path\}`/);
  assert.match(app, /const PLATFORM_PATHS = /);
  assert.match(app, /\/\^#game=\(/);
});
