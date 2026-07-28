// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M5 PvP gate. Owns the decision so operators can swap this plugin for faction/team/
// duel rules without touching the relay. Only PLAYER-targeted hits reach this hook —
// actor targets are never gated.

import type { Plugin } from '../api';

export const pvp: Plugin = {
  name: 'pvp',
  onPlayerHit(api, attacker, victimId, name) {
    const block = (why: string): false => {
      api.log('info', 'pvp.blocked', { attacker: attacker.name, victimId, event: name, why });
      return false;
    };
    if (!api.config.rules.pvp) return block('disabled');

    // Party members are exempt everywhere, before any zoning question: friendly fire in a
    // group that is fighting its way through a dungeon together is not a rule, it is a bug.
    if (api.arePartied?.(attacker.id, victimId)) return block('same party');

    const zone = api.config.rules.pvpZone;
    if (zone === 'none') return block('zone none');
    if (zone === 'wilderness') {
      const cellKey = api.cellOfPlayer?.(victimId) ?? '';
      if (cellKey === '') return block('unknown cell'); // fail closed: never a free hit
      if (api.config.rules.safeCells.includes(cellKey)) return block('safe cell');
      // Exterior keys are "x,y"; anything else is an interior — shops, homes, guildhalls,
      // where a player must be able to stand still without being killed for it.
      if (!/^-?\d+,-?\d+$/.test(cellKey)) return block('interior');
    }
    return true;
  },
};
