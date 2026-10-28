// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Death penalty. [rules] deathPenalty:
//   "none"   -- no penalty.
//   "repeat" -- OT3-122: dying again within REPEAT_WINDOW_MS of the last death sends the
//               client a DeathPenalty debuff, scaled by how many deaths are in the chain.
//               A first death, or one after the window, costs nothing.

import type { Plugin } from '../api';

export const REPEAT_WINDOW_MS = 10 * 60_000;
const DEBUFF_SEC = 120;
const MAX_STACKS = 5;

// Keyed by character name, so a relog does not reset the chain.
// ponytail: per-process and never pruned (one tiny row per character that died); persist if restarts matter.
const chains = new Map<string, { at: number; n: number }>();

export const deathPenalty: Plugin = {
  name: 'death-penalty',
  onPlayerDeath(api, player) {
    if (api.config.rules.deathPenalty !== 'repeat') return;
    const now = Date.now();
    const prev = chains.get(player.name);
    const n = prev && now - prev.at <= REPEAT_WINDOW_MS ? prev.n + 1 : 1;
    chains.set(player.name, { at: now, n });
    if (n < 2) return;
    const stacks = Math.min(n - 1, MAX_STACKS);
    api.sendEvent(player.id, 'DeathPenalty', { stacks, durationSec: DEBUFF_SEC });
    api.log('info', 'death_penalty.repeat', { id: player.id, deaths: n, stacks });
  },
};
