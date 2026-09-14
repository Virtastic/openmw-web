// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s142: JOIN A FRIEND STRAIGHT FROM THE LAUNCHER. A drop-in used to be two full boots: your own
// world first, then the social panel, then a second reload into the friend's. The launcher now
// asks the gateway who is playing (/auth/friends-playing) and boots ONCE, dialling the friend's
// world with your own as mphome. This is that boot, cold: befriend, close the tab, come back
// later dialling the friend directly -- and land beside them, a guest, with the way home intact.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession, harnessSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19100; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const rowOf = (handle) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(handle)}; }) || {})`;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'lj-host', ownId: 'priv-lj-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'lj-guest', ownId: 'priv-lj-guest' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const H = `ljhost${tag}`, G = `ljguest${tag}`;
    await host.client.cmd(`profile:lj-host@example.com:${H}`);
    await guest.client.cmd(`profile:lj-guest@example.com:${G}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    await host.client.cmd(`social:FriendRequest:${G}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await guest.client.cmd(`social:FriendAccept:${H}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');

    // The guest closes their tab. Later, at the launcher, the gateway says who is playing.
    guest.client.close();
    await ctx.sleep(3_000);
    const token = await harnessSession(GW_PORT, guest.account);
    let playing = [];
    for (const by = Date.now() + STEP; Date.now() < by && playing.length === 0;) {
      const r = await fetch(`http://127.0.0.1:${GW_PORT}/auth/friends-playing`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(r.status, 200, 'the launcher can ask who is playing');
      playing = (await r.json()).friends || [];
      if (playing.length === 0) await ctx.sleep(1_000);
    }
    ctx.log(`friends playing: ${JSON.stringify(playing)}`);
    assert.equal(playing.length, 1, "the host's open, occupied world is listed for the friend");
    assert.equal(playing[0].name, H);
    assert.equal(playing[0].wsPath, '/w/priv-lj-host');

    // One boot, straight there: mp = the friend's world, mphome = our own.
    const back = await addClient(ctx, GW_PORT, { name: 'lj-guest', ownId: 'priv-lj-guest', dial: `ws://127.0.0.1:${GW_PORT}/w/priv-lj-host` });
    await back.client.waitFor('window.omw.state.state === "Joined"', 120_000, 'the guest is joined on the first dial');
    await host.client.waitFor(`${rowOf(G)}.id !== undefined`, STEP, 'the host sees the guest arrive');
    await back.client.waitFor(`String(window.omw.state.worldHost||"") === ${JSON.stringify(H)} && String(window.omw.state.amHost||"") === "false"`, STEP, 'the guest knows whose world this is');
    // Beside the host, not at a default spawn.
    const hostPose = JSON.parse(await host.client.eval('window.omw.state.pose||"{}"'));
    const guestPose = JSON.parse(await back.client.eval('window.omw.state.pose||"{}"'));
    const gap = Math.hypot(hostPose.x - guestPose.x, hostPose.y - guestPose.y);
    ctx.log(`landed ${gap.toFixed(0)} units from the host`);
    assert.ok(gap < 600, `the guest did not land beside the host (${gap.toFixed(0)} units)`);
    // And the way home still works: the host goes solo, the guest lands in their own world.
    await grantLockerSession(back.client, GW_PORT, back.account);
    await host.client.cmd('worldmode:private');
    await back.client.waitFor('window.omw.state.state === "Joined" && String(window.omw.state.dialTarget||"").indexOf("priv-lj-guest") >= 0', 300_000, 'the guest is home after the host closed up');
    ctx.log('PASS: joined a friend in one boot from the launcher, landed beside them, and the way home held');
  } finally {
    host.stop();
  }
}
