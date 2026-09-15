// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Harness link shaping (#212): the FIFO holds for rtt/2, keeps order, freezes on the stall
// schedule, and is off entirely when the env is unset.

import test from 'node:test';
import assert from 'node:assert/strict';
import { NetDelay, netDelayFromEnv } from '../src/net/netdelay';

test('netdelay: unset env means no FIFO at all', () => {
  assert.equal(netDelayFromEnv({}), undefined);
  assert.equal(netDelayFromEnv({ OMWMP_NET_DELAY_MS: '0' }), undefined);
  assert.equal(netDelayFromEnv({ OMWMP_NET_DELAY_MS: '150' })!().halfMs, 75);
  assert.deepEqual(netDelayFromEnv({ OMWMP_NET_STALL: '300/2' })!().stall, { ms: 300, everyMs: 2000 });
});

test('netdelay: due times are rtt/2 out, monotonic, and pushed past a stall window', () => {
  let now = 0;
  const d = new NetDelay(75, { ms: 300, everyMs: 2000 }, () => now);
  assert.equal(d.dueAt(1000), 1075);
  assert.equal(d.dueAt(1010), 1085);
  assert.equal(d.dueAt(2100), 2300, 'inside the stall window (2000..2300): held to its end');
  assert.equal(d.dueAt(2290), 2365);
  now = 5000;
  const order: number[] = [];
  d.push(() => order.push(1));
  d.push(() => order.push(2));
  assert.equal(d.pending(), 2);
  assert.deepEqual(order, [], 'nothing runs synchronously');
});

test('netdelay: N ms actually delays, in order', async () => {
  const d = new NetDelay(30);
  const t0 = Date.now();
  const order: number[] = [];
  const done = new Promise<void>((resolve) => {
    d.push(() => order.push(1));
    d.push(() => { order.push(2); resolve(); });
  });
  await done;
  assert.deepEqual(order, [1, 2]);
  assert.ok(Date.now() - t0 >= 25, `held for ${Date.now() - t0} ms, wanted ~30`);
});
