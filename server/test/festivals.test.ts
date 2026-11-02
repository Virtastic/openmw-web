// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-201: festivals switch on and off with the world's calendar; gifts once per character.
import test from 'node:test';
import assert from 'node:assert/strict';
import { festivals, festivalOn } from '../src/plugins/builtin/festivals';
import type { PluginApi } from '../src/plugins/api';
import type { Config } from '../src/config';

function fakeApi(enabled = true, dates: string[] = []) {
  const clock = { gameHour: 9, day: 15, month: 1, year: 427, timeScale: 30 };
  const gives: { id: number; recordId: string }[] = [];
  const chats: { target: 'all' | number; text: string }[] = [];
  const claims = new Set<string>();
  const online = [{ id: 1, name: 'A', rank: 0 }, { id: 2, name: 'B', rank: 0 }];
  const api = {
    config: { festivals: { enabled, giftGold: 0, dates } } as unknown as Config,
    log: () => {},
    players: () => online,
    chat: (target: 'all' | number, msg: { text: string }) => { chats.push({ target, text: msg.text }); },
    world: { time: () => ({ ...clock }) },
    give: (id: number, recordId: string) => { gives.push({ id, recordId }); },
    claimOnce: (id: number, key: string) => { const k = `${id}|${key}`; if (claims.has(k)) return false; claims.add(k); return true; },
  } as unknown as PluginApi;
  return { api, clock, gives, chats, online };
}

test('the calendar: each festival on its own date, nothing between', () => {
  assert.equal(festivalOn(0, 1)?.id, 'newlife');
  assert.equal(festivalOn(1, 16)?.id, 'heartsday');
  assert.equal(festivalOn(4, 30)?.id, 'witches');
  assert.equal(festivalOn(1, 15), undefined);
  // An operator override moves a date (month 1-based in config).
  assert.equal(festivalOn(9, 31, ['witches=10/31'])?.id, 'witches');
  assert.equal(festivalOn(4, 30, ['witches=10/31']), undefined);
});

test("Heart's Day switches on at its date, gifts everyone once, and switches off after", () => {
  const { api, clock, gives, chats } = fakeApi();
  festivals.onTick!(api, 0);
  assert.equal(chats.length, 0, 'the day before: nothing');
  clock.day = 16;
  festivals.onTick!(api, 0);
  assert.ok(chats.some((c) => c.target === 'all' && /Heart's Day has begun/.test(c.text)));
  assert.deepEqual(gives.map((g) => g.id).sort(), [1, 2]);
  festivals.onTick!(api, 0);
  festivals.onPlayerJoinWorld!(api, { id: 1, name: 'A', rank: 0 }); // a relog on the day
  assert.equal(gives.length, 2, 'once per character');
  clock.day = 17;
  festivals.onTick!(api, 0);
  assert.ok(chats.some((c) => /is over/.test(c.text)));
  // Next year it comes round again.
  clock.year = 428; clock.day = 16;
  festivals.onTick!(api, 0);
  assert.equal(gives.length, 4);
});

test('a latecomer on the day is told and gifted; disabled does nothing', () => {
  const a = fakeApi();
  a.clock.month = 0; a.clock.day = 1;
  festivals.onPlayerJoinWorld!(a.api, { id: 9, name: 'Late', rank: 0 });
  assert.deepEqual(a.gives, [{ id: 9, recordId: 'potion_cyro_brandy_01' }]);
  const off = fakeApi(false);
  off.clock.day = 16;
  festivals.onTick!(off.api, 0);
  festivals.onPlayerJoinWorld!(off.api, { id: 1, name: 'A', rank: 0 });
  assert.equal(off.gives.length + off.chats.length, 0);
});
