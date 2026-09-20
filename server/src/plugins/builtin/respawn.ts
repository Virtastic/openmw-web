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
// default WAS the Example Suite demo's village spawn — a coordinate from a different game world
// entirely, so on retail Morrowind every death threw the player somewhere arbitrary. The
// shipped default is now "" (where you fell; backlog 355), and the demo coordinate lives in
// the browser harness config. An operator who sets a point set it on purpose: no warning.

import type { Plugin } from '../api';

export const respawn: Plugin = {
  name: 'respawn',

  onPlayerDeath(api, player) {
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
    const surfaced = whereTheyFell && !configured && /^-?\d+,-?\d+$/.test(whereTheyFell.cellKey) && whereTheyFell.z < 0
      ? { ...whereTheyFell, z: 32 }
      : undefined;
    const dest = configured ?? surfaced ?? whereTheyFell;
    if (!dest) {
      // No configured point, and no pose yet (died before ever moving). Nothing to send
      // — the client keeps its own position rather than being teleported into the void.
      api.log('warn', 'respawn.no_destination', { id: player.id, name: player.name });
      return;
    }

    api.sendEvent(player.id, 'PlayerResurrect', { ...dest, restoreHp: true });
    api.log('info', 'respawn.sent', {
      id: player.id, cellKey: dest.cellKey,
      via: configured ? 'configured' : surfaced ? 'surfaced' : 'where_they_fell',
    });

    // TELL THE WORLD. A friend vanishing mid-fight with no message reads as a bug or a
    // disconnect rather than as a death. One line is the whole fix.
    api.chat('all', { channel: 'server', text: `${player.name} has fallen.` });
  },
};
