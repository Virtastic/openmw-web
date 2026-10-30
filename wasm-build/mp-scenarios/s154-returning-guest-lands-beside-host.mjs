// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s154: A RETURNING PLAYER WHO ACCEPTS AN INVITE LANDS BESIDE THE INVITER, AND STAYS THERE.
// Every character doc has a position, and a join restores it. The rejoin position hold
// re-asserted that stored spot for eight seconds -- so a player who came back to help and
// accepted the invite at once was put next to the friend for a frame and teleported to wherever
// they last logged out. The invite is where they meant to go (global.lua MP_InviteAccepted
// releases the hold). v1 reached this through joinfriend; the invite path is what v2 keeps.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';
import { inviteAndAccept } from './_social.mjs';

const STEP = 30_000;
const GW_PORT = 19150; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 480_000;
const pose = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));
const dist2 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

export default async function run(ctx) {
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'ret-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'ret-guest', boot: BOOT });
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
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(G)}; }) || {})`;
    const hostRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(H)}; }) || {})`;

    const joinTo = async (cli, what) => {
      await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, `the host sees the guest ${what}`);
      await cli.waitFor('window.omw.state.state === "Joined"', 60_000, `the guest is joined ${what}`);
    };
    await joinTo(guest.client, 'the first time');
    await guest.client.waitFor('String(window.omw.state.baselineReady||"") === "1"', 60_000, 'the guest is settled');
    // The guest goes far from the host (a teleport: the cell centre is walled by terrain),
    // so their stored position is nowhere near them.
    const hostAt = await pose(host.client);
    await guest.client.cmd(`snapto:${Math.round(hostAt.x + 2000)},${Math.round(hostAt.y)},${Math.round(hostAt.z + 200)}`);
    await ctx.sleep(6_000); // the doc's position follows the pose stream
    const far = await pose(guest.client);
    ctx.log(`the guest walked to ${far.x.toFixed(0)},${far.y.toFixed(0)}; the host is at ${hostAt.x.toFixed(0)},${hostAt.y.toFixed(0)} (${dist2(far, hostAt).toFixed(0)} apart)`);
    assert.ok(dist2(far, hostAt) > 400, 'the guest must be well away from the host before leaving (walk hook / terrain)');
    guest.client.close(); // logout flushes the doc with that far spot
    await host.client.waitFor(`${guestRow}.id === undefined`, 120_000, 'the host sees the guest leave');
    // A RETURN, NOT A RECONNECT. The server keeps the position of a guest back within
    // GUEST_REBOOT_MS (60 s, server.ts guestSpawn: the auth rescue re-dials a crashed client and
    // must not yank it to the host). A 50 fps client came back inside that window, so every run
    // measured the crash path and the invite never came (#161: no invite line on the return).
    await ctx.sleep(65_000);

    // Back, straight to the friend. The stored position is 'far'; the invite is the host.
    const worldUrl = `ws://127.0.0.1:${GW_PORT}/w/${guest.ownId}`;
    const back = await ctx.launchClient('ret-guest', '', { mpUrl: worldUrl, homeUrl: worldUrl, ...BOOT }); // same name = same account
    await joinTo(back, 'again');
    // The invite is accepted at once, while the rejoin position hold is still armed.
    await inviteAndAccept(host.client, back, H, STEP);
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
    // The RETURNING client's own narration: the restore, the invite and the hold, in the order
    // they ran. The failure tail prints the first two clients only (#159: this was missing).
    const said = (back.logTail ? back.logTail(400) : '').split(String.fromCharCode(10))
      .filter((l) => /\[mp\] (rejoin|restore|invite|session state|follow|snap)/.test(l)).slice(-20).join(String.fromCharCode(10));
    assert.ok(last < 400, `the returning guest ended ${last} units from the host: the rejoin position hold pulled them back to where they logged out
${said}`);
    assert.equal(await host.client.eval(`${guestRow}.id !== undefined`), true, 'the host must see the returning guest');
    ctx.log('PASS: a returning guest joined straight to the host and stayed beside them');
  } finally {
    host.stop();
  }
}
