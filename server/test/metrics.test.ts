// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Observability layer: the Prometheus renderer's output shape, that the counters actually
// move when a real session runs through the server, and that /metrics is invisible unless
// it is switched on and correctly authenticated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { Counter, Histogram, Gauge, metrics, renderMetrics, resetMetrics } from '../src/metrics';
import { TestClient, tmpDataDir } from './helpers';

const TOKEN = 'scrape-me-9f3a';

// Pulls one sample out of Prometheus text. `series` is the full line prefix including any
// label block, e.g. 'omwmp_auth_total{op="login",result="AUTH_FAILED"}'.
function sample(text: string, series: string): number | undefined {
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const cut = line.lastIndexOf(' ');
    if (cut > 0 && line.slice(0, cut) === series) return Number(line.slice(cut + 1));
  }
  return undefined;
}

test('metrics: Prometheus renderer output shape', async (t) => {
  await t.test('counter emits HELP/TYPE and a zero series when unlabelled', () => {
    const c = new Counter('test_thing_total', 'A thing.', []);
    const lines = c.toText().trimEnd().split('\n');
    assert.deepEqual(lines, ['# HELP test_thing_total A thing.', '# TYPE test_thing_total counter', 'test_thing_total 0']);
    c.inc();
    c.inc({}, 4);
    assert.equal(sample(c.toText(), 'test_thing_total'), 5);
  });

  await t.test('label values are escaped and rendered in sorted order', () => {
    const c = new Counter('test_labelled_total', 'Labelled.', ['b', 'a']);
    c.inc({ a: 'quote"and\\slash', b: 'nl\nhere' });
    const line = c.toText().split('\n').find((l) => !l.startsWith('#') && l.length > 0)!;
    assert.equal(line, 'test_labelled_total{a="quote\\"and\\\\slash",b="nl\\nhere"} 1');
  });

  await t.test('a wrong label set is warned about and dropped, never minted', () => {
    const c = new Counter('test_strict_total', 'Strict.', ['a']);
    c.inc({ a: 'ok' });
    c.inc({ a: 'ok', b: 'extra' });
    c.inc({});
    assert.equal(c.get({ a: 'ok' }), 1);
    assert.equal(c.toText().split('\n').filter((l) => l.startsWith('test_strict_total')).length, 1);
  });

  await t.test('histogram renders cumulative _bucket, le="+Inf", _sum and _count', () => {
    const h = new Histogram('test_dur_seconds', 'Durations.', ['store'], [0.1, 1]);
    h.observe({ store: 'x' }, 0.05);
    h.observe({ store: 'x' }, 0.5);
    h.observe({ store: 'x' }, 30);
    const text = h.toText();
    assert.match(text, /^# TYPE test_dur_seconds histogram$/m);
    assert.equal(sample(text, 'test_dur_seconds_bucket{store="x",le="0.1"}'), 1);
    assert.equal(sample(text, 'test_dur_seconds_bucket{store="x",le="1"}'), 2); // cumulative
    assert.equal(sample(text, 'test_dur_seconds_bucket{store="x",le="+Inf"}'), 3);
    assert.equal(sample(text, 'test_dur_seconds_sum{store="x"}'), 30.55);
    assert.equal(sample(text, 'test_dur_seconds_count{store="x"}'), 3);
    // A negative or non-finite observation is dropped, not recorded as 0.
    h.observe({ store: 'x' }, -1);
    h.observe({ store: 'x' }, NaN);
    assert.equal(sample(h.toText(), 'test_dur_seconds_count{store="x"}'), 3);
  });

  await t.test('gauge sums its live collectors and unhooks cleanly', () => {
    const g = new Gauge('test_live', 'Live.');
    const off = g.addCollector(() => 2);
    g.addCollector(() => 3);
    assert.equal(sample(g.toText(), 'test_live'), 5);
    off();
    assert.equal(sample(g.toText(), 'test_live'), 3);
  });
});

test('metrics: counters move through a real session', async (t) => {
  // Every bot dials from 127.0.0.1: without headroom the per-IP cap and the login limiter
  // would fire during setup and make the assertions below lie about what happened.
  resetMetrics();
  const server = await startServer({
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: {
      limits: { maxConnsPerIp: 200, loginPerMinPerIp: 10_000 },
      metrics: { enabled: true, token: TOKEN },
    },
  });
  t.after(() => server.close());

  // 1. connect + register + join.
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('metrics_alice');
  await a.waitEvent('PlayerList');

  // 2. a second connection fails to log in with the wrong password.
  const b = await TestClient.connect(server.port);
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.login('metrics_alice', 'wrong-password');
  await b.waitDisconnect('AUTH_FAILED');
  await b.closed;

  // 3. alice takes a cell (authority grant) and is then kicked by the server.
  a.sendCellChange('26,25', 1, 2, 3);
  await a.waitEvent('ActorAuthorityGrant');
  const text = renderMetrics();

  await t.test('connection and auth series', () => {
    assert.equal(sample(text, 'omwmp_connections_opened_total'), 2);
    assert.equal(sample(text, 'omwmp_auth_total{op="register",result="success"}'), 1);
    assert.equal(sample(text, 'omwmp_auth_total{op="login",result="AUTH_FAILED"}'), 1);
    assert.equal(sample(text, 'omwmp_auth_total{op="login",result="success"}'), undefined);
  });

  await t.test('join latency is observed once, in-world gauge reads the roster', () => {
    assert.equal(sample(text, 'omwmp_join_latency_seconds_count'), 1);
    assert.equal(sample(text, 'omwmp_join_latency_seconds_bucket{le="+Inf"}'), 1);
    assert.ok((sample(text, 'omwmp_join_latency_seconds_sum') ?? -1) >= 0);
    assert.equal(sample(text, 'omwmp_sessions_in_world'), 1);
  });

  await t.test('cell authority grant is tallied', () => {
    assert.equal(sample(text, 'omwmp_cell_authority_total{kind="grant"}'), 1);
  });

  await t.test('persistence flush duration is observed', async () => {
    // The cell change is a specced 'now' flush point for the player doc, but the write
    // itself is fire-and-forget — hence the fresh render rather than the snapshot above.
    await new Promise((r) => setTimeout(r, 50));
    const fresh = renderMetrics();
    assert.ok((sample(fresh, 'omwmp_persist_flush_seconds_count{store="players"}') ?? 0) >= 1);
    assert.ok((sample(fresh, 'omwmp_persist_flush_seconds_sum{store="players"}') ?? -1) >= 0);
    assert.equal(sample(fresh, 'omwmp_persist_flush_failed_total{store="players"}'), undefined);
  });

  await t.test('the failed login is counted as an AUTH_FAILED disconnect', () => {
    assert.equal(sample(text, 'omwmp_disconnects_total{code="AUTH_FAILED"}'), 1);
  });

  await t.test('a client-side close still lands in the disconnect total', async () => {
    a.close();
    await a.closed;
    // cleanup() is driven by the socket close event; give the loop a turn to run it.
    await new Promise((r) => setTimeout(r, 50));
    const after = renderMetrics();
    assert.equal(sample(after, 'omwmp_disconnects_total{code="CLIENT_CLOSE"}'), 1);
    assert.equal(sample(after, 'omwmp_sessions_in_world'), 0);
  });

  await t.test('a rate-limit trip is attributed to the budget that ran out', async () => {
    const c = await TestClient.connect(server.port);
    c.hello();
    await c.waitJson('SessionHelloOk');
    // msgsPerSec is 60 by default and the bucket burst equals the rate.
    for (let i = 0; i < 200; i++) c.sendJson({ t: 'SessionPing', clientTime: i });
    await c.waitDisconnect('RATE');
    await c.closed;
    assert.ok((sample(renderMetrics(), 'omwmp_rate_limited_total{budget="msgs"}') ?? 0) >= 1);
  });

  await t.test('a malformed event body is counted as a protocol error', async () => {
    const d = await TestClient.connect(server.port);
    await d.joinAsNew('metrics_dave');
    await d.waitEvent('PlayerList');
    const before = sample(renderMetrics(), 'omwmp_protocol_errors_total{kind="unknown_event"}') ?? 0;
    d.sendEvent('NoSuchEventName', { x: 1 });
    d.sendEvent('ChatSend', { text: 'flush the queue' });
    await d.waitEvent('ChatMessage', (v) => String((v as { text: string }).text).includes('flush the queue'));
    assert.equal(sample(renderMetrics(), 'omwmp_protocol_errors_total{kind="unknown_event"}'), before + 1);
    d.close();
    await d.closed;
  });
});

test('metrics: /metrics endpoint access control', async (t) => {
  await t.test('404 (not 401) while disabled, so the route is invisible', async () => {
    const server = await startServer({ dataDir: tmpDataDir(), port: 0, host: '127.0.0.1' });
    t.after(() => server.close());
    const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    assert.equal(res.status, 404);
    // An enabled endpoint with no token is still off: there is no unauthenticated mode.
    const noToken = await startServer({
      dataDir: tmpDataDir(),
      port: 0,
      host: '127.0.0.1',
      configOverride: { metrics: { enabled: true, token: '' } },
    });
    t.after(() => noToken.close());
    assert.equal((await fetch(`http://127.0.0.1:${noToken.port}/metrics`)).status, 404);
  });

  await t.test('401 on a missing or wrong bearer, 200 + text on the right one', async () => {
    const server = await startServer({
      dataDir: tmpDataDir(),
      port: 0,
      host: '127.0.0.1',
      configOverride: { metrics: { enabled: true, token: TOKEN } },
    });
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.port}`;

    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer nope' } })).status, 401);
    // A same-length wrong token must not pass the constant-time compare either.
    const sameLen = TOKEN.slice(0, -1) + 'X';
    assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${sameLen}` } })).status, 401);
    assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: TOKEN } })).status, 401);

    const ok = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(ok.headers.get('access-control-allow-origin'), null); // scraper endpoint, not a browser one
    const body = await ok.text();
    assert.match(body, /^# HELP omwmp_connections_opened_total /m);
    assert.match(body, /^# TYPE omwmp_sessions_in_world gauge$/m);
  });

  await t.test('/status stays public and unauthenticated', async () => {
    const server = await startServer({
      dataDir: tmpDataDir(),
      port: 0,
      host: '127.0.0.1',
      configOverride: { metrics: { enabled: true, token: TOKEN } },
    });
    t.after(() => server.close());
    const res = await fetch(`http://127.0.0.1:${server.port}/status`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(((await res.json()) as { playerCount: number }).playerCount, 0);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200);
  });
});

// Guard against the registry drifting from the documented surface.
test('metrics: every registered metric renders a HELP and TYPE line', () => {
  const text = renderMetrics();
  for (const name of Object.values(metrics).map((m) => m.name)) {
    assert.match(text, new RegExp(`^# HELP ${name} `, 'm'), `${name} HELP`);
    assert.match(text, new RegExp(`^# TYPE ${name} `, 'm'), `${name} TYPE`);
  }
});
