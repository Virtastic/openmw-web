-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
-- OT3-95: THE SCRIPT-CLASS TABLE. Where each MWScript runs (mwmp/puppets.hpp ScriptClass):
--   world  -- the world's (a door's lock, a lookout, a timer): the sim peer runs it, clients
--             skip it and forward an activation of its object / a StartScript of it to the peer.
--   client -- the player's (dialogue results, chargen, the player's own state): only the
--             triggering client runs it; the peer skips it.
--   both   -- runs everywhere, as every script did before this table.
-- Ids are script record ids, any case. Module 03 (the quest/phase generator) writes the lists;
-- this file is its output format.
--
-- EMPTY MEANS "NOT CLASSIFIED YET": with no id listed the engine runs everything everywhere,
-- exactly as before. The moment any id is listed the table is taken as total: a script it does
-- not name still runs everywhere, but each engine prints "[mp] UNCLASSIFIED SCRIPT <id>" and
-- the sweep (wasm-build/mp-harness.mjs) fails the scenario that ran it.
return {
    world = {},
    client = {},
    both = {},
}
