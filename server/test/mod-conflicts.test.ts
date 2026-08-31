// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which mods overwrite which, and which ones are about to break.
//
// These are two different kinds of answer and the code must not blur them. A file conflict is
// ordinary — a replacer exists to replace things, and OpenMW already decides it by data= order,
// so the job is to make that decision VISIBLE. A missing master is not survivable: the engine
// aborts at startup, which reaches the player as a black screen with nothing written anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeConflicts, missingMasters, MOD_META } from '../src/core/mod-conflicts';
import { readMasters } from '../src/core/esm';
import { emptyDoc, type InstalledMod } from '../src/core/mods';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'confl-'));

const mod = (slug: string, over: Partial<InstalledMod> = {}): InstalledMod => ({
  slug, name: slug, archive: '', source: '', installedAt: '', enabled: true,
  plugins: [], archives: [], files: 0, bytes: 0, ...over,
});

/** Write the file list commitInstall would have written. */
function withFiles(dataDir: string, slug: string, files: string[]): void {
  mkdirSync(join(dataDir, MOD_META), { recursive: true });
  writeFileSync(join(dataDir, MOD_META, `${slug}.json`), JSON.stringify(files));
}

// --- file conflicts ---------------------------------------------------------------------------

test('the mod later in the list wins, because that is what OpenMW does', () => {
  const d = tmp();
  withFiles(d, 'first', ['meshes/x.nif', 'meshes/y.nif', 'textures/a.dds']);
  withFiles(d, 'second', ['meshes/x.nif', 'textures/a.dds']);
  const c = computeConflicts(d, { ...emptyDoc(), mods: [mod('first'), mod('second')] });
  assert.equal(c.length, 1);
  assert.equal(c[0]!.winner, 'second');
  assert.equal(c[0]!.loser, 'first');
  assert.equal(c[0]!.files, 2);
  assert.deepEqual(c[0]!.sample, ['meshes/x.nif', 'textures/a.dds']);
});

test('reordering flips who wins, and nothing else', () => {
  const d = tmp();
  withFiles(d, 'a', ['meshes/x.nif']);
  withFiles(d, 'b', ['meshes/x.nif']);
  const flip = computeConflicts(d, { ...emptyDoc(), mods: [mod('b'), mod('a')] });
  assert.equal(flip[0]!.winner, 'a');
});

test('case is not a conflict', () => {
  // One mod ships Meshes/X.nif and another meshes/x.nif; the VFS treats them as the same file
  // and so must this, or a real clash goes unreported.
  const d = tmp();
  withFiles(d, 'a', ['Meshes/X.nif']);
  withFiles(d, 'b', ['meshes/x.nif']);
  assert.equal(computeConflicts(d, { ...emptyDoc(), mods: [mod('a'), mod('b')] }).length, 1);
});

test('a disabled mod is in no conflicts', () => {
  const d = tmp();
  withFiles(d, 'a', ['meshes/x.nif']);
  withFiles(d, 'b', ['meshes/x.nif']);
  assert.deepEqual(computeConflicts(d, {
    ...emptyDoc(), mods: [mod('a'), mod('b', { enabled: false })],
  }), []);
});

test('mods that share nothing produce nothing', () => {
  const d = tmp();
  withFiles(d, 'a', ['meshes/x.nif']);
  withFiles(d, 'b', ['textures/y.dds']);
  assert.deepEqual(computeConflicts(d, { ...emptyDoc(), mods: [mod('a'), mod('b')] }), []);
});

test('a mod installed before file lists existed is not a crash', () => {
  const d = tmp();
  withFiles(d, 'a', ['meshes/x.nif']);
  // 'b' has no list on disk at all.
  assert.deepEqual(computeConflicts(d, { ...emptyDoc(), mods: [mod('a'), mod('b')] }), []);
});

// --- masters ------------------------------------------------------------------------------------

test('a plugin needing a base master that is loaded is fine', () => {
  const doc = { ...emptyDoc(), mods: [
    mod('tr', { plugins: [{ file: 'TR.esp', enabled: true, masters: ['Morrowind.esm'] }] }),
  ] };
  assert.deepEqual(missingMasters(doc, ['Morrowind.esm']), []);
});

test('a plugin needing a DISABLED expansion is reported', () => {
  // The exact case the dashboard has to warn about: switching Tribunal off breaks the mod that
  // was built against it, and the engine refuses to start rather than skipping it.
  const doc = { ...emptyDoc(), mods: [
    mod('tr', { plugins: [{ file: 'TR.esp', enabled: true, masters: ['Tribunal.esm'] }] }),
  ] };
  assert.deepEqual(missingMasters(doc, ['Morrowind.esm']),
    [{ mod: 'tr', plugin: 'TR.esp', master: 'Tribunal.esm' }]);
});

test('one mod can satisfy another mod master', () => {
  const doc = { ...emptyDoc(), mods: [
    mod('base', { plugins: [{ file: 'TR_Mainland.esm', enabled: true }] }),
    mod('addon', { plugins: [{ file: 'Addon.esp', enabled: true, masters: ['TR_Mainland.esm'] }] }),
  ] };
  assert.deepEqual(missingMasters(doc, ['Morrowind.esm']), []);
  // ...and switching the provider off breaks the dependent.
  const off = { ...doc, mods: [{ ...doc.mods[0]!, enabled: false }, doc.mods[1]!] };
  assert.deepEqual(missingMasters(off, ['Morrowind.esm']).map((m) => m.master), ['TR_Mainland.esm']);
});

test('a disabled PLUGIN inside an enabled mod stops satisfying masters', () => {
  const doc = { ...emptyDoc(), mods: [
    mod('base', { plugins: [{ file: 'TR_Mainland.esm', enabled: false }] }),
    mod('addon', { plugins: [{ file: 'Addon.esp', enabled: true, masters: ['TR_Mainland.esm'] }] }),
  ] };
  assert.equal(missingMasters(doc, ['Morrowind.esm']).length, 1);
});

test('master names are matched case-insensitively', () => {
  // A plugin records whatever case it was built against, and Morrowind's own filenames vary
  // between installs.
  const doc = { ...emptyDoc(), mods: [
    mod('m', { plugins: [{ file: 'A.esp', enabled: true, masters: ['MORROWIND.ESM'] }] }),
  ] };
  assert.deepEqual(missingMasters(doc, ['Morrowind.esm']), []);
});

// --- reading them out of a real plugin ----------------------------------------------------------

/** A minimal but structurally real TES3 header. */
function tes3(masters: string[]): Buffer {
  const subs: Buffer[] = [];
  const hedr = Buffer.alloc(300);
  subs.push(Buffer.concat([Buffer.from('HEDR'), u32(300), hedr]));
  for (const m of masters) {
    const name = Buffer.from(`${m}\0`, 'latin1');
    subs.push(Buffer.concat([Buffer.from('MAST'), u32(name.length), name]));
    subs.push(Buffer.concat([Buffer.from('DATA'), u32(8), Buffer.alloc(8)]));
  }
  const body = Buffer.concat(subs);
  return Buffer.concat([Buffer.from('TES3'), u32(body.length), u32(0), u32(0), body]);
}
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

test('masters are read out of a real TES3 header, in order', () => {
  const d = tmp();
  const p = join(d, 'Mod.esp');
  writeFileSync(p, tes3(['Morrowind.esm', 'Tribunal.esm']));
  assert.deepEqual(readMasters(p), ['Morrowind.esm', 'Tribunal.esm']);
});

test('a plugin with no masters, or one we cannot parse, reports none', () => {
  // The safe direction: no false warning about a dependency that may not exist, and the engine
  // stays the final authority either way.
  const d = tmp();
  const none = join(d, 'None.esp');
  writeFileSync(none, tes3([]));
  assert.deepEqual(readMasters(none), []);

  const junk = join(d, 'Junk.esp');
  writeFileSync(junk, Buffer.from('not a plugin at all'));
  assert.deepEqual(readMasters(junk), []);

  assert.deepEqual(readMasters(join(d, 'does-not-exist.esp')), []);
});

test('a truncated header stops rather than reading past the end', () => {
  const d = tmp();
  const p = join(d, 'Cut.esp');
  const full = tes3(['Morrowind.esm', 'Tribunal.esm']);
  writeFileSync(p, full.subarray(0, full.length - 20));
  // Whatever it manages to read, it must not throw and must not invent a master.
  const got = readMasters(p);
  assert.ok(Array.isArray(got));
  assert.ok(got.every((m) => m === 'Morrowind.esm' || m === 'Tribunal.esm'));
});
