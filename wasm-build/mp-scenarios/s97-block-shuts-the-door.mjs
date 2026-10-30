// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s97: BLOCKING SOMEONE SHUTS THE DOOR, not just the chat window.
//
// v2 (no party worlds, OT3-31): invites are friends-only. So "blocked" only keeps somebody
// from being invited or located if blocking actually ends the friendship. It does
// (social.ts block() calls removeFriend, with a comment explaining that a blocked person left
// in the list keeps leaking presence and location), and that is a load-bearing detail no test
// stated: change block() to a mute-like flag and every blocked player walks back into the
// world they were thrown out of, with the friends list still showing them gone.
//
// Two people, two worlds, the real panel commands throughout.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

const STEP = 30_000;
// Spaced ten apart from its neighbours on purpose: the gateway puts each world it
// spawns on GW_PORT + 200 upward, one per client, so adjacent scenarios were handing
// each other a port the previous run had not finished draining — which surfaces as
// "the player own world must come up" and looks exactly like a broken product.
const GW_PORT = 18890;

export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'block-host',
  });
  try {
    const guest = await addClient(ctx, GW_PORT, {
      name: 'block-guest',
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

    // The control: while they are friends the host CAN invite the guest, or the refusal below
    // would prove nothing. (v1 used joinfriend into the host's party world; that door is gone.)
    const guestFriends = JSON.parse(await host.client.eval("window.omw.state.friends||'[]'"));
    const guestAcct = guestFriends[0].acct;
    const invite = async () => {
      await host.client.eval("window.omw.state.socialResult = ''; 'cleared'");
      await host.client.cmd(`social:InviteSend:${guestAcct}`);
      await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'InviteSend'`, STEP, 'the invite is answered');
      return JSON.parse(await host.client.eval("window.omw.state.socialResult||'{}'"));
    };
    const first = await invite();
    assert.equal(first.ok, true, `a friend must be invitable before any block: ${JSON.stringify(first)}`);
    ctx.log('ok: while welcome, the guest could be invited -- the control this scenario needs');

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
    // And the door is shut. Asked the same way, by the same client, about the same account it
    // invited a moment ago -- only the friendship has changed.
    const after = await invite();
    assert.equal(after.ok, false, `a blocked player could still be invited: ${JSON.stringify(after)}`);
    ctx.log(`ok: the invite is refused after the block (${after.detail})`);
    ctx.log('PASS: a block ends the friendship and invites to them stop');
  } finally {
    host.stop();
  }
}
