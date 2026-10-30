// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s127: WHAT YOU PICK UP IS YOURS. v2 has one world and no host: whatever a player takes (here
// a dagger another player dropped) is written to THEIR OWN character, so after a relog it is
// still in their pocket. (v1 phrased this as a guest taking loot home from a friend's world;
// the world switching it needed is gone, OT3-31/58, the per-character write is not.)
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

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
  // RETAIL, so the loot is a real content item. A minted record (equiptest) cannot cross worlds:
  // records are per-world registries, and that is a separate, recorded gap (MP-COVERAGE-MAP).
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'loot-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'loot-guest', boot: BOOT });
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
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    // A RETAIL reload: the page reboots into the host's world and streams the game data again,
    // and the socket is dialled only once the world is up (global.lua: first frame). Minutes.
    try {
      await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, "the guest is inside the host's world");
    } catch (e) {
      const lines = (guest.client.logTail ? guest.client.logTail(4000) : '').split(String.fromCharCode(10))
        .filter((l) => /session state|Starting a new game|Loading cell|changing world|world change|ticket|Joined|locker/i.test(l)).slice(-25);
      ctx.log('guest log through the switch: ' + lines.join(' || '));
      const raw = (guest.client.logTail ? guest.client.logTail(60) : '').split(String.fromCharCode(10)).filter((l) => !/Local map|GL_INVALID|RigGeometry/.test(l)).slice(-30);
      ctx.log('guest raw tail: ' + raw.join(' || '));
      ctx.log(`guest page: state=${await guest.client.eval('window.omw.state.state')} href=${await guest.client.eval('location.href.slice(0,200)')} jsErrors=${JSON.stringify((guest.client.jsErrors ? guest.client.jsErrors() : []).slice(-3))}`);
      throw e;
    }
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined (after the redial)');
    // The switch reloaded the page; the harness's locker session lives on window and must be
    // granted again or the way HOME dies at "no locker session" (a real player's fragment
    // carries it). This is what left the guest kicked and stranded on the first runs.
    await grantLockerSession(guest.client, GW_PORT, guest.account);
    ctx.log("ok: the guest is in the host's world");

    // The host hands over a real item: an iron dagger, granted then dropped; the guest picks it up.
    const ITEM = 'iron dagger', NAME = 'Iron Dagger';
    await host.client.cmd(`equip:${ITEM}:16`);
    await ctx.sleep(2_000);
    await host.client.cmd(`drop:${ITEM}`);
    await guest.client.waitFor(`${netCount} === 1`, STEP, 'the guest sees the drop');
    const netId = await guest.client.eval('Object.keys(JSON.parse(window.omw.state.netObjects))[0]');
    const name = NAME;
    ctx.log(`the drop is "${name}" (net ${netId})`);
    const had = await countOf(guest.client, name);
    await guest.client.cmd(`takenet:${netId}`);
    await guest.client.waitFor(`${netCount} === 0`, STEP, 'the guest took it');
    await ctx.sleep(3_000); // the guest's inventory diff (2 s) writes it to THEIR character
    assert.equal(await countOf(guest.client, name), had + 1, 'the guest holds the item');
    ctx.log(`ok: the guest picked up "${name}" in the host's world`);

    // The guest's tab reloads (a relog); their character is theirs, so the dagger must still
    // be in the pack after the restore (v2: no host to close up and no own world to go home to).
    await guest.client.reload();
    await guest.client.waitFor('window.omw.state.state === "Joined"', 180_000, 'the guest is back in the world after the reload');
    await guest.client.waitFor('String(window.omw.state.restored||"") === "1" || String(window.omw.state.baselineReady||"") === "1"', 60_000, 'the guest character is restored');
    await ctx.sleep(2_000);
    const home = await countOf(guest.client, name);
    ctx.log(`after the relog the guest holds ${home} of "${name}" (had ${had} before the visit)`);
    assert.equal(home, had + 1, 'the loot did not come home: it was written to the wrong character, or the restore dropped it');
    ctx.log('PASS: a guest keeps what they carried out of a friend\'s world');
  } finally {
    host.stop();
  }
}
