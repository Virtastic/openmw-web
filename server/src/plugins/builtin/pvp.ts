// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M5 PvP gate. Owns the decision so operators can swap this plugin for faction/team/
// duel rules without touching the relay. Only PLAYER-targeted hits reach this hook —
// actor targets are never gated.

import type { Plugin } from '../api';

export const pvp: Plugin = {
  name: 'pvp',
  onPlayerHit(api, attacker, victimId, name) {
    if (api.config.rules.pvp) return true;
    api.log('info', 'pvp.blocked', { attacker: attacker.name, victimId, event: name });
    return false;
  },
};
