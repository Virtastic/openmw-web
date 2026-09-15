// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s154: A RETURNING GUEST LANDS BESIDE THE HOST, AND STAYS THERE. Every character doc has a
// position (this world's, or the most recent anywhere), and a fresh join sends both the rejoin
// restore (to that stored spot) and the invite (to the host). Both teleports queued; then the
// rejoin position hold re-asserted the stored spot for eight seconds -- so a guest who came
// back to help was put next to the host for a frame and teleported to wherever they last
// logged out, unless they happened to press a key. The invite is where they meant to go.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19150; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 480_000;
const pose = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));
const dist2 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

export default async function run(ctx) {
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'ret-host', ownId: 'priv-ret-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'ret-guest', ownId: 'priv-ret-guest', boot: BOOT });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const H = `rhost${tag}`, G = `rguest${tag}`;
    await host.client.cmd(`profile:ret-host@example.com:${H}`);
    await guest.client.cmd(`profile:ret-guest@example.com:${G}`);
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
    const friendAcct = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"))[0].acct;
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(G)}; }) || {})`;
    const hostRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(H)}; }) || {})`;

    const joinFriend = async (cli, what) => {
      await cli.cmd(`joinfriend:${friendAcct}`);
      await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, `the host sees the guest ${what}`);
      await cli.waitFor('window.omw.state.state === "Joined"', 60_000, `the guest is joined ${what}`);
      await grantLockerSession(cli, GW_PORT, guest.account);
    };
    await joinFriend(guest.client, 'the first time');
    await guest.client.waitFor('String(window.omw.state.baselineReady||"") === "1"', 60_000, 'the guest is settled');
    // The guest wanders far from the host, so their stored position is nowhere near them.
    await guest.client.cmd('walk:0,1,6000:run');
    await ctx.sleep(8_000);
    const far = await pose(guest.client);
    const hostAt = await pose(host.client);
    ctx.log(`the guest walked to ${far.x.toFixed(0)},${far.y.toFixed(0)}; the host is at ${hostAt.x.toFixed(0)},${hostAt.y.toFixed(0)} (${dist2(far, hostAt).toFixed(0)} apart)`);
    assert.ok(dist2(far, hostAt) > 400, 'the guest must be well away from the host before leaving (walk hook / terrain)');
    guest.client.close(); // logout flushes the doc with that far spot
    await host.client.waitFor(`${guestRow}.id === undefined`, 120_000, 'the host sees the guest leave');

    // Back, straight to the friend. The stored position is 'far'; the invite is the host.
    const ownUrl = `ws://127.0.0.1:${GW_PORT}/w/${guest.ownId}`;
    const back = await ctx.launchClient('ret-guest', '', { mpUrl: ownUrl, homeUrl: ownUrl, ...BOOT }); // same name = same account
    await grantLockerSession(back, GW_PORT, guest.account);
    await back.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is home');
    await joinFriend(back, 'again');
    // Touch nothing for twelve seconds (past the 8 s restore hold) and watch where they are.
    const samples = [];
    for (let i = 0; i < 12; i++) {
      await ctx.sleep(1_000);
      const p = await pose(back);
      const h = JSON.parse(await back.eval(`JSON.stringify(${hostRow})`));
      samples.push(p ? dist2(p, hostAt).toFixed(0) : '?');
      if (i === 11) ctx.log(`distance to the host's spot over 12 s: ${samples.join(' ')}; host row seen=${h.id !== undefined}`);
    }
    const last = Number(samples[samples.length - 1]);
    assert.ok(last < 400, `the returning guest ended ${last} units from the host: the rejoin position hold pulled them back to where they logged out`);
    assert.equal(await host.client.eval(`${guestRow}.id !== undefined`), true, 'the host must see the returning guest');
    ctx.log('PASS: a returning guest joined straight to the host and stayed beside them');
  } finally {
    host.stop();
  }
}
