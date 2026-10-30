// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-70 / 195: the capacity series are on /metrics with a peer running, and they move with load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerLoad, PEER_STEP_MS } from '../src/peers/peerload';
import { LabeledGauge } from '../src/metrics';
import { CellQueue } from '../src/world/cellqueue';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('PeerLoad: bursts are frames; a slow peer shows a long interval and a sim/real ratio under 1', () => {
  const on = new PeerLoad();
  let t = 1000;
  for (let i = 0; i < 100; i++) { for (let k = 0; k < 3; k++) on.noteBatch('r', t + k, 4); t += PEER_STEP_MS; }
  const good = on.sample('r', t)!;
  assert.ok(Math.abs(good.p50 - 50) < 1 && Math.abs(good.p99 - 50) < 1, JSON.stringify(good));
  assert.equal(good.simReal, 1);
  assert.equal(good.actors, 12, 'three batches of four actors in one frame');

  const slow = new PeerLoad();
  t = 1000;
  for (let i = 0; i < 100; i++) { slow.noteBatch('r', t, 1); t += 100; }
  const s = slow.sample('r', t)!;
  assert.ok(Math.abs(s.p99 - 100) < 1);
  assert.ok(Math.abs(s.simReal - 0.5) < 0.01, 'a 100 ms frame runs sim at half real time');

  // A peer that went quiet is reported as quiet, never as fast.
  const quiet = slow.sample('r', t + 30_000)!;
  assert.ok(quiet.p99 >= 30_000 && quiet.simReal < 0.01);
  assert.equal(on.sample('nobody'), undefined);
});

test('LabeledGauge renders one series per label set and drops a non-finite value', () => {
  const g = new LabeledGauge('omwmp_test_lg', 'h', ['region']);
  g.addCollector(() => [{ labels: { region: 'a' }, value: 1 }, { labels: { region: 'b' }, value: NaN }]);
  const text = g.toText();
  assert.match(text, /^omwmp_test_lg\{region="a"\} 1$/m);
  assert.ok(!text.includes('region="b"'));
});

test('CellQueue reports its depth and how long each op waited', async () => {
  const waits: number[] = [];
  const q = new CellQueue({ onError: () => undefined, onWait: (ms) => waits.push(ms) });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const a = q.run('c1', () => gate);
  const b = q.run('c1', () => undefined);
  const g = q.runGlobal(() => undefined);
  assert.equal(q.depth, 3);
  await new Promise((r) => setTimeout(r, 30));
  release();
  await Promise.all([a, b, g]);
  assert.equal(q.depth, 0);
  assert.equal(waits.length, 3);
  assert.ok(Math.max(...waits) >= 25, 'the op behind the gate waited for it');
});

test('on /metrics with a peer running: region, peer, loop, op-queue, relay, byte and account series; they move under load', async (t) => {
  const PASS = 'peer-secret-capacity';
  const TOKEN = 'metrics-token-capacity-0123456789';
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS }, limits: { maxConnsPerIp: 16 }, metrics: { enabled: true, token: TOKEN } } });
  t.after(() => server.close());
  server.config.simPeer.enabled = true;
  const peer = await TestClient.simPeer(server.port, PASS);
  t.after(() => peer.close());
  const scrape = async () => (await fetch(`http://127.0.0.1:${server.port}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
  const val = (text: string, re: RegExp): number | undefined => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };

  const before = await scrape();
  const accountsBefore = val(before, /^omwmp_accounts_created_total (\d+(?:\.\d+)?)/m) ?? 0;

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('CapA');
  await a.waitEvent('PlayerList');
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('CapB');
  await b.waitEvent('PlayerList');
  a.sendCellChange('0,0', 1, 1, 0);
  b.sendCellChange('0,0', 2, 2, 0);

  // The peer streams ~3 batches of 5 actors per 80 ms frame (slower than the 50 ms pace).
  const entry = (i: number) => ({ ref: { index: i, contentFile: 0 },
    pose: { x: i, y: i, z: 0, yaw: 0, pitch: 0, flags: 0, animVel: 0, counter: 0 } });
  const actors = [1, 2, 3, 4, 5].map(entry);
  for (let f = 0; f < 40; f++) {
    for (let k = 0; k < 3; k++) peer.sendActorMoveBatch(1, actors);
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 2_300)); // a peer pass: held cells settle
  const text = await scrape();

  assert.equal(val(text, /^omwmp_peer_up\{region="world"\} (\d+)/m), 1, 'the peer is up in its region');
  assert.equal(val(text, /^omwmp_sessions_in_region\{region="world"\} (\d+)/m), 2);
  assert.ok((val(text, /^omwmp_peer_held_cells\{region="world"\} (\d+)/m) ?? 0) >= 1, 'held cells');
  const p99 = val(text, /^omwmp_peer_frame_interval_ms\{quantile="0.99",region="world"\} ([\d.]+)/m);
  assert.ok(p99 !== undefined && p99 >= 70, `frame interval p99 follows the 80 ms cadence (got ${p99})`);
  const simReal = val(text, /^omwmp_peer_sim_real_ratio\{region="world"\} ([\d.]+)/m)!;
  assert.ok(simReal > 0.4 && simReal < 0.85, `sim/real under 1 for an 80 ms frame (got ${simReal})`);
  assert.equal(val(text, /^omwmp_peer_active_actors\{region="world"\} (\d+)/m), 15, '3 batches x 5 actors per frame');
  assert.ok(/^omwmp_event_loop_delay_p50_seconds /m.test(text) && /^omwmp_event_loop_delay_p99_seconds /m.test(text));
  assert.ok(/^omwmp_op_queue_depth /m.test(text));
  assert.ok(/^omwmp_op_queue_wait_seconds_count /m.test(text));
  assert.ok((val(text, /^omwmp_relay_checks_total (\d+)/m) ?? 0) > 0, 'relay checks counted');
  assert.ok((val(text, /^omwmp_bytes_out_total (\d+)/m) ?? 0) > 0 && (val(text, /^omwmp_bytes_in_total (\d+)/m) ?? 0) > 0);
  assert.ok((val(text, /^omwmp_accounts_created_total (\d+)/m) ?? 0) >= accountsBefore + 2, 'two accounts created');
  assert.ok(/^omwmp_server_crashes_total /m.test(text) || /# TYPE omwmp_server_crashes_total counter/.test(text));
  assert.ok(/# TYPE omwmp_client_errors_total counter/.test(text));
});
