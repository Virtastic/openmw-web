// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s81 (Phase A1): the client redials a dead server ITSELF, with truncated exponential
// backoff and full jitter.
//
// Asserts the MECHANISM, not just "it retried": attempt count climbs, and the scheduled
// delays both GROW (backoff) and VARY (jitter). Jitter is the part that actually matters
// operationally — every client notices a restart within the same second, so un-jittered
// retries redial in lockstep and hammer a server that is still coming up. That is a
// documented cascading-failure mode (SRE Workbook, Pokemon GO: retry amplification hit 20x
// peak RPS and effectively halved GCLB capacity), which is why this is a launch blocker
// rather than polish.
import assert from 'node:assert/strict';

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-redial');

  ctx.serverKill();
  await a.waitFor('(window.__omwMP||{}).reconnecting === "true"', 15000, 'entered the reconnect cycle');

  // Sample the scheduler while it backs off. Nothing is listening on the port any more, so
  // every attempt fails and we get a clean series of scheduled delays.
  const delays = [];
  let lastAttempt = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && delays.length < 4) {
    const attempt = Number(await a.eval('(window.__omwMP||{}).reconnectAttempt || 0'));
    if (attempt > lastAttempt) {
      lastAttempt = attempt;
      delays.push(Number(await a.eval('(window.__omwMP||{}).nextRetrySeconds || 0')));
    }
    await ctx.sleep(500);
  }
  ctx.log(`attempts=${lastAttempt} scheduled delays=${JSON.stringify(delays)}`);

  assert.ok(lastAttempt >= 3, `expected repeated redials, saw ${lastAttempt}`);

  // Backoff: the CEILING doubles per attempt, so later delays must be able to exceed the
  // first ceiling. Compare maxima rather than consecutive pairs — with full jitter any
  // individual delay can legitimately be small.
  const maxLate = Math.max(...delays.slice(1));
  assert.ok(maxLate > delays[0] || maxLate > 1,
    `delays show no growth: ${JSON.stringify(delays)}`);

  // Jitter: identical values across attempts would mean a fixed delay, i.e. the lockstep
  // behaviour this exists to prevent.
  assert.ok(new Set(delays.map((d) => d.toFixed(2))).size > 1,
    `delays are not jittered (all identical): ${JSON.stringify(delays)}`);

  // And the player is told to wait rather than to reload — reloading would cost them the
  // in-place rejoin the parked resume ticket buys.
  const line = String(await a.eval('(window.__omwMP||{}).lastChatLine || ""')).toLowerCase();
  assert.ok(line.includes('reconnect'), `expected a reconnecting notice, got "${line}"`);
  ctx.log('ok: self-redial with growing, jittered delays and a wait-not-reload notice');
}
