// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s94: the things the social panel took over when the typed commands were deleted.
//
// Reporting was `/report <player> <reason>`; muting and blocking could be done from a row and
// undone from NOWHERE; the privacy control lived only in a MyGUI window that stopped drawing.
// Now all four are panel actions, and each one crosses the same three boundaries a rename
// silently breaks: the page's command string, player.lua's parse, and the server's op.
//
// So this drives the real page. It is the only cover for:
//   * 'social:ReportPlayer:<name>:<reason>' — the ONE two-part argument in the whole command
//     set, split in player.lua. A wrong split files a report with an empty reason, which the
//     server refuses with no_reason and the player reads as "reporting is broken".
//   * the blocked/muted mirrors, which are what the Settings tab renders the way back from.
//   * the privacy segment, which had no UI at all between the MyGUI window going and this.
import assert from 'node:assert/strict';

const STEP = 20_000;

const jsonOf = async (c, key, dflt = '[]') =>
  JSON.parse(await c.eval(`window.omw.state.${key}||'${dflt}'`));
/** Click a button in the social panel by its visible label, within the open Settings tab. */
const clickByText = async (c, label) => c.eval(
  `(function(){ var b = [...document.querySelectorAll('#omw-social button')]
      .find(function(x){ return x.textContent.trim() === ${JSON.stringify(label)}; });
    if (!b) return 'not-found'; b.click(); return 'clicked'; })()`);

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('pan-a'),
    ctx.launchClient('pan-b'),
  ]);
  const nameB = b.name;

  await a.waitFor('window.omw.state.friends !== undefined', STEP, 'A received an initial FriendList');
  // The roster has to carry B before A can act on them by name: every person-targeting op
  // resolves a display name against it.
  await a.waitFor(`(window.omw.state.players||'').includes(${JSON.stringify(nameB)})`,
    STEP, 'B is in A\'s roster');

  // --- 1. REPORT, with a reason -----------------------------------------------------------
  // The reason travels after the name in one command string. An empty one comes back
  // 'no_reason', which is exactly what a broken split would produce — so the pass here is
  // ok, and the failure is diagnosable rather than a timeout.
  const why = 'grief-' + Math.random().toString(36).slice(2, 8);
  await a.eval(`window.omw.send('social:ReportPlayer:${nameB}:${why}')`);
  await a.waitFor(
    `JSON.parse(window.omw.state.socialResult||'{}').op === 'ReportPlayer'`,
    STEP, 'the server answered the report');
  const rep = JSON.parse(await a.eval("window.omw.state.socialResult||'{}'"));
  assert.equal(rep.ok, true, `the report was refused: ${JSON.stringify(rep)}`);
  assert.equal(rep.detail, 'ok', `unexpected detail: ${JSON.stringify(rep)}`);
  ctx.log(`ok: reported ${nameB} with a reason (${why})`);

  // --- 2. MUTE and BLOCK put the person on a list the panel can render --------------------
  await a.eval(`window.omw.send('social:MuteAdd:${nameB}')`);
  await a.waitFor(`JSON.parse(window.omw.state.muted||'[]').length === 1`, STEP,
    'the muted list reached the client');
  const muted = await jsonOf(a, 'muted');
  assert.equal(muted[0].name, nameB, `the muted row must name the person, got ${JSON.stringify(muted)}`);

  await a.eval(`window.omw.send('social:BlockAdd:${nameB}')`);
  await a.waitFor(`JSON.parse(window.omw.state.blocked||'[]').length === 1`, STEP,
    'the blocked list reached the client');
  const blocked = await jsonOf(a, 'blocked');
  assert.equal(blocked[0].name, nameB, `the blocked row must name the person, got ${JSON.stringify(blocked)}`);
  ctx.log('ok: mute and block are mirrored as lists, with names');

  // --- 3. THE WAY BACK, from the panel itself ---------------------------------------------
  // Not by sending the command directly: the whole point is that the Settings tab RENDERS an
  // unblock/unmute control and it is wired. Open the panel, switch to Settings, click.
  await a.eval("window.omw.send('openui:social')");
  await a.waitFor("document.getElementById('omw-social').classList.contains('show')",
    STEP, 'the social panel opened');
  await a.eval(`(function(){ var t = document.querySelector('#omw-social [data-t="settings"]');
    if (t) t.click(); return !!t; })()`);
  await a.waitFor(`document.querySelector('#omw-social [data-t="presence"]') !== null`,
    STEP, 'the Settings tab shows the privacy control');

  assert.equal(await clickByText(a, 'unblock'), 'clicked', 'no unblock button in Settings');
  await a.waitFor(`JSON.parse(window.omw.state.blocked||'[]').length === 0`, STEP,
    'unblock from the panel emptied the blocked list');
  assert.equal(await clickByText(a, 'unmute'), 'clicked', 'no unmute button in Settings');
  await a.waitFor(`JSON.parse(window.omw.state.muted||'[]').length === 0`, STEP,
    'unmute from the panel emptied the muted list');
  ctx.log('ok: unblock and unmute, clicked in the panel, reached the server');

  // --- 4. PRIVACY, which had no control at all --------------------------------------------
  // The server echoes the mode it stored; the panel reads that, not what was clicked.
  const pressPresence = (mode) => a.eval(
    `(function(){ var b = document.querySelector('#omw-social [data-presence="${mode}"]');
      if (!b) return 'not-found'; b.click(); return 'clicked'; })()`);
  assert.equal(await pressPresence('private'), 'clicked', 'no private button');
  await a.waitFor(`window.omw.state.presenceMode === 'private'`, STEP,
    'the server stored the private presence mode');
  assert.equal(await pressPresence('public'), 'clicked', 'no public button');
  await a.waitFor(`window.omw.state.presenceMode === 'public'`, STEP,
    'and back to public');
  ctx.log('ok: the privacy control is wired end to end');
}
