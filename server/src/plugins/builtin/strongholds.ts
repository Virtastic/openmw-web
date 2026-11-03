// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-198: visit a friend's stronghold. Containers and placed items are per character
// (OT3-82 container views, OT3-165 per-character takes), so a stronghold's contents are its
// builder's own copy. A party member who has not built that stronghold and walks into it while
// its owner (a party member with the stronghold quest under way) is online is a GUEST: the
// server shows them the OWNER's copy of the cell (worldstate viewAs: their taken items, their
// chests) and refuses every take and put there with 'guest'. The owner, anyone who has the
// quest themselves, and strangers outside the owner's party are unaffected.
// The built stages are enable/disable state, which is world-wide already (backlog 218).
// ponytail: interiors only, matched by cell name; the exterior stronghold cells have no
// containers of the owner's to protect.

import type { Plugin, PluginApi, PluginPlayer } from '../api';

export interface Stronghold { quest: string; name: string; cell: RegExp }

// Vanilla quest ids of the three Great House strongholds and the interior cells they build.
// The quest ids are Morrowind.esm's; the cell names are the least certain part (see the
// commit), so the match is a prefix on the interior name.
export const STRONGHOLDS: Stronghold[] = [
  { quest: 'hh_stronghold', name: 'Rethan Manor', cell: /^rethan manor\b/i },
  { quest: 'hr_stronghold', name: 'Indarys Manor', cell: /^indarys manor\b/i },
  { quest: 'ht_stronghold', name: 'Tel Uvirith', cell: /^tel uvirith\b/i },
];

export const strongholdAt = (cellKey: string): Stronghold | undefined => STRONGHOLDS.find((s) => s.cell.test(cellKey));

function owns(api: PluginApi, id: number, s: Stronghold): boolean {
  const j = api.journalOf?.(id);
  if (!j) return false;
  for (const [q, idx] of Object.entries(j)) if (q.toLowerCase() === s.quest && idx > 0) return true;
  return false;
}

/** The online party member whose stronghold this is, when `player` is a guest in it. */
export function hostIn(api: PluginApi, playerId: number, cellKey: string): number | undefined {
  if (!api.config.strongholds.guestView) return undefined;
  const s = strongholdAt(cellKey);
  if (!s || owns(api, playerId, s)) return undefined;
  return (api.partyOnline?.(playerId) ?? []).find((m) => owns(api, m, s));
}

export const strongholds: Plugin = {
  name: 'strongholds',
  onCellView(api, player, cellKey) {
    const host = hostIn(api, player.id, cellKey);
    return host === undefined ? undefined : { hostId: host, readOnly: true };
  },
  onPlayerCellChange(api, player: PluginPlayer, _from, to) {
    const host = hostIn(api, player.id, to);
    if (host === undefined) return;
    const owner = api.players().find((p) => p.id === host)?.name ?? 'your friend';
    api.chat(player.id, { channel: 'server', text: `You are a guest in ${owner}'s ${strongholdAt(to)!.name}: look around, but leave their things where they are.` });
  },
};
