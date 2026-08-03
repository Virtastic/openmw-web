// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Death-penalty seed: [rules] deathPenalty = "none" is the only M2 mode, so this is a
// deliberate no-op hook — the extension point (gold loss, skill drain, item drop) for
// operators and later milestones.

import type { Plugin } from '../api';

export const deathPenalty: Plugin = {
  name: 'death-penalty',
  onPlayerDeath(api, player) {
    if (api.config.rules.deathPenalty === 'none') return;
    api.log('warn', 'death_penalty.unknown_mode', { id: player.id, mode: api.config.rules.deathPenalty });
  },
};
