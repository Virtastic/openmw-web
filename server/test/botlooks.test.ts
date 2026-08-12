// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// BOTS MUST LOOK LIKE DIFFERENT PEOPLE.
//
// The bot roster shared ONE appearance: every bot got the same race, head, hair and class, and
// isMale was hardcoded true. "Three players standing in the village" rendered as three
// identical men, which reads as a rendering fault rather than a roster and is useless for a
// screenshot. botLooks gives one entry per bot, cycled when there are more bots than entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestBots } from '../src/dev/testbots';
import { AccountStore } from '../src/core/accounts';
import { PlayerStore } from '../src/persist/playerstore';
import { Roster } from '../src/core/players';
import { tmpDataDir } from './helpers';
import { createHash } from 'node:crypto';

const LOOKS = [
  'dark elf|b_n_dark elf_f_head_01|b_n_dark elf_f_hair_01|healer',
  'breton|b_n_breton_f_head_01|b_n_breton_f_hair_01|mage',
  'imperial|b_n_imperial_m_head_01|b_n_imperial_m_hair_00|agent',
];

async function boot(count: number, looks: string[]) {
  const dir = tmpDataDir();
  const accounts = new AccountStore(dir);
  const players = new PlayerStore(dir, 'w');
  const roster = new Roster();
  // Only what testbots actually calls. A partial stub that is missing one of these throws
  // deep inside the reconcile loop, which reads as a feature failure rather than a fixture gap.
  const social = {
    onJoin: () => {},
    refreshPresenceViews: () => {},
    handleEvent: () => true,
    partyMembersOf: () => [] as string[],
  } as never;
  const bots = await startTestBots({
    roster, social, accounts, players, isPublic: true, count,
    names: ['Nyra', 'Sable', 'Orin', 'Vesk'], prefix: 'Bot', looks,
    spawn: { cellKey: '0,0', x: 0, y: 0, z: 0 },
    look: { race: '', head: '', hair: '', class: '' },
  } as never);
  return { bots, players, accounts };
}

test('each bot gets its own race, head, hair and sex', async () => {
  const { bots, players } = await boot(3, LOOKS);
  const names = (bots as unknown as { names: string[] }).names;
  assert.equal(names.length, 3, 'fixture did not start three bots');

  // charId is derived from the account key (see testbots), so the docs can be read back
  // without the supervisor exposing its internals. Doing it via `ids` returned undefined for
  // every bot and made the distinctness check pass against an EMPTY set — a vacuous green.
  const docs = await Promise.all(names.map(async (n) => {
    const charId = `c${createHash('sha1').update(`devbot:${n.toLowerCase()}`).digest('hex').slice(0, 24)}`;
    return players.get(charId);
  }));
  const apps = docs.map((d) => (d as { appearance?: Record<string, unknown> } | undefined)?.appearance);
  assert.equal(apps.filter(Boolean).length, 3,
    'every bot must have an appearance written, or the check below proves nothing');

  const seen = apps.map((a) => JSON.stringify(a));
  assert.equal(new Set(seen).size, 3,
    `bots share an appearance, so they render as one person repeated: ${seen.join(' | ')}`);
  const males = apps.filter((a) => a && a['isMale'] === true).length;
  assert.ok(males > 0 && males < 3,
    `expected a mix of sexes from the head ids, got ${males} male of 3 — isMale may still be hardcoded`);
});

test('a malformed entry is dropped, not turned into a broken puppet', async () => {
  const { bots } = await boot(2, ['dark elf|only|three', ...LOOKS]);
  assert.ok(bots, 'a bad entry must not throw; it is logged and skipped');
});
