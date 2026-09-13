// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s134: THE GUEST'S TAB DIES MID-VISIT, AND THEY COME BACK. A real player's browser crashes,
// their laptop sleeps, they hit F5 (which bounces index.html to the launcher). What must hold:
// the loot they picked up in the friend's world before the drop is on THEIR character when
// they boot at home (the host world's logout flush wrote it, and the home world re-reads the
// row rather than trusting its own copy -- the s132 bug); and when they rejoin the friend,
// whose world is still in party mode, they are a guest again with that loot still in hand,
// and the host sees them back. Three worlds' caches of one character, in order.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

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
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'drop-host', ownId: 'priv-drop-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'drop-guest', ownId: 'priv-drop-guest', boot: BOOT });
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
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    const friendAcct = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"))[0].acct;
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;

    const joinFriend = async (cli, what) => {
      await cli.cmd(`joinfriend:${friendAcct}`);
      await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, `the host sees the guest ${what}`);
      await cli.waitFor('window.omw.state.state === "Joined"', 60_000, `the guest is joined ${what}`);
      await grantLockerSession(cli, GW_PORT, guest.account); // the switch reloaded the page
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
    ctx.log('ok: the guest dropped; the host world is still in party mode');

    // Back at the launcher, into their OWN world first (that is where a boot lands): the loot
    // must be there -- written by the host world at logout, read fresh by the home world.
    const ownUrl = `ws://127.0.0.1:${GW_PORT}/w/${guest.ownId}`;
    const back = await ctx.launchClient('drop-guest', '', { mpUrl: ownUrl, homeUrl: ownUrl, ...BOOT }); // same name = same account
    await grantLockerSession(back, GW_PORT, guest.account);
    await back.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is back in their own world');
    await back.waitFor('String(window.omw.state.restored||"") === "1"', 60_000, 'the guest character is restored at home');
    await ctx.sleep(2_000);
    const atHome = await countOf(back, NAME);
    ctx.log(`at home after the drop the guest holds ${atHome} "${NAME}" (had ${had} before the visit)`);
    assert.equal(atHome, had + 1, 'the loot taken before the tab died did not survive: the host world never flushed it, or the home world served its stale copy');

    // ...and rejoins the friend: a guest again, loot in hand, the host sees them return.
    await joinFriend(back, 'again after the drop');
    await ctx.sleep(2_000);
    const again = await countOf(back, NAME);
    ctx.log(`back in the host world the guest holds ${again} "${NAME}"`);
    assert.equal(again, had + 1, 'the loot did not follow the guest back into the host world: the host world served the copy it cached before the drop');
    assert.equal(await host.client.eval(`${guestRow}.id !== undefined`), true, 'the host must see the returning guest');
    ctx.log("PASS: the guest's tab died mid-visit; they came home with the loot, rejoined the friend, and still hold it there");
  } finally {
    host.stop();
  }
}
