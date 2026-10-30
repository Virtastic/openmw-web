// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-114 / OT3-120: the low-rate PartyUpdate behind the party frame and the compass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Social } from '../src/core/social';
import { SocialStore } from '../src/core/socialstore';
import type { Player, Roster } from '../src/core/players';

interface Sent { name: string; body: Record<string, unknown> }

function world() {
  const store = new SocialStore(':memory:');
  const players = new Map<string, Player>();
  const sent = new Map<string, Sent[]>();
  const add = (acct: string, x = 0): Player => {
    const box: Sent[] = [];
    sent.set(acct, box);
    const p = {
      id: players.size + 1, name: acct, accountKey: acct, inWorld: true, cellKey: '0,0',
      pose: { x, y: 2, z: 3 },
      peer: { sendEvent: (n: string, b: Record<string, unknown>) => void box.push({ name: n, body: b }) },
    } as unknown as Player;
    players.set(acct, p);
    return p;
  };
  const roster = {
    activeForAccount: (a: string) => players.get(a),
    inWorld: () => [...players.values()].filter((p) => p.inWorld),
    findByName: (n: string) => players.get(n),
  } as unknown as Roster;
  const social = new Social({
    store, roster, displayName: (a) => a, resolveName: (n) => (players.has(n) ? n : undefined),
    now: () => 1_700_000_000_000,
    vitalsOf: (p) => ({ hp: [p.id * 10, 100], mp: [5, 50], ft: [7, 70] }),
  });
  const updates = (a: string) => (sent.get(a) ?? []).filter((e) => e.name === 'PartyUpdate');
  return { store, social, add, updates };
}

test('PartyUpdate: each member gets the OTHERS with bars, cell and position; strangers get nothing', () => {
  const w = world();
  const a = w.add('a', 100); const b = w.add('b', 200); w.add('c', 300);
  assert.equal(w.social.partyInvite(a, 'b'), 'ok');
  assert.equal(w.social.partyAccept(b, 'a'), 'ok');
  w.social.pushPartyUpdates();
  const forA = w.updates('a').at(-1)!.body as { members: Record<string, unknown>[] };
  assert.deepEqual(forA.members.map((m) => m.acct), ['b']);
  assert.deepEqual(forA.members[0]!.hp, [20, 100]);
  assert.deepEqual(forA.members[0]!.mp, [5, 50]);
  assert.equal(forA.members[0]!.cell, '0,0');
  assert.equal(forA.members[0]!.x, 200);
  assert.equal(w.updates('b').at(-1)!.body.members instanceof Array, true);
  assert.equal(w.updates('c').length, 0, 'an unpartied player is sent nothing');
  w.social.stop(); w.store.close();
});

test('PartyUpdate: an offline member is a bare row, a solo "party" sends nothing', () => {
  const w = world();
  const a = w.add('a'); const b = w.add('b');
  assert.equal(w.social.partyInvite(a, 'b'), 'ok');
  assert.equal(w.social.partyAccept(b, 'a'), 'ok');
  b.inWorld = false;
  w.social.pushPartyUpdates();
  const row = (w.updates('a').at(-1)!.body.members as Record<string, unknown>[])[0]!;
  assert.equal(row.acct, 'b');
  assert.equal(row.hp, undefined);
  assert.equal(row.x, undefined);
  w.social.stop(); w.store.close();
});

test('the server ticks pushPartyUpdates every 2 s with the sim-peer pass', () => {
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(src, /simPeerPass\(\); pushStoryLicence\(\); social\.pushPartyUpdates\(\);[^}]*\}, 2_000/);
});
