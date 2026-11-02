// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-210: engine switches from the URL, and the settings.cfg rewrite the server's value goes
// through. Runs StreamFS.engineOpts/applySetting out of the real play/streamfs.js.
//   node wasm-build/streamfs-engineopts.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../play/streamfs.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(src, { window, location: { search: '' }, navigator: {}, console });
const S = window.StreamFS;
const engineOpts = (q) => JSON.parse(JSON.stringify(S.engineOpts(q)));
const applySetting = S.applySetting;

// Nothing asked: nothing written, the engine default stands.
assert.deepEqual(engineOpts(''), []);
assert.deepEqual(engineOpts(undefined), []);
assert.deepEqual(engineOpts('?meshcleanup=yes'), []);
assert.deepEqual(engineOpts('?meshcleanup=0'), [['Models', 'mesh cleanup', 'false']]);
assert.deepEqual(engineOpts('?tier=low&meshcleanup=1'), [['Models', 'mesh cleanup', 'true']]);

// OT3-213: physics threads 0/1/2 only; anything else leaves the engine default (1).
assert.deepEqual(engineOpts('?physthreads=0'), [['Physics', 'async num threads', '0']]);
assert.deepEqual(engineOpts('?physthreads=2&meshcleanup=1'), [['Models', 'mesh cleanup', 'true'], ['Physics', 'async num threads', '2']]);
assert.deepEqual(engineOpts('?physthreads=3'), []);
assert.deepEqual(engineOpts('?physthreads=12'), []);

// OT3-211: the atlas switch, visual only, so the URL decides it even in MP.
assert.deepEqual(engineOpts('?atlas=1'), [['Models', 'texture atlas', 'true']]);
assert.deepEqual(engineOpts('?atlas=0&meshcleanup=1'), [['Models', 'mesh cleanup', 'true'], ['Models', 'texture atlas', 'false']]);

// applySetting: replace inside the right section, never duplicate (OpenMW refuses duplicates).
const base = '[Video]\nwindow mode = 2\n[Models]\nmesh cleanup = true\n[Game]\nfoo = 1\n';
let out = applySetting(base, 'Models', 'mesh cleanup', 'false');
assert.equal(out, '[Video]\nwindow mode = 2\n[Models]\nmesh cleanup = false\n[Game]\nfoo = 1\n');
assert.equal((out.match(/mesh cleanup/g) || []).length, 1);
// The same key in another section is a different setting.
out = applySetting('[Other]\nmesh cleanup = x\n', 'Models', 'mesh cleanup', 'true');
assert.equal(out, '[Other]\nmesh cleanup = x\n[Models]\nmesh cleanup = true\n');
// Section present, key absent: added under it.
out = applySetting('[Models]\nxbaseanim = a.nif\n[Game]\n', 'Models', 'mesh cleanup', 'false');
assert.equal(out, '[Models]\nmesh cleanup = false\nxbaseanim = a.nif\n[Game]\n');
// Case and spacing of the existing line do not matter.
out = applySetting('[models]\n  Mesh Cleanup=true\n', 'Models', 'mesh cleanup', 'false');
assert.equal(out, '[models]\nmesh cleanup = false\n');
// Empty or unterminated input.
assert.equal(applySetting('', 'Models', 'mesh cleanup', 'true'), '[Models]\nmesh cleanup = true\n');
assert.equal(applySetting('[A]\nb = 1', 'Models', 'k', 'v'), '[A]\nb = 1\n[Models]\nk = v\n');

console.log('streamfs-engineopts: ok');
