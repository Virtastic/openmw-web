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
// The third is the one worth the scenario, and it needs a FRESH attempt to mean anything. A
// client that has been refused reaches a terminal state and stops retrying — correct, since a
// banned player should not hammer the door, but it makes "still disconnected a minute later"
// worthless as evidence: a client that had simply died would look identical. So the ban is
// tested against a real page reload, which is what a player does, and the unban is the control:
// same client, same account, same reload, and the only thing that changed is the ban.
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

    // 2. AND THEY STAY OUT. A fresh attempt, not a wait: the client reaches a TERMINAL state
    // after an auth rejection and stops retrying, which is right — a banned player should not
    // hammer the door — but it means "still disconnected" a minute later says nothing at all.
    // The reload is a real re-auth through the front door, the same one a player makes by
    // opening the page again, and it is the thing a ban has to survive.
    const reload = async (what, timeoutMs) => {
      await host.client.eval('setTimeout(function(){ location.reload(); }, 50); 1');
      await ctx.sleep(2000);
      return host.client.waitFor(
        'window.omw.state.state === "Joined" || window.omw.state.state === "Failed"',
        timeoutMs, what);
    };
    await reload('the banned player finished a fresh attempt', 180_000);
    const afterBan = await host.client.eval('window.omw.state.state');
    assert.notEqual(afterBan, 'Joined',
      'a banned player signed straight back in on a fresh page load — the ban removed them but'
      + ' does not keep them out');
    ctx.log(`ok: a fresh attempt is refused while banned (state: ${afterBan})`);

    // 3. AND IT IS REVERSIBLE — the CONTROL for step 2. Same client, same account, same reload:
    // the only thing that changed is the ban. Without this, step 2 would be satisfied by a
    // client that simply cannot connect for any reason at all.
    const unban = await fetch(`${base}/games/${host.ownId}/action`, {
      method: 'POST', headers: auth, body: JSON.stringify({ kind: 'unban', target: account }),
    });
    assert.equal(unban.status, 200, `unban must be accepted (${unban.status})`);
    await reload('the unbanned player finished a fresh attempt', 180_000);
    const afterUnban = await host.client.eval('window.omw.state.state');
    assert.equal(afterUnban, 'Joined',
      `an unbanned player must be able to come back, got ${afterUnban} — if this cannot connect`
      + ' either, the refusal above proved nothing about the ban');
    ctx.log('ok: unbanning let them back in — which is what makes the refusal above mean anything');

    ctx.log('PASS: a ban removes them, keeps them out, and can be undone');
  } finally {
    host.stop();
  }
}
