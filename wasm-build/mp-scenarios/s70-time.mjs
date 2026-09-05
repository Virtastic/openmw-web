// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s70 (M7): the server owns the clock (PROTOCOL.md §M7 WorldTime / WorldTimeRequest).
//   1. Both clients apply a WorldTime at join and agree on the calendar.
//   2. A rests 8 hours -> A's client DETECTS the local jump and sends WorldTimeRequest
//      (asserted on the counter, not inferred), the server applies + rebroadcasts, and B's
//      clock advances by the same 8 hours. One player resting moves time for everyone.
//   3. B never originated a request of its own: applying a WorldTime must not look like a
//      local jump and bounce back (that loop would ratchet the world clock forever).
//   0. The clock is the SERVER's, proven against a value only the server can supply (its
//      persisted start date, cellstore.ts:98 — year 427, month 7, day 16). "Both clients
//      agree" is NOT evidence: two clients free-running from the same demo start date agree
//      perfectly while the clock is completely dead. That is exactly how an earlier version
//      of this scenario passed against a world clock that could not be written at all.
//   4. B SLEWS rather than snaps: sampled while it converges, B's clock is strictly
//      between its old value and the target for at least one sample.
import assert from 'node:assert/strict';

const STEP_TIMEOUT = 25_000;
const REST_HOURS = 8;
// The server's persisted start date (server/src/persist/cellstore.ts:98) — a value the
// clients can only have because the server sent it.
const SERVER_YEAR = 427;
const SERVER_MONTH = 7;
const SERVER_DAY = 16;

const timeOf = async (c) => JSON.parse(await c.eval('window.omw.state.gameTime||"{}"'));
const num = async (c, key) => Number(await c.eval(`window.omw.state.${key}||"0"`));

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a'), ctx.launchClient('bot-b')]);

  // The clock arrives at join (§M7: WorldTime is sent at join, on change and every 60 s).
  await a.waitFor('Number(window.omw.state.timeApplied||"0") > 0', STEP_TIMEOUT, 'A applied WorldTime');
  await b.waitFor('Number(window.omw.state.timeApplied||"0") > 0', STEP_TIMEOUT, 'B applied WorldTime');
  // Both slew from their own local start date to the server's, so give them time to
  // converge before comparing (a snap would be instant — that is asserted below).
  let t0a = null;
  let t0b = null;
  const convergeBy = Date.now() + STEP_TIMEOUT;
  while (Date.now() < convergeBy) {
    [t0a, t0b] = await Promise.all([timeOf(a), timeOf(b)]);
    if (Number.isFinite(t0a.abs) && Number.isFinite(t0b.abs) && Math.abs(t0a.abs - t0b.abs) < 0.5) break;
    await ctx.sleep(500);
  }
  ctx.log(`join clocks: A=${JSON.stringify(t0a)} B=${JSON.stringify(t0b)}`);
  assert.ok(Number.isFinite(t0a.abs) && Number.isFinite(t0b.abs), 'both clients expose a clock');
  assert.ok(Math.abs(t0a.abs - t0b.abs) < 0.5, `clients disagree by ${(t0a.abs - t0b.abs).toFixed(2)} h at join`);

  // The mechanism: the write actually reaches the engine (a dropped global write is
  // silent — see world.lua TIME_FIELDS), and the calendar we ended up on is the SERVER's.
  for (const [c, name] of [[a, 'A'], [b, 'B']]) {
    assert.equal(await c.eval('window.omw.state.clockWritable'), 'true',
      `${name}: world-clock writes are being dropped by the engine`);
  }
  for (const [t, name] of [[t0a, 'A'], [t0b, 'B']]) {
    assert.equal(t.year, SERVER_YEAR, `${name} is not on the server's calendar year (${t.year})`);
    assert.equal(t.month, SERVER_MONTH, `${name} is not in the server's month (${t.month})`);
    assert.ok(Math.abs(t.day - SERVER_DAY) <= 1, `${name} is not on the server's day (${t.day})`);
  }
  ctx.log(`ok: both clients adopted the server calendar ${SERVER_YEAR}-${SERVER_MONTH}-${SERVER_DAY}`);

  const beforeB = t0b.abs;
  assert.equal(await b.eval('window.omw.state.timeRequests'), '0', 'B has not asked for time');

  // A rests. The client does not "know" it rested — it sees the engine's clock jump and
  // turns that into the request, which is the only mechanism a real rest offers.
  await a.eval(`window.omw.send('rest:${REST_HOURS}')`);
  await a.waitFor('Number(window.omw.state.timeRequests||"0") === 1', STEP_TIMEOUT,
    "A's rest was detected and sent as a WorldTimeRequest");
  ctx.log('ok: local jump detected -> WorldTimeRequest');

  // B converges on the new time. Sample while it moves: a snap would jump straight from
  // `beforeB` to the target with nothing in between.
  const targetB = beforeB + REST_HOURS;
  let sawIntermediate = false;
  const deadline = Date.now() + STEP_TIMEOUT;
  let lastAbs = beforeB;
  while (Date.now() < deadline) {
    const t = await timeOf(b);
    if (t.abs > beforeB + 0.2 && t.abs < targetB - 0.2) sawIntermediate = true;
    lastAbs = t.abs;
    if (t.abs >= targetB - 0.35) break;
    await ctx.sleep(150);
  }
  ctx.log(`B clock ${beforeB.toFixed(2)} -> ${lastAbs.toFixed(2)} (target ${targetB.toFixed(2)}), slew samples seen: ${sawIntermediate}`);
  assert.ok(lastAbs >= targetB - 0.35, `B did not reach the shared time (${lastAbs.toFixed(2)} vs ${targetB.toFixed(2)})`);
  assert.ok(sawIntermediate, 'B snapped instead of slewing (no intermediate sample observed)');

  // Echo guard: B applied a WorldTime; it must not have read that as its own rest.
  const reqB = await num(b, 'timeRequests');
  ctx.log(`B timeRequests = ${reqB} (must stay 0)`);
  assert.equal(reqB, 0, 'applying WorldTime bounced back as a WorldTimeRequest');

  // And A ends up on the same clock as B.
  const [t1a, t1b] = await Promise.all([timeOf(a), timeOf(b)]);
  ctx.log(`after rest: A=${t1a.abs.toFixed(2)} B=${t1b.abs.toFixed(2)}`);
  assert.ok(Math.abs(t1a.abs - t1b.abs) < 0.75,
    `clients diverged after the rest: ${(t1a.abs - t1b.abs).toFixed(2)} h`);
  ctx.log('ok: one player resting advanced the shared clock');
}
