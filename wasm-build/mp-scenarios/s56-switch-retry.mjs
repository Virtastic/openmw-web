// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s56: A FAILED WORLD SWITCH MUST STAY RETRYABLE.
//
// watchWorldSwitch sets its dedupe latch (`seen = want`) BEFORE dialling, and cleared it only
// when the returned promise REJECTED. But the two soft-failure branches inside rebootIntoWorld
// — no locker session, and no login ticket — showed their notice and returned normally. The
// promise resolved, .catch never ran, and the latch stayed pinned to that destination.
//
// net.switchTo publishes a destination into the mirror and nothing ever unpublishes it, and
// global.lua re-dials the identical worldUrls.public string every time. So `want === seen` on
// every later tick: the first Public click failed with a notice, and every click after it for
// the life of the page was silently swallowed as a duplicate. The player clicks Public, sees
// an error once, and then clicking Public does nothing at all, forever.
//
// Both halves are needed and this asserts both:
//   - the failure must UNLATCH, or the retry is ignored;
//   - the failure must also clear the MIRROR, or the cleared latch simply re-fires the same
//     doomed switch every 250 ms and the player is buried in modals.
//
// The harness authenticates with a password (?mpauto=1), not the SSO locker, so
// __omwLockerToken is empty and the "no locker session" branch is the natural path here. No
// mocking: this is the real failure, taken twice.
import assert from 'node:assert/strict';

const STEP = 20_000;
const DEST = 'ws://127.0.0.1:59999/w/vvardenfell';

const TOUR_UP = "(function(){ var e = document.getElementById('omw-tour');"
  + " return !!(e && e.classList.contains('show')"
  + " && /could not change world/i.test(e.textContent || '')); })()";

const dismiss = async (client, ctx) => {
  await client.eval("(function(){ var b = document.getElementById('omw-tour-next'); if (b) b.click(); })()");
  await ctx.sleep(300);
};

/** Publish a destination the way net.switchTo does. */
const publish = (client) => client.eval(`(function(){ window.omw.state = window.omw.state || {};
  window.omw.state.switchTo = ${JSON.stringify(DEST)}; })()`);

/** Wait for the failure notice, which is the observable proof that a switch was ATTEMPTED.
 *  Deliberately not the mirror: the mirror only clears on the fixed code, so using it here
 *  would mask the latch property behind the mirror property. */
async function waitAttempted(client, ctx, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (String(await client.eval(TOUR_UP)) === 'true') return true;
    await ctx.sleep(250);
  }
  return false;
}

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-a', '');

  // The page must genuinely be in multiplayer mode, or the watcher is not even running and
  // every assertion below would pass for the wrong reason.
  assert.equal(String(await a.eval('!!window.__omwMPEnabled')), 'true',
    'the client is not in multiplayer mode, so the world-switch watcher never started');
  await a.waitFor('!!(window.omw.state)', STEP, 'the Lua mirror appears');

  // Confirm the precondition rather than assuming it: if a locker token existed, this would
  // take the ticket branch instead and the scenario would be testing something else.
  const tok = String(await a.eval("window.__omwLockerToken || ''"));
  assert.equal(tok, '', 'expected no locker session in the harness; this scenario tests that branch');

  // --- first attempt: it must fail, and it must say so ------------------------------------
  await publish(a);
  assert.ok(await waitAttempted(a, ctx),
    'the first switch was never attempted, or failed without telling the player anything');
  ctx.log('  first switch failed and the player was told');

  // The mirror must be cleared by the failure. net.switchTo publishes a destination and
  // nothing ever unpublishes it, so a latch cleared over a mirror that still holds the
  // destination re-fires the same doomed switch every 250 ms.
  const left = String(await a.eval("window.omw.state.switchTo || ''"));
  assert.equal(left, '',
    'the failed destination is still sitting in the mirror; whatever clears the dedupe latch '
    + 'will now re-fire this switch several times a second');

  await dismiss(a, ctx);

  // --- second attempt at the SAME destination: this is the regression --------------------
  // Before the fix the latch was pinned to DEST by the failed first attempt, so this publish
  // was swallowed as a duplicate and the player's second click did nothing at all.
  await publish(a);
  assert.ok(await waitAttempted(a, ctx),
    'the SECOND switch to the same world was swallowed as a duplicate — a failed first '
    + 'attempt pinned the dedupe latch, so Public is dead for the life of the page');
  ctx.log('  second switch to the same world was attempted, not swallowed');

  // --- and it must not retry on its own ---------------------------------------------------
  await dismiss(a, ctx);
  await ctx.sleep(2000);
  assert.equal(String(await a.eval(TOUR_UP)), 'false',
    'the switch re-fired by itself with no new click — a cleared latch over an uncleared '
    + 'mirror retries several times a second and buries the player in modals');
  ctx.log('  ok: retryable on a new click, and silent without one');

  assert.deepEqual(a.jsErrors(), [],
    'an uncaught exception on the switch path:\n' + a.logTail());
}
