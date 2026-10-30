// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s70 (M7): the server owns the clock (PROTOCOL.md §M7 WorldTime / WorldTimeRequest).
//   1. Both clients apply a WorldTime at join and agree on the calendar.
//   2. A rests 8 hours -> A's client DETECTS the local jump and sends WorldTimeRequest
//      (asserted on the counter, not inferred). OT3-108: the server takes it as PERSONAL, so
//      A keeps the 8 hours and B's clock does not move (v1 advanced everyone).
//   3. B never originated a request of its own: applying a WorldTime must not look like a
//      local jump and bounce back (that loop would ratchet the world clock forever).
//   0. The clock is the SERVER's, proven against a value only the server can supply (its
//      persisted start date, cellstore.ts:98 — year 427, month 7, day 16). "Both clients
//      agree" is NOT evidence: two clients free-running from the same demo start date agree
//      perfectly while the clock is completely dead. That is exactly how an earlier version
//      of this scenario passed against a world clock that could not be written at all.
//   (v1's step 4, "B slews rather than snaps to a shared rest", went with the shared skip;
//   only a script skip is shared now.)
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

  // OT3-108: the rest is PERSONAL. A's own clock keeps the 8 hours; the shared sky does not
  // skip, so B's clock stays on the world's. Give a periodic WorldTime time to arrive (it would
  // pull A back if the offset were lost, and move B if the skip were shared).
  await ctx.sleep(12_000);
  const [t1a, t1b] = await Promise.all([timeOf(a), timeOf(b)]);
  ctx.log(`after rest: A=${t1a.abs.toFixed(2)} B=${t1b.abs.toFixed(2)} (B was ${beforeB.toFixed(2)})`);
  assert.ok(t1a.abs - beforeB > REST_HOURS - 1, `A's rest did not stick (A ${t1a.abs.toFixed(2)}, was ${beforeB.toFixed(2)})`);
  assert.ok(Math.abs(t1b.abs - beforeB) < 1, `B's clock moved ${(t1b.abs - beforeB).toFixed(2)} h on A's personal rest`);
  assert.equal(await num(a, 'timeRefused'), 0, "A's rest was refused");
  // Echo guard: B applied no skip and must not have read anything as its own rest.
  assert.equal(await num(b, 'timeRequests'), 0, 'B sent a WorldTimeRequest it never made');
  ctx.log('ok: one player resting moved only their own clock');
}
