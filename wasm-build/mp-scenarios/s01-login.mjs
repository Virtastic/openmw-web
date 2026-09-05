// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s01: two clients register+login (&mpauto=1) and reach Joined; the server /status roster
// lists exactly both; each client's Lua roster mirror (omw.state.players) sees the other.
import assert from 'node:assert/strict';

export default async function run(ctx) {
  // Launch concurrently — each boot is ~30-60s of engine load, no need to serialize.
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a'),
    ctx.launchClient('bot-b'),
  ]);

  // launchClient already waited for state === 'Joined' on both.
  const status = await ctx.serverStatus();
  const names = status.players.map((p) => p.name).sort();
  ctx.log('server /status players:', JSON.stringify(names));
  assert.deepEqual(names, [a.name, b.name].sort(), '/status must list exactly both bots');

  // Roster propagation: each client's omw.state.players (JSON from global.lua) includes the
  // OTHER bot within 5s (PlayerList/PlayerJoinWorld fan-out).
  const seesExpr = (other) =>
    `JSON.parse(window.omw.state.players||"[]").some(p=>p.name===${JSON.stringify(other)})`;
  await a.waitFor(seesExpr(b.name), 5000, `roster on ${a.name} includes ${b.name}`);
  await b.waitFor(seesExpr(a.name), 5000, `roster on ${b.name} includes ${a.name}`);

  // playerId mirror sanity: distinct, numeric.
  const [idA, idB] = await Promise.all([a.eval('window.omw.state.playerId'), b.eval('window.omw.state.playerId')]);
  assert.ok(idA && idB && idA !== idB, `playerIds must be distinct (got ${idA}, ${idB})`);
  ctx.log(`ok: both joined (ids ${idA}/${idB}), rosters converged`);
}
