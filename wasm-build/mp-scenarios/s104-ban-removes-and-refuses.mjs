// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s104: A BAN REMOVES THEM AND KEEPS THEM OUT.
//
// Banning is the action every other moderation feature exists to lead up to, and it is the one
// with the most places to go half-right. It has to do three separate things, in three separate
// programs, and any one of them failing leaves an operator believing they acted:
//
//   1. the operator's click has to reach a running GAME (through the gateway's proxy) rather
//      than only the platform that proxied it,
//   2. the player in that game has to actually leave — a ban that only writes a row is a note
//      to a file while the griefer keeps playing,
//   3. and they must not get back IN, which is a different decision in a different place from
//      the one that threw them out — the world's auth check on rejoin.
//
// The third is the one worth the scenario, and the client makes it honest: it has its own retry
// ladder, so it is hammering the door throughout. The unban at the end is the control — if it
// could not get back in then either, step 2 proved only that the client had given up.
import assert from 'node:assert/strict';
import { startGatewayAndClient } from './_gateway.mjs';

const OWNER = { name: 'banops@example.com', password: 'a-long-enough-passphrase' };
const STEP = 30_000;
// Spaced from its neighbours: the gateway puts each world on GW_PORT + 200 upward, one per
// client, so adjacent scenarios otherwise hand each other a port still draining.
const GW_PORT = 18940;

export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'ban-target', ownId: 'priv-ban-world',
  });
  const base = `http://127.0.0.1:${GW_PORT}/admin/api`;
  try {
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const handle = `banme${tag}`;
    await host.client.cmd(`profile:ban-target@example.com:${handle}`);
    await host.client.waitFor('window.omw.state.profileOk !== undefined', STEP, 'profile answered');
    assert.equal(await host.client.eval('window.omw.state.profileOk'), 'true', 'the player needs a handle');

    // The operator.
    const owner = await fetch(`${base}/setup/owner`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
    });
    assert.equal(owner.status, 200, `owner creation (${owner.status})`);
    const token = (await owner.json()).token;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await fetch(`${base}/setup`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ deploymentMode: 'multiplayer', completed: true }),
    });

    // The player is in their game and connected — the state a ban has to change.
    await host.client.waitFor('window.omw.state.state === "Joined"', STEP, 'the player is in a game');
    const account = host.account;

    // THE BAN, issued the way the dashboard issues it: an action, proxied into the game the
    // player is actually in. The platform cannot ban on its own — the roster lives in the game.
    const banned = await fetch(`${base}/games/${host.ownId}/action`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ kind: 'ban', target: account, detail: 'griefing in world chat' }),
    });
    const banText = await banned.text();
    assert.equal(banned.status, 200,
      `the ban must reach the game through the proxy (${banned.status}): ${banText.slice(0, 200)}`);
    ctx.log(`ok: the operator banned ${account} through the gateway`);

    // 1. THEY LEAVE. A ban that only writes a row is a note to a file while they keep playing.
    await host.client.waitFor('window.omw.state.state !== "Joined"', 60_000,
      'a banned player must actually be removed from the game, not merely recorded');
    ctx.log('ok: the banned player was disconnected');

    // 2. AND THEY STAY OUT. The client has its own retry ladder — it is trying to get back in
    // this whole time, which is what makes this a real test rather than a pause. Its rejoin is
    // refused by the world's auth check, a different decision from the one that removed it.
    //
    // NOT a /auth/password probe: these accounts are created through ?mpauto and have no
    // password, so that call is refused whether or not anyone is banned — it would have passed
    // for the wrong reason and proved nothing.
    await ctx.sleep(20000); // several of the client's own reconnect attempts
    const stillOut = await host.client.eval('window.omw.state.state');
    assert.notEqual(stillOut, 'Joined',
      'a banned player got back in on their own reconnect — the ban removed them but does not'
      + ' keep them out');
    ctx.log(`ok: still out after retrying (state: ${stillOut})`);

    // 3. AND IT IS REVERSIBLE — which is also the CONTROL for step 2. If the client could not
    // reconnect here either, then step 2 proved only that it had stopped trying.
    const unban = await fetch(`${base}/games/${host.ownId}/action`, {
      method: 'POST', headers: auth, body: JSON.stringify({ kind: 'unban', target: account }),
    });
    assert.equal(unban.status, 200, `unban must be accepted (${unban.status})`);
    await host.client.waitFor('window.omw.state.state === "Joined"', 90_000,
      'an unbanned player must get back in on the same retry that was being refused');
    ctx.log('ok: unbanning let them straight back in — which is what makes step 2 mean anything');

    ctx.log('PASS: a ban removes them, keeps them out, and can be undone');
  } finally {
    host.stop();
  }
}
