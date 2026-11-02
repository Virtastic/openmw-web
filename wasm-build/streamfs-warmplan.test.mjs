// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-57: the background warm-up no longer fills whole archives; music and voice are opt-in.
// Runs StreamFS.warmPlan out of the real play/streamfs.js.   node wasm-build/streamfs-warmplan.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../play/streamfs.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(src, { window, location: { search: '' }, navigator: {}, console });
const plan = window.StreamFS.warmPlan;
const hits = (p, paths) => paths.filter((x) => p.re.test(x));

const paths = [
  '/mwdata/Morrowind.bsa', '/mwdata/openmw-web-assets.bsa', '/mwdata/Tribunal.bsa',
  '/mwdata/Sound/Fx/FOOT/walkr_lt.wav', '/mwdata/Sound/Cr/kwama/roar.wav',
  '/mwdata/Music/Explore/mx_explore_1.mp3', '/mwdata/Music/Battle/mx_battle_1.mp3',
  '/mwdata/Sound/Vo/i/m/Hlo_IM064.mp3', '/mwdata/Sound/Vo/d/f/Idl_DF006.mp3', '/mwdata/Sound/Vo/d/f/Atk_DF001.mp3',
];

// Default: loose effects and creature sounds only. No archive, no music, no voice.
let p = plan('');
assert.deepEqual(hits(p, paths), ['/mwdata/Sound/Fx/FOOT/walkr_lt.wav', '/mwdata/Sound/Cr/kwama/roar.wav']);
assert.deepEqual(hits(plan(undefined), paths), hits(p, paths));

// Opt-ins.
assert.deepEqual(hits(plan('music'), paths).filter((x) => /music/i.test(x)), ['/mwdata/Music/Explore/mx_explore_1.mp3', '/mwdata/Music/Battle/mx_battle_1.mp3']);
assert.ok(!hits(plan('music'), paths).some((x) => /\.bsa$|vo\//i.test(x)));
assert.deepEqual(hits(plan('Voice'), paths).filter((x) => /vo\//i.test(x)), ['/mwdata/Sound/Vo/i/m/Hlo_IM064.mp3', '/mwdata/Sound/Vo/d/f/Idl_DF006.mp3']);
assert.equal(hits(plan('music, voice'), paths).length, 6);

// all = the old blanket warm-up: archives first, the asset pack ahead of Morrowind.bsa.
p = plan('all');
assert.equal(hits(p, paths).length, 9, 'everything but the attack line');
const rank = (x) => p.first.findIndex((r) => r.test(x));
assert.ok(rank('/mwdata/openmw-web-assets.bsa') < rank('/mwdata/Morrowind.bsa'));
assert.ok(rank('/mwdata/Morrowind.bsa') < rank('/mwdata/Sound/Fx/a.wav'));

assert.equal(plan('none'), null);
assert.equal(plan('all,none'), null);
console.log('streamfs-warmplan: ok');
