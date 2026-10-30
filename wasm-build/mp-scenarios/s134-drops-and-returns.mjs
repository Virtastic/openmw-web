// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s134: A PLAYER'S TAB DIES AND THEY COME BACK. A real player's browser crashes, their laptop
// sleeps, they hit F5. What must hold: the loot they picked up before the drop is on THEIR
// character when they rejoin (the logout flush wrote it, and the next join re-reads the row
// rather than trusting a cached copy -- the s132 bug), and the other player sees them back.
// (v1 split this over a visited host world and an own world; there is one world now.)
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19040; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const netCount = 'Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length';

async function countOf(c, name) {
  await c.eval("if (window.omw.state) window.omw.state.countName = null; 'cleared';");
  await c.cmd(`countname:${name}`);
  await c.waitFor("typeof window.omw.state.countName === 'string'", 10_000, 'count reported');
  return Number(await c.eval('window.omw.state.countName'));
}

export default async function run(ctx) {
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'drop-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'drop-guest', boot: BOOT });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `dhost${tag}`, guestHandle = `dguest${tag}`;
    await host.client.cmd(`profile:drop-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:drop-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    await host.client.cmd(`social:FriendRequest:${guestHandle}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await guest.client.cmd(`social:FriendAccept:${hostHandle}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;

    const joinFriend = async (cli, what) => {
      await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, `the host sees the guest ${what}`);
      await cli.waitFor('window.omw.state.state === "Joined"', 60_000, `the guest is joined ${what}`);
      await cli.waitFor('String(window.omw.state.restored||"") === "1" || String(window.omw.state.baselineReady||"") === "1"', 60_000, `the guest is settled ${what}`);
    };
    await joinFriend(guest.client, 'in the host world');
    ctx.log("ok: the guest is in the host's world");

    // Loot before the drop: the host hands over a real item, the guest takes it.
    const ITEM = 'iron dagger', NAME = 'Iron Dagger';
    await host.client.cmd(`equip:${ITEM}:16`);
    await ctx.sleep(2_000);
    await host.client.cmd(`drop:${ITEM}`);
    await guest.client.waitFor(`${netCount} === 1`, STEP, 'the guest sees the drop');
    const netId = await guest.client.eval('Object.keys(JSON.parse(window.omw.state.netObjects))[0]');
    const had = await countOf(guest.client, NAME);
    await guest.client.cmd(`takenet:${netId}`);
    await guest.client.waitFor(`${netCount} === 0`, STEP, 'the guest took it');
    await ctx.sleep(3_000); // the guest's inventory diff (2 s) writes it to THEIR character
    assert.equal(await countOf(guest.client, NAME), had + 1, 'the guest holds the item in the host world');
    ctx.log(`ok: the guest holds ${had + 1} "${NAME}" in the host's world`);

    // THE TAB DIES. No goodbye, no flip: the socket just closes.
    guest.client.close();
    await host.client.waitFor(`${guestRow}.id === undefined`, 120_000, 'the host sees the guest drop');
    ctx.log('ok: the guest dropped');

    // Back through the door: the loot must be there -- written at logout, read fresh at the
    // next join (v1 went home to an own world first; there is only the one world now).
    const worldUrl = `ws://127.0.0.1:${GW_PORT}/w/${guest.ownId}`;
    const back = await ctx.launchClient('drop-guest', '', { mpUrl: worldUrl, homeUrl: worldUrl, ...BOOT }); // same name = same account
    await joinFriend(back, 'after the drop');
    await ctx.sleep(2_000);
    const atHome = await countOf(back, NAME);
    ctx.log(`after the rejoin the player holds ${atHome} "${NAME}" (had ${had} before)`);
    assert.equal(atHome, had + 1, 'the loot taken before the tab died did not survive: the world never flushed it, or served its stale copy');
    assert.equal(await host.client.eval(`${guestRow}.id !== undefined`), true, 'the other player must see the returning one');
    ctx.log("PASS: the player's tab died; they came back with the loot and the other player sees them return");
  } finally {
    host.stop();
  }
}
