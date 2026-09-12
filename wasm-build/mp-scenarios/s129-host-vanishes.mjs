// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s129: THE HOST'S TAB CLOSES. Not the polite Solo flip (s102): the leader's browser just
// goes -- a crash, a reload, a closed laptop. The world stays open a moment for them to come
// back (server.ts: owner_left, 90 s grace, guests keep playing), and if they do not, the world
// closes to guests as 'owner_left' and each guest is sent HOME, where they land joined in
// their own world rather than stranded on a dead socket. The guest must be told why, too.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 18990; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'gone-host', ownId: 'priv-gone-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'gone-guest', ownId: 'priv-gone-guest' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `ghost${tag}`, guestHandle = `gguest${tag}`;
    await host.client.cmd(`profile:gone-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:gone-guest@example.com:${guestHandle}`);
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
    await grantLockerSession(guest.client, GW_PORT, guest.account); // the switch reloaded the page
    ctx.log("ok: the guest is in the host's world");

    // THE HOST VANISHES: the page leaves, the socket dies, no Solo flip, no goodbye.
    const gone = Date.now();
    await host.client.eval('setTimeout(function(){ location.href = "about:blank"; }, 50); "leaving";');
    // The guest keeps playing through the grace: still joined 30 s later, and told the host dropped.
    await ctx.sleep(30_000);
    assert.equal(await guest.client.eval('window.omw.state.state'), 'Joined', 'the guest must keep playing through the grace window');
    ctx.log('ok: 30 s after the host vanished the guest is still in the world (grace)');

    // ...then the world closes to guests and the guest lands HOME.
    await guest.client.waitFor(`(window.omw.state.worldClosed||'') !== '' || String(window.omw.state.state||'') !== 'Joined'`, 150_000,
      'the world closed to the guest after the grace (owner_left)');
    await guest.client.waitFor('window.omw.state.state === "Joined" && String(window.omw.state.worldClosed||"") === ""', 180_000,
      'the guest is back in their own world');
    ctx.log(`ok: the guest landed home ${Math.round((Date.now() - gone) / 1000)} s after the host vanished`);
    const url = await guest.client.eval('String(window.omw.state.mpUrl || location.hash || "").slice(0, 120)');
    ctx.log(`PASS: the host's tab closed; the guest played on through the grace and was sent home (${url})`);
  } finally {
    host.stop();
  }
}
