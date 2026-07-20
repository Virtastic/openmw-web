// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s91: wrong password for an existing account. The register-then-login-on-exists flow must
// end in Failed/AUTH_FAILED (after one reconnect), and the player must see the banner —
// not silence. Also proves a failed auth does NOT appear in /status.
import assert from 'node:assert/strict';

export default async function run(ctx) {
  // Create the account with the harness password, then leave.
  const owner = await ctx.launchClient('bot-w');
  const account = owner.name;
  owner.close();

  // Same account, wrong password, no auto-login.
  const imp = await ctx.launchClient('bot-w-imp', `&name=${encodeURIComponent(account)}&pass=wrong-password`, {
    noAuto: true,
    waitExpr: '(window.__omwMP||{}).state === "Failed"',
    waitWhat: '__omwMP.state === Failed (wrong password)',
  });

  const lastError = await imp.eval('(window.__omwMP||{}).lastError || ""');
  ctx.log('lastError:', JSON.stringify(lastError));
  assert.match(lastError, /AUTH_FAILED/, 'wrong password must surface AUTH_FAILED');

  await imp.waitFor('!!document.getElementById("mp-banner")', 6000, 'DOM failure banner visible');

  const status = await ctx.serverStatus();
  assert.equal(status.players.length, 0, 'failed auth must not occupy a roster slot');
  ctx.log('ok: AUTH_FAILED surfaced, banner shown, roster empty');
}
