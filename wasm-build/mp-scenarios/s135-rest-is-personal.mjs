// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s135: A REST IS PERSONAL. v2 (OT3-108): rest and wait move a personal clock offset and the
// shared sky never skips. Player B sleeping eight hours is not refused (healing and level-up
// land), B's own clock stays ahead and is not rolled back, and player A's clock does not move;
// A resting later moves only A. (v1 refused a guest's rest unless they owned the world, and
// rolled them back to the host's clock; `[rules] timeSkip = owner` is gone.)
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

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
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'clock-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'clock-guest' });
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
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 120_000, 'the host sees the other player');
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the other player is joined');
    const [h0, g0] = await converged(ctx, host.client, guest.client, STEP, 'at join');
    ctx.log(`ok: both on the host's clock (host ${h0.abs}, guest ${g0.abs})`);
    assert.equal(await num(guest.client, 'timeRequests'), 0, 'the guest has not asked for time');

    // B SLEEPS. v2 (OT3-108): a rest is PERSONAL. It is not refused (so its healing and level-up
    // land), B's character keeps a clock offset, and the shared sky never skips: A's clock does
    // not move, and B is NOT rolled back to it.
    await guest.client.cmd(`rest:${REST_HOURS}`);
    await guest.client.waitFor('Number(window.omw.state.timeRequests||"0") === 1', STEP, "B's rest became a WorldTimeRequest");
    await ctx.sleep(12_000); // past the slew and the next periodic WorldTime
    const h1 = await timeOf(host.client);
    const g1 = await timeOf(guest.client);
    assert.ok(Math.abs(h1.abs - h0.abs) < 0.5, `A's clock moved ${(h1.abs - h0.abs).toFixed(2)} h on B's personal rest`);
    assert.ok(g1.abs - h1.abs > REST_HOURS - 1, `B was rolled back to the shared clock (B ${g1.abs}, shared ${h1.abs}): the rest should have stuck`);
    assert.equal(await num(guest.client, 'timeRefused'), 0, "B's rest was refused; v2 rests are personal, not refused");
    ctx.log(`ok: B rested ${REST_HOURS} h and kept it (B ${g1.abs}); A stayed on the shared clock (${h1.abs})`);

    // A SLEEPS TOO: B's offset is B's own, so B does not move again.
    const gBefore = (await timeOf(guest.client)).abs;
    await host.client.cmd(`rest:${REST_HOURS}`);
    await host.client.waitFor('Number(window.omw.state.timeRequests||"0") === 1', STEP, "A's rest became a WorldTimeRequest");
    await ctx.sleep(12_000);
    const h2 = await timeOf(host.client);
    const g2 = await timeOf(guest.client);
    assert.ok(h2.abs - h1.abs > REST_HOURS - 1, `A's own rest did not stick (A ${h2.abs}, was ${h1.abs})`);
    assert.ok(Math.abs(g2.abs - gBefore) < 1, `B's clock moved ${(g2.abs - gBefore).toFixed(2)} h on A's personal rest`);
    assert.equal(await num(host.client, 'timeRefused'), 0, "A's rest was refused");
    ctx.log("PASS: a rest moves only the sleeper's own clock; the shared sky never skips");
  } finally {
    host.stop();
  }
}
