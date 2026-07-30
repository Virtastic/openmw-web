// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s55: the handle picker. [login] requireProfile refuses SessionReady until email+username
// are set, and holds the session open so the client can answer. Nothing ever asked the
// player, so the flag was unusable — and while it was off, player.name fell back to the
// account login name, which for an SSO account is the person's REAL NAME. This drives the
// whole gate: held at ProfileNeeded -> picker shown -> handle submitted -> in the world.
import assert from 'node:assert/strict';

export const serverRules = '[login]\nrequireProfile = true';

export default async function run(ctx) {
  // The client cannot reach Joined until the handle is set, so wait on the HOLD state.
  const a = await ctx.launchClient('bot-prof', '', {
    waitExpr: '(window.__omwMP||{}).state === "ProfileNeeded"',
    waitWhat: '__omwMP.state === ProfileNeeded',
  });
  ctx.log('ok: server held the session at ProfileNeeded');

  await a.waitFor(`!!document.getElementById('omw-uname')`, 8000,
    'the handle picker appeared (without it the gate is a dead end)');
  assert.equal(await a.eval(`(window.__omwMP||{}).profileRequired`), 'true',
    'profileRequired must be mirrored for the picker to trigger on');
  ctx.log('ok: picker shown');

  // This account has no provider email, so the picker must ask for one — otherwise the gate
  // is unsatisfiable for any account that did not arrive via SSO.
  assert.ok(await a.eval(`!!document.getElementById('omw-uname-em')`),
    'no email on the account, so the picker must ask for one');
  await a.eval(`document.getElementById('omw-uname-em').value = 'bot@example.com'`);

  // A bad handle must be REFUSED and explained, not silently swallowed.
  await a.eval(`document.getElementById('omw-uname-in').value = 'no spaces!'`);
  await a.click('#omw-uname-go');
  await a.waitFor(
    `/only|refused|spaces/i.test(document.getElementById('omw-uname-err').textContent)`,
    8000, 'a malformed handle is explained to the player');
  ctx.log('ok: bad handle refused with a reason');

  // A good one lets the player into the world.
  const handle = 'bot' + Math.random().toString(36).slice(2, 8);
  await a.eval(`document.getElementById('omw-uname-in').value = ${JSON.stringify(handle)}`);
  await a.click('#omw-uname-go');
  await a.waitFor(`!document.getElementById('omw-uname')`, 10000, 'the picker closed on success');
  await a.waitFor(`(window.__omwMP||{}).state === "Joined"`, 15000,
    'setting a handle completed the join');
  ctx.log(`ok: handle "${handle}" accepted and the player entered the world`);

  const luaErrs = a.luaErrors();
  assert.equal(luaErrs.length, 0, 'Lua errors during run:\n' + luaErrs.join('\n'));
}
