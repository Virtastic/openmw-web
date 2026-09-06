// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s95: THE WHOLE POINT, end to end — two people in their own games become friends, one opens
// their game, the other joins it, and they are in the same world talking to each other.
//
// Nothing covered this. s63 admitted its guest through the deleted public mode and skips; s57
// covers revival, not company. Every piece was tested on its own — friend requests, the
// Solo/Party flip, JoinFriend authorisation, world switching — and the one thing nobody could
// answer was whether a player can actually reach a friend, which is the product.
//
// It found a real bug the first time it ran: FriendRequestReceived is only pushed to a target
// in the SENDER'S world, and two people each in their own game is the ordinary case, so the
// request was stored and the recipient was never told. The FriendList snapshot carries pending
// requests now (server/src/core/social.ts), and step 2 below is what proves it.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 18860;

export const bootTimeoutMs = 420_000;

const jsonOf = async (c, key, dflt = '[]') =>
  JSON.parse(await c.eval(`window.omw.state.${key}||'${dflt}'`));

export default async function run(ctx) {
  // Two players, two worlds, one gateway — the state everybody is in before they meet.
  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'friend-host', ownId: 'priv-host-world',
  });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'friend-guest', ownId: 'priv-guest-world' });
    const hostName = host.client.name;
    const guestName = guest.client.name;
    ctx.log(`host ${hostName} in ${host.ownId}; guest ${guestName} in ${guest.ownId}`);

    // 0. Both pick a public handle, which is what onboarding makes every real player do and
    // what the panel's "Add a friend by their username" field takes. It matters MECHANICALLY
    // here: a name is resolved cross-process through the shared usernames table, while the
    // account-name fallback (existsNow) only knows what THIS world process has cached — so an
    // account created in another world a moment ago is invisible to it. Two people in their
    // own games is exactly that case, and without a handle the request dies 'no_such_player'.
    const hostHandle = `host${String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6)}`;
    const guestHandle = `guest${String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6)}`;
    await host.client.cmd(`profile:host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:guest@example.com:${guestHandle}`);
    // profileOk, not profileUsername: the username mirror is written from the WELCOME
    // payload, so it only catches up on the next join. ProfileResult is the answer to this
    // request, and profileError says why when it is not ok.
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP,
        `the server answered ${who}'s profile setup`);
      const ok = await cli.eval('window.omw.state.profileOk');
      const why = await cli.eval("window.omw.state.profileError||''");
      assert.equal(ok, 'true', `${who} could not take a public handle: ${why}`);
    }
    ctx.log(`handles: ${hostHandle} / ${guestHandle}`);

    // 1. The host asks, by handle. The guest is in a DIFFERENT world, so nothing can be
    // pushed to them.
    await host.client.waitFor('window.omw.state.friends !== undefined', STEP,
      'the host received an initial FriendList');
    await host.client.cmd(`social:FriendRequest:${guestHandle}`);
    await host.client.waitFor(
      `JSON.parse(window.omw.state.socialResult||'{}').op === 'FriendRequest'`,
      STEP, 'the server answered the request');
    const sent = JSON.parse(await host.client.eval("window.omw.state.socialResult||'{}'"));
    assert.equal(sent.ok, true, `the request was refused: ${JSON.stringify(sent)}`);
    ctx.log(`ok: ${hostName} asked ${guestName} (who is in another world)`);

    // 2. THE ONE THAT WAS BROKEN. The guest must learn about it. The only path is the
    // FriendList snapshot, because the live event cannot cross worlds.
    await guest.client.waitFor(
      `JSON.parse(window.omw.state.friendRequests||'[]').length > 0`,
      STEP, 'the guest sees the pending request (cross-world delivery)');
    const reqs = await jsonOf(guest.client, 'friendRequests');
    assert.equal(reqs[0].name, hostHandle,
      `the request must name the sender by their handle: ${JSON.stringify(reqs)}`);
    ctx.log('ok: the request reached a player in another world');

    // 3. Accept, and both sides agree they are friends.
    await guest.client.cmd(`social:FriendAccept:${hostHandle}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`,
      STEP, 'the guest has the host as a friend');
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`,
      STEP, 'the host has the guest as a friend');
    const hostFriends = await jsonOf(host.client, 'friends');
    assert.equal(hostFriends[0].name, guestHandle);
    // The panel offers "join" only for a friend it believes is online; presence is server-wide,
    // so a friend in their OWN world must read as online here.
    await host.client.waitFor(
      `(JSON.parse(window.omw.state.friends||'[]')[0]||{}).online === true`,
      STEP, 'a friend in their own world reads as online');
    ctx.log('ok: friends, and each sees the other online across worlds');

    // 4. The host opens their game to friends. Solo -> Party is a flip of the SAME world, so
    // nobody travels and the host stays where they are.
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(
      `JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`,
      STEP, 'the server answered the mode flip');
    const flip = JSON.parse(await host.client.eval("window.omw.state.socialResult||'{}'"));
    assert.equal(flip.ok, true, `the flip was refused: ${JSON.stringify(flip)}`);
    ctx.log('ok: the host is playing Party');

    // 5. The guest joins the host. The account key comes off the friend row, exactly as the
    // panel's "join" button reads it — a display name would not do, ids are per-session.
    const guestFriends = await jsonOf(guest.client, 'friends');
    const hostAcct = guestFriends[0].acct;
    assert.ok(hostAcct, `no account key on the friend row: ${JSON.stringify(guestFriends)}`);
    await guest.client.cmd(`joinfriend:${hostAcct}`);

    // The switch is a reconnect: the page redials into the host's world. What proves arrival
    // is the HOST seeing them, not the guest's own optimism.
    //
    // AND IT HAS TO BE THE id, NOT THE NAME. server.ts publishes a PLATFORM-WIDE Players
    // list — a row exists for everyone online anywhere — and stamps an id only on someone
    // this world actually holds. Matching the name alone was already true the moment the
    // guest logged into their OWN game, so this passed before the guest had gone anywhere
    // and the chat below then went out in the world they were leaving. The roster carries
    // USERNAMES (displayName resolves the public handle), so the name is the handle, not
    // the harness client name.
    const guestRow =
      `(JSON.parse(window.omw.state.players || '[]')
        .find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`,
      120_000, "the guest arrived in the host's world");
    ctx.log(`ok: ${guestHandle} is in ${hostHandle}'s world`);

    // 6. And they can talk, which is the thing they came for. World chat reaches everyone in
    // the world; if the guest were still in their own world this could not arrive.
    const nonce = 'hi-' + Math.random().toString(36).slice(2, 8);
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000,
      'the guest is joined after the switch');
    await guest.client.cmd(`chatx:party::${nonce}`);
    await host.client.waitFor(
      `(window.omw.state.chatLog||'').includes(${JSON.stringify(nonce)})`,
      STEP, 'the host heard the guest');
    ctx.log('ok: they can talk to each other');
    ctx.log('PASS: two players, one world, by way of the friend list');
  } finally {
    host.stop();
  }
}
