// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-199: daily bounty boards. Each guild posts ONE contract a day (UTC day, the same for
// everyone), picked from a fixed pool by the day number, so a restart or a second world posts
// the same board:
//   - Fighters Guild: kill N of a creature, anywhere.
//   - Morag Tong: a writ against N of the Sixth House's creatures.
//   - Thieves Guild: open N locks inside a town's buildings.
// PARTY-SHAREABLE: progress belongs to the party (or the character, unpartied). A kill counts
// for every party with a member who saw it (worldstate's witness list, the same rule as the
// per-character kill tally); a lock counts for the opener's party. When the count is reached,
// every online member who belongs to the guild (or anyone, with requireMembership off) is paid,
// at most once per character per guild per day (claimOnce, persisted on the character).
// Off by default ([bounties] enabled): it is a gold faucet and the operator sizes it.
// ponytail: progress is in memory (a restart restarts today's count, never the pay-out); and
// there is no board UI yet -- the board is told in server chat on arrival and on rotation.

import type { Plugin, PluginApi, PluginKill, PluginPlayer } from '../api';

export const DAY_MS = 24 * 60 * 60_000;
const GOLD = 'gold_001';

export type Guild = 'fighters guild' | 'morag tong' | 'thieves guild';
export const GUILDS: Guild[] = ['fighters guild', 'morag tong', 'thieves guild'];
const GUILD_NAME: Record<Guild, string> = {
  'fighters guild': 'Fighters Guild', 'morag tong': 'Morag Tong', 'thieves guild': 'Thieves Guild',
};

export type Contract =
  | { kind: 'kill'; targets: string[]; n: number; what: string }
  | { kind: 'unlock'; town: string; n: number; what: string };

// Vanilla record ids. rat, mudcrab, cliff racer, nix-hound, scamp, slaughterfish and ash_ghoul
// are already named elsewhere in this tree; kagouti, alit, ash_slave, ash_zombie,
// corprus_stalker and corprus_lame are standard Morrowind.esm creature ids.
export const POOLS: Record<Guild, Contract[]> = {
  'fighters guild': [
    { kind: 'kill', targets: ['kagouti'], n: 3, what: 'kagouti' },
    { kind: 'kill', targets: ['alit'], n: 3, what: 'alit' },
    { kind: 'kill', targets: ['nix-hound'], n: 4, what: 'nix-hounds' },
    { kind: 'kill', targets: ['cliff racer'], n: 5, what: 'cliff racers' },
    { kind: 'kill', targets: ['mudcrab'], n: 4, what: 'mudcrabs' },
    { kind: 'kill', targets: ['rat'], n: 6, what: 'rats' },
    { kind: 'kill', targets: ['slaughterfish', 'slaughterfish_small'], n: 4, what: 'slaughterfish' },
  ],
  'morag tong': [
    { kind: 'kill', targets: ['ash_slave'], n: 3, what: 'ash slaves of the Sixth House' },
    { kind: 'kill', targets: ['ash_zombie'], n: 3, what: 'ash zombies of the Sixth House' },
    { kind: 'kill', targets: ['ash_ghoul'], n: 1, what: 'an ash ghoul of the Sixth House' },
    { kind: 'kill', targets: ['corprus_stalker', 'corprus_lame'], n: 2, what: 'corprus beasts' },
  ],
  'thieves guild': [
    { kind: 'unlock', town: 'balmora', n: 3, what: 'locks in Balmora' },
    { kind: 'unlock', town: 'vivec', n: 3, what: 'locks in Vivec' },
    { kind: 'unlock', town: "ald'ruhn", n: 3, what: "locks in Ald'ruhn" },
    { kind: 'unlock', town: 'sadrith mora', n: 3, what: 'locks in Sadrith Mora' },
    { kind: 'unlock', town: 'caldera', n: 2, what: 'locks in Caldera' },
    { kind: 'unlock', town: 'pelagiad', n: 2, what: 'locks in Pelagiad' },
  ],
};

/** Today's contract for a guild: deterministic in the day number, different per guild. */
export function contractFor(guild: Guild, day: number): Contract {
  const pool = POOLS[guild];
  const salt = GUILDS.indexOf(guild) * 7;
  return pool[(day + salt) % pool.length]!;
}

/** Day number of a wall-clock time. */
export const dayOf = (nowMs: number): number => Math.floor(nowMs / DAY_MS);

/** "Balmora, Guild of Fighters" is in Balmora; an exterior "x,y" is in no town by name. */
export const inTown = (cellKey: string, town: string): boolean =>
  cellKey.toLowerCase() === town || cellKey.toLowerCase().startsWith(`${town},`);

interface Board { day: number; progress: Map<string, number>; announced: boolean }
const boards = new WeakMap<PluginApi, Board>();

function boardOf(api: PluginApi, nowMs: number): Board {
  const day = dayOf(nowMs);
  let b = boards.get(api);
  if (!b || b.day !== day) boards.set(api, (b = { day, progress: new Map(), announced: false }));
  return b;
}

const isMember = (api: PluginApi, id: number, guild: Guild): boolean =>
  !api.config.bounties.requireMembership || api.factionRankOf?.(id, guild) !== undefined;

/** Progress key: the party, else the character. */
const groupOf = (api: PluginApi, id: number): string => {
  const party = api.partyIdOf?.(id);
  return party !== undefined ? `p${party}` : `c${id}`;
};
const membersOf = (api: PluginApi, id: number): number[] => [id, ...(api.partyOnline?.(id) ?? [])];

export function boardText(api: PluginApi, nowMs: number, forId?: number): string[] {
  const day = dayOf(nowMs);
  return GUILDS
    .filter((g) => forId === undefined || isMember(api, forId, g))
    .map((g) => {
      const c = contractFor(g, day);
      return `${GUILD_NAME[g]} contract today: ${c.kind === 'kill' ? 'slay' : 'open'} ${c.n} ${c.what} (${api.config.bounties.goldPerContract} gold each, party-shared).`;
    });
}

/** Count one unit of progress for the groups of `ids` on `guild`; pay out on completion. */
function credit(api: PluginApi, guild: Guild, ids: number[], nowMs: number): void {
  const b = boardOf(api, nowMs);
  const c = contractFor(guild, b.day);
  const done = new Set<string>();
  for (const id of ids) {
    const g = groupOf(api, id);
    if (done.has(g)) continue; // a party of three who all saw it is one kill, not three
    done.add(g);
    const members = membersOf(api, id);
    if (!members.some((m) => isMember(api, m, guild))) continue;
    const key = `${guild}|${g}`;
    const before = b.progress.get(key) ?? 0;
    if (before >= c.n) continue;
    const now = before + 1;
    b.progress.set(key, now);
    if (now < c.n) {
      for (const m of members) api.chat(m, { channel: 'server', text: `${GUILD_NAME[guild]} contract: ${now}/${c.n} ${c.what}.` });
      continue;
    }
    const gold = api.config.bounties.goldPerContract;
    for (const m of members) {
      if (!isMember(api, m, guild)) continue;
      if (api.claimOnce && !api.claimOnce(m, `bounty:${b.day}:${guild}`)) {
        api.chat(m, { channel: 'server', text: `${GUILD_NAME[guild]} contract complete. You were already paid for today's.` });
        continue;
      }
      if (gold > 0) api.give?.(m, GOLD, gold, `${GUILD_NAME[guild]} contract complete: ${gold} gold.`, `bounty:${guild}`);
    }
    api.log('info', 'bounty.complete', { guild, group: g, members, gold, day: b.day });
  }
}

export const bountyBoard: Plugin = {
  name: 'bounty-board',
  onPlayerJoinWorld(api, player: PluginPlayer) {
    if (!api.config.bounties.enabled) return;
    for (const text of boardText(api, Date.now(), player.id)) api.chat(player.id, { channel: 'server', text });
  },
  onTick(api, nowMs) {
    if (!api.config.bounties.enabled) return;
    const b = boardOf(api, nowMs);
    if (b.announced) return;
    b.announced = true;
    // A new day: everyone online hears their guilds' new board (the first tick after a
    // start is a "new day" too; a player who just joined hears it twice, which is harmless).
    for (const p of api.players()) for (const text of boardText(api, nowMs, p.id)) api.chat(p.id, { channel: 'server', text });
  },
  onActorKilled(api, kill: PluginKill) {
    if (!api.config.bounties.enabled || kill.witnesses.length === 0) return;
    const day = dayOf(Date.now());
    for (const g of GUILDS) {
      const c = contractFor(g, day);
      if (c.kind === 'kill' && c.targets.includes(kill.recordId)) credit(api, g, kill.witnesses, Date.now());
    }
  },
  onLockOpened(api, player, cellKey) {
    if (!api.config.bounties.enabled) return;
    const c = contractFor('thieves guild', dayOf(Date.now()));
    if (c.kind === 'unlock' && inTown(cellKey, c.town)) credit(api, 'thieves guild', [player.id], Date.now());
  },
};
