// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s100: "COME JOIN ME" ACROSS WORLDS — the other half of the invite.
//
// Invites are stored in the shared table precisely so they can reach somebody who is not in
// your world (drainInvites hands them over on join). Accepting one, though, only ever meant
// "teleport to the inviter's live coordinates" — which no other world process can supply. So
// every invite that actually needed to cross a world was answered not_online and the card sat
// there refusing to be accepted: delivered, readable, and inert.
//
// Accepting from elsewhere is the world switch now, with joinFriend's own checks inside it.
// This drives the whole thing through the panel's commands: invite, receive in another world,
// accept, arrive.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

const STEP = 30_000;
// Spaced ten apart from its neighbours on purpose: the gateway puts each world it
// spawns on GW_PORT + 200 upward, one per client, so adjacent scenarios were handing
// each other a port the previous run had not finished draining — which surfaces as
// "the player own world must come up" and looks exactly like a broken product.
const GW_PORT = 18900;

export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'inv-host', ownId: 'priv-inv-host',
  });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'inv-guest', ownId: 'priv-inv-guest' });

    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `ihost${tag}`;
    const guestHandle = `iguest${tag}`;
    await host.client.cmd(`profile:inv-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:inv-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }

    // Friends first: joinFriend authorises the switch, and an invite from a stranger must not
    // become a way around that.
    await host.client.cmd(`social:FriendRequest:${guestHandle}`);
    await guest.client.waitFor(
      `JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP,
      'the request crossed worlds');
    await guest.client.cmd(`social:FriendAccept:${hostHandle}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP,
      'they are friends');

    // The host opens their game and invites — the guest is in their OWN world, which is where
    // everybody is before they go anywhere together.
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(
      `JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP,
      'the mode flip is answered');
    const hostFriends = JSON.parse(await host.client.eval("window.omw.state.friends||'[]'"));
    const guestAcct = hostFriends[0].acct;
    await host.client.cmd(`social:InviteSend:${guestAcct}`);
    await host.client.waitFor(
      `JSON.parse(window.omw.state.socialResult||'{}').op === 'InviteSend'`, STEP,
      'the invite is answered');
    const sent = JSON.parse(await host.client.eval("window.omw.state.socialResult||'{}'"));
    assert.equal(sent.ok, true, `the invite was refused: ${JSON.stringify(sent)}`);

    // 1. IT ARRIVES, in a different world.
    await guest.client.waitFor(`JSON.parse(window.omw.state.invites||'[]').length > 0`, STEP,
      'the invite reached a player in another world');
    const invites = JSON.parse(await guest.client.eval("window.omw.state.invites||'[]'"));
    assert.equal(invites[0].name, hostHandle,
      `the card must name the inviter by handle: ${JSON.stringify(invites)}`);
    ctx.log('ok: the invite reached a player in another world, named correctly');

    // 2. AND IT CAN BE ACCEPTED. This is what answered not_online: no process here knows where
    // the inviter is standing, because they are not here.
    await guest.client.eval("window.omw.state.joinFriendTo = ''; window.omw.state.socialResult = ''; 'cleared'");
    await guest.client.cmd(`social:InviteAccept:${invites[0].acct}`);
    // Either it starts the switch, or the server refuses and SAYS why. Waiting only for the
    // success signal made a refusal look like a hang, with the reason sitting unread.
    await guest.client.waitFor(
      `(window.omw.state.joinFriendTo||'') !== ''`
      + ` || JSON.parse(window.omw.state.socialResult||'{}').op === 'InviteAccept'`,
      STEP, 'the server answered the accept');
    const went = await guest.client.eval("window.omw.state.joinFriendTo||''");
    const why = await guest.client.eval("window.omw.state.socialResult||'{}'");
    assert.notEqual(went, '',
      `accepting an invite from another world was refused instead of starting the switch: ${why}`);
    ctx.log('ok: accepting routed to the world switch');

    // 3. AND THEY ACTUALLY ARRIVE. Proven from the HOST's roster, where an `id` is stamped
    // only for someone this world is really holding.
    const guestRow =
      `(JSON.parse(window.omw.state.players || '[]')
        .find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 120_000,
      "the guest arrived in the host's world");
    ctx.log(`ok: ${guestHandle} came when invited`);
    ctx.log('PASS: an invite crosses worlds and can be accepted');
  } finally {
    host.stop();
  }
}
