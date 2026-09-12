// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s130: YOUR FRIEND IS INDOORS WHEN YOU JOIN. Hosts are usually in a shop, a guild, a tomb.
// The server places a joining guest at the leader's live cell and pose (server.ts guestSpawn)
// -- an interior NAME, not a grid key -- and the world's peer has to be holding that room
// already (it anchors every occupied cell, interiors as room anchors). The guest must land in
// the same room, beside the host, with a holder that is neither of them.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

export const managedPeer = true;
const STEP = 30_000;
const GW_PORT = 19000; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const cellOf = async (c) => String(await c.eval('window.omw.state.cell||""'));
const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));

export default async function run(ctx) {
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'in-host', ownId: 'priv-in-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'in-guest', ownId: 'priv-in-guest', boot: BOOT });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `ihost${tag}`, guestHandle = `iguest${tag}`;
    await host.client.cmd(`profile:in-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:in-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    await host.client.cmd(`social:FriendRequest:${guestHandle}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await guest.client.cmd(`social:FriendAccept:${hostHandle}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');

    // The host goes indoors FIRST, and their world's peer must already hold the room.
    const outside = await cellOf(host.client);
    await host.client.cmd('door:enter');
    await host.client.waitFor(`String(window.omw.state.cell||"") !== ${JSON.stringify(outside)}`, STEP, 'the host went through a door');
    const room = await cellOf(host.client);
    await host.client.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 300_000, "the host's peer holds the room");
    await host.client.waitFor('window.omw.state.isHolder === "false"', STEP, 'the host does not hold it');
    ctx.log(`host is inside "${room}" (holder=${await host.client.eval('window.omw.state.authorityHolder')})`);

    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    const guestFriends = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"));
    await guest.client.cmd(`joinfriend:${guestFriends[0].acct}`);
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, "the guest is inside the host's world");
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(guest.client, GW_PORT, guest.account);

    // 1. Same room. 2. Beside the host. 3. The room is simulated for the guest too.
    await guest.client.waitFor(`String(window.omw.state.cell||"") === ${JSON.stringify(room)}`, 120_000, `the guest landed in "${room}" with the host`);
    const [hp, gp] = [await poseOf(host.client), await poseOf(guest.client)];
    const d = Math.hypot(hp.x - gp.x, hp.y - gp.y, hp.z - gp.z);
    ctx.log(`guest landed in "${await cellOf(guest.client)}", ${Math.round(d)} units from the host`);
    assert.ok(d < 600, `the guest landed in the right room but ${Math.round(d)} units from the host`);
    await guest.client.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 120_000, 'the room has a holder from the guest\'s side');
    await guest.client.waitFor('window.omw.state.isHolder === "false"', STEP, 'the guest does not hold it');
    await guest.client.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the guest puppets the room\'s actors');
    ctx.log(`PASS: joined a friend who was indoors -- same room, beside them, simulated (holder=${await guest.client.eval('window.omw.state.authorityHolder')})`);
  } finally {
    host.stop();
  }
}
