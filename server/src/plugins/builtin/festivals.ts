// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-201: calendar festivals on the world's own clock (api.world.time(), the M7 shared
// calendar; month is 0-based, Morning Star = 0). A festival is on for its whole game day:
// the tick notices the date turning onto it (announced to everyone) and off it (said goodbye),
// and every character in the world while it is on gets its gift once (claimOnce, keyed by
// festival and game year, so it is once per character per festival, and again next year).
// Off by default ([festivals] enabled): the gifts are free items.
// ponytail: no town decorations or NPC dialogue yet -- both need content (placed statics, an
// INFO record) the server cannot author; the festival speaks through server chat.

import type { Plugin, PluginApi, PluginPlayer } from '../api';

export interface Festival {
  id: string;
  name: string;
  month: number; // 0-based (Morning Star = 0)
  day: number;   // 1-based
  gift: { recordId: string; count: number; what: string };
  lines: string[];
}

// Dates from the Tamrielic calendar. New Life (1 Morning Star) and Heart's Day (16 Sun's Dawn)
// are well attested; the Witches Festival date is the least certain of the three (see the
// commit) and every date can be moved with [festivals] dates.
// Gifts are vanilla Morrowind.esm ids: Cyrodiilic Brandy, heather, bonemeal.
export const FESTIVALS: Festival[] = [
  {
    id: 'newlife', name: 'the New Life Festival', month: 0, day: 1,
    gift: { recordId: 'potion_cyro_brandy_01', count: 1, what: 'a bottle of Cyrodiilic Brandy' },
    lines: ['The taverns pour for free tonight: a new year, a New Life.'],
  },
  {
    id: 'heartsday', name: "Heart's Day", month: 1, day: 16,
    gift: { recordId: 'ingred_heather_01', count: 3, what: 'a sprig of heather' },
    lines: ['Bards sing of Polydor and Eloisa; inns give their beds to lovers tonight.'],
  },
  {
    id: 'witches', name: 'the Witches Festival', month: 4, day: 30,
    gift: { recordId: 'ingred_bonemeal_01', count: 2, what: 'a pouch of bonemeal' },
    lines: ['Hags and conjurers walk the roads tonight. Keep a ward about you.'],
  },
];

/** The festival on this date, if any. `dates` overrides ("id=month/day", month 1-based). */
export function festivalOn(month: number, day: number, dates: string[] = []): Festival | undefined {
  for (const f of FESTIVALS) {
    const o = dates.map((d) => /^(\w+)=(\d+)\/(\d+)$/.exec(d.trim())).find((m) => m?.[1] === f.id);
    const fm = o ? Number(o[2]) - 1 : f.month, fd = o ? Number(o[3]) : f.day;
    if (fm === month && fd === day) return f;
  }
  return undefined;
}

const activeBy = new WeakMap<PluginApi, string | undefined>();

function today(api: PluginApi): { fest?: Festival; year: number } {
  const t = api.world.time();
  return { fest: festivalOn(t.month, t.day, api.config.festivals.dates), year: t.year };
}

function gift(api: PluginApi, p: PluginPlayer, f: Festival, year: number): void {
  if (!api.claimOnce?.(p.id, `festival:${f.id}:${year}`)) return;
  api.give?.(p.id, f.gift.recordId, f.gift.count, `A gift for ${f.name}: ${f.gift.what}.`, `festival:${f.id}`);
  const gold = api.config.festivals.giftGold;
  if (gold > 0) api.give?.(p.id, 'gold_001', gold, `And ${gold} gold to spend on ${f.name}.`, `festival:${f.id}`);
}

export const festivals: Plugin = {
  name: 'festivals',
  onPlayerJoinWorld(api, player) {
    if (!api.config.festivals.enabled) return;
    const { fest, year } = today(api);
    if (!fest) return;
    api.chat(player.id, { channel: 'server', text: `Today is ${fest.name}. ${fest.lines[0] ?? ''}`.trim() });
    gift(api, player, fest, year);
  },
  onTick(api) {
    if (!api.config.festivals.enabled) return;
    const { fest, year } = today(api);
    const was = activeBy.get(api);
    if (fest?.id === was) return;
    activeBy.set(api, fest?.id);
    const ended = FESTIVALS.find((f) => f.id === was);
    if (ended) api.chat('all', { channel: 'server', text: `${ended.name[0]!.toUpperCase()}${ended.name.slice(1)} is over for another year.` });
    if (!fest) return;
    api.chat('all', { channel: 'server', text: `${fest.name[0]!.toUpperCase()}${fest.name.slice(1)} has begun! ${fest.lines.join(' ')}` });
    for (const p of api.players()) gift(api, p, fest, year);
    api.log('info', 'festival.start', { id: fest.id, year });
  },
};
