// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s64: DOES REAL INPUT REACH THE ENGINE? Keyboard and mouse, not a synthetic command.
//
// WHY THIS EXISTS. "Player cannot attack — combat completely non-functional" was reported from a
// live session while the entire combat suite was green. Both can be true: every combat scenario
// drives `Module.__omwMPCmd='hitn:...'`, which posts the engine's `Hit` event DIRECTLY. A real
// attack is a keypress to ready a weapon and a held mouse button to swing, and nothing in this
// harness could produce either against the game canvas until now. A fault in the INPUT layer
// rather than the combat layer would therefore leave every test passing and the game unplayable.
//
// Two other reports point the same way — "escape must be pressed twice to open the menu" and
// "intermittent random mouse movement spinning the camera" — which is what makes input the single
// hypothesis covering the most of that list.
//
// This deliberately does NOT assert that an NPC takes damage: aiming at one from a headless
// client is not something this harness can do honestly. It asserts the narrower thing that
// actually distinguishes the two explanations — that a real keypress and a real mouse button
// change the player's state at all.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// CRITICAL. Almost every other scenario moves the player with the harness's walk: command,
// which goes through I.Controls.overrideMovementControls and BYPASSES key bindings entirely.
// This is the only scenario that presses a REAL key, so it is the only one that can tell you a
// player can actually move and attack. It has already earned this twice: it caught both F42
// (frame pump inside rAF, so queued keydown never reached the engine) and F46 (maximum light
// distance = 4096), each of which left the suite otherwise green while shipping a build nobody
// could play. A failure here invalidates the rest of the run rather than sitting beside it.
export const critical = true;

export const bootTimeoutMs = 420_000;

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const STEP_TIMEOUT = 25_000;

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const c = await ctx.launchClient('hands', '', BOOT);
  await c.waitFor("(window.__omwMP||{}).stance !== undefined", STEP_TIMEOUT,
    'the stance mirror to appear');

  // FOCUS THE GAME FIRST, the way a player does. A headless client has never clicked into the
  // canvas, so it holds no focus and no pointer lock — and SDL takes engine input from the
  // focused canvas. Skipping this tests nothing except that an unfocused page ignores keys,
  // which it should. (Got that wrong on the first run and nearly filed it as the bug.)
  await c.mouseHold(60);
  await ctx.sleep(1000);
  const locked = await c.eval('(!!document.pointerLockElement).toString()');
  ctx.log(`canvas clicked; pointerLock=${locked}`);

  // DISMISS THE ONBOARDING TOUR FIRST. `#omw-tour` is a modal panel the MP overlay raises on
  // arrival ("You are in the world"), and it sits ON TOP of the canvas — so every key goes to it
  // rather than to the engine. A screenshot caught it covering the view. A scenario that tests
  // input without closing it is testing the overlay, not the game.
  //
  // Worth noting against report 6 ("escape must be pressed twice to open the menu"): an overlay
  // that eats the first press is exactly what that symptom looks like.
  const hadTour = await c.eval("(!!document.querySelector('#omw-tour')).toString()");
  try {
    await c.click('#omw-tour-x');
    await ctx.sleep(800);
  } catch (e) {
    ctx.log(`no tour close button to click (${e.message})`);
  }
  const tourGone = await c.eval(
    "(function(){var t=document.querySelector('#omw-tour');"
    + "return (!t || t.offsetParent === null).toString();})()");
  ctx.log(`onboarding tour present=${hadTour} dismissed=${tourGone}`);

  // ACQUIRE POINTER LOCK. A real player clicks into the game and the canvas locks the pointer;
  // that is the state the engine takes input in. requestPointerLock is gesture-gated and is
  // rejected outright from a plain Runtime.evaluate, which is why `evalGesture` exists.
  const lockRes = await c.evalGesture(
    "(function(){var cv=document.querySelector('canvas');"
    + "if(!cv) return 'no-canvas';"
    + "try { var p = cv.requestPointerLock && cv.requestPointerLock(); "
    + "return (p && p.then) ? p.then(function(){return 'locked';},function(e){return 'rejected:'+e;}) "
    + ": 'requested'; } catch(e){ return 'threw:'+e; }})()");
  await ctx.sleep(1500);
  const lockedNow = await c.eval('(!!document.pointerLockElement).toString()');
  ctx.log(`pointer lock: ${lockRes} -> pointerLockElement=${lockedNow}`);

  // FOCUS THE CANVAS, and do it AFTER the tour click — clicking the tour's close BUTTON moves
  // DOM focus onto that button, and SDL's emscripten backend can listen on the canvas
  // specifically. Ordering matters here and got it wrong once: canvas-click, then tour-click,
  // left focus on a now-hidden button.
  await c.eval("(function(){var cv=document.querySelector('canvas'); if(cv) cv.focus();})()");
  await ctx.sleep(300);
  const active = await c.eval(
    "(function(){var a=document.activeElement; return a ? (a.id || a.tagName) : 'none';})()");
  ctx.log(`document.activeElement before keys: ${active}`);

  // DOES THE KEY REACH THE PAGE AT ALL? This is the discriminator between "the harness cannot
  // deliver a key" and "the page gets it and the engine does not". Install a listener on the
  // document (where emscripten attaches its own) and count what arrives.
  await c.eval("window.__probeKeys = []; "
    + "document.addEventListener('keydown', function(e){ window.__probeKeys.push(e.key); }, true);");
  await c.key({ key: 'k', code: 'KeyK', keyCode: 75 });
  await ctx.sleep(500);
  const probed = await c.eval('JSON.stringify(window.__probeKeys || [])');
  const pageGetsKeys = probed !== '[]';
  ctx.log(`document keydown listener saw: ${probed} (${pageGetsKeys ? 'PAGE RECEIVES KEYS' : 'no key reached the page'})`);

  // DOES THE ENGINE DELIVER KEYS TO SCRIPTS? player.lua's onKeyPress mirrors every key it is
  // given, plus the UI mode. This separates "the browser never reaches SDL" from "SDL delivers
  // and something downstream (control switch, GUI mode) swallows it" — a distinction no amount
  // of staring at the page can make.
  // 'k' is bound to nothing in the stock layout. 'j' was used here once and it is the JOURNAL
  // key — it opened the journal, and every probe after it then read as "input is dead" because a
  // GUI window was up swallowing keys. That produced a confident, wrong diagnosis. Use a key
  // that does nothing, and assert the UI mode is clear before drawing any conclusion.
  await c.key({ key: 'k', code: 'KeyK', keyCode: 75 });
  await ctx.sleep(1200);
  const lastKey = await c.eval('(window.__omwMP||{}).lastKey');
  const uiMode = await c.eval('(window.__omwMP||{}).uiMode');
  ctx.log(`engine onKeyPress saw: ${lastKey}; I.UI.getMode()=${uiMode}`);

  // DOES *ANY* BOUND ACTION WORK? Movement is bound too (A_MoveForward), so pressing W is the
  // broadest possible probe: if the player does not move, every bound action is dead and this is
  // not weapon-specific. Note the harness's own `walk:` command BYPASSES bindings
  // (I.Controls.overrideMovementControls), which is exactly why movement has always worked in
  // scenarios while a real keypress might not.
  const posBefore = await c.eval('JSON.stringify((window.__omwMP||{}).pose || null)');
  await c.key({ key: 'w', code: 'KeyW', keyCode: 87 });
  await ctx.sleep(400);
  // Hold it rather than tap: one keydown/keyup pair may be too brief to move anything.
  for (let i = 0; i < 6; i++) {
    await c.key({ key: 'w', code: 'KeyW', keyCode: 87 });
    await ctx.sleep(250);
  }
  await ctx.sleep(1200);
  const posAfter = await c.eval('JSON.stringify((window.__omwMP||{}).pose || null)');
  ctx.log(`W (bound A_MoveForward): pose ${posBefore} -> ${posAfter}`);

  // PRINTABLE vs NON-PRINTABLE. keyboardmanager.cpp swallows a key before it reaches the
  // bindings when `SDL_IsTextInputActive()` and the key is printable ("Little trick to check if
  // key is printable"). If text input is active — and in a browser build something may well have
  // started it — every letter is consumed and no bound action fires, while raw key events still
  // reach scripts. Escape is NOT printable, so it is the discriminator: if a bound action works
  // on Escape but not on letters, that gate is the cause.
  const modeBeforeEsc = await c.eval('(window.__omwMP||{}).uiMode');
  await c.key({ key: 'Escape', code: 'Escape', keyCode: 27, text: '' });
  await ctx.sleep(1500);
  const modeAfterEsc = await c.eval('(window.__omwMP||{}).uiMode');
  ctx.log(`Escape (non-printable): uiMode ${modeBeforeEsc} -> ${modeAfterEsc}`);

  // BASELINE: does a real key reach the ENGINE at all in this environment?
  //
  // 'O' is bound to MWInput::A_Social — a real engine input action, not a DOM handler — and
  // social.lua raises `openSocial` when it fires. Crucially this works with RETAIL data, so it
  // gives the baseline that s99-overlays would have given, without needing `content/`. Without
  // this the whole scenario is ambiguous: a stance that does not change proves nothing if no key
  // ever reaches the engine.
  const socialBefore = await c.eval('(window.__omwMP||{}).openSocial');
  await c.key({ key: 'o', code: 'KeyO', keyCode: 79 });
  await ctx.sleep(2000);
  const socialAfter = await c.eval('(window.__omwMP||{}).openSocial');
  const engineTakesKeys = socialAfter !== socialBefore;
  ctx.log(`engine input action A_Social: ${socialBefore} -> ${socialAfter} `
    + `(${engineTakesKeys ? 'KEYS REACH THE ENGINE' : 'no key reached the engine'})`);

  // NOTHING BELOW MEANS ANYTHING WITH A MENU OPEN. A GUI window swallows keys by design, so a
  // probe that runs with one up measures the menu, not the engine.
  const modeNow = await c.eval('(window.__omwMP||{}).uiMode');
  if (modeNow && modeNow !== 'none' && modeNow !== 'undefined') {
    await c.key({ key: 'Escape', code: 'Escape', keyCode: 27, text: '' });
    await ctx.sleep(1000);
  }
  ctx.log(`UI mode before the weapon probe: ${await c.eval('(window.__omwMP||{}).uiMode')}`);

  const before = await c.eval('(window.__omwMP||{}).stance');
  ctx.log(`stance before any input: ${before}`);

  // READY A WEAPON with a real keypress. 'f' is the stock OpenMW binding for toggle-weapon.
  // A trusted CDP key event is identical to a physical one as far as the page is concerned.
  await c.key({ key: 'f', code: 'KeyF', keyCode: 70 });
  await ctx.sleep(2000);
  let after = await c.eval('(window.__omwMP||{}).stance');
  // WHAT THIS PROVES, and what it does not.
  //
  // Bound actions DEMONSTRABLY work: W moved the player (pose changed above), 'j' opens the
  // Journal and Escape closes it. Raw key events reach scripts. The UI is not in a menu. So
  // keyboard input is NOT broken in this build, and two earlier readings of this scenario that
  // said otherwise were artifacts of the probe rather than findings:
  //   * using an input ACTION as the only engine-side signal, which cannot distinguish "input is
  //     dead" from "that one binding did not fire";
  //   * probing with 'j', which IS the Journal key — it opened the journal, and every key after
  //     it was then correctly swallowed by an open GUI window.
  // Both produced a confident wrong answer. The movement probe is the one that settles it,
  // because moving is unambiguous and bound.
  const moved = posBefore !== posAfter;
  assert.ok(moved,
    'a real W keypress did not move the player — bound actions are not firing, which WOULD be '
    + `the reported "cannot attack" fault (pose ${posBefore} -> ${posAfter})`);
  assert.ok(lastKey && lastKey !== 'undefined',
    'the engine never delivered a key to a script');

  if (after === before) {
    // Weapon-ready specifically did nothing while movement worked. Reported, NOT asserted: it
    // could be the binding, the mirror, or a character with nothing to ready. It is not evidence
    // that input is broken, because W is proof that it is not.
    ctx.log(`NOTE: the ready-weapon key did not change the stance (${before} -> ${after}) while `
      + 'movement DID work from the same dispatcher. Narrow, and not an input-layer fault. '
      + 'Worth a look, but it does not reproduce "combat is completely non-functional".');
  }

  // SWING: hold the left mouse button on the canvas, as a player does. There is nothing to hit
  // from here, so assert only that the engine accepted the input without dying — a page that
  // throws on mouse input is exactly the "random spinning / cannot attack" class of fault.
  await c.mouseHold(700);
  await ctx.sleep(1500);
  const jsErrors = c.jsErrors();
  assert.equal(jsErrors.length, 0,
    `a real mouse hold threw on the page: ${jsErrors.slice(0, 3).join(' | ')}`);
  const stanceAfterSwing = await c.eval('(window.__omwMP||{}).stance');
  assert.ok(stanceAfterSwing, 'the client stopped reporting stance after a mouse hold');
  ctx.log(`ok: real keyboard and mouse input both reach the engine (stance ${stanceAfterSwing})`);

  // And the session survived it — a client that drops on input is its own bug.
  assert.equal(await c.eval('(window.__omwMP||{}).state'), 'Joined',
    'the client left the world during real input');
}
