// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s135: THE HOST'S CLOCK IS THE HOST'S. You join a friend's world and they lead; if you
// sleep eight hours the whole world does not lose its evening. `[rules] timeSkip` defaults
// to "owner" now: a guest's Rest is refused and TOLD ("only the world owner can rest for
// everyone"), the host's clock does not move, and the guest -- whose engine already advanced
// its own clock -- is rolled back to the host's within seconds rather than living a shift
// ahead until the next periodic WorldTime. The host resting still moves time for both.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19050; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const REST_HOURS = 8;
const timeOf = async (c) => JSON.parse(await c.eval('window.omw.state.gameTime||"{}"'));
const num = async (c, key) => Number(await c.eval(`window.omw.state.${key}||"0"`));

async function converged(ctx, a, b, timeoutMs, what) {
  const by = Date.now() + timeoutMs;
  let ta, tb;
  while (Date.now() < by) {
    [ta, tb] = await Promise.all([timeOf(a), timeOf(b)]);
    if (Number.isFinite(ta.abs) && Number.isFinite(tb.abs) && Math.abs(ta.abs - tb.abs) < 0.5) return [ta, tb];
    await ctx.sleep(500);
  }
  assert.fail(`${what}: clocks disagree by ${(ta.abs - tb.abs).toFixed(2)} h (host ${ta.abs}, guest ${tb.abs})`);
}

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'clock-host', ownId: 'priv-clock-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'clock-guest', ownId: 'priv-clock-guest' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `chost${tag}`, guestHandle = `cguest${tag}`;
    await host.client.cmd(`profile:clock-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:clock-guest@example.com:${guestHandle}`);
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
    await guest.client.cmd(`joinfriend:${friendAcct}`);
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 120_000, "the guest is inside the host world");
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(guest.client, GW_PORT, guest.account);
    const [h0, g0] = await converged(ctx, host.client, guest.client, STEP, 'at join');
    ctx.log(`ok: both on the host's clock (host ${h0.abs}, guest ${g0.abs})`);
    assert.equal(await num(guest.client, 'timeRequests'), 0, 'the guest has not asked for time');

    // THE GUEST SLEEPS. The engine advances their clock, the jump becomes a request, and the
    // host's world says no.
    await guest.client.cmd(`rest:${REST_HOURS}`);
    await guest.client.waitFor('Number(window.omw.state.timeRequests||"0") === 1', STEP, "the guest's rest became a WorldTimeRequest");
    await guest.client.waitFor('Number(window.omw.state.timeRefused||"0") === 1', STEP, 'the guest was told the rest is refused');
    ctx.log('ok: the guest asked, the host world refused and said so');
    // The host's clock never moved (8 h would be unmistakable; free-run is minutes).
    const h1 = await timeOf(host.client);
    assert.ok(Math.abs(h1.abs - h0.abs) < 0.5, `the host's clock moved ${(h1.abs - h0.abs).toFixed(2)} h on a GUEST's rest`);
    // ...and the guest is back on it within seconds, not a shift ahead.
    const [h2, g2] = await converged(ctx, host.client, guest.client, 20_000, 'after the refused rest');
    ctx.log(`ok: the guest is back on the host's clock (host ${h2.abs}, guest ${g2.abs})`);
    assert.equal(await num(host.client, 'timeRequests'), 0, 'the host must not have bounced a request of its own');

    // THE HOST SLEEPS: the leader's rest moves time for both.
    const before = (await timeOf(guest.client)).abs;
    await host.client.cmd(`rest:${REST_HOURS}`);
    await host.client.waitFor('Number(window.omw.state.timeRequests||"0") === 1', STEP, "the host's rest became a WorldTimeRequest");
    await guest.client.waitFor(`Number(JSON.parse(window.omw.state.gameTime||"{}").abs||0) >= ${before + REST_HOURS - 0.5}`, STEP, "the guest's clock followed the host's rest");
    const [h3, g3] = await converged(ctx, host.client, guest.client, STEP, "after the host's rest");
    ctx.log(`ok: the host rested ${REST_HOURS} h and the guest followed (host ${h3.abs}, guest ${g3.abs}, guest was ${before})`);
    assert.equal(await num(guest.client, 'timeRequests'), 1, "applying the host's WorldTime bounced back as a guest request");
    assert.equal(await num(host.client, 'timeRefused'), 0, "the host's own rest was refused");
    ctx.log("PASS: a guest cannot fast-forward the host's world and is told so; the host's rest moves time for both");
  } finally {
    host.stop();
  }
}
