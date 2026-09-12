// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s127: A GUEST TAKES THEIR LOOT HOME. The model (MP-COVERAGE-MAP: "a guest keeps what they
// carry out"): you join a friend's world, they lead, and whatever you pick up there is yours
// -- it is written to YOUR character, not the host's campaign -- so when the host closes up
// and you land back in your own world, it is still in your pocket. The quest log stays the
// host's; the loot does not. Without this, helping a friend is pure charity.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 18960; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const netCount = 'Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length';

// By NAME: the host minted the test item, and a minted record wears a different local id
// in every world (M7 maps server ids per world) -- counting by the host's id on the guest,
// let alone on the guest at home, asks for a record that does not exist there.
async function countOf(c, name) {
  await c.eval("if (window.omw.state) window.omw.state.countName = null; 'cleared';");
  await c.cmd(`countname:${name}`);
  await c.waitFor("typeof window.omw.state.countName === 'string'", 10_000, 'count reported');
  return Number(await c.eval('window.omw.state.countName'));
}

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'loot-host', ownId: 'priv-loot-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'loot-guest', ownId: 'priv-loot-guest' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `lhost${tag}`, guestHandle = `lguest${tag}`;
    await host.client.cmd(`profile:loot-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:loot-guest@example.com:${guestHandle}`);
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
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined (after the redial)');
    ctx.log("ok: the guest is in the host's world");

    // The host hands over an item: drop, and the guest picks it up (s108's trade).
    await host.client.cmd('equiptest');
    await host.client.waitFor('(window.omw.state.equippedIds||"") !== ""', 12_000, 'the host holds the test item');
    const itemId = (await host.client.eval('window.omw.state.equippedIds')).split(',')[0];
    await host.client.cmd(`drop:${itemId}`);
    await guest.client.waitFor(`${netCount} === 1`, STEP, 'the guest sees the drop');
    const netId = await guest.client.eval('Object.keys(JSON.parse(window.omw.state.netObjects))[0]');
    await guest.client.waitFor(`String((JSON.parse(window.omw.state.netObjectNames||"{}")[${JSON.stringify(netId)}])||"") !== ""`, STEP, 'the guest resolved the drop to a named record');
    const name = await guest.client.eval(`JSON.parse(window.omw.state.netObjectNames)[${JSON.stringify(netId)}]`);
    ctx.log(`the drop is "${name}" (host id ${itemId}, net ${netId})`);
    const had = await countOf(guest.client, name);
    await guest.client.cmd(`takenet:${netId}`);
    await guest.client.waitFor(`${netCount} === 0`, STEP, 'the guest took it');
    await ctx.sleep(3_000); // the guest's inventory diff (2 s) writes it to THEIR character
    assert.equal(await countOf(guest.client, name), had + 1, 'the guest holds the item in the host world');
    ctx.log(`ok: the guest picked up "${name}" in the host's world`);

    // The host closes up; the guest goes home -- and must still have it there.
    await host.client.cmd('worldmode:private');
    // The notice lives only until the page reloads for home (a few hundred ms); leaving is the same signal.
    await guest.client.waitFor(`(window.omw.state.worldClosed||'') !== '' || String(window.omw.state.state||'') !== 'Joined'`, STEP, 'the guest is sent home');
    await guest.client.waitFor('window.omw.state.state === "Joined" && String(window.omw.state.worldClosed||"") === ""', 180_000,
      'the guest is back in their own world');
    await guest.client.waitFor('String(window.omw.state.restored||"") === "1" || String(window.omw.state.baselineReady||"") === "1"', 60_000, 'the guest character is restored at home');
    await ctx.sleep(2_000);
    const home = await countOf(guest.client, name);
    ctx.log(`back home the guest holds ${home} of "${name}" (had ${had} before the visit)`);
    assert.equal(home, had + 1, 'the loot did not come home: it was written to the wrong character, or the restore dropped it');
    ctx.log('PASS: a guest keeps what they carried out of a friend\'s world');
  } finally {
    host.stop();
  }
}
