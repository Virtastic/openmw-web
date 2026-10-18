// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// telemetry npcPath: a drawn actor's probe entry (actors.lua: id = its FormId string, net = its net
// id) maps to the SAME key the page's 0x200 tap files that actor's poses under, so each NPC is
// measured against its own path. Runs tapKey pulled out of play/index.html.
//   node wasm-build/telemetry-tapkey.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../play/index.html', import.meta.url), 'utf8');
const at = src.indexOf('function tapKey(p){');
assert.ok(at > 0, 'tapKey is where this test expects it');
const tapKey = new Function(src.slice(at).match(/^[\s\S]*?\r?\n   \}/)[0] + '; return tapKey;')();

// The tap's own key for a 0x200 entry, as index.html builds it: (cf === -2 ? 'n' : cf + ':') + index.
const wire = (index, cf) => (cf === -2 ? 'n' : cf + ':') + index;

// esm/formid.cpp: '0x' + hex(index | cf << 24). Morrowind.esm (cf 0), a plugin (cf 1), a big index.
assert.equal(tapKey({ id: '0x101f7c3' }), wire(0x01f7c3, 1));
assert.equal(tapKey({ id: '0x5e2' }), wire(0x5e2, 0));
assert.equal(tapKey({ id: '0x3ffffff' }), wire(0xffffff, 3));
// A named runtime actor travels by net id (contentFile -2), whatever its engine id.
assert.equal(tapKey({ id: '@0x1b5', net: 42 }), wire(42, -2));
// A body only this engine made, or an older engine's probe: no key (the page falls back to nearest).
assert.equal(tapKey({ id: '@0x1b5' }), null);
assert.equal(tapKey({}), null);
console.log('telemetry-tapkey: ok');
