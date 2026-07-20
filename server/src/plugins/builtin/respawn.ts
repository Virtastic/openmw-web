// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// On death, teleports the player to the configured respawn point with restored dynamic
// stats ([rules] respawnCellKey/respawnX/Y/Z — placeholder demo-Village coords by
// default; operators override per content set).

import type { Plugin } from '../api';

export const respawn: Plugin = {
  name: 'respawn',
  onPlayerDeath(api, player) {
    const r = api.config.rules;
    api.sendEvent(player.id, 'PlayerResurrect', {
      cellKey: r.respawnCellKey,
      x: r.respawnX,
      y: r.respawnY,
      z: r.respawnZ,
      restoreHp: true,
    });
    api.log('info', 'respawn.sent', { id: player.id, cellKey: r.respawnCellKey });
  },
};
