// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s128: A GUEST FIGHTS IN A FRIEND'S WORLD. The whole point of joining: you and your friend
// take on the world together, in THEIR world, with their NPCs simulated by their world's
// peer. Every fight scenario so far ran in a symmetric harness world; this one goes through
// the real door -- befriend, Party, joinfriend, retail data through the gateway -- and then
// both players hit the same NPC in the host's world, which must die once for both. The
// gateway world spawns its own peer from the shared config (managedPeer).
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';
import { pickUntil } from './_probe.mjs';

export const managedPeer = true;
const STEP = 30_000;
const GW_PORT = 18980; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));

export default async function run(ctx) {
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'fight-host', ownId: 'priv-fight-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'fight-guest', ownId: 'priv-fight-guest', boot: BOOT });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `fhost${tag}`, guestHandle = `fguest${tag}`;
    await host.client.cmd(`profile:fight-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:fight-guest@example.com:${guestHandle}`);
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
    await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, "the guest is inside the host's world");
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(guest.client, GW_PORT, guest.account);
    ctx.log("ok: the guest is in the host's world");

    // The host's world is simulated by its own peer: a holder that is neither of them.
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 300_000, `${who}: the host's world has a peer holding the cell`);
      await cli.waitFor('window.omw.state.isHolder === "false"', STEP, `${who} does not hold it`);
      await cli.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, `${who} puppets the cell actors`);
    }
    ctx.log(`ok: the host's peer holds the cell (holder=${await host.client.eval('window.omw.state.authorityHolder')})`);

    // Both hit the same NPC in the host's world; it dies once, for both.
    let pa, pb, victim;
    ({ found: victim, probes: [pa, pb] } = await pickUntil(ctx, () => Promise.all([probeOf(host.client), probeOf(guest.client)]), (pa, pb) => Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard && !/mudcrab|scrib|rat|slaughterfish|kwama/.test(r))));
    assert.ok(victim, `need a living NPC both see: host=${JSON.stringify(Object.keys(pa))} guest=${JSON.stringify(Object.keys(pb))}`);
    const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
    const deadline = Date.now() + 90_000;
    let died = false;
    while (Date.now() < deadline && !died) {
      await host.client.cmd(`hitn:${victim}:40`);
      await guest.client.cmd(`hitn:${victim}:40`);
      await ctx.sleep(600);
      died = (await host.client.eval(deadExpr)) === true || (await guest.client.eval(deadExpr)) === true;
    }
    ctx.log(`hitFwd host=${await host.client.eval('window.omw.state.hitFwd')} guest=${await guest.client.eval('window.omw.state.hitFwd')}`);
    assert.ok(died, `"${victim}" never died in the host's world: the guest's (or host's) hits are not reaching the world's peer`);
    await host.client.waitFor(deadExpr, STEP, 'the host sees it dead');
    await guest.client.waitFor(deadExpr, STEP, 'the guest sees it dead');
    ctx.log(`PASS: host and guest killed "${victim}" together in the host's world`);
  } finally {
    host.stop();
  }
}
