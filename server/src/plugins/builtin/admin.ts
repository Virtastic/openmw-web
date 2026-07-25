// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 admin policy. The COMMANDS live in core/admin.ts (one gate for the chat and event
// paths); this plugin owns the two operator decisions around them:
//   * who starts out as an owner ([admin] owners, re-applied every boot so an operator
//     never has to hand-edit accounts/<name>.json to bootstrap rank 3), and
//   * an optional per-command veto — replace this plugin to scope commands by time of
//     day, by a staff roster, or to require two operators online.
// The default veto allows everything the rank gate already allowed.

import type { Plugin } from '../api';

export const admin: Plugin = {
  name: 'admin',
  onServerStart(api) {
    for (const name of api.config.admin.owners) {
      void api.world.promoteOwner(name).then((ok) => {
        api.log(ok ? 'info' : 'warn', ok ? 'admin.owner_seeded' : 'admin.owner_unknown', { account: name });
      });
    }
  },
  onAdminCommand(api, actor, cmd) {
    if (cmd === 'console' && !api.config.admin.allowConsole) return false;
    return true;
  },
};
