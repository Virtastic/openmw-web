// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s92: the server dies mid-session (SIGKILL — no SessionDisconnect, no clean shutdown).
// The joined player must get an in-game "connection lost" notice (screen message + chat
// history); the DOM banner is reserved for never-joined failures, so it must NOT appear.
//
// CONTRACT CHANGE (Phase A1): a mid-session loss now lands in `Reconnecting`, not
// `Offline` — the client redials itself with backoff+jitter and, because the resume ticket
// is still parked, a short outage rejoins in place. `Offline` is now reserved for a
// terminal disconnect. Backoff mechanics are asserted separately in s81-reconnect.
import assert from 'node:assert/strict';

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-lost');

  ctx.serverKill();

  await a.waitFor('window.omw.state.reconnecting === "true"', 15000,
    'entered the reconnect cycle after server death');
  await a.waitFor(
    '(window.omw.state.lastChatLine||"").toLowerCase().includes("connection lost")',
    5000, 'in-game "connection lost" notice');

  const banner = await a.eval('!!document.getElementById("mp-banner")');
  assert.equal(banner, false, 'mid-session loss shows the in-game notice, not the boot banner');
  ctx.log("ok: reconnect cycle started + in-game connection-lost notice, no banner");
}
