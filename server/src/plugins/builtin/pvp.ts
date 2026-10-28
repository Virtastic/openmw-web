// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M5 PvP gate. Owns the decision so operators can swap this plugin for faction/team/
// duel rules without touching the relay. Only PLAYER-targeted hits reach this hook —
// actor targets are never gated.
// OT3-163: consent first. rules.pvp is the operator's master switch; under it a hit needs an
// accepted duel or both in the Arena (explicit, so no zone/sprout rule applies), or both
// players flagged (then every zone rule below still applies). Never open-world by default.

import type { Plugin } from '../api';

// OT3-162, onboarding: whatever the operator's zoning, nobody is killed by a player where
// chargen leaves them, or before they have found their feet. (UO lost most of its new players
// to open PvP.) Seyda Neen's exterior grid plus every interior named for it.
const SEYDA_NEEN = new Set(['-2,-9', '-3,-9', '-2,-10', '-3,-10']);
const inSeydaNeen = (cellKey: string | undefined): boolean =>
  cellKey !== undefined && (SEYDA_NEEN.has(cellKey) || /^seyda neen\b/i.test(cellKey));
const SPROUT_LEVEL = 5; // below this a character neither takes nor deals player damage

export const pvp: Plugin = {
  name: 'pvp',
  onPlayerDeath(api, player) {
    api.diedInDuel?.(player.id); // ends the duel and names the winner
  },
  onPlayerHit(api, attacker, victimId, name) {
    const block = (why: string): false => {
      api.log('info', 'pvp.blocked', { attacker: attacker.name, victimId, event: name, why });
      return false;
    };
    if (!api.config.rules.pvp) return block('disabled');
    const consent = api.pvpConsent?.(attacker.id, victimId);
    if (consent === 'duel' || consent === 'arena') return true;
    if (consent !== 'flag') return block('no consent');
    if (inSeydaNeen(api.cellOfPlayer?.(victimId)) || inSeydaNeen(api.cellOfPlayer?.(attacker.id)))
      return block('seyda neen');
    // Both ways: a protected character who could still hit others would grief with impunity.
    if (api.levelOfPlayer && (api.levelOfPlayer(victimId) < SPROUT_LEVEL || api.levelOfPlayer(attacker.id) < SPROUT_LEVEL))
      return block('sprout');

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
