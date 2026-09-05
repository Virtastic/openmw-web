// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s93: the multiplayer server's dashboard, in a real browser.
//
// Nothing else in CI loads server/web/app.js in a browser; the server suite asserts against its
// TEXT. A ReferenceError inside a page handler ships green that way, which is how three
// undeclared identifiers once killed chat (see the harness's jsErrors gate). So this drives the
// real page against a real gateway with a real game and a real player in it:
//
//   sign in -> the Overview lists the player, labelled with whose game they are in
//           -> clicking the game opens THAT game's console, proxied through the gateway
//           -> kicking them there removes the row.
//
// Asserting the page throws nothing is worth more than the clicks, and the harness does that
// for every client at teardown.
import assert from 'node:assert/strict';
import { startGatewayAndClient } from './_gateway.mjs';

const OWNER = { name: 'owner@example.com', password: 'a-long-enough-passphrase' };

export default async function run(ctx) {
  const gwPort = 18780 + (Number(String(ctx.runId).replace(/\D/g, '').slice(-2)) % 100);
  const { client: bot, ownId, stop } = await startGatewayAndClient(ctx, { gwPort, name: 'bot-dash', ownId: 'priv-dash-world' });
  const base = `http://127.0.0.1:${gwPort}/admin/api`;
  try {
    // The operator: first-run owner creation (loopback needs no setup key), then the wizard's
    // finished answer, which also writes the mode marker into the shared dir. Both through
    // the API, because the wizard's later steps are file uploads this harness has no files for.
    const owner = await fetch(`${base}/setup/owner`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
    });
    assert.equal(owner.status, 200, `owner creation on the multiplayer server (${owner.status})`);
    const token = (await owner.json()).token;
    const setup = await fetch(`${base}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ deploymentMode: 'multiplayer', completed: true }),
    });
    assert.equal(setup.status, 200, 'the wizard answer is accepted with no environment flag');

    // The server side of the page, first: a failing overview would otherwise surface only as
    // a page that never finishes rendering.
    const auth = { authorization: `Bearer ${token}` };
    const ov = await fetch(`${base}/overview`, { headers: auth });
    const ovText = await ov.text();
    assert.equal(ov.status, 200, `overview answers (${ov.status}): ${ovText.slice(0, 300)}`);
    const ovJson = JSON.parse(ovText);
    assert.equal(ovJson.platform, true, 'the multiplayer server answers as the platform');
    ctx.log(`overview: ${ovJson.players?.length ?? '?'} player(s), ${ovJson.games?.length ?? '?'} game(s)`);

    // The page. A browser tab at /admin, signed in the way the page signs itself in.
    const page = await ctx.launchClient('admin', '', {
      url: `http://127.0.0.1:${gwPort}/admin`,
      waitExpr: `!!document.getElementById('mainNav')`,
      waitWhat: 'the dashboard shell loaded',
    });
    await page.eval(`sessionStorage.setItem('omwmp_admin_token', ${JSON.stringify(token)}); location.reload(); 'reloading'`);

    // PEOPLE FIRST: the bot, in its own game. On a miss, say what the page DID show.
    // innerText is what a person SEES, CSS text-transform included: table headers render in
    // capitals, so every text match below is case-insensitive.
    const shown = async () => page.eval(
      `location.hash + ' | ' + (document.getElementById('pageTitle')||{}).textContent + ' | ' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400)`);
    try {
      await page.waitFor(`/in whose game/i.test(document.body.innerText)`, 20_000,
        'the people-first Overview rendered');
    } catch (err) {
      throw new Error(`${err.message}\n--- page showed ---\n${await shown().catch((e) => String(e))}`);
    }
    const botName = (await bot.eval(`(window.__omwMP||{}).name || ''`)) || '';
    await page.waitFor(`document.body.innerText.includes(${JSON.stringify(ownId)})`, 15_000,
      `the game ${ownId} is listed`);
    const text = await page.eval('document.body.innerText');
    assert.ok(/Playing now/.test(text), 'the Overview leads with who is playing');
    assert.ok(!/Nobody is playing right now/.test(text.split('Games')[0] ?? text),
      'the player in the game must be listed, not "nobody"');
    ctx.log(`ok: overview lists a player in ${ownId}${botName ? ` (${botName})` : ''}`);

    // CLICK THROUGH: the game's own console, by proxy under the same sign-in.
    await page.eval(`location.hash = '#game=' + ${JSON.stringify(ownId)}; 'go'`);
    await page.waitFor(`location.hash === '#console' && /in the world/i.test(document.body.innerText)`,
      20_000, "the game's console opened through the proxy");
    await page.waitFor(`!!document.querySelector('[data-act="kick"]')`, 10_000,
      'the roster has the player, with a kick button');
    assert.ok(/back to all games/i.test(await page.eval(`document.body.innerText`)),
      'the page says which game it is looking at');
    ctx.log('ok: the game console opened by proxy');

    // ACT: kick from the game's page. The confirm modal is only for bans; kick is direct.
    await page.eval(`document.querySelector('[data-act="kick"]').click(); 'kicked'`);
    await page.waitFor(`!document.querySelector('[data-act="kick"]')`, 20_000,
      'the kicked player left the roster');
    await bot.waitFor(`(window.__omwMP||{}).state !== "Joined"`, 20_000,
      'the bot was actually disconnected');
    ctx.log('ok: kicked through the proxy, and the row went');

    // BACK: leaving the game returns to the people-first page.
    await page.eval(`location.hash = '#games'; 'back'`);
    await page.waitFor(`location.hash === '#overview' && /in whose game/i.test(document.body.innerText)`,
      10_000, 'back to all games');
    ctx.log('PASS: the multiplayer dashboard works in a browser');
  } finally {
    stop();
  }
}
