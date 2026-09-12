// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s133: FOLLOW YOUR FRIEND THROUGH A DOOR. The leader walks into a building; you follow. In
// the host world, through the real join, both must end up in the same interior, each seeing
// the other there, with the room held by the world peer. s117 proved this with a companion
// in a symmetric world; this is the two-player version through the door of a friend world.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

export const managedPeer = true;
const STEP = 30_000;
const GW_PORT = 19030; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const cellOf = async (c) => String(await c.eval('window.omw.state.cell||""'));

export default async function run(ctx) {
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'door-host', ownId: 'priv-door-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'door-guest', ownId: 'priv-door-guest', boot: BOOT });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `ohost${tag}`, guestHandle = `oguest${tag}`;
    await host.client.cmd(`profile:door-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:door-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    await host.client.cmd(`social:FriendRequest:${guestHandle}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await guest.client.cmd(`social:FriendAccept:${hostHandle}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    const guestFriends = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"));
    await guest.client.cmd(`joinfriend:${guestFriends[0].acct}`);
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    const hostRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(hostHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, "the guest is inside the host world");
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(guest.client, GW_PORT, guest.account);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, `${who} puppets the cell (the peer holds it)`);
    }
    const outside = await cellOf(host.client);
    ctx.log(`ok: both outside in "${outside}"`);

    // The leader goes in; the friend follows through the same door.
    await host.client.cmd('door:enter');
    await host.client.waitFor(`String(window.omw.state.cell||"") !== ${JSON.stringify(outside)}`, STEP, 'the host went through the door');
    const room = await cellOf(host.client);
    await guest.client.cmd('door:enter');
    await guest.client.waitFor(`String(window.omw.state.cell||"") === ${JSON.stringify(room)}`, STEP, `the guest followed into "${room}"`);
    // Each sees the other in there, and the room is held by the world peer for both.
    await host.client.waitFor(`${guestRow}.id !== undefined`, STEP, 'the host still sees the guest inside');
    await guest.client.waitFor(`${hostRow}.id !== undefined`, STEP, 'the guest sees the host inside');
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 120_000, `${who}: the room has a holder`);
      await cli.waitFor('window.omw.state.isHolder === "false"', STEP, `${who} does not hold it`);
    }
    ctx.log(`PASS: the guest followed the host into "${room}"; both see each other and the room is simulated`);
  } finally {
    host.stop();
  }
}
