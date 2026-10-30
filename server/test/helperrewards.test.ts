// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-91: helper rewards, the mentor bonus and the ledger rows behind them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HelperRewards, HELPER_GOLD, MENTOR_BONUS_GOLD, HELPER_DAILY_CAP } from '../src/core/helperrewards';
import { Quests } from '../src/core/quests';
import { PlayerStore } from '../src/persist/playerstore';
import { CellStore } from '../src/persist/cellstore';
import type { Player, Roster } from '../src/core/players';
import type { LedgerEntry } from '../src/core/trade';
import { tmpDataDir } from './helpers';

const pl = (id: number, name: string): Player => ({ id, name, charId: name, accountKey: name } as unknown as Player);

function rig(levels: Record<string, number>, revoked = new Set<string>()) {
  let now = 1_000_000;
  const gave: { to: string; gold: number; note: string }[] = [];
  const ledger: LedgerEntry[] = [];
  const hr = new HelperRewards({
    now: () => now,
    levelOf: (p) => levels[p.name] ?? 1,
    mentorOk: (p) => !revoked.has(p.name),
    give: (p, gold, note) => void gave.push({ to: p.name, gold, note }),
    ledger: (e) => void ledger.push(e),
  });
  return { hr, gave, ledger, advance: (ms: number) => { now += ms; } };
}

test('a helper is paid the flat amount, once per helped stage, and it is in the ledger', () => {
  const r = rig({});
  const sprout = pl(1, 'sprout'), helper = pl(2, 'helper');
  assert.equal(r.hr.reward(sprout, helper, 'a1_1', 10), HELPER_GOLD);
  assert.equal(r.hr.reward(sprout, helper, 'a1_1', 10), 0, 'same stage is not paid twice');
  assert.equal(r.hr.reward(sprout, helper, 'a1_1', 20), HELPER_GOLD, 'the next stage is');
  assert.equal(r.gave.length, 2);
  assert.equal(r.ledger.length, 2);
  assert.equal(r.ledger[0]!.b.char, 'helper');
  assert.deepEqual(r.ledger[0]!.a.gave, [{ id: 'gold_001', n: HELPER_GOLD }]);
  assert.match(r.ledger[0]!.reason!, /helper reward: a1_1@10/);
});

test('a mentor (L10+, not revoked) helping a sprout (below L5) gets the bonus; peers and revoked mentors do not', () => {
  const r = rig({ sprout: 2, mentor: 12, peer: 12, bad: 12 }, new Set(['bad']));
  assert.equal(r.hr.reward(pl(1, 'sprout'), pl(2, 'mentor'), 'q', 1), HELPER_GOLD + MENTOR_BONUS_GOLD);
  assert.equal(r.hr.reward(pl(1, 'sprout'), pl(3, 'bad'), 'q', 1), HELPER_GOLD, 'revoked');
  assert.equal(r.hr.reward(pl(9, 'peer'), pl(2, 'mentor'), 'q', 1), HELPER_GOLD, 'writer is not a sprout');
  assert.match(r.gave[0]!.note, /mentor bonus/);
});

test('the daily cap stops farming and resets after a day', () => {
  const r = rig({});
  const a = pl(1, 'a'), h = pl(2, 'h');
  let total = 0, i = 0;
  while (true) { const g = r.hr.reward(a, h, 'q', ++i); if (g === 0) break; total += g; }
  assert.ok(total <= HELPER_DAILY_CAP && total + HELPER_GOLD > HELPER_DAILY_CAP);
  r.advance(24 * 60 * 60_000);
  assert.equal(r.hr.reward(a, h, 'q', 999), HELPER_GOLD);
});

test('quest credit: the member who is past the stage, or not on the quest, is the helper', async () => {
  const dir = tmpDataDir();
  const players = new PlayerStore(dir, 'w1');
  const cells = new CellStore(dir);
  const list: Player[] = [];
  const mk = (acct: string): Player => {
    const p = { id: list.length + 1, name: acct, accountKey: acct, charId: acct, rank: 0, inWorld: true, cellKey: '0,0',
      lastInputAt: Date.now(), peer: { sendEvent: () => undefined } } as unknown as Player;
    list.push(p);
    return p;
  };
  const roster = { inWorld: () => list, activeForAccount: (a: string) => list.find((p) => p.accountKey === a) } as unknown as Roster;
  const helped: string[] = [];
  const q = new Quests({
    roster, cells, players, regressAllowed: () => false,
    partyMembers: () => ['w', 'ahead', 'behind', 'other'],
    helperReward: (_w, h, qid, idx) => void helped.push(`${h.name}:${qid}:${idx}`),
  });
  const w = mk('w'); mk('ahead'); mk('behind'); mk('other');
  players.update('w', (d) => { (d.journal ??= {}).q1 = 5; });
  players.update('ahead', (d) => { (d.journal ??= {}).q1 = 20; });
  players.update('behind', (d) => { (d.journal ??= {}).q1 = 1; });
  // 'other' never started q1 (another faction's quest)
  (q as unknown as { creditParty(p: Player, qid: string, i: number): void }).creditParty(w, 'q1', 10);
  assert.deepEqual(helped.sort(), ['ahead:q1:10', 'other:q1:10']);
  assert.equal(players.getCached('behind')?.journal?.q1, 10, 'the behind member is credited, not paid');
  await players.close(); await cells.close();
});

test('wiring: the server pays through AdminGive with a note and the Lua shows it', () => {
  const srv = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(srv, /sendEvent\('AdminGive', \{ recordId: GOLD_ID, count: gold, note \}\)/);
  const lua = readFileSync(new URL('../../openmw/files/data/scripts/mp/admin.lua', import.meta.url), 'utf8');
  assert.match(lua, /data\.note/);
});
