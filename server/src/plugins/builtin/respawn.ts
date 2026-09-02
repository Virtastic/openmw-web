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
//   1. The operator's configured respawn point, if they set one.
//   2. WHERE YOU DIED. Not ideal (it can loop in a bad spot) but it is recoverable, and it is
//      strictly better than the alternative below.
//
// What this replaced: an unconditional teleport to `[rules] respawnCellKey`, whose shipped
// default is the EXAMPLE SUITE demo's village spawn — a coordinate from a different game world
// entirely. On a server running retail Morrowind that is a meaningless point on the grid, so
// every death threw the player somewhere arbitrary, potentially into open sea. Nothing in the
// deploy docs told an operator to change it, and nothing warned them.

import type { Plugin } from '../api';

/** The shipped default, which is only meaningful for the bundled Example Suite demo. */
const DEMO_RESPAWN_CELL = '26,25';

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
    const configured = r.respawnCellKey !== ''
      ? { cellKey: r.respawnCellKey, x: r.respawnX, y: r.respawnY, z: r.respawnZ }
      : undefined;
    // Where they fell. Last resort, but never nowhere.
    const whereTheyFell = api.posOfPlayer?.(player.id);

    const dest = configured ?? whereTheyFell;
    if (!dest) {
      // No configured point, and no pose yet (died before ever moving). Nothing to send
      // — the client keeps its own position rather than being teleported into the void.
      api.log('warn', 'respawn.no_destination', { id: player.id, name: player.name });
      return;
    }

    api.sendEvent(player.id, 'PlayerResurrect', { ...dest, restoreHp: true });
    api.log('info', 'respawn.sent', {
      id: player.id, cellKey: dest.cellKey,
      via: configured ? 'configured' : 'where_they_fell',
    });

    // TELL THE WORLD. A friend vanishing mid-fight with no message reads as a bug or a
    // disconnect rather than as a death. One line is the whole fix.
    api.chat('all', { channel: 'server', text: `${player.name} has fallen.` });
  },
};
