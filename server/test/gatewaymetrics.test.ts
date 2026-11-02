// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// ONE SCRAPE TARGET, EVERY WORLD IN IT.
//
// Worlds listen on internal ports that deploy/Caddyfile does not proxy, so the gateway folds
// their /metrics into its own. OT3-195: no world= label any more, so the fold dedupes both the
// metadata AND same-keyed series (summing them), and keeps each family contiguous.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory, foldExpositions } from '../src/gateway/directory';

const TOKEN = 'scrape-token';

class FakeChild extends EventEmitter {
  pid = 42;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

/** A stand-in world that answers /metrics exactly as a real one does. */
function fakeWorld(id: string): Promise<{ port: number; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    if (req.url === '/metrics') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' });
      // Same metric NAME as the gateway's own and as its sibling world — which is the whole
      // reason the fold has to dedupe rather than concatenate.
      res.end(`# HELP omwmp_sessions_in_world PLAYERS currently in world.\n`
        + `# TYPE omwmp_sessions_in_world gauge\n`
        + `omwmp_sessions_in_world 7\n`
        + `# HELP omwmp_peer_up 1 when the region has a connected sim peer.\n`
        + `# TYPE omwmp_peer_up gauge\n`
        + `omwmp_peer_up{region="${id}"} 1\n`);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      port: (srv.address() as { port: number }).port,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    }));
  });
}

test('the gateway scrape carries every world, with valid metadata', async (t) => {
  const w1 = await fakeWorld('alpha');
  const w2 = await fakeWorld('beta');
  t.after(() => Promise.all([w1.close(), w2.close()]));

  const wdir = mkdtempSync(join(tmpdir(), 'omw-gwm-'));
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080, serverEntry: '/fake/s.mjs', nodeBin: '/fake/node',
      basePort: 41000, maxWorlds: 4, startTimeoutMs: 1000,
      restartBackoffMs: 1000,
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-gwm-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    // Report both fakes as up, on the ports they are really listening on.
    fetchStatus: async (port) => ({ playerCount: 0, connectedCount: 0, maxPlayers: 32, name: `w${port}` }),
  });
  // Two worlds whose allocated ports are the fakes'. allocPort hands out basePort upward, so
  // point the supervisor's view at the real listeners by starting them and rewriting the ports.
  worlds.ensure('alpha');
  worlds.ensure('beta');
  const live = worlds as unknown as { worlds: Map<string, { port: number; lastStatus?: unknown }> };
  live.worlds.get('alpha')!.port = w1.port;
  live.worlds.get('beta')!.port = w2.port;
  await worlds.poll(); // marks them up

  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, metricsToken: TOKEN,
  });
  t.after(async () => { await dir.close(); worlds.stopAll(); });

  const res = await fetch(`http://127.0.0.1:${dir.port}/metrics`,
    { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  const body = await res.text();

  assert.ok(!body.includes('world='), 'no world label anywhere (OT3-195)');
  // Same series from gateway (0) and both worlds (7 each): one line, summed.
  const sess = body.split('\n').filter((l) => l.startsWith('omwmp_sessions_in_world '));
  assert.deepEqual(sess, ['omwmp_sessions_in_world 14']);
  assert.match(body, /omwmp_peer_up\{region="alpha"\} 1/);
  assert.match(body, /omwmp_peer_up\{region="beta"\} 1/);
  const keys = body.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.slice(0, l.lastIndexOf(' ')));
  assert.equal(new Set(keys).size, keys.length, 'a duplicate series makes the payload invalid');

  // VALID EXPOSITION: metadata declared once, however many worlds emit the same metric.
  const helps = body.split('\n').filter((l) => l.startsWith('# HELP '));
  assert.equal(new Set(helps).size, helps.length, 'a repeated # HELP makes the payload invalid');
  const types = body.split('\n').filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]);
  assert.equal(new Set(types).size, types.length, 'a repeated # TYPE makes the payload invalid');
});

// A SICK WORLD MUST NOT BLIND THE WHOLE SCRAPE. Monitoring that goes dark because one world of
// ten is wedged is worse than monitoring that reports the nine.
test('a world that does not answer is skipped, not fatal', async (t) => {
  const good = await fakeWorld('good');
  t.after(() => good.close());

  const wdir = mkdtempSync(join(tmpdir(), 'omw-gwm2-'));
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080, serverEntry: '/fake/s.mjs', nodeBin: '/fake/node',
      basePort: 42000, maxWorlds: 4, startTimeoutMs: 1000,
      restartBackoffMs: 1000,
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-gwm2-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async (port) => ({ playerCount: 0, connectedCount: 0, maxPlayers: 32, name: `w${port}` }),
  });
  worlds.ensure('good');
  worlds.ensure('dead');
  const live = worlds as unknown as { worlds: Map<string, { port: number }> };
  live.worlds.get('good')!.port = good.port;
  live.worlds.get('dead')!.port = 1; // nothing listens here
  await worlds.poll();

  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, metricsToken: TOKEN,
  });
  t.after(async () => { await dir.close(); worlds.stopAll(); });

  const res = await fetch(`http://127.0.0.1:${dir.port}/metrics`,
    { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200, 'one unreachable world must not fail the endpoint');
  const body = await res.text();
  assert.match(body, /omwmp_peer_up\{region="good"\} 1/, 'the healthy world is still reported');
});

test('foldExpositions: families stay contiguous, histograms sum, metadata once', () => {
  const a = '# HELP h x\n# TYPE h histogram\nh_bucket{le="1"} 1\nh_bucket{le="+Inf"} 2\nh_sum 3\nh_count 2\n'
    + '# HELP g y\n# TYPE g gauge\ng 0\n';
  const b = '# HELP g y\n# TYPE g gauge\ng 5\n# HELP h x\n# TYPE h histogram\nh_bucket{le="1"} 1\nh_bucket{le="+Inf"} 1\nh_sum 0.5\nh_count 1\n';
  assert.equal(foldExpositions([a, b]),
    '# HELP h x\n# TYPE h histogram\nh_bucket{le="1"} 2\nh_bucket{le="+Inf"} 3\nh_sum 3.5\nh_count 3\n'
    + '# HELP g y\n# TYPE g gauge\ng 5\n');
});
