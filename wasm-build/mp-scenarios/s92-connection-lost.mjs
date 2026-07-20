// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s92: the server dies mid-session (SIGKILL — no SessionDisconnect, no clean shutdown).
// The joined player must get an in-game "connection lost" notice (screen message + chat
// history) and land in the Offline state; the DOM banner is reserved for never-joined
// failures, so it must NOT appear here.
import assert from 'node:assert/strict';

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-lost');

  ctx.serverKill();

  await a.waitFor('(window.__omwMP||{}).state === "Offline"', 15000, 'state -> Offline after server death');
  await a.waitFor(
    '((window.__omwMP||{}).lastChatLine||"").toLowerCase().includes("connection lost")',
    5000, 'in-game "connection lost" notice');

  const banner = await a.eval('!!document.getElementById("mp-banner")');
  assert.equal(banner, false, 'mid-session loss shows the in-game notice, not the boot banner');
  ctx.log('ok: Offline + in-game connection-lost notice, no banner');
}
