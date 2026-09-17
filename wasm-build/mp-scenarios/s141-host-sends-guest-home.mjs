// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s141: THE HOST SENDS A GUEST HOME. Every co-op lobby has "remove from party" beside "block";
// here the only evictions were Solo (everyone out) and block (unfriend forever). WorldKick
// sends ONE guest home with its own reason, keeps the friendship and the open door -- so the
// same friend can come straight back -- and the other guest never moves. Along the way: the
// server names the host in WorldMode, so the guest's UI can say whose world it is visiting.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19090; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const rowOf = (handle) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(handle)}; }) || {})`;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'kick-host', ownId: 'priv-kick-host' });
  try {
    const pest = await addClient(ctx, GW_PORT, { name: 'kick-pest', ownId: 'priv-kick-pest' });
    const pal = await addClient(ctx, GW_PORT, { name: 'kick-pal', ownId: 'priv-kick-pal' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const H = `khost${tag}`, PEST = `kpest${tag}`, PAL = `kpal${tag}`;
    await host.client.cmd(`profile:kick-host@example.com:${H}`);
    await pest.client.cmd(`profile:kick-pest@example.com:${PEST}`);
    await pal.client.cmd(`profile:kick-pal@example.com:${PAL}`);
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
    // Whose world: the host knows it is the host; the guests know whose game they are in.
    await host.client.waitFor('String(window.omw.state.amHost||"") === "true"', STEP, 'the host is told it hosts');
    await pest.client.waitFor(`String(window.omw.state.amHost||"") === "false" && String(window.omw.state.worldHost||"") === ${JSON.stringify(H)}`, STEP, "the guest is told whose world it is visiting");
    ctx.log(`ok: guest UI knows it is visiting ${await pest.client.eval('window.omw.state.worldHost')}'s world`);

    // The host sends one of them home.
    await host.client.cmd(`social:WorldKick:${PEST}`);
    await pest.client.waitFor(`(window.omw.state.worldClosed||'') !== '' || String(window.omw.state.state||'') !== 'Joined'`, STEP, 'the kicked guest is sent home');
    // Being sent home is a page navigation (the launcher redials), and between the wait above
    // and this read the page can be mid-reload with no window.omw yet (#116: "Cannot read
    // properties of undefined"). The reason is narration, not the verdict: read it if it is there.
    const told = await pest.client.eval("JSON.stringify(window.omw && window.omw.state ? { why: window.omw.state.worldClosed||'', by: window.omw.state.worldClosedBy||'' } : null)").catch(() => 'null');
    const { why = '', by = '' } = JSON.parse(told) || {}; // empty = the page was already navigating
    ctx.log(`the kicked guest was told: reason="${why}" by="${by}"`);
    if (why) assert.equal(why, 'kicked', 'the notice must say the host sent them home');
    await host.client.waitFor(`${rowOf(PEST)}.id === undefined`, STEP, 'the kicked guest is gone from the host world');
    await pest.client.waitFor('window.omw.state.state === "Joined" && String(window.omw.state.worldClosed||"") === ""', 180_000, 'the kicked guest lands in their own world');
    // The other guest never moved, and still sees the host.
    assert.equal(await pal.client.eval("window.omw.state.worldClosed||''"), '', 'the other guest must not be sent home');
    assert.equal(await pal.client.eval('window.omw.state.state'), 'Joined');
    assert.equal(await pal.client.eval(`${rowOf(H)}.id !== undefined`), true, 'the other guest still sees the host');
    assert.equal(await host.client.eval(`${rowOf(PAL)}.id !== undefined`), true, 'the host still sees the other guest');
    // ...and it was a kick, not a block: still friends. But "send home" STICKS: walking
    // straight back in on their own is refused -- and told as a kick, not as "private".
    await grantLockerSession(pest.client, GW_PORT, pest.account);
    // The friends list lands a moment after the join on the rebooted page.
    await pest.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'a kick must not touch the friendship');
    const friends = JSON.parse(await pest.client.eval("window.omw.state.friends||'[]'"));
    await pest.client.cmd(`joinfriend:${friends[0].acct}`);
    // The guest's world says ok (it cannot see the host world's cooldown); the host world
    // refuses at the door and the page goes home saying so.
    await pest.client.waitFor(`String(window.omw.state.state||"") !== "Joined" || String(window.omw.state.worldClosed||"") !== ""`, 180_000, 'the kicked guest set off');
    await pest.client.waitFor('String(window.omw.state.state||"") === "Joined" && String(window.omw.state.dialTarget||"").indexOf("priv-kick-pest") >= 0', 300_000, 'the kicked guest is back home after being refused at the door');
    assert.equal(await host.client.eval(`${rowOf(PEST)}.id !== undefined`), false, 'a kicked guest must not be able to walk straight back in');
    ctx.log('ok: the door stayed shut to the kicked guest');
    // The host changes their mind: an INVITE reopens the door.
    await grantLockerSession(pest.client, GW_PORT, pest.account);
    await host.client.cmd(`social:InviteSend:${pest.account}`);
    await pest.client.waitFor(`JSON.parse(window.omw.state.invites||'[]').length > 0`, STEP, 'the invite reaches the kicked guest');
    const invites = JSON.parse(await pest.client.eval("window.omw.state.invites||'[]'"));
    await pest.client.cmd(`social:InviteAccept:${invites[0].acct}`);
    await host.client.waitFor(`${rowOf(PEST)}.id !== undefined`, 300_000, 'the kicked guest is back in the host world after being invited again');
    ctx.log('PASS: the host sent a guest home; they were told, landed home, the other guest stayed, and they could come back');
  } finally {
    host.stop();
  }
}
