// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s90: the server is unreachable. A real player must SEE a failure — Lua state goes Failed
// with UNREACHABLE, and the DOM failure banner (#mp-banner, play/index.html) appears.
import assert from 'node:assert/strict';

export default async function run(ctx) {
  // Port 9 (discard) — nothing listens there; the WS fails without ever opening.
  const a = await ctx.launchClient('bot-down', '', {
    mpUrl: 'ws://127.0.0.1:9/ws',
    waitExpr: '(window.__omwMP||{}).state === "Failed"',
    waitWhat: '__omwMP.state === Failed (server down)',
  });

  const lastError = await a.eval('(window.__omwMP||{}).lastError || ""');
  ctx.log('lastError:', JSON.stringify(lastError));
  assert.match(lastError, /UNREACHABLE/, 'unreachable server must surface UNREACHABLE');

  // Banner poller runs every 2s — allow a couple of ticks.
  await a.waitFor('!!document.getElementById("mp-banner")', 6000, 'DOM failure banner visible');
  const banner = await a.eval('document.getElementById("mp-banner").textContent');
  ctx.log('banner:', JSON.stringify(banner));
  assert.match(banner, /reload the page to retry/i, 'banner must tell the player what to do');
}
