// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Where a dead player comes back.
//
// Morrowind has no respawn — vanilla death is "reload your save" — so multiplayer has to invent
// one, and the invention is a gameplay decision rather than a technicality. Getting it wrong is
// the difference between dying being a setback and dying ending the session.
//
// THE ORDER MATTERS:
//
//   0. DOWNED (OT3-174): with a party member online, nobody respawns at once. They lie where
//      they fell for DOWNED_MS while the party is told; a party member's Restore Health
//      (spell or scroll) stands them up in place. Unrevived, they respawn by the order below.
//   1. The operator's configured respawn point, if they set one.
//   1b. The nearest temple or shrine this character has visited (OT3-174), all items kept.
//   2. WHERE YOU DIED. Not ideal (it can loop in a bad spot) but it is recoverable, and it is
//      strictly better than the alternative below.
//
// What this replaced: an unconditional teleport to `[rules] respawnCellKey`, whose shipped
// default WAS the Example Suite demo's village spawn — a coordinate from a different game world
// entirely, so on retail Morrowind every death threw the player somewhere arbitrary. The
// shipped default is now "" (where you fell; backlog 355), and the demo coordinate lives in
// the browser harness config. An operator who sets a point set it on purpose: no warning.

import type { Plugin, PluginApi, PluginPlayer } from '../api';

export const DOWNED_MS = 30_000;
const REVIVE_HP_FRACTION = 0.25;
// Per server (the api is one per server): who is downed, and their respawn timer.
const downedBy = new WeakMap<PluginApi, Map<number, ReturnType<typeof setTimeout>>>();
const downedOf = (api: PluginApi) => {
  let m = downedBy.get(api);
  if (!m) downedBy.set(api, (m = new Map()));
  return m;
};

const EXTERIOR = /^-?\d+,-?\d+$/;

/** OT3-174: the visited shrine nearest to where they fell (outdoors), or to the last outdoor
 *  spot they left (indoors). Shrines with no outdoor reference lose to any that have one;
 *  with no reference point at all, the most recently visited wins. */
export function nearestShrine(api: PluginApi, playerId: number, fell: { cellKey: string; x: number; y: number } | undefined) {
  const v = api.shrinesOf?.(playerId);
  if (!v || v.shrines.length === 0) return undefined;
  const from = fell && EXTERIOR.test(fell.cellKey) ? fell : v.outside;
  let best = v.shrines[v.shrines.length - 1]!;
  if (from) {
    let bestD = Infinity;
    for (const s of v.shrines) {
      if (s.ex === undefined || s.ey === undefined) continue;
      const d = (s.ex - from.x) ** 2 + (s.ey - from.y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
  }
  return { cellKey: best.cellKey, x: best.x, y: best.y, z: best.z };
}

function respawnNow(api: PluginApi, player: PluginPlayer) {
  const r = api.config.rules;
  const configured = r.respawnCellKey !== ''
    ? { cellKey: r.respawnCellKey, x: r.respawnX, y: r.respawnY, z: r.respawnZ }
    : undefined;
  // Where they fell. Last resort, but never nowhere.
  const whereTheyFell = api.posOfPlayer?.(player.id);

  // ...BUT NOT ON THE SEABED. A player who drowns fell under water; put back exactly there
  // with full health they drown again on the next breath, and again (backlog 485: six
  // deaths in three minutes). An exterior's water surface is z = 0 everywhere in Morrowind,
  // so a where-you-fell below it comes back at the surface of the same spot: breath
  // restored, able to swim for the shore. Interiors keep their own water levels, which the
  // server does not know; the operator's configured point is untouched.
  const shrine = configured ? undefined : nearestShrine(api, player.id, whereTheyFell);
  const surfaced = whereTheyFell && !configured && !shrine && /^-?\d+,-?\d+$/.test(whereTheyFell.cellKey) && whereTheyFell.z < 0
    ? { ...whereTheyFell, z: 32 }
    : undefined;
  const dest = configured ?? shrine ?? surfaced ?? whereTheyFell;
  if (!dest) {
    // No configured point, and no pose yet (died before ever moving). Nothing to send
    // — the client keeps its own position rather than being teleported into the void.
    api.log('warn', 'respawn.no_destination', { id: player.id, name: player.name });
    return;
  }

  api.sendEvent(player.id, 'PlayerResurrect', { ...dest, restoreHp: true });
  api.log('info', 'respawn.sent', {
    id: player.id, cellKey: dest.cellKey,
    via: configured ? 'configured' : shrine ? 'shrine' : surfaced ? 'surfaced' : 'where_they_fell',
  });
}

export const respawn: Plugin = {
  name: 'respawn',

  onPlayerDeath(api, player) {
    // The client resends PlayerDeath every 5 s while dead: a downed player is already waiting.
    const downed = downedOf(api);
    if (downed.has(player.id)) return;

    // TELL THE PEOPLE WHO CARE. A friend vanishing mid-fight with no message reads as a bug
    // or a disconnect rather than as a death. OT3-176: the same cell and the party only --
    // a server-wide "X has fallen" is noise to everyone else (and a free stalker feed).
    const party = api.partyOnline?.(player.id) ?? [];
    const cell = api.posOfPlayer?.(player.id)?.cellKey;
    const told = new Set([player.id, ...party]);
    if (cell !== undefined) {
      for (const p of api.players()) if (api.posOfPlayer?.(p.id)?.cellKey === cell) told.add(p.id);
    }
    for (const id of told) api.chat(id, { channel: 'server', text: `${player.name} has fallen.` });

    if (party.length === 0) { respawnNow(api, player); return; }
    const timer = setTimeout(() => { downed.delete(player.id); respawnNow(api, player); }, DOWNED_MS);
    timer.unref?.();
    downed.set(player.id, timer);
    const secs = Math.round(DOWNED_MS / 1000);
    for (const id of party) {
      api.chat(id, { channel: 'party', text: `${player.name} is down. Restore Health (spell or scroll) on them within ${secs} s to revive them.` });
    }
    api.chat(player.id, { channel: 'party', text: `You are down. Your party has ${secs} s to revive you before you return to the nearest shrine.` });
    api.log('info', 'respawn.downed', { id: player.id, party });
  },

  onPlayerRevive(api, healer, victimId) {
    const downed = downedOf(api);
    const timer = downed.get(victimId);
    if (timer === undefined || !(api.partyOnline?.(victimId) ?? []).includes(healer.id)) return;
    clearTimeout(timer);
    downed.delete(victimId);
    const max = api.maxHealthOf?.(victimId);
    const hp = Math.max(1, Math.round((max ?? 40) * REVIVE_HP_FRACTION));
    // Up where they lie: standUp skips the client's teleport; the position is the peer's.
    api.sendEvent(victimId, 'PlayerResurrect', { ...(api.posOfPlayer?.(victimId) ?? {}), standUp: true, hp });
    api.log('info', 'respawn.revived', { id: victimId, by: healer.id, hp });
    return true;
  },

  onPlayerDisconnect(api, player) {
    const downed = downedOf(api);
    clearTimeout(downed.get(player.id));
    downed.delete(player.id);
  },
};
