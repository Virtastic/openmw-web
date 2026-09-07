// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s97: BLOCKING SOMEONE SHUTS THE DOOR, not just the chat window.
//
// A party world admits the owner's FRIENDS — mayJoinWorld asks areFriends and nothing else.
// So "blocked" only keeps somebody out if blocking actually ends the friendship. It does
// (social.ts block() calls removeFriend, with a comment explaining that a blocked person left
// in the list keeps leaking presence and location), and that is a load-bearing detail no test
// stated: change block() to a mute-like flag and every blocked player walks back into the
// world they were thrown out of, with the friends list still showing them gone.
//
// Two people, two worlds, the real panel commands throughout.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 18867;

export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'block-host', ownId: 'priv-block-host',
  });
  try {
    const guest = await addClient(ctx, GW_PORT, {
      name: 'block-guest', ownId: 'priv-block-guest',
    });

    // Handles, because that is what the panel's "add a friend" field takes and what a name
    // resolves through across processes.
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `bhost${tag}`;
    const guestHandle = `bguest${tag}`;
    await host.client.cmd(`profile:block-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:block-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }

    // Become friends, the ordinary way.
    await host.client.cmd(`social:FriendRequest:${guestHandle}`);
    await guest.client.waitFor(
      `JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP,
      'the guest sees the request');
    await guest.client.cmd(`social:FriendAccept:${hostHandle}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP,
      'the host has a friend');
    ctx.log('ok: they are friends');

    // The host opens the door and the guest walks in — the baseline this scenario needs, or
    // the refusal below would prove nothing.
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(
      `JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP,
      'the mode flip is answered');
    const guestFriends = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"));
    const hostAcct = guestFriends[0].acct;
    await guest.client.cmd(`joinfriend:${hostAcct}`);
    // joinFriendTo is set ONLY when the server said yes and the client is redialling, so it is
    // the one signal that separates "allowed" from "refused". (The refusal text lives in a Lua
    // local the panel renders and never mirrors, so there is nothing else to read.)
    await guest.client.waitFor(`(window.omw.state.joinFriendTo||'') !== ''`, STEP,
      'the server allowed the join while they were friends');
    const guestRow =
      `(JSON.parse(window.omw.state.players || '[]')
        .find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 120_000,
      "the guest is in the host's world before any block");
    ctx.log('ok: the guest got in while welcome — the control this scenario needs');

    // NOW BLOCK THEM.
    await host.client.cmd(`social:BlockAdd:${guestHandle}`);
    await host.client.waitFor(
      `JSON.parse(window.omw.state.socialResult||'{}').op === 'BlockAdd'`, STEP,
      'the block is answered');
    const res = JSON.parse(await host.client.eval("window.omw.state.socialResult||'{}'"));
    assert.equal(res.ok, true, `the block was refused: ${JSON.stringify(res)}`);

    // The friendship must be GONE, both sides. This is the part the door depends on.
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 0`, STEP,
      'blocking removes them from the friends list');
    await guest.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 0`, STEP,
      'and from theirs — a block the other side cannot see is a block that leaks presence');
    const blocked = JSON.parse(await host.client.eval("window.omw.state.blocked||'[]'"));
    assert.equal(blocked.length, 1, `the blocked list must name them: ${JSON.stringify(blocked)}`);
    ctx.log('ok: blocking ended the friendship on both sides');

    // And the door is shut. Asked the same way, by the same client, with the same account key
    // it used a moment ago when it worked — only the friendship has changed.
    //
    // Cleared first so this cannot pass on the LAST join's leftover value: joinFriendTo is
    // only ever written on success, so an empty one after a full round trip is the refusal.
    await guest.client.eval("window.omw.state.joinFriendTo = ''; 'cleared'");
    await guest.client.cmd(`joinfriend:${hostAcct}`);
    await ctx.sleep(8000); // a bounded wait: there is no positive signal for "no"
    const after = await guest.client.eval("window.omw.state.joinFriendTo||''");
    assert.equal(after, '',
      `a blocked player was told where to dial: ${after} — the block did not shut the door`);
    ctx.log('ok: the door is shut, not just the chat window');
    ctx.log('PASS: a block ends the friendship and the world stops admitting them');
  } finally {
    host.stop();
  }
}
