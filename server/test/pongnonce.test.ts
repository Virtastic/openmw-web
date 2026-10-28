// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-27: RTT comes only from the server's own ping nonce. A pong that echoes anything but
// the stamp last sent (a forged later stamp to look fast, a replay, garbage) yields no sample.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pongRtt } from '../src/net/ws';

const echo = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(v, 0); return b; };

test('only the exact nonce echo measures RTT, once', () => {
  const st: { lastPongAt: number; sentStamp?: number } = { lastPongAt: 0, sentStamp: 1000 };
  assert.equal(pongRtt(st, echo(1990), 2000), undefined, 'forged later stamp');
  assert.equal(pongRtt(st, Buffer.alloc(3), 2000), undefined, 'garbage');
  assert.equal(pongRtt(st, echo(1000), 2000), 1000);
  assert.equal(pongRtt(st, echo(1000), 2001), undefined, 'replayed nonce');
});
