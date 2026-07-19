// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Sends the MOTD as a server chat line on world join. Exists to prove the hook bus.

import type { Plugin } from '../api';

export const motd: Plugin = {
  name: 'motd',
  onPlayerJoinWorld(api, player) {
    const text = api.config.server.motd;
    if (text) api.chat(player.id, { channel: 'server', text });
  },
};
