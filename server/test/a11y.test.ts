// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-145: accessibility of chat, social and the dialogs in play/index.html. Markup invariants
// are asserted on the source; the Tab trap is extracted and EXECUTED against a fake DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../play/index.html', import.meta.url), 'utf8');

test('the three dialogs are role=dialog, modal and named', () => {
  for (const [id, title] of [['omw-social', 'omw-social-title'], ['omw-ask', 'omw-ask-title'], ['omw-tour', 'omw-tour-title']]) {
    const tag = new RegExp(`<div id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
    assert.match(tag, /role="dialog"/, id);
    assert.match(tag, /aria-modal="true"/, id);
    assert.match(tag, new RegExp(`aria-labelledby="${title}"`), id);
    assert.ok(html.includes(`id="${title}"`), `${title} exists`);
  }
});

test('chat: the feed is a polite live log, stays readable when idle, inputs are labelled', () => {
  assert.match(html, /id="omw-feed" role="log" aria-live="polite"/);
  assert.match(html, /#omw-chat \.feed\.idle \.ln\{ opacity:\.5;/);
  assert.doesNotMatch(html, /#omw-chat \.feed\.idle \.ln\{ opacity:0;/);
  assert.match(html, /id="omw-tx"[^>]*aria-label="Chat message"/);
  assert.match(html, /id="omw-wto"[^>]*aria-label="Whisper to"/);
  assert.match(html, /ai\.setAttribute\('aria-label','Add a friend by their username'\)/);
});

test('tabs are buttons with role=tab in a tablist (chat and social)', () => {
  assert.match(html, /id="omw-chans" role="tablist"/);
  assert.match(html, /'<button type="button" role="tab" aria-selected=/);
  assert.match(html, /id="omw-nav" role="tablist"/);
  assert.match(html, /el\('button','nv'/);
  assert.match(html, /d\.setAttribute\('role','tab'\); d\.setAttribute\('aria-selected'/);
  assert.doesNotMatch(html, /'<span class="chan'/);
  assert.doesNotMatch(html, /el\('div','nv'/);
});

test('reduced motion is honoured for chat, social and the dialogs, not only loading', () => {
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)\{\s*#omw-chat \*, #omw-social \*, #omw-ask \*, #omw-tour \*/);
});

test('Tab is trapped in the top-most open dialog', () => {
  const m = /\/\*A11YDIALOG\*\/([\s\S]*?)\/\*END A11YDIALOG\*\//.exec(html);
  assert.ok(m);
  type N = { id: string; disabled?: boolean; offsetParent: object | null; focus(): void; getAttribute(k: string): string | null };
  const mkNode = (id: string): N => ({ id, offsetParent: {}, focus() { active = this; }, getAttribute: () => null });
  let active: N | undefined;
  const a = mkNode('a'), b = mkNode('b'), c = mkNode('c');
  const dialog = (nodes: N[]) => ({ classList: { contains: (k: string) => k === 'show' }, querySelectorAll: () => nodes,
    contains: (n: N | undefined) => n !== undefined && nodes.includes(n) });
  const social = dialog([a, b, c]);
  const fakeDoc = {
    getElementById: (id: string) => (id === 'omw-social' ? social : null),
    get activeElement() { return active; }, body: {}, contains: () => true,
  };
  const { trapTab, visibleDialog } = new Function('document', 'setTimeout', `${m[1]}; return { trapTab, visibleDialog };`)(fakeDoc, () => 0) as {
    trapTab(e: object, d: object): void; visibleDialog(): unknown;
  };
  assert.equal(visibleDialog(), social, 'finds the open dialog');
  const ev = (shiftKey: boolean) => { const e = { shiftKey, prevented: false, preventDefault() { e.prevented = true; } }; return e; };
  active = c; let e = ev(false); trapTab(e, social); assert.ok(e.prevented); assert.equal(active, a, 'Tab from the last wraps to the first');
  active = a; e = ev(true); trapTab(e, social); assert.ok(e.prevented); assert.equal(active, c, 'Shift+Tab from the first wraps to the last');
  active = b; e = ev(false); trapTab(e, social); assert.equal(e.prevented, false, 'the middle is left to the browser');
  active = undefined; e = ev(false); trapTab(e, social); assert.equal(active, a, 'focus outside the dialog is pulled in');
  assert.match(html, /if \(e\.key === 'Tab'\)\{\s*var dlg = visibleDialog\(\);\s*if \(dlg\)\{ trapTab\(e, dlg\); e\.stopImmediatePropagation\(\)/);
});

test('dialogs take focus on open and give it back on close', () => {
  assert.match(html, /premintTicket\(\); focusDialog\(sEl\)/);
  assert.match(html, /uiHold\(false\); releaseDialogFocus\(\); \}/);
  assert.equal((html.match(/focusDialog\(tourEl\)/g) ?? []).length, 2, 'tour and notice');
  assert.match(html, /bd\.classList\.add\('show'\); focusDialog\(bd\)/);
});
