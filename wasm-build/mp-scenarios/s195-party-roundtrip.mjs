// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s195: SOLO -> A FRIEND'S PARTY -> HOME, AND A FRIEND WHO FOLLOWS. The seamless-switch work
// (2026-10-22) fixed two things no scenario reached:
//
//   1. A friend visiting a THIRD player's party could not be joined: the join routed to the world
//      the friend OWNS, flipped to Solo when they left, and answered not_open every time. It now
//      follows their presence row into the world they are in.
//   2. Party clicked WHILE VISITING queued a flip for the arrival home in a Lua local, and the
//      reboot home wiped it: the player arrived in Solo. The page now carries it.
//
// Three players, all friends. C opens a party; A visits it; B joins A and must land in C's
// world (1). A then clicks Party from inside C's world and must arrive home IN PARTY (2), and
// the switch must report how long it took (switchMs on the destination's boot timeline).
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19220; // ten apart from its neighbours (s175 = 19210)
export const bootTimeoutMs = 420_000;
const friendsOf = (cli) => cli.eval("window.omw.state.friends||'[]'").then((s) => JSON.parse(s));

export default async function run(ctx) {
  const a = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'rt-a', ownId: 'priv-rt-a', maxWorlds: 6 });
  try {
    const b = await addClient(ctx, GW_PORT, { name: 'rt-b', ownId: 'priv-rt-b' });
    const c = await addClient(ctx, GW_PORT, { name: 'rt-c', ownId: 'priv-rt-c' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const A = `rta${tag}`, B = `rtb${tag}`, C = `rtc${tag}`;
    const all = [['A', a.client, A], ['B', b.client, B], ['C', c.client, C]];
    for (const [who, cli, h] of all) await cli.cmd(`profile:${who.toLowerCase()}-rt@example.com:${h}`);
    for (const [who, cli] of all) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    // Everyone friends with everyone: B may enter C's party only as C's friend.
    for (const [x, y, yh, xh] of [[a, b, B, A], [a, c, C, A], [b, c, C, B]]) {
      const before = (await friendsOf(x.client)).length;
      await x.client.cmd(`social:FriendRequest:${yh}`);
      await y.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, `${yh} gets the request`);
      await y.client.cmd(`social:FriendAccept:${xh}`);
      await x.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === ${before + 1}`, STEP, `${xh} and ${yh} are friends`);
    }
    const acctOf = async (cli, handle) => (await friendsOf(cli)).find((f) => f.name === handle)?.acct;

    // C opens a party; A goes to it.
    await c.client.cmd('worldmode:party');
    await c.client.waitFor(`window.omw.state.whereNow === 'party'`, STEP, 'C is in Party');
    await a.client.cmd(`joinfriend:${await acctOf(a.client, C)}`);
    await a.client.waitFor(`window.omw && window.omw.state && window.omw.state.state === "Joined" && String(window.omw.state.dialTarget||"").indexOf("priv-rt-c") >= 0`, 300_000, 'A lands in C\'s world');
    await grantLockerSession(a.client, GW_PORT, a.account);
    // Stamped when the loading screen RELEASES, a few seconds after Joined (the settle hold).
    await a.client.waitFor('Number((window.__omwBoot||{}).switchMs||0) > 0', 120_000, 'the switch time on the boot timeline').catch(() => {});
    const aSwitch = Number(await a.client.eval('(window.__omwBoot||{}).switchMs||0'));
    ctx.log(`ok: A is visiting C (switch took ${aSwitch} ms)`);
    assert.ok(aSwitch > 0, 'the destination must report the switch time (switchMs on its boot timeline)');

    // (1) B joins A -- and follows A into C's party, not to A's empty Solo home.
    await ctx.sleep(6000); // A's presence row names C's world on the next heartbeat
    await b.client.eval('window.omw.state.joinFriendResult = ""');
    await b.client.cmd(`joinfriend:${await acctOf(b.client, A)}`);
    await b.client.waitFor(`String(window.omw.state.joinFriendResult||"") !== "" || String(window.omw.state.dialTarget||"").indexOf("priv-rt-c") >= 0`, 60_000, 'B gets an answer');
    const jr = String(await b.client.eval('window.omw.state.joinFriendResult||""'));
    ctx.log(`B joinFriendResult: ${jr}`);
    assert.ok(!/not_open/.test(jr), `B was routed to A's own (Solo) world: ${jr}`);
    await b.client.waitFor(`window.omw && window.omw.state && window.omw.state.state === "Joined" && String(window.omw.state.dialTarget||"").indexOf("priv-rt-c") >= 0`, 300_000, 'B lands in C\'s world, beside A');
    ctx.log('ok: B followed A into C\'s party');

    // (2) A clicks Party while visiting: home, and IN PARTY on arrival.
    await a.client.cmd('where:party');
    await a.client.waitFor(`window.omw && window.omw.state && window.omw.state.state === "Joined" && String(window.omw.state.dialTarget||"").indexOf("priv-rt-a") >= 0`, 300_000, 'A lands home');
    await grantLockerSession(a.client, GW_PORT, a.account);
    await a.client.waitFor(`window.omw.state.whereNow === 'party'`, 60_000,
      'A must arrive home in Party: the flip queued while visiting must survive the reload');
    await a.client.waitFor('Number((window.__omwBoot||{}).switchMs||0) > 0', 120_000, 'the switch time home').catch(() => {});
    const home = Number(await a.client.eval('(window.__omwBoot||{}).switchMs||0'));
    ctx.log(`ok: A is home in Party (switch took ${home} ms)`);

    // C was not disturbed by any of it.
    assert.equal(await c.client.eval('window.omw.state.state'), 'Joined', 'C is still playing');
    assert.equal(await c.client.eval('window.omw.state.whereNow'), 'party', 'C is still hosting');
    ctx.log(`PASS: follow-into-party and Party-while-visiting both held; switches ${aSwitch} / ${home} ms`);
  } finally {
    a.stop();
  }
}
