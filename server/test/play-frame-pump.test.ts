// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The page's frame pump (play/index.html onRuntimeInitialized). Every hide/show of the tab used to
// leave one more rAF loop running, each a full engine frame per refresh, so fps fell with every
// alt-tab (prod 2026-10-10/26: 0.72x after two hide/show cycles, 0.39x after three). The scheduler
// is lifted out of the page and run against stub rAF / timers / MessageChannel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const indexPath = join(process.cwd(), '..', 'play', 'index.html');
const html = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
const opts = html === '' ? { skip: 'play/index.html is not part of the server image' } : {};
const start = html.indexOf('       var scheduled = false');
const src = start < 0 ? '' : html.slice(start, html.indexOf("append('[pump] frame pump started", start));

test('one engine frame per refresh, however often the tab hides and shows', opts, () => {
  assert.ok(src.includes('function pumpFrame'), 'the scheduler was found in the page');
  let raf: Array<() => void> = [], timers: Array<() => void> = [];
  const msgs: unknown[] = [], vis: Array<() => void> = [];
  let pumps = 0;
  const document = { hidden: false, addEventListener: (_t: string, f: () => void) => vis.push(f) };
  const mc = { port1: {} as { onmessage?: (e: { data: unknown }) => void }, port2: { postMessage: (d: unknown) => msgs.push(d) } };
  new Function('document', 'mc', 'Module', 'window', 'requestAnimationFrame', 'setTimeout', 'performance', 'append',
    `var __frames = 0, __accum = 0, __t0 = 0;\n${src}`)(
    document, mc, { _omw_pump_frame: () => pumps++ }, {},
    (f: () => void) => raf.push(f), (f: () => void) => timers.push(f), { now: () => 0 }, () => {});
  const drain = () => { while (msgs.length) mc.port1.onmessage!({ data: msgs.shift() }); };
  const refresh = () => { const q = raf; raf = []; q.forEach((f) => f()); drain(); };
  const timer = () => { const q = timers; timers = []; q.forEach((f) => f()); drain(); };
  drain();
  for (let cycle = 0; cycle < 5; cycle++) {
    pumps = 0;
    for (let i = 0; i < 10; i++) refresh();
    assert.equal(pumps, 10, `after ${cycle} hide/show cycles: one engine frame per refresh`);
    document.hidden = true; vis.forEach((f) => f()); drain(); // the rAF tick stays queued, frozen
    pumps = 0;
    for (let i = 0; i < 3; i++) timer();
    assert.ok(pumps >= 3, 'a hidden tab keeps running on the timer');
    document.hidden = false; vis.forEach((f) => f());
    refresh(); timer(); refresh(); // the frozen tick fires; the timer chain hands back to rAF
  }
});
