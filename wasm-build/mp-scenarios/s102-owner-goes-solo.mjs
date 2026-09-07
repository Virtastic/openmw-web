// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s102: CLOSING YOUR GAME CLOSES IT — on the guests who are already inside.
//
// mayJoinWorld gates ARRIVAL only. Flipping Party back to Solo therefore shut the door and
// left every guest standing in the room: the host believed they were alone, the panel said
// Solo, and somebody else was still walking around their world. server.ts closes to guests on
// the flip for exactly that reason, and this is the only test that watches it happen to a real
// second browser rather than to a mock roster.
//
// It also covers the notice, which matters more than it looks: a guest who is simply
// disconnected sees a network error and retries forever. WorldClosed is what tells them their
// host closed up, so the client goes home instead of hammering a door that is now shut.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

const STEP = 30_000;
// Spaced ten apart from its neighbours on purpose: the gateway puts each world it
// spawns on GW_PORT + 200 upward, one per client, so adjacent scenarios were handing
// each other a port the previous run had not finished draining — which surfaces as
// "the player own world must come up" and looks exactly like a broken product.
const GW_PORT = 18920;

export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'solo-host', ownId: 'priv-solo-host',
  });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'solo-guest', ownId: 'priv-solo-guest' });

    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `shost${tag}`;
    const guestHandle = `sguest${tag}`;
    await host.client.cmd(`profile:solo-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:solo-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }

    await host.client.cmd(`social:FriendRequest:${guestHandle}`);
    await guest.client.waitFor(
      `JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await guest.client.cmd(`social:FriendAccept:${hostHandle}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP,
      'they are friends');

    // Open, and let the guest in.
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(
      `JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP,
      'the flip to party is answered');
    const guestFriends = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"));
    await guest.client.cmd(`joinfriend:${guestFriends[0].acct}`);
    const guestRow =
      `(JSON.parse(window.omw.state.players || '[]')
        .find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 120_000,
      "the guest is inside the host's world");
    ctx.log('ok: the guest is in, which is what makes the close meaningful');

    // THE HOST CLOSES UP.
    await host.client.cmd('worldmode:private');
    await host.client.waitFor(
      `JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP,
      'the flip back to solo is answered');

    // 1. The guest is TOLD, rather than just dropped. Without this their client cannot tell a
    // closed world from a broken network, and retries into a door that will not open.
    await guest.client.waitFor(`(window.omw.state.worldClosed||'') !== ''`, STEP,
      'the guest is told the world closed, not merely disconnected');
    const why = await guest.client.eval("window.omw.state.worldClosed||''");
    const by = await guest.client.eval("window.omw.state.worldClosedBy||''");
    ctx.log(`ok: the guest was told: ${why} (by ${by || 'the host'})`);
    assert.ok(!by.includes('@'),
      `the notice must name the host's CHARACTER, never an account address: ${by}`);

    // 2. And they actually leave: the host ends up alone in the world they just closed.
    await host.client.waitFor(`${guestRow}.id === undefined`, 60_000,
      'the guest is gone from the world, not merely told about it');
    ctx.log('ok: the host is alone again');
    ctx.log('PASS: going Solo closes the world on the guests already inside it');
  } finally {
    host.stop();
  }
}
