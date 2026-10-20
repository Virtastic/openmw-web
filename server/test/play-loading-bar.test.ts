// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The loading screen's boot bar (play/index.html __omwLoading). Players read a stripe that never
// moved for a minute as a hang (prod 2026-10-20): during boot the bar is now one 0-100 track that
// only goes forward, creeps on the compositor through the blocking engine start, and reports the
// boot timeline once. The controller is lifted out of the page and run against a stub DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const indexPath = join(process.cwd(), '..', 'play', 'index.html');
const html = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
const opts = html === '' ? { skip: 'play/index.html is not part of the server image' } : {};
const src = /window\.__omwLoading = (\(function\(\)\{[\s\S]*?\n \}\)\(\));/.exec(html)?.[1] ?? '';

function boot() {
  const node = () => {
    const cls = new Set<string>();
    const props = new Map<string, string>();
    return { textContent: '', style: { display: '', setProperty: (k: string, v: unknown) => props.set(k, String(v)) },
      classList: { add: (...c: string[]) => c.forEach((x) => cls.add(x)), remove: (...c: string[]) => c.forEach((x) => cls.delete(x)),
        contains: (c: string) => cls.has(c) }, cls, props };
  };
  const els = { loading: node(), 'ld-title': node(), 'ld-status': node(), 'ld-fill': node(), 'ld-detail': node() };
  els.loading.classList.add('indet');
  const lines: string[] = [];
  const window: Record<string, unknown> = { omw: { state: {} }, __omwBoot: { scriptStart: 5 }, __omwMark: () => {} };
  const ld = new Function('window', 'document', 'append', 'setInterval', 'setTimeout', `return ${src};`)(
    window, { getElementById: (id: keyof typeof els) => els[id] }, (t: string) => lines.push(t), () => 0, () => 0);
  const p = () => Number(els['ld-fill'].props.get('--p') ?? 0);
  return { ld, els, lines, p };
}

test('one forward-only bar: download, mount, creep, then the steps after the engine returns', opts, () => {
  const { ld, els, lines, p } = boot();
  ld.set(50, 'Downloading the game engine', '16 MB received.');
  assert.equal(p(), 0.1, 'the engine download is the first fifth');
  ld.fromLog('[mw] mounted 7205 files from mwdata/ (863MB, streamed on demand)');
  assert.equal(p(), 0.2);
  assert.equal(els['ld-detail'].textContent, '7205 files ready');
  ld.fromLog('[mw] READY -> Morrowind GOTY');
  assert.equal(els['ld-status'].textContent, 'Starting the game engine', 'not "Entering the world" before the engine has started');
  ld.creep();
  assert.ok(els.loading.cls.has('creep'), 'the blocking engine start creeps');
  assert.equal(els['ld-status'].textContent, 'Loading Morrowind');
  ld.set(null, 'Loading Morrowind', 'x');
  assert.ok(els.loading.cls.has('creep') && !els.loading.cls.has('indet'), 'a label change does not stop the creep or bring back the stripe');
  ld.set(10, 'Downloading', 'late file');
  assert.ok(els.loading.cls.has('creep'), 'a late per-file % never pulls the bar back');
  ld.set(null, 'Signing in', '');
  assert.equal(p(), 0.93);
  assert.ok(!els.loading.cls.has('creep'));
  ld.show('Almost there', 'Settling the world…');
  assert.equal(p(), 0.97, 'the settle hold is a step, not the stripe');
  ld.done();
  assert.match(lines.join('\n'), /^\[boot\] scriptStart=5/m, 'the boot timeline is reported once');
  ld.show('Loading', 'Entering a new area…');
  assert.ok(els.loading.cls.has('indet'), 'after boot, a door load is the stripe as before');
});
