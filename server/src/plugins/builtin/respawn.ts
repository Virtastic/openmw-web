// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Where a dead player comes back.
//
// Morrowind has no respawn — vanilla death is "reload your save" — so multiplayer has to invent
// one, and the invention is a gameplay decision rather than a technicality. Getting it wrong is
// the difference between dying being a setback and dying ending the session.
//
// THE ORDER MATTERS, and it is party-first on purpose:
//
//   1. A PARTY MEMBER who is in-world. You died fighting alongside people; putting you back with
//      them keeps the fight going and keeps the evening going. Sending you across the map instead
//      means a ten-minute walk during which your friends either wait or move on without you —
//      which is how a co-op session quietly ends.
//   2. The operator's configured respawn point, if they set one.
//   3. WHERE YOU DIED. Not ideal (it can loop in a bad spot) but it is recoverable, and it is
//      strictly better than the alternative below.
//
// What this replaced: an unconditional teleport to `[rules] respawnCellKey`, whose shipped
// default is the EXAMPLE SUITE demo's village spawn — a coordinate from a different game world
// entirely. On a server running retail Morrowind that is a meaningless point on the grid, so
// every death threw the player somewhere arbitrary, potentially into open sea. Nothing in the
// deploy docs told an operator to change it, and nothing warned them.

import type { Plugin, PluginApi, PluginPlayer } from '../api';

/** The shipped default, which is only meaningful for the bundled Example Suite demo. */
const DEMO_RESPAWN_CELL = '26,25';

function partyDestination(api: PluginApi, player: PluginPlayer):
{ cellKey: string; x: number; y: number; z: number } | undefined {
  for (const id of api.partyOfPlayer?.(player.id) ?? []) {
    const pos = api.posOfPlayer?.(id);
    if (pos) return pos;
  }
  return undefined;
}

export const respawn: Plugin = {
  name: 'respawn',

  onServerStart(api) {
    // SAY IT AT BOOT, not after the first player drowns. A world running real game data with the
    // demo's coordinate still configured is misconfigured, and it is invisible until someone dies.
    if (api.config.rules.respawnCellKey === DEMO_RESPAWN_CELL && api.config.simPeer.enabled) {
      api.log('warn', 'respawn.demo_default_on_real_world', {
        cellKey: DEMO_RESPAWN_CELL,
        fix: 'set [rules] respawnCellKey/X/Y/Z to a real location in YOUR content — the default '
          + 'is the Example Suite village and means nothing on retail Morrowind',
      });
    }
  },

  onPlayerDeath(api, player) {
    const r = api.config.rules;
    const withParty = partyDestination(api, player);
    const configured = r.respawnCellKey !== ''
      ? { cellKey: r.respawnCellKey, x: r.respawnX, y: r.respawnY, z: r.respawnZ }
      : undefined;
    // Where they fell. Last resort, but never nowhere.
    const whereTheyFell = api.posOfPlayer?.(player.id);

    const dest = withParty ?? configured ?? whereTheyFell;
    if (!dest) {
      // No party, no configured point, and no pose yet (died before ever moving). Nothing to send
      // — the client keeps its own position rather than being teleported into the void.
      api.log('warn', 'respawn.no_destination', { id: player.id, name: player.name });
      return;
    }

    api.sendEvent(player.id, 'PlayerResurrect', { ...dest, restoreHp: true });
    api.log('info', 'respawn.sent', {
      id: player.id, cellKey: dest.cellKey,
      via: withParty ? 'party' : configured ? 'configured' : 'where_they_fell',
    });

    // TELL THE PARTY. Nobody was told anything when a member died — your friend vanished from
    // beside you mid-fight and the game said nothing, which reads as a bug or a disconnect
    // rather than as a death. One line is the whole fix.
    for (const id of api.partyOfPlayer?.(player.id) ?? []) {
      api.chat(id, { channel: 'server', text: `${player.name} has fallen.` });
    }
  },
};
