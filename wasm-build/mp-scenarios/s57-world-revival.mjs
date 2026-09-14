// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s57: YOUR OWN WORLD COMES BACK. The single most common multiplayer journey: you go help a
// friend, your own solo world sits empty and the gateway reaps it, and when you go home it
// must be REVIVED on dial -- with its owner, so it is still private -- rather than dead-end at
// AUTH_FAILED on a loading screen (the bug that gated multiplayer off production). Rewritten
// for the Solo/Party model: the "away" world is a FRIEND's, not the deleted public one.
// worldrevive.test.ts proves the gateway machinery; this proves the browser round trip.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19130; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
// Short enough to drive the reap rather than wait out the 2-minute default; long enough that a
// client (SwiftShader, a busy box) finishes arriving before its own world is judged idle.
const REAP_MS = 45_000;
const TRAV_ID = 'priv-rev-trav'; // the traveller's own world -- the one that reaps and revives
const rowOf = (h) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(h)}; }) || {})`;

export default async function run(ctx) {
  const worldUp = async (id) => {
    try {
      const r = await (await fetch(`http://127.0.0.1:${GW_PORT}/worlds/${id}`, { signal: AbortSignal.timeout(2000) })).json();
      return r && r.up === true;
    } catch { return false; }
  };
  // The friend whose world stays up (they are in it) and gives the traveller somewhere to be.
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'rev-host', ownId: 'priv-rev-host', idleReapMs: REAP_MS });
  try {
    const trav = await addClient(ctx, GW_PORT, { name: 'rev-trav', ownId: TRAV_ID });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const H = `rvhost${tag}`, T = `rvtrav${tag}`;
    await host.client.cmd(`profile:rev-host@example.com:${H}`);
    await trav.client.cmd(`profile:rev-trav@example.com:${T}`);
    for (const [who, cli] of [['host', host.client], ['trav', trav.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    assert.ok(await worldUp(TRAV_ID), "the traveller's own world is up before they leave");

    // The traveller goes to help the friend. Their own world is now empty.
    await host.client.cmd(`social:FriendRequest:${T}`);
    await trav.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await trav.client.cmd(`social:FriendAccept:${H}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    const acct = JSON.parse(await trav.client.eval("window.omw.state.friends||'[]'"))[0].acct;
    await trav.client.cmd(`joinfriend:${acct}`);
    await host.client.waitFor(`${rowOf(T)}.id !== undefined`, 300_000, "the traveller reached the friend's world");
    await trav.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the traveller is joined at the friend');
    await grantLockerSession(trav.client, GW_PORT, trav.account);
    ctx.log("ok: the traveller is in the friend's world; their own world is now empty");

    // ...and the gateway reaps the empty own-world. Prove it actually went down.
    const by = Date.now() + REAP_MS + 90_000;
    let reaped = false;
    while (Date.now() < by && !reaped) { reaped = !(await worldUp(TRAV_ID)); if (!reaped) await ctx.sleep(3_000); }
    assert.ok(reaped, `the traveller's empty world was never reaped (${TRAV_ID} still up after ${(REAP_MS + 90_000) / 1000}s)`);
    ctx.log(`ok: the empty own-world ${TRAV_ID} was reaped while the traveller was away`);

    // Home again: the dial must REVIVE the reaped world and land them Joined, not AUTH_FAILED.
    await trav.client.cmd('where:solo');
    await trav.client.waitFor(`window.omw.state.state === "Joined" && String(window.omw.state.dialTarget||"").indexOf(${JSON.stringify(TRAV_ID)}) >= 0`, 300_000,
      'the traveller is back in their own, revived world');
    assert.notEqual(await trav.client.eval('window.omw.state.state'), 'Failed', 'the return dead-ended at Failed');
    assert.ok(await worldUp(TRAV_ID), 'the own-world is up again (revived on dial)');
    ctx.log('PASS: a reaped own-world revived on the owner\'s dial home; the most common journey holds');
  } finally {
    host.stop();
  }
}
