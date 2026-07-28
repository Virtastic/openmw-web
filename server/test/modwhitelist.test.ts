// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.5.2b: the approved-mod whitelist and the tier rule. The product question is
// whether one player can run a texture pack their friends have not installed — yes for
// cosmetics, no for record-bearing plugins, because those change the game itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ModWhitelist } from '../src/core/mod-whitelist';
import { ContentGate } from '../src/core/manifest';

const DOC = {
  generatedFrom: ['demo'],
  mods: [{
    id: 'demo',
    name: 'Demo Pack',
    order: 0,
    contentFiles: ['DemoPlugin.esp'],
    fileCount: 3,
    totalBytes: 30,
    files: [
      { path: 'meshes/x/pretty.nif', size: 10, sha256: 'a'.repeat(64), tier: 'cosmetic' as const },
      { path: 'textures/x/pretty.dds', size: 10, sha256: 'b'.repeat(64), tier: 'cosmetic' as const },
      { path: 'DemoPlugin.esp', size: 10, sha256: 'c'.repeat(64), tier: 'content' as const },
    ],
  }],
};

test('whitelist classifies by tier and looks up by hash and by name', () => {
  const wl = ModWhitelist.fromDoc(DOC);
  assert.equal(wl.empty, false);
  assert.equal(wl.lookup('A'.repeat(64))?.file.tier, 'cosmetic', 'hash lookup is case-insensitive');
  assert.equal(wl.lookupName('pretty.nif'), 'cosmetic');
  assert.equal(wl.lookupName('DemoPlugin.esp'), 'content', 'plugins are never cosmetic');
  assert.equal(wl.lookupName('unknown.nif'), undefined);
  assert.equal(wl.knownName('meshes/whatever/pretty.dds'), true, 'basename match, path-independent');
});

test('a missing manifest is a vanilla server, not a boot failure', async () => {
  const wl = await ModWhitelist.load('/nonexistent-dir-for-this-test');
  assert.equal(wl.empty, true);
  assert.equal(wl.lookupName('anything.nif'), undefined);
});

test('content gate: cosmetic mods may differ between players, plugins may not', () => {
  const wl = ModWhitelist.fromDoc(DOC);
  const gate = new ContentGate('names');
  gate.setModWhitelist(wl);

  // First player defines the session and is running the cosmetic pack.
  const withPack = [
    { name: 'Morrowind.esm', size: 1, idx: 0 },
    { name: 'pretty.nif', size: 10, idx: 1 },
  ];
  assert.equal(gate.check(withPack).ok, true);

  // Second player WITHOUT the pack is welcome: they will simply see vanilla meshes.
  const without = [{ name: 'Morrowind.esm', size: 1, idx: 0 }];
  assert.equal(gate.check(without).ok, true,
    'nobody should have to install a texture pack because a friend did');

  // ...but a record-bearing plugin one player has and the other lacks IS a mismatch:
  // they would disagree about the contents of the world.
  const withPlugin = [
    { name: 'Morrowind.esm', size: 1, idx: 0 },
    { name: 'DemoPlugin.esp', size: 10, idx: 1 },
  ];
  const refused = gate.check(withPlugin);
  assert.equal(refused.ok, false, 'a content plugin must match across the world');
  assert.match(String(refused.detail), /DemoPlugin\.esp/);
});

test('the real generated manifest is well formed and correctly tiered', async () => {
  // Skips cleanly where the operator has not generated one (CI without the archives).
  const wl = await ModWhitelist.load(new URL('../data', import.meta.url).pathname);
  if (wl.empty) return;
  assert.ok(wl.mods.length >= 1);
  for (const mod of wl.mods) {
    assert.ok(mod.files.length > 0, `${mod.name} has files`);
    for (const f of mod.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.path} has a real hash`);
      const isPlugin = /\.(esp|esm|omwaddon)$/i.test(f.path);
      assert.equal(f.tier, isPlugin ? 'content' : 'cosmetic', `${f.path} tiered by kind`);
    }
  }
  // Load order is the bundle order: MOP's optimized meshes, then Atlas over them.
  assert.deepEqual([...wl.mods].map((m) => m.order), [...wl.mods].map((_, i) => i));
});
