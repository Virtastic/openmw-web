// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-105: the busy flag: set by the owner's UiBusy, ended by damage and by the server cap,
// every edge told to the world peer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BusyFlags, BUSY_CAP_MS } from '../src/core/busy';
import type { Player } from '../src/core/players';

function rig() {
  let now = 1_000_000;
  const told: string[] = [];
  const p = { id: 7, name: 'Ann' } as unknown as Player;
  const busy = new BusyFlags({ now: () => now, notify: (pl, b) => void told.push(`${pl.id}:${b}`) });
  return { busy, p, told, advance: (ms: number) => { now += ms; } };
}

test('UiBusy sets and clears; only a boolean counts; repeats do not re-notify', () => {
  const r = rig();
  assert.equal(r.busy.handleEvent(r.p, 'Other', new Map()), false);
  assert.equal(r.busy.handleEvent(r.p, 'UiBusy', new Map([['busy', true]])), true);
  assert.equal(r.busy.isBusy(7), true);
  r.busy.handleEvent(r.p, 'UiBusy', new Map([['busy', true]]));
  r.busy.handleEvent(r.p, 'UiBusy', new Map([['busy', 'yes']]));
  assert.deepEqual(r.told, ['7:true'], 'one edge');
  r.busy.handleEvent(r.p, 'UiBusy', new Map([['busy', false]]));
  assert.equal(r.busy.isBusy(7), false);
  assert.deepEqual(r.told, ['7:true', '7:false']);
});

test('damage clears busy at once; a hit on a non-busy player says nothing', () => {
  const r = rig();
  r.busy.damaged(r.p);
  assert.deepEqual(r.told, []);
  r.busy.set(r.p, true);
  r.busy.damaged(r.p);
  assert.equal(r.busy.isBusy(7), false);
  assert.deepEqual(r.told, ['7:true', '7:false']);
});

test('the server cap ends busy even if the client never says so', () => {
  const r = rig();
  r.busy.set(r.p, true);
  r.advance(BUSY_CAP_MS - 1);
  r.busy.sweep((id) => (id === 7 ? r.p : undefined));
  assert.equal(r.busy.isBusy(7), true);
  r.advance(2);
  assert.equal(r.busy.isBusy(7), false, 'expired even before the sweep');
  r.busy.sweep((id) => (id === 7 ? r.p : undefined));
  assert.deepEqual(r.told, ['7:true', '7:false']);
});

test('wiring: connection routes UiBusy (not from system peers), the stats report ends it on damage', () => {
  const conn = readFileSync(new URL('../src/net/connection.ts', import.meta.url), 'utf8');
  assert.match(conn, /!this\.isSystem && this\.ctx\.busy\?\.handleEvent/);
  const ps = readFileSync(new URL('../src/core/playerstate.ts', import.meta.url), 'utf8');
  assert.match(ps, /hp\.c < hpBefore\) ctx\.onDamaged\?\.\(p\)/);
  const srv = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(srv, /busy\.sweep\(\(id\) => roster\.get\(id\)\)/);
  assert.match(srv, /sendEvent\('PlayerBusy'/);
});
