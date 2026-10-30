// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-99: the faction title behind a nameplate. Every player's highest faction rank (not
// expelled) is pushed to every client as PlayerTitles [{id, faction, rank}]; the client turns
// (faction, rank) into the rank NAME from its own game data (core.factions), so the server needs
// no copy of the ESM. Sent only when the set changed, and once to a player who has not had it.
// Only a faction id and a rank number leave the server: the name on the plate is the one the
// client already shows for that player.

import type { Player, Roster } from './players';
import type { PlayerDoc } from '../persist/playerstore';

export interface TitleRow { id: number; faction: string; rank: number }

/** The highest non-expelled rank in a doc's factions, or undefined. Ties go to the faction id order. */
export function topFaction(factions: PlayerDoc['factions']): { faction: string; rank: number } | undefined {
  let best: { faction: string; rank: number } | undefined;
  for (const id of Object.keys(factions ?? {}).sort()) {
    const f = factions![id]!;
    if (f.expelled === true || !Number.isFinite(f.rank) || f.rank < 1) continue; // 1-based: 0 is "not a member"
    if (!best || f.rank > best.rank) best = { faction: id, rank: Math.floor(f.rank) };
  }
  return best;
}

export class Titles {
  private readonly sent = new Map<number, string>(); // playerId -> signature last sent

  constructor(private readonly d: {
    roster: Roster;
    factionsOf(p: Player): PlayerDoc['factions'];
  }) {}

  /** Called from the 2 s tick. */
  tick(): void {
    const humans = this.d.roster.inWorld().filter((p) => !p.system);
    const rows: TitleRow[] = [];
    for (const p of humans) {
      const top = topFaction(this.d.factionsOf(p));
      if (top) rows.push({ id: p.id, ...top });
    }
    const sig = JSON.stringify(rows);
    const live = new Set<number>();
    for (const p of humans) {
      live.add(p.id);
      if (this.sent.get(p.id) === sig) continue;
      this.sent.set(p.id, sig);
      p.peer.sendEvent('PlayerTitles', { titles: rows as unknown as never });
    }
    for (const id of this.sent.keys()) if (!live.has(id)) this.sent.delete(id);
  }
}
