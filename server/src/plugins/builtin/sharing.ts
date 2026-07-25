// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M6 sharing policy. Whether a quest family is world-shared or per-player is an operator
// decision, so it lives here rather than in the relay: swap this plugin to scope sharing
// to a party, a faction, or a time window without touching core.

import type { Plugin } from '../api';

export const sharing: Plugin = {
  name: 'sharing',
  onShareFamily(api, family) {
    return api.config.sharing[family];
  },
  onJournalRegress(api, questId) {
    // Some MW quests legitimately move backwards; the operator allowlists those ids.
    return api.config.sharing.regressAllowlist.includes(questId);
  },
};
