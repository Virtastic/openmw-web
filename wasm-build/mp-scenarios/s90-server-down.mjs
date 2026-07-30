// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s90: the server is unreachable. A real player must SEE a failure — Lua state goes Failed
// with UNREACHABLE and the failure modal appears.
//
// Self-redial (s81) made this retry with backoff, which is right for a drop AFTER joining
// (the character is in there, the resume ticket rejoins in place) but wrong for a server that
// was never reachable: it retried silently forever and the player watched a boot screen with
// no explanation. net.lua now gives up visibly after UNREACHABLE_ATTEMPTS when it never
// joined.
import assert from 'node:assert/strict';

export default async function run(ctx) {
  // Port 9 (discard) — nothing listens there; the WS fails without ever opening.
  const a = await ctx.launchClient('bot-down', '', {
    mpUrl: 'ws://127.0.0.1:9/ws',
    waitExpr: '(window.__omwMP||{}).state === "Failed"',
    waitWhat: '__omwMP.state === Failed (server down)',
    joinTimeoutMs: 90_000, // the backoff ladder runs before it gives up
  });

  const lastError = await a.eval('(window.__omwMP||{}).lastError || ""');
  ctx.log('lastError:', JSON.stringify(lastError));
  assert.match(lastError, /UNREACHABLE/, 'unreachable server must surface UNREACHABLE');

  // The failure surface is a modal now (index.html mpErrorModal), not the old #mp-banner.
  await a.waitFor('!!document.getElementById("mp-error-modal")', 8000, 'failure modal visible');
  const shown = await a.eval('document.getElementById("mp-error-modal").textContent');
  ctx.log('modal:', JSON.stringify(shown));
  assert.match(shown, /reach|retry|reload|join/i, 'the modal must tell the player what happened');
}
