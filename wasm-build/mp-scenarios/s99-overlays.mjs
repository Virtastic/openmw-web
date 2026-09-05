// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s99: HTML overlay diagnosis + regression. The chat/social UI lives in index.html's DOM and
// talks to the engine over the window.omw bridge; the MyGUI windows are gone. This
// exercises the REAL key path end-to-end with trusted CDP key events:
//   T -> player.lua toggleChat -> mp.set('openChat') -> JS poll opens the panel + focuses input
//   O -> A_Social action -> social.lua toggle -> mp.set('openSocial') -> panel shows
//   chatx command -> server ChatSend -> ChatMessage -> chatLog mirror (feed data path)
import assert from 'node:assert/strict';

const T = { key: 't', code: 'KeyT', keyCode: 84 };
const O = { key: 'o', code: 'KeyO', keyCode: 79 };
const ESC = { key: 'Escape', code: 'Escape', keyCode: 27, text: '' };

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-ov');

  // The loading screen deliberately OUTLIVES state === "Joined": it stays up through the
  // position-restore gate so a player never sees the default spawn before being put back
  // where they logged out. It covers the whole viewport while it does, so driving the UI
  // before it clears makes every click land on it — the intermittent
  // "clicking the Party tab selected it (click landed on: loading)" failure. Wait for boot
  // to actually finish, which is what a player does.
  await a.waitFor(
    `(function(){ var l = document.getElementById('loading');
       return !l || l.style.display === 'none' || l.classList.contains('hide'); })()`,
    20000, 'the boot loading screen cleared');

  // 0. The overlay DOM must exist (the IIFE at the end of index.html ran without dying).
  assert.equal(await a.eval(`!!document.getElementById('omw-chat') && !!document.getElementById('omw-social')`),
    true, 'overlay DOM missing — the overlay <script> did not run');
  ctx.log('ok: overlay DOM present');

  // 0b. A first-timer (fresh profile) gets the feature tour the moment chargen completes.
  // Close it via its X before exercising the hotkeys.
  await a.waitFor(`document.getElementById('omw-tour').classList.contains('show')`, 8000,
    'feature tour appears for a first-timer');
  await a.eval(`document.getElementById('omw-tour-x').click()`);
  await a.waitFor(`!document.getElementById('omw-tour').classList.contains('show')`, 3000,
    'tour closes via X');
  ctx.log('ok: feature tour shown + dismissed');

  // 1. T opens chat: Lua leg (openChat signal) then JS leg (panel active + input focused).
  // SDL's keyboard listener hangs off the CANVAS (tabindex=0) — a real player focused it by
  // clicking into the game; CDP keys go to the focused element, so focus it explicitly.
  await a.eval(`document.getElementById('canvas').focus()`);
  await a.key(T);
  await a.waitFor(`document.getElementById('omw-chat').classList.contains('active')`, 5000,
    'T opened the chat panel');
  await a.waitFor(`document.activeElement && document.activeElement.id === 'omw-tx'`, 3000,
    'chat input took keyboard focus');
  ctx.log('ok: chat panel open + input focused');

  // 2. The cursor handshake command must be consumed by pollCommands (queue drains).
  // 20s, not 4s. The queue drains once per FRAME (pollCommands runs in onFrame), and a
  // freshly booted client under software
  // rasterisation runs at a fraction of 1 fps -- while the page's pump refills the slot from
  // its outbox every 40 ms. Measured here: a queued `uimode:off` held the slot for 4.5 s, the
  // `uimode:on` behind it for another 1.5 s, and the outbox was empty by 6 s. The 4 s budget
  // was a deadline guessed against a faster machine, and it failed as "the handshake was never
  // consumed" when the handshake was merely third in line.
  await a.waitFor(`window.omw.queue.length === 0`, 20_000, 'uimode:on consumed (queue drained)');
  ctx.log('ok: uimode handshake consumed');

  // 3. Escape closes and hands input back.
  await a.key(ESC);
  await a.waitFor(`!document.getElementById('omw-chat').classList.contains('active')`, 3000,
    'Escape closed the chat panel');
  ctx.log('ok: Escape closes chat');

  // 4. O toggles the social panel (A_Social engine action -> Lua -> JS). Closing the chat
  // blurred its input; give the canvas the keyboard back first (as a real click would).
  await a.eval(`document.getElementById('canvas').focus()`);
  await a.key(O);
  await a.waitFor(`document.getElementById('omw-social').classList.contains('show')`, 5000,
    'O opened the social panel');
  ctx.log('ok: O opens social panel');
  await a.key(ESC);
  await a.waitFor(`!document.getElementById('omw-social').classList.contains('show')`, 3000,
    'Escape closed the social panel');

  // 5. Chat data path: a chatx command must round-trip via the server into the chatLog mirror.
  const nonce = 'n' + Math.random().toString(36).slice(2, 10);
  await a.eval(`window.omw.send(${JSON.stringify('chatx:say::diag ' + nonce)})`);
  await a.waitFor(`(window.omw.state.chatLog||'').includes(${JSON.stringify(nonce)})`, 5000,
    'chatx message round-tripped into chatLog');
  ctx.log('ok: chatx -> server -> chatLog round-trip');

  // 6. REAL typing into the chat input. The engine binds keys on window/document (the same
  // nodes we do), so a shield that only calls stopPropagation lets SDL eat the keystrokes —
  // this asserts characters actually land in the field.
  await a.eval(`document.getElementById('canvas').focus()`);
  await a.key(T);
  await a.waitFor(`document.activeElement && document.activeElement.id === 'omw-tx'`, 4000, 'chat input focused');
  for (const ch of ['h','e','l','l','o']) await a.key({ key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.charCodeAt(0) - 32 });
  await a.waitFor(`document.getElementById('omw-tx').value === 'hello'`, 4000,
    'typed characters reached the chat input (not swallowed by SDL)');
  ctx.log('ok: typing lands in the overlay input');
  await a.key(ESC);

  // 7. REAL mouse input into the social panel, with POINTER LOCK engaged first — a player
  // clicks into the game before pressing O, and SDL then locks the pointer from inside the
  // wasm. While locked the cursor belongs to the canvas and DOM clicks cannot land, so a test
  // that never locks would pass on a panel the player cannot actually click. a.click() dispatches a hit-tested browser
  // click — element.click() would bypass hit-testing and pass even when the canvas covers the
  // panel or a pointer lock owns the cursor, which is the failure being tested for.
  await a.click('#canvas'); // as a player does: enters the game, SDL grabs the pointer
  await ctx.sleep(500);
  ctx.log('pointer lock after clicking the game: ' + await a.eval(`!!document.pointerLockElement`));
  await a.key(O);
  await a.waitFor(`document.getElementById('omw-social').classList.contains('show')`, 4000, 'social opened');
  await a.waitFor(`!document.pointerLockElement`, 3000,
    'pointer lock released when the overlay opened (a locked pointer eats every DOM click)');
  assert.equal(await a.eval(`getComputedStyle(document.getElementById('canvas')).pointerEvents`), 'none',
    'canvas is click-through while an overlay is open');
  // Switch tabs by clicking — proves controls inside the panel receive real input.
  // (the Party tab died with the party concept — Players is the surviving second tab)
  let hit = await a.click('#omw-social [data-t="players"]');
  await a.waitFor(`document.querySelector('#omw-social [data-t="players"]').classList.contains('on')`,
    3000, 'clicking the Players tab selected it (click landed on: ' + hit + ')');
  hit = await a.click('#omw-social-close');
  await a.waitFor(`!document.getElementById('omw-social').classList.contains('show')`, 3000,
    'clicking Close actually closed the panel (click landed on: ' + hit + ')');
  assert.equal(await a.eval(`getComputedStyle(document.getElementById('canvas')).pointerEvents`), 'auto',
    'canvas is interactive again once the overlay closes');
  ctx.log('ok: real mouse clicks land in the social panel');

  // 7b. The panel must NOT rebuild itself while open. The mirror poll used to call
  // renderSocial() every 150ms unconditionally, and the render replaces the panel's DOM — so
  // the friend input was destroyed and recreated ~7x/second, eating focus, typed characters,
  // and any click landing between two renders ("it flashes and I can't click or type").
  // Measured live before the fix: 5 replacements in 2 seconds.
  await a.key(O);
  await a.waitFor(`document.getElementById('omw-social').classList.contains('show')`, 4000, 'social reopened');
  await a.eval(`(function(){
      var first = document.querySelector('#omw-social input');
      window.__rr = { replaced: 0 };
      window.__rrTimer = setInterval(function(){
        var cur = document.querySelector('#omw-social input');
        if (cur !== first) { window.__rr.replaced++; first = cur; }
      }, 100);
    })()`);
  await ctx.sleep(1500);
  const churn = await a.eval(`(clearInterval(window.__rrTimer), window.__rr.replaced)`);
  assert.equal(churn, 0,
    `the social panel rebuilt its DOM ${churn}x while open — focus, typing and clicks die`);
  // And focus must actually survive in the field the player types into. Step 7 left the panel
  // on Players, which has no input — go back to Friends for the field.
  await a.click('#omw-social [data-t="friends"]');
  await a.waitFor(`!!document.querySelector('#omw-social input')`, 3000, 'friends tab shows its field');
  await a.click('#omw-social input');
  await ctx.sleep(300);
  assert.equal(await a.eval(`document.activeElement && document.activeElement.tagName`), 'INPUT',
    'clicking the friend field did not focus it (SDL preventDefault on mousedown eats focus)');
  ctx.log('ok: social panel is stable while open; its field takes focus');
  await a.key(ESC);

  // 8. Enter must SEND. The window-capture shield stops the event before it reaches the
  // input's own listener, so Enter has to be driven from the shield — otherwise you can type
  // but nothing sends.
  await a.eval(`document.getElementById('canvas').focus()`);
  await a.key(T);
  await a.waitFor(`document.activeElement && document.activeElement.id === 'omw-tx'`, 4000, 'chat input focused');
  // Letters only: the key helper derives code as 'Key'+CH, which is invalid for digits.
  await a.eval(`document.getElementById('omw-tx').value = ''`); // Esc preserves the draft
  const msg = 'e' + Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6);
  for (const ch of msg) await a.key({ key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.charCodeAt(0) - 32 });
  try {
    await a.waitFor(`document.getElementById('omw-tx').value === ${JSON.stringify(msg)}`, 4000, 'message typed');
  } catch (err) {
    ctx.log('DIAG want=' + JSON.stringify(msg) + ' got=' + JSON.stringify(await a.eval(
      `JSON.stringify({ v: document.getElementById('omw-tx').value, active: document.activeElement && document.activeElement.id, open: document.getElementById('omw-chat').className, hold: !!window.__omwUiHold })`)));
    throw err;
  }
  await a.key({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
  await a.waitFor(`document.getElementById('omw-tx').value === ''`, 3000,
    'Enter cleared the input (the send handler ran)');
  await a.waitFor(`(window.omw.state.chatLog||'').includes(${JSON.stringify(msg)})`, 5000,
    'Enter actually delivered the message through the server');
  ctx.log('ok: Enter sends the typed message');
  await a.key(ESC);

  // Transition notices: being moved between worlds, or losing your party, must SAY so.
  // Driven through the same mirror the engine writes, so this exercises the real watcher.
  // noticeSeq TOO, because that is what actually gates the watcher. A notice reports an
  // EVENT rather than a state, so the page fires only when the sequence moves -- otherwise
  // every unrelated mirror update would replay the last eviction. global.lua bumps it
  // alongside the fields, so setting the fields without it is not what the engine does.
  await a.eval(`window.omw.state.worldClosedBy = 'Ada';
    window.omw.state.worldClosed = 'owner_went_solo';
    window.omw.state.noticeSeq = String(Number(window.omw.state.noticeSeq || 0) + 1)`)
  await a.waitFor(`document.getElementById('omw-tour').classList.contains('show')
    && /Returning to your own world/.test(document.getElementById('omw-tour-title').textContent)`,
    4000, 'being evicted from a world shows a notice');
  // A notice must NOT be persisted: it reports an event, so the next one has to show too.
  assert.equal(await a.eval(`document.getElementById('omw-tour-dots').innerHTML`), '',
    'a notice must not render tour dots');
  assert.match(await a.eval(`document.getElementById('omw-tour-body').textContent`), /Ada.+closed their world/,
    'the notice must name who closed the world');
  const noticeHit = await a.click('#omw-tour-next');
  await a.waitFor(`!document.getElementById('omw-tour').classList.contains('show')`, 3000,
    'the notice closed (click landed on: ' + noticeHit + ')');

  // (the party-travel notice died with parties; the eviction notice above is the one
  // transition notice the Solo/Party model still has)
  ctx.log('ok: transition notices fire and do not persist');

  const luaErrs = a.luaErrors();
  assert.equal(luaErrs.length, 0, 'Lua errors during run:\n' + luaErrs.join('\n'));
  ctx.log('ok: no Lua errors — overlays fully wired');
}
