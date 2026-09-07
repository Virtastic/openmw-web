// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s101: AN OPERATOR ACTUALLY ADMINISTERS THE PLATFORM — against a real game with a real
// player in it.
//
// s93 proves the dashboard PAGE loads and can reach one game's console. What nothing covered
// is the platform surface an operator uses to run a box: list the games, see whose they are,
// reach into a running one through the proxy, and stop one. Those are the actions that either
// work or leave an operator with a browser and no way to act.
//
// Two of today's bugs live on this path and both were invisible from the server suite:
//   - a game was labelled with its owner's ACCOUNT KEY (the login identifier, and a real name
//     for an SSO account) because the gateway resolved names from a cache that, being a
//     different process, had never seen them.
//   - the proxy is the only way one sign-in reaches a game's own admin API; if it stops
//     working every per-game page goes with it.
import assert from 'node:assert/strict';
import { startGatewayAndClient } from './_gateway.mjs';

const OWNER = { name: 'ops@example.com', password: 'a-long-enough-passphrase' };
const STEP = 30_000;
// Spaced ten apart from its neighbours on purpose: the gateway puts each world it
// spawns on GW_PORT + 200 upward, one per client, so adjacent scenarios were handing
// each other a port the previous run had not finished draining — which surfaces as
// "the player own world must come up" and looks exactly like a broken product.
const GW_PORT = 18910;

export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'ops-player', ownId: 'priv-ops-world',
  });
  const base = `http://127.0.0.1:${GW_PORT}/admin/api`;
  try {
    // The player takes a handle, so the games list has something to show that is NOT their
    // account key — which is the whole point of the assertion below.
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const handle = `opsplayer${tag}`;
    await host.client.cmd(`profile:ops-player@example.com:${handle}`);
    await host.client.waitFor('window.omw.state.profileOk !== undefined', STEP, 'profile answered');
    assert.equal(await host.client.eval('window.omw.state.profileOk'), 'true', 'the player needs a handle');

    // The operator claims the server (loopback needs no setup key) and finishes the wizard.
    const owner = await fetch(`${base}/setup/owner`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
    });
    assert.equal(owner.status, 200, `owner creation (${owner.status})`);
    const token = (await owner.json()).token;
    const auth = { authorization: `Bearer ${token}` };
    const setup = await fetch(`${base}/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ deploymentMode: 'multiplayer', completed: true }),
    });
    assert.equal(setup.status, 200, 'the wizard answer is accepted');

    // 1. THE GAMES LIST — what is running, and whose it is.
    const games = await (await fetch(`${base}/games`, { headers: auth })).json();
    const mine = (games.games ?? games).find((g) => g.id === host.ownId);
    assert.ok(mine, `the running game must be listed: ${JSON.stringify(games).slice(0, 300)}`);
    assert.equal(mine.ownerName, handle,
      `a game must be labelled with its owner's HANDLE, not their account key — got`
      + ` ${JSON.stringify(mine.ownerName)}, which for an SSO account is a real name`);
    ctx.log(`ok: the platform lists ${(games.games ?? games).length} game(s), owner named by handle`);

    // 2. THE PROXY — one sign-in reaching into a running game's own admin API. Every per-game
    // page in the dashboard is this call with a different tail.
    const proxied = await fetch(`${base}/games/${host.ownId}/players`, { headers: auth });
    assert.equal(proxied.status, 200,
      `the operator must reach a game's own API through the gateway (${proxied.status})`);
    const roster = await proxied.json();
    const rows = roster.players ?? roster;
    assert.ok(Array.isArray(rows) && rows.length >= 1,
      `the game must report its player through the proxy: ${JSON.stringify(roster).slice(0, 200)}`);
    ctx.log('ok: the proxy reaches the running game, authenticated as the operator');

    // 3. STOPPING ONE. The action an operator needs when a game misbehaves, and the one that
    // is hardest to take back — so it must actually take effect.
    const stop = await fetch(`${base}/games/${host.ownId}/stop`, { method: 'POST', headers: auth });
    assert.equal(stop.status, 200, `stopping a game must be allowed to the owner (${stop.status})`);

    // The supervisor reports it gone (or down) rather than pretending. Polled, because a stop
    // is a SIGTERM and a drain, not an instant.
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      const now = await (await fetch(`${base}/games`, { headers: auth })).json();
      const row = (now.games ?? now).find((g) => g.id === host.ownId);
      gone = !row || row.up === false;
      if (!gone) await ctx.sleep(1000);
    }
    assert.ok(gone, 'a stopped game must stop being reported as running');
    ctx.log('ok: the operator stopped a running game and the platform agrees it is gone');
    ctx.log('PASS: an operator can see, reach into, and stop the games on their box');
  } finally {
    host.stop();
  }
}
