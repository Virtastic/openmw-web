// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s131: YOU DIE WHILE VISITING. Death and respawn (s22) in the world you were invited to:
// the guest must come back to life IN THE HOST'S WORLD -- moved to that world's respawn
// point, health restored, still a guest the host can see -- and not be bounced home or left
// on a dead socket. Dying is the most ordinary thing that happens to a helper.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19010; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'die-host', ownId: 'priv-die-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'die-guest', ownId: 'priv-die-guest' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `dhost${tag}`, guestHandle = `dguest${tag}`;
    await host.client.cmd(`profile:die-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:die-guest@example.com:${guestHandle}`);
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
    await host.client.waitFor(`${guestRow}.id !== undefined`, 120_000, "the guest is inside the host's world");
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(guest.client, GW_PORT, guest.account);
    const worldUrl = String(await guest.client.eval('String(window.omw.state.publicStage||"")'));
    ctx.log("ok: the guest is in the host's world");

    // Walk away from the spawn point first (the guest is placed beside the host, who stands on
    // it), or the respawn is a move of zero units and proves nothing -- s22's lesson.
    await guest.client.waitFor('Number(window.omw.state.hp||"0") > 0', STEP, 'the guest has health');
    const at = await poseOf(guest.client);
    await guest.client.cmd(`snapto:${Math.round(at.x + 900)},${Math.round(at.y)},${Math.round(at.z + 8)}`);
    await ctx.sleep(3_000);
    const before = await poseOf(guest.client);
    assert.ok(Math.hypot(before.x - at.x, before.y - at.y) > 500, 'the guest did not step away from the spawn point');
    await guest.client.cmd('sethp:0');
    // Respawn: moved, alive again, and STILL in the host's world with the host watching.
    let pose = before;
    const by = Date.now() + 90_000;
    while (Date.now() < by) {
      pose = await poseOf(guest.client);
      if (pose && Math.hypot(pose.x - before.x, pose.y - before.y) > 300) break;
      await ctx.sleep(500);
    }
    assert.ok(pose && Math.hypot(pose.x - before.x, pose.y - before.y) > 300, 'the guest never respawned (no move to the respawn point)');
    await guest.client.waitFor('Number(window.omw.state.hp||"0") > 0', 15_000, 'health restored after the respawn');
    assert.equal(await guest.client.eval('window.omw.state.state'), 'Joined', 'the guest must still be connected after dying');
    assert.equal(await guest.client.eval('String(window.omw.state.worldClosed||"")'), '', 'dying must not send the guest home');
    await host.client.waitFor(`${guestRow}.id !== undefined`, STEP, "the host still sees the guest after the respawn");
    ctx.log(`PASS: the guest died and respawned inside the host's world (${Math.round(Math.hypot(pose.x - before.x, pose.y - before.y))} units away), still a guest the host can see`);
  } finally {
    host.stop();
  }
}
