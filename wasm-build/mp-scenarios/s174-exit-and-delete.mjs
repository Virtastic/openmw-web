// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s174: EXIT, THEN DELETE THE CHARACTER. A player leaves the world the way the UI does --
// Escape, the main menu's Exit, its confirmation (mainmenu.cpp -> index.html
// __omwExitToLauncher -> 'leaving' -> PlayerLeaving) -- and goes straight to the character
// screen and deletes the character they were just playing (frontdoor.ts characterRoutes).
//
// The bug this guards (2026-09-23): the server waited for the socket close to take the
// character out of the world, a close that behind a proxy arrived only when the keepalive gave
// up, 86 s later -- and for all of that time the delete was refused as "being played right
// now". leaving.test.ts proves the server half over a TestClient; this proves the whole trip,
// with somebody else in the world watching, because "out of the world" has two more audiences
// than the roster: the watching client's puppet, and the sim peer's avatar body. A ghost on
// either is a solid, AI-off body standing where the player left.
//
// Shape: A owns a character world (the id DERIVED from the character, so the gateway's
// isPlayed check applies to it), B is A's friend and a guest in it, and the world's own
// managed peer holds the cell. A exits; B must lose A's row and puppet, the peer must despawn
// A's avatar, and the delete must be accepted -- with numbers for how long each took.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, harnessSession, grantLockerSession } from './_gateway.mjs';

export const managedPeer = true;
// The harness respawn point is the Example Suite village (26,25): open sea in retail, where A
// was dying during setup. The shipped default (where you fell) instead.
export const serverRules = 'respawnCellKey = ""';
export const bootTimeoutMs = 420_000;
const GW_PORT = 19200; // ten apart from its neighbours (see s102)
const STEP = 30_000;
// INDOORS: at the Seyda Neen dock a level-1 character idling through the setup below was
// killed by a slaughterfish (mw_death.mp3 at +4 min), and a dead player cannot walk or exit.
const BOOT = { retail: true, joinTimeoutMs: 420_000, startCell: 'Seyda Neen, Census and Excise Office' };
const ESC = { key: 'Escape', code: 'Escape', keyCode: 27, text: '' };
// The engine's own widgets at the default 640x360 harness window, as fractions of the canvas
// (measured from a screenshot of the menu; mp-harness clickCanvas).
const EXIT_BUTTON = [0.49, 0.68]; // Return / Options / Exit, centred; Exit at (315,186) of 640x273
const CONFIRM_YES = [0.455, 0.54]; // "Quit Morrowind?" Yes at (291,147)

export default async function run(ctx) {
  const gw = `http://127.0.0.1:${GW_PORT}`;
  const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
  const A_HANDLE = `leaver${tag}`, B_HANDLE = `watch${tag}`;

  // B, the watcher, in their own world first -- where everybody is before they go anywhere.
  const watch = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'del-watch', ownId: 'priv-del-watch', boot: BOOT });
  const B = watch.client;
  try {
    // A: a character, then ITS world, whose id the gateway derives from the character id (the
    // launcher's POST /worlds {characterId}). A harness account only comes into being at its first world sign-in (?mpauto registers
    // there), and that sign-in gives it its first character. So A signs in once, in a
    // throwaway world, and that character is the one A then plays from the character screen.
    const first = await addClient(ctx, GW_PORT, { name: 'del-leaver', ownId: 'priv-del-leaver-first' });
    await first.client.close();
    const accountA = first.account;
    const tokenA = await harnessSession(GW_PORT, accountA);
    const authA = { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' };
    const listed = await (await fetch(`${gw}/auth/characters`, { headers: authA })).json();
    const charId = listed.characters?.[0]?.id;
    assert.ok(charId, `A's first sign-in must have given the account a character: ${JSON.stringify(listed)}`);
    const mk = await fetch(`${gw}/worlds`, { method: 'POST', headers: authA, body: JSON.stringify({ mode: 'private', characterId: charId }) });
    const worldA = (await mk.json()).id;
    assert.equal(mk.status, 200, `A's character world must be creatable (${mk.status})`);
    assert.ok(worldA.endsWith('-' + charId.slice(-8)), `the world id must be derived from the character: ${worldA} / ${charId}`);
    for (const by = Date.now() + 60_000; Date.now() < by;) {
      if ((await (await fetch(`${gw}/worlds/${worldA}`)).json()).up) break;
      await ctx.sleep(1000);
    }
    const urlA = `ws://127.0.0.1:${GW_PORT}/w/${worldA}`;
    // The launcher boots the chosen character with #mpchar/#mpcharname; the harness URL builder
    // only knows #mphome, so the boot fragment is completed before the page's own scripts run.
    // mpchar only: #mpcharname sets OPENMW_MP_NAME, which the harness sign-in (?mpauto) uses as
    // the ACCOUNT name -- it signed in as a stranger ('Leaver') and was refused as private.
    const frag = `&mpchar=${encodeURIComponent(charId)}`;
    const A = await ctx.launchClient('del-leaver', '', { mpUrl: urlA, homeUrl: urlA, ...BOOT,
      newDocScript: `if (/index\\.html/.test(location.pathname) && !/mpchar=/.test(location.hash)) history.replaceState(null, '', location.href + ${JSON.stringify(frag)});` });
    await grantLockerSession(A, GW_PORT, accountA);

    // Friends, Party, and B walks into A's world.
    await A.cmd(`profile:del-leaver@example.com:${A_HANDLE}`);
    await B.cmd(`profile:del-watch@example.com:${B_HANDLE}`);
    for (const [who, c] of [['A', A], ['B', B]]) {
      await c.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await c.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    await A.cmd(`social:FriendRequest:${B_HANDLE}`);
    await B.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await B.cmd(`social:FriendAccept:${A_HANDLE}`);
    await A.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    await A.cmd('worldmode:party');
    await A.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    const acctA = JSON.parse(await B.eval("window.omw.state.friends||'[]'"))[0].acct;
    await B.cmd(`joinfriend:${acctA}`);
    const rowOf = (h) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(h)}; }) || {})`;
    await A.waitFor(`${rowOf(B_HANDLE)}.id !== undefined`, 300_000, "B reached A's world");
    await B.waitFor('window.omw.state.state === "Joined"', 60_000, "B is joined in A's world");
    await grantLockerSession(B, GW_PORT, watch.account);
    const idA = Number(await A.eval('window.omw.state.selfId'));
    assert.ok(idA > 0, 'A has a connection id');

    // PRECONDITIONS, so every "gone" below is about something that was there: B sees A's row
    // and A's puppet, the world has a peer, the peer spawned A's avatar, and the character is
    // a real slot on the account (it is only written when creation finishes).
    await B.waitFor(`${rowOf(A_HANDLE)}.id === ${idA}`, STEP, "A in B's roster");
    await B.waitFor(`!!JSON.parse(window.omw.state.puppets||'{}')['${idA}']`, 120_000, "A's puppet on B");
    await B.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 300_000, "A's world has a peer holding the cell");
    const spawnedRe = new RegExp(`avatar spawned for #${idA}\\b`);
    for (const by = Date.now() + 180_000; Date.now() < by && !spawnedRe.test(ctx.childLogTail('gateway')); ) await ctx.sleep(2000);
    assert.ok(spawnedRe.test(ctx.childLogTail('gateway')), `the peer never spawned A's avatar (#${idA}) -- nothing for a ghost check to see`);
    const slots = async () => ((await (await fetch(`${gw}/auth/characters`, { headers: authA })).json()).characters ?? []).map((c) => c.id);
    for (const by = Date.now() + 60_000; Date.now() < by && !(await slots()).includes(charId); ) await ctx.sleep(2000);
    assert.ok((await slots()).includes(charId), `A's character never became a slot: ${JSON.stringify(await slots())}`);
    ctx.log(`ok: A (#${idA}, ${charId}) plays in ${worldA}; B watches; the peer holds A's avatar`);

    // A plays for a moment: walks where B can see. A fresh retail character boots with a
    // window up (uiMode Interface), which owns the controls -- Escape closes it first.
    await A.eval("document.getElementById('canvas').focus(); 1");
    for (let i = 0; i < 3 && String(await A.eval('window.omw.state.uiMode||"none"')) !== 'none'; i++) { await A.key(ESC); await ctx.sleep(2500); }
    // Not the subject: a cramped office can stop a walk short, so it is reported, not judged.
    const walked = await A.walk(0, 1, 2500, 15).then((p) => JSON.stringify(p), (e) => 'blocked: ' + e.message.slice(0, 80));
    ctx.log(`A walked: ${walked}`);
    await ctx.sleep(3000);

    // EXIT, the way the UI does it. Escape opens the main menu; Exit; the confirmation.
    // A window may be up first (a fresh retail character boots with one: uiMode Interface), and
    // Escape closes that before the next one opens the menu -- a player presses it twice too.
    await A.eval("document.getElementById('canvas').focus(); 1");
    for (let i = 0; i < 4 && String(await A.eval('window.omw.state.uiMode')) !== 'MainMenu'; i++) { await A.key(ESC); await ctx.sleep(2500); }
    assert.equal(String(await A.eval('window.omw.state.uiMode')), 'MainMenu', 'Escape never opened the main menu');
    await ctx.sleep(1500); // the menu fades in; a click before it is drawn lands on nothing
    ctx.log(`Exit at ${JSON.stringify(await A.clickCanvas(...EXIT_BUTTON))}`);
    await ctx.sleep(1500);
    // Yes -- again if the first click landed before the box was drawn (a frame can take seconds).
    for (let i = 0; i < 3 && /index\.html/.test(String(await A.eval('location.pathname').catch(() => 'navigating'))); i++) {
      ctx.log(`confirm at ${JSON.stringify(await A.clickCanvas(...CONFIRM_YES))}`);
      await ctx.sleep(4000);
    }
    const t0 = Date.now();
    const exitIso = new Date(t0 - 15_000).toISOString(); // the click landed before the page left
    try {
      await A.waitFor('!/index\\.html/.test(location.pathname)', STEP, 'Exit took the page to the launcher');
    } catch (e) {
      await A.screenshot('/repo/wasm-build/harness-out/s174-exit.png').catch(() => {});
      throw new Error(`Exit never left the game (screenshot wasm-build/harness-out/s174-exit.png): ${e.message}`);
    }
    ctx.log(`ok: A exited through the menu (${await A.eval('location.pathname')})`);

    // The watcher, WHILE still in A's world (a Party world closes to its guests when the owner
    // leaves, and B is sent home in up to 30 s -- so this is read first, and read fast).
    let rowGone = null, puppetGone = null;
    for (const by = Date.now() + 20_000; Date.now() < by && (rowGone === null || puppetGone === null);) {
      const s = JSON.parse(await B.eval(`JSON.stringify({ row: ${rowOf(A_HANDLE)}.id !== undefined, pup: !!JSON.parse(window.omw.state.puppets||'{}')['${idA}'] })`));
      if (!s.row && rowGone === null) rowGone = Date.now() - t0;
      if (!s.pup && puppetGone === null) puppetGone = Date.now() - t0;
      if (rowGone === null || puppetGone === null) await ctx.sleep(250);
    }
    ctx.log(`B: A's roster row gone after ${rowGone} ms, puppet gone after ${puppetGone} ms`);
    assert.ok(rowGone !== null, "B still lists A 20 s after A exited: a ghost in the roster");
    assert.ok(puppetGone !== null, "B still has A's puppet 20 s after A exited: a ghost body");

    // THE DELETE, from the character screen, as soon as the player gets there.
    const del = async () => (await (await fetch(`${gw}/auth/characters?id=${encodeURIComponent(charId)}`, { method: 'DELETE', headers: authA })).json());
    const firstTry = Date.now() - t0;
    let res = await del();
    const firstAnswer = res;
    // Measured, not only judged: if it is refused, how long until it is not.
    for (const by = Date.now() + 120_000; !res.ok && /being played/.test(String(res.error)) && Date.now() < by;) { await ctx.sleep(2000); res = await del(); }
    const acceptedAt = res.ok ? Date.now() - t0 : null;
    ctx.log(`DELETE at +${firstTry} ms answered ${JSON.stringify(firstAnswer)}; accepted at ${acceptedAt === null ? 'never' : '+' + acceptedAt + ' ms'}`);
    assert.equal(firstAnswer.ok, true, `deleting the character right after Exit was refused: ${JSON.stringify(firstAnswer)}`
      + ` (asked ${firstTry} ms after Exit; ${acceptedAt === null ? 'still refused 120 s later' : `accepted ${acceptedAt} ms after Exit`})`);
    assert.ok(!(await slots()).includes(charId), 'the character is still on the account after the delete');

    // The peer: A's avatar was despawned, and nothing respawned it afterwards.
    const log = ctx.childLogTail('gateway');
    const despawnRe = new RegExp(`puppet despawned for [^"\\n]*\\(#${idA}\\)`);
    // ONLY what the peers said after the exit: A's first sign-in world had its own #1, spawned
    // and despawned long before (every world's peer narrates into the gateway's log).
    const lines = log.split('\n').filter((l) => { const m = /"ts":"([^"]+)"/.exec(l); return m && m[1] >= exitIso; });
    const despawnAt = lines.findIndex((l) => despawnRe.test(l));
    const respawn = despawnAt >= 0 && lines.slice(despawnAt + 1).some((l) => spawnedRe.test(l));
    ctx.log(`peer: despawn line ${despawnAt >= 0 ? 'seen' : 'MISSING'}; respawned after: ${respawn}`);
    assert.ok(despawnAt >= 0, `the peer never despawned A's avatar (#${idA}): a ghost body on the simulator`);
    assert.ok(!respawn, "the peer spawned A's avatar again after A left");

    // And the world's roster: A's world is retired with the character, or at least empty of A.
    const w = await (await fetch(`${gw}/worlds/${worldA}`)).json().catch(() => ({}));
    ctx.log(`A's world after the delete: ${JSON.stringify(w)}`);
    assert.ok(!w.up || w.playerCount === 0 || w.error, `A's world still counts players after A left and deleted: ${JSON.stringify(w)}`);
    ctx.log(`PASS: exit -> delete accepted at +${firstTry} ms; B lost A's row in ${rowGone} ms and puppet in ${puppetGone} ms; the peer despawned the avatar`);
  } finally {
    watch.stop();
  }
}
