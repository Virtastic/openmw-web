// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s46 (Phase C/E3, UI/UX): the multiplayer windows as a PLAYER meets them.
//
// Every other scenario asserts state — mirrors, positions, roster contents. None of them
// prove a player can actually see or reach any of it. A feature can be perfectly correct on
// the wire and completely unusable: a window that renders empty, a list that never refreshes
// after an action, a refusal that goes nowhere. That is the gap this covers.
//
// It does two things automation can genuinely do here:
//   1. Drives the real flows (open -> request -> accept -> refresh) and asserts the WINDOW
//      state changed, not just the network state.
//   2. Captures screenshots at each step, so the visual result is reviewable rather than
//      inferred. Layout and legibility remain a human judgement (PLAYTEST.md) — these are
//      the evidence for that judgement, not a substitute for it.
//
// The windows are opened through a test-only event because the harness cannot inject SDL
// keys, so F and G cannot be pressed. That the KEYS themselves work is a playtest item.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STEP = 20_000;
const SHOTS = mkdtempSync(join(tmpdir(), 'omw-mp-ui-'));

const jsonOf = async (c, key, dflt = '[]') => JSON.parse(await c.eval(`window.omw.state.${key}||'${dflt}'`));

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('ui-a'), ctx.launchClient('ui-b')]);
  ctx.log(`screenshots -> ${SHOTS}`);

  // --- 1. The social window opens and renders an empty state ------------------------
  // An empty list must still be a WINDOW with an explanatory line, not a blank box: "no
  // friends yet" and "the feature is broken" must not look the same to a player.
  await a.waitFor("window.omw.state.friends !== undefined", STEP, 'A has a friend list');
  await a.eval("window.omw.send('openui:social')");
  await ctx.sleep(2000);
  ctx.log(`  social window (empty): ${await a.screenshot(join(SHOTS, '1-social-empty.png'))}`);

  // --- 2. An incoming request must SURFACE without the player hunting for it ---------
  await b.eval(`window.omw.send('social:FriendRequest:${a.name}')`);
  await a.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`,
    STEP, 'A can see the incoming request in its window state');
  await ctx.sleep(1500);
  ctx.log(`  social window (request pending): ${await a.screenshot(join(SHOTS, '2-social-request.png'))}`);

  // --- 3. Accepting refreshes BOTH windows --------------------------------------------
  // The window rebuilds by destroy+create, so a missing re-render leaves the player looking
  // at a stale list and pressing a button that no longer means anything.
  const req = (await jsonOf(a, 'friendRequests'))[0];
  await a.eval(`window.omw.send('social:FriendAccept:${req.acct}')`);
  await a.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'A list refreshed');
  await b.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'B list refreshed');
  await ctx.sleep(1500);
  ctx.log(`  social window (friend added): ${await a.screenshot(join(SHOTS, '3-social-friend.png'))}`);

  const friend = (await jsonOf(a, 'friends'))[0];
  assert.equal(friend.name, b.name, 'the row must show a human name, not an account key');
  assert.equal(friend.online, true, 'a connected friend must read as online');

  // --- 4. A refusal reaches the player ------------------------------------------------
  // Asking for somebody who does not exist. The player must SEE why; a silent no-op is
  // indistinguishable from a broken server, which is the whole reason SocialResult exists.
  await a.eval("window.omw.send('social:FriendRequest:NoSuchPerson')");
  await a.waitFor(`(JSON.parse(window.omw.state.socialResult||'{}').detail||'') === 'no_such_player'`,
    STEP, 'A was told why the request failed');
  await ctx.sleep(1000);
  ctx.log(`  social window (refusal shown): ${await a.screenshot(join(SHOTS, '4-social-refusal.png'))}`);

  // (There is no admin window any more: operators act from the web dashboard, which s93
  // drives in a real browser. Section 5 used to assert its rank-filtered menu here.)

  ctx.log(`UI screenshots written to ${SHOTS} — review for layout and legibility`);
}
