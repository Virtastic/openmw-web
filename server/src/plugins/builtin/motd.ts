// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Sends the MOTD as a server chat line — ONCE per player, on first arrival.

import type { Plugin } from '../api';

// Names already greeted by this world process.
//
// onPlayerJoinWorld fires on EVERY join, and a session joins many times: a reconnect is a join,
// and so is a world switch. Sending the MOTD each time put three copies of the same banner in
// the log before the player had read any of it, scrolling the actual conversation away.
//
// Deliberately NOT cleared on disconnect: a world switch is a disconnect followed by a join, so
// clearing there would re-greet on every switch — the exact spam this removes. Each world is
// its own process with its own set, so a player is greeted once per world they visit, which is
// the honest reading of "arriving somewhere".
//
// Keyed by name, not id: the roster recycles ids, so an id-keyed set would eventually greet the
// wrong person or skip someone. Bounded so a long-lived public world cannot grow it without
// limit; the cap is far above any real concurrent population, and evicting simply re-greets.
const GREETED_CAP = 4096;

// PER SERVER, not per module. The plugin object is a shared singleton, so a module-level set
// would be shared by every server in the process — one world greeting a player would silence
// the greeting in another. Keyed weakly off the api so it cannot outlive the server it belongs
// to, and so tests that stand up many servers behave like the separate worlds they represent.
const greetedBy = new WeakMap<object, Set<string>>();

export const motd: Plugin = {
  name: 'motd',
  onPlayerJoinWorld(api, player) {
    const text = api.config.server.motd;
    if (!text) return;
    let greeted = greetedBy.get(api);
    if (!greeted) {
      greeted = new Set<string>();
      greetedBy.set(api, greeted);
    }
    if (greeted.has(player.name)) return;
    if (greeted.size >= GREETED_CAP) greeted.clear();
    greeted.add(player.name);
    api.chat(player.id, { channel: 'server', text });
  },
};
