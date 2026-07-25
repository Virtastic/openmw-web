// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M7 cell resets. WHICH cells respawn their loot/objects and how often is an operator
// policy, so it lives in a plugin: this one reads [cellReset] and registers a schedule
// that the M7 world module persists (world/global.json) and sweeps. Replace it to reset
// on server-empty, on a real-world clock, or per dungeon-clear instead.

import type { Plugin } from '../api';

export const cellReset: Plugin = {
  name: 'cell-reset',
  onServerStart(api) {
    const { cells, intervalSec } = api.config.cellReset;
    for (const cellKey of cells) {
      // intervalSec 0 registers the cell without a timer: still resettable on demand
      // (admin command / another plugin) but never on a schedule.
      if (api.world.scheduleCellReset(cellKey, intervalSec)) {
        api.log('info', 'cellreset.scheduled', { cellKey, intervalSec });
      } else {
        api.log('warn', 'cellreset.bad_entry', { cellKey, intervalSec });
      }
    }
  },
};
