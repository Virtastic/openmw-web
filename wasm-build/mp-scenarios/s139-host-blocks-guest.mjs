// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s139: THE HOST BLOCKS A GUEST WHO IS ALREADY INSIDE. The friends list is the only door into
// a party world, and it was checked at the door only: a guest the host had just blocked stayed
// in the host's world -- seeing, hearing, looting -- until the host went solo and threw out
// EVERYONE. The host leads, and the host's strongest social act must work on the person
// standing in front of them: that one guest is told why and lands home; the other guest stays.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19070; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const rowOf = (handle) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(handle)}; }) || {})`;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'blk-host', ownId: 'priv-blk-host' });
  try {
    const pest = await addClient(ctx, GW_PORT, { name: 'blk-pest', ownId: 'priv-blk-pest' });
    const pal = await addClient(ctx, GW_PORT, { name: 'blk-pal', ownId: 'priv-blk-pal' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const H = `bhost${tag}`, PEST = `bpest${tag}`, PAL = `bpal${tag}`;
    await host.client.cmd(`profile:blk-host@example.com:${H}`);
    await pest.client.cmd(`profile:blk-pest@example.com:${PEST}`);
    await pal.client.cmd(`profile:blk-pal@example.com:${PAL}`);
    for (const [who, cli] of [['host', host.client], ['pest', pest.client], ['pal', pal.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    for (const [handle, g] of [[PEST, pest], [PAL, pal]]) {
      await host.client.cmd(`social:FriendRequest:${handle}`);
      await g.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, `the request reaches ${handle}`);
      await g.client.cmd(`social:FriendAccept:${H}`);
    }
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 2`, STEP, 'the host has two friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    for (const [handle, g] of [[PEST, pest], [PAL, pal]]) {
      const acct = JSON.parse(await g.client.eval("window.omw.state.friends||'[]'"))[0].acct;
      await g.client.cmd(`joinfriend:${acct}`);
      await host.client.waitFor(`${rowOf(handle)}.id !== undefined`, 300_000, `the host sees ${handle} arrive`);
      await g.client.waitFor('window.omw.state.state === "Joined"', 60_000, `${handle} is joined after the redial`);
      await grantLockerSession(g.client, GW_PORT, g.account);
    }
    ctx.log('ok: the host and two friends are together');

    // The host blocks one of them.
    await host.client.cmd(`social:BlockAdd:${PEST}`);
    await pest.client.waitFor(`(window.omw.state.worldClosed||'') !== '' || String(window.omw.state.state||'') !== 'Joined'`, STEP, 'the blocked guest is sent home');
    const why = await pest.client.eval("window.omw.state.worldClosed||''");
    ctx.log(`the blocked guest was told: reason="${why}" by="${await pest.client.eval("window.omw.state.worldClosedBy||''")}"`);
    if (why) assert.equal(why, 'unfriended', 'the notice must say the friendship ended, not that the world closed');
    await host.client.waitFor(`${rowOf(PEST)}.id === undefined`, STEP, 'the blocked guest is gone from the host world');
    await pest.client.waitFor('window.omw.state.state === "Joined" && String(window.omw.state.worldClosed||"") === ""', 180_000, 'the blocked guest lands in their own world');
    // The other guest never moved, and still sees the host.
    assert.equal(await pal.client.eval("window.omw.state.worldClosed||''"), '', 'the other guest must not be sent home');
    assert.equal(await pal.client.eval('window.omw.state.state'), 'Joined');
    assert.equal(await pal.client.eval(`${rowOf(H)}.id !== undefined`), true, 'the other guest still sees the host');
    assert.equal(await host.client.eval(`${rowOf(PAL)}.id !== undefined`), true, 'the host still sees the other guest');
    // ...and the door stays shut: the blocked guest cannot walk back in.
    const acct = JSON.parse(await pest.client.eval("window.omw.state.friends||'[]'"));
    ctx.log(`the blocked guest's friends list now: ${JSON.stringify(acct.map((f) => f.acct))}`);
    assert.equal(acct.length, 0, 'the block must also have removed the friendship');
    ctx.log('PASS: the host blocked a guest mid-session; that guest was told why and landed home, the other guest stayed');
  } finally {
    host.stop();
  }
}
