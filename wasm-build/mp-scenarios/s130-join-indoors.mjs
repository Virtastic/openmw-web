// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s130: YOUR FRIEND IS INDOORS WHEN YOU ACCEPT THEIR INVITE. Friends are usually in a shop, a
// guild, a tomb. Accepting an invite teleports you to the inviter's live cell and pose -- an
// interior NAME, not a grid key -- and the world's peer has to be holding that room already
// (it anchors every occupied cell, interiors as room anchors). The invitee must land in the
// same room, beside the host, with a holder that is neither of them.
// (v1 did this at join, through joinfriend and guestSpawn; both went with OT3-31/58.)
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';
import { befriend, inviteAndAccept } from './_social.mjs';

export const managedPeer = true;
const STEP = 30_000;
const GW_PORT = 19000; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const cellOf = async (c) => String(await c.eval('window.omw.state.cell||""'));
const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));

export default async function run(ctx) {
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'in-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'in-guest', boot: BOOT });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `ihost${tag}`, guestHandle = `iguest${tag}`;
    await host.client.cmd(`profile:in-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:in-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    await befriend(host.client, guest.client, hostHandle, guestHandle, STEP);

    // The host goes indoors FIRST, and their world's peer must already hold the room.
    const outside = await cellOf(host.client);
    await host.client.cmd('door:enter');
    await host.client.waitFor(`String(window.omw.state.cell||"") !== ${JSON.stringify(outside)}`, STEP, 'the host went through a door');
    const room = await cellOf(host.client);
    await host.client.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 300_000, "the host's peer holds the room");
    await host.client.waitFor('window.omw.state.isHolder === "false"', STEP, 'the host does not hold it');
    ctx.log(`host is inside "${room}" (holder=${await host.client.eval('window.omw.state.authorityHolder')})`);

    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, "the guest is in the world");
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined');
    // v2 has no join-at-the-leader's-spot (guestSpawn went with the owner, OT3-31): the way to
    // be beside a friend who is indoors is their invite, accepted.
    await inviteAndAccept(host.client, guest.client, hostHandle, STEP);

    // 1. Same room. 2. Beside the host. 3. The room is simulated for the guest too.
    await guest.client.waitFor(`String(window.omw.state.cell||"") === ${JSON.stringify(room)}`, 120_000, `the guest landed in "${room}" with the host`);
    // THE POSE SETTLES AFTER THE CELL: the two are published separately, and a fast client read
    // the pre-teleport exterior pose the moment the cell flipped (#158: 70655 u, while the peer
    // had already put the body beside the host). Up to 15 s for it; a real misplacement stays off.
    let d = Infinity;
    for (const until = Date.now() + 15_000; Date.now() < until && d >= 600;) {
      const [hp, gp] = [await poseOf(host.client), await poseOf(guest.client)];
      d = Math.hypot(hp.x - gp.x, hp.y - gp.y, hp.z - gp.z);
      if (d >= 600) await ctx.sleep(500);
    }
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
