// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-95: world-class scripts run only on the peer that holds their cell. A client's activation
// of such an object (ScriptActivate) and its StartScript of such a script (ScriptStart) are
// forwarded there; and the class table itself is well-formed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quests } from '../src/core/quests';
import type { Player, Roster } from '../src/core/players';

type Sent = { name: string; body: Record<string, unknown> };
function fake(id: number, cellKey: string, system = false): Player {
  const sent: Sent[] = [];
  return {
    id, name: `P${id}`, accountKey: `p${id}`, charId: `p${id}`, inWorld: true, cellKey, system,
    peer: { sendEvent: (name: string, body: Record<string, unknown>) => sent.push({ name, body }), sent },
  } as unknown as Player;
}
const sentOf = (p: Player, name: string) =>
  (p.peer as unknown as { sent: Sent[] }).sent.filter((e) => e.name === name).map((e) => e.body);

function harness(holders: Record<string, number>) {
  const players = new Map<number, Player>();
  const roster = { get: (id: number) => players.get(id), inWorld: () => [...players.values()] } as unknown as Roster;
  const peerP = fake(99, '0,0', true);
  players.set(99, peerP);
  const quests = new Quests({
    roster,
    holderOf: (k: string) => holders[k],
    peerFor: () => peerP,
  } as unknown as ConstructorParameters<typeof Quests>[0]);
  const add = (id: number, cellKey: string) => { const p = fake(id, cellKey); players.set(id, p); return p; };
  return { quests, peer: peerP, add };
}

const REF = { __refnum: { index: 1234, contentFile: 0 } };
const activate = (cellKey: string) => new Map<string, unknown>([['ref', REF], ['cellKey', cellKey]]) as never;

test("a world-script activation goes to the peer holding the object's cell", () => {
  const h = harness({ 'balmora, guild of mages': 99 });
  const a = h.add(1, 'balmora, guild of mages');
  assert.equal(h.quests.handleEvent(a, 'ScriptActivate', activate('balmora, guild of mages')), true);
  assert.deepEqual(sentOf(h.peer, 'ScriptActivate'), [
    { ref: REF, cellKey: 'balmora, guild of mages', by: 1 },
  ]);
  assert.ok(typeof a.questTriggerAt === 'number', 'it stamps the quest trace like ObjectActivated');
});

test('a world-script activation is reach-gated and needs a peer holder', () => {
  const h = harness({ '3,4': 1, '0,0': 99 });
  const a = h.add(1, '3,4');
  h.quests.handleEvent(a, 'ScriptActivate', activate('-20,7')); // from afar
  h.quests.handleEvent(a, 'ScriptActivate', activate('3,4')); // held by a client, not a peer
  h.quests.handleEvent(a, 'ScriptActivate', new Map([['cellKey', '3,4']]) as never); // no ref
  assert.deepEqual(sentOf(h.peer, 'ScriptActivate'), []);
  h.quests.handleEvent(h.peer, 'ScriptActivate', activate('0,0'));
  assert.deepEqual(sentOf(h.peer, 'ScriptActivate'), [], 'the peer never forwards to itself');
});

test("a client's StartScript of a world script is started on the peer", () => {
  const h = harness({});
  const a = h.add(1, '0,0');
  const start = (script: unknown) => h.quests.handleEvent(a, 'ScriptStart', new Map([['script', script]]) as never);
  start('Sleepers_Script');
  start('');
  start('x'.repeat(65));
  start('bad;id');
  start(5);
  assert.deepEqual(sentOf(h.peer, 'ScriptStart'), [{ script: 'sleepers_script' }]);
});

const TABLE = resolve(import.meta.dirname, '../../openmw/files/data/scripts/mp/scriptclasses.lua');
test('the script-class table is well-formed: known classes, each id in one class only', {
  skip: existsSync(TABLE) ? false : 'openmw/ is not part of the server image',
}, () => {
  const src = readFileSync(TABLE, 'utf8').replace(/--.*$/gm, '');
  const body = /return\s*\{([\s\S]*)\}\s*$/.exec(src.trim());
  assert.ok(body, 'the file returns one table');
  const classes = [...(body?.[1] ?? '').matchAll(/(\w+)\s*=\s*\{([^}]*)\}/g)];
  assert.deepEqual(classes.map((m) => m[1]).sort(), ['both', 'client', 'world']);
  const seen = new Map<string, string>();
  for (const [, cls = '', list = ''] of classes) {
    for (const [, id = ''] of list.matchAll(/['"]([^'"]*)['"]/g)) {
      assert.match(id, /^[A-Za-z0-9_ ]{1,64}$/, `${cls}: ${JSON.stringify(id)} is not a script id`);
      const key = id.toLowerCase();
      assert.equal(seen.get(key), undefined, `${id} is in both ${seen.get(key)} and ${cls}`);
      seen.set(key, cls);
    }
  }
});
