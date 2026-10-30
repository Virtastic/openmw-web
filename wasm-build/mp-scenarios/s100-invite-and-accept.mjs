// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s100: "COME JOIN ME" -- THE INVITE, SENT, RECEIVED AND ACCEPTED.
// Invites live in the shared store so they survive the sender and reach the target wherever
// they are. Accepting one teleports you to the inviter's live coordinates. v1 also had to cross
// worlds (accepting was a world switch); there is one world now (OT3-31, OT3-58), so this
// drives the whole thing through the panel's commands: invite, receive, accept, arrive beside
// them after the host has walked somewhere else.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';
import { befriend, inviteAndAccept } from './_social.mjs';

const STEP = 30_000;
const GW_PORT = 18900;
export const bootTimeoutMs = 420_000;
const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'inv-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'inv-guest' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `ihost${tag}`;
    const guestHandle = `iguest${tag}`;
    await host.client.cmd(`profile:inv-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:inv-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    // Friends first: an invite from a stranger is refused.
    await befriend(host.client, guest.client, hostHandle, guestHandle, STEP);
    await host.client.waitFor('window.omw.state.pose && window.omw.state.pose !== "null"', STEP, 'the host has a pose');
    await guest.client.waitFor('window.omw.state.pose && window.omw.state.pose !== "null"', STEP, 'the guest has a pose');

    // The host walks off, so the invite has somewhere to bring the guest.
    const hp = await poseOf(host.client);
    await host.client.cmd(`snapto:${Math.round(hp.x + 3000)},${Math.round(hp.y)},${Math.round(hp.z + 200)}`);
    await ctx.sleep(4_000);
    const hostAt = await poseOf(host.client);
    const before = await poseOf(guest.client);
    assert.ok(Math.hypot(hostAt.x - before.x, hostAt.y - before.y) > 1500, 'the host must be well away from the guest first');

    const card = await inviteAndAccept(host.client, guest.client, hostHandle, STEP);
    ctx.log(`ok: the invite arrived and names ${card.name}`);

    // THEY ACTUALLY ARRIVE: beside the host's spot.
    let d = Infinity;
    for (const until = Date.now() + 30_000; Date.now() < until && d > 1000;) {
      const g = await poseOf(guest.client);
      const h = await poseOf(host.client);
      d = Math.hypot(g.x - h.x, g.y - h.y);
      if (d > 1000) await ctx.sleep(1000);
    }
    assert.ok(d <= 1000, `accepting the invite left the guest ${Math.round(d)} units from the host`);
    ctx.log(`PASS: an invite is delivered and accepting it brings the guest to the host (${Math.round(d)} units)`);
  } finally {
    host.stop();
  }
}
