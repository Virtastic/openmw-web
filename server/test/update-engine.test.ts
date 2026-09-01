// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The engine one-click update, minus the network.
//
// installEngineZip swaps the files a live bind mount is serving, so what matters most is
// what it must NOT do: touch anything when the zip is not a client bundle, write outside
// the client dir, or delete the engine a currently open page is still fetching from.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { engineStatus, installEngineZip, shaFor, startEngineUpdate } from '../src/net/admin/update-engine';
import { getInstallProgress } from '../src/net/admin/mod-install';
import { crc32 } from '../src/core/zip';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'engupd-'));

/** A real zip, in memory (same builder as mod-install.test.ts). */
function buildZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const body = Buffer.from(f.data);
    const comp = deflateRawSync(body);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(body);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const HASH_A = 'aaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbb';

/** The smallest thing installEngineZip accepts as a client bundle. Like the real one, the
 *  index references its engine dir - that reference is what the keep-set reads. */
const bundle = (hash: string, marker: string): { name: string; data: string }[] => [
  { name: 'index.html', data: `<html><script src="e/${hash}/openmw.js"></script>${marker}</html>` },
  { name: `e/${hash}/openmw.wasm`, data: `wasm-${marker}` },
  { name: `e/${hash}/openmw.js`, data: `js-${marker}` },
  { name: 'server.py', data: marker },
];

function writeZip(dir: string, files: { name: string; data: string }[]): string {
  const p = join(dir, 'bundle.zip');
  writeFileSync(p, buildZip(files));
  return p;
}

/** A snapshot of every file under a dir, path → content. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) Object.assign(out, snapshot(p, base));
    else out[p.slice(base.length + 1).replaceAll('\\', '/')] = readFileSync(p, 'utf8');
  }
  return out;
}

test('shaFor parses shasum output and matches exact filenames only', () => {
  const sums = [
    `${'1'.repeat(64)}  openmw-web-v1.2.0.zip`,
    `${'2'.repeat(64)} *openmw-web-src-v1.2.0.tar.gz`,
    'not a sums line',
  ].join('\n');
  assert.equal(shaFor(sums, 'openmw-web-v1.2.0.zip'), '1'.repeat(64));
  assert.equal(shaFor(sums, 'openmw-web-src-v1.2.0.tar.gz'), '2'.repeat(64));
  assert.equal(shaFor(sums, 'v1.2.0.zip'), null);
  assert.equal(shaFor('', 'anything'), null);
});

test('a good zip installs, index.html included, and records the tag', async () => {
  const clientDir = tmp();
  const zip = writeZip(tmp(), bundle(HASH_A, 'new'));
  const r = await installEngineZip(zip, clientDir, 'v9.9.9', () => {});
  assert.deepEqual(r, { ok: true });
  assert.ok(readFileSync(join(clientDir, 'index.html'), 'utf8').endsWith('new</html>'));
  assert.equal(readFileSync(join(clientDir, 'e', HASH_A, 'openmw.wasm'), 'utf8'), 'wasm-new');
  assert.equal(readFileSync(join(clientDir, 'server.py'), 'utf8'), 'new');
  assert.equal(engineStatus(clientDir).tag, 'v9.9.9');
  assert.ok(!existsSync(join(clientDir, '.staging')), 'staging is cleaned up');
});

test('updating keeps the engine a live page is using, prunes older orphans', async () => {
  const clientDir = tmp();
  // The state after one prior update: current engine A, plus an orphan from before it.
  await installEngineZip(writeZip(tmp(), bundle(HASH_A, 'old')), clientDir, 'v1.0.0', () => {});
  mkdirSync(join(clientDir, 'e', 'cccccccccccc'), { recursive: true });
  writeFileSync(join(clientDir, 'e', 'cccccccccccc', 'openmw.wasm'), 'orphan');

  const r = await installEngineZip(writeZip(tmp(), bundle(HASH_B, 'new')), clientDir, 'v2.0.0', () => {});
  assert.deepEqual(r, { ok: true });
  // A page opened before the update still loads engine A (the outgoing index referenced
  // it); the orphan no index ever pointed at is pruned.
  const engines = readdirSync(join(clientDir, 'e')).sort();
  assert.deepEqual(engines, [HASH_A, HASH_B]);
  assert.ok(readFileSync(join(clientDir, 'index.html'), 'utf8').endsWith('new</html>'));
  assert.equal(engineStatus(clientDir).tag, 'v2.0.0');
});

test('an extra engine dir shipped by the new release is installed and kept', async () => {
  // A release may carry an e/ dir without openmw.wasm (a variant, a shared asset dir).
  // The wasm-bearing dirs gate the install; the others must still survive the prune.
  const clientDir = tmp();
  await installEngineZip(writeZip(tmp(), bundle(HASH_A, 'old')), clientDir, 'v1.0.0', () => {});
  const files = bundle(HASH_B, 'new');
  files.push({ name: 'e/dddddddddddd/shaders.bin', data: 'variant' });
  const r = await installEngineZip(writeZip(tmp(), files), clientDir, 'v2.0.0', () => {});
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(readdirSync(join(clientDir, 'e')).sort(), [HASH_A, HASH_B, 'dddddddddddd']);
});

test('a zip that is not a client bundle changes nothing at all', async () => {
  const clientDir = tmp();
  await installEngineZip(writeZip(tmp(), bundle(HASH_A, 'live')), clientDir, 'v1.0.0', () => {});
  const before = snapshot(clientDir);

  const junk = writeZip(tmp(), [{ name: 'readme.txt', data: 'not a bundle' }]);
  const r = await installEngineZip(junk, clientDir, 'v2.0.0', () => {});
  assert.equal(r.ok, false);
  assert.deepEqual(snapshot(clientDir), before, 'the live client is byte-identical');
  assert.equal(engineStatus(clientDir).tag, 'v1.0.0', 'the tag still names what is running');
});

test('a garbage file that is not a zip is a clean failure, not a throw', async () => {
  const clientDir = tmp();
  const dir = tmp();
  const p = join(dir, 'bundle.zip');
  writeFileSync(p, 'this is not a zip');
  const r = await installEngineZip(p, clientDir, 'v1.0.0', () => {});
  assert.equal(r.ok, false);
  assert.ok(!existsSync(join(clientDir, '.staging')));
});

test('an archive with a traversal entry is refused entirely, nothing written', async () => {
  const clientDir = tmp();
  const files = bundle(HASH_A, 'x');
  files.push({ name: '../escape.txt', data: 'must not exist' });
  const r = await installEngineZip(writeZip(tmp(), files), clientDir, 'v1.0.0', () => {});
  assert.equal(r.ok, false, 'zip listing refuses hostile archives outright');
  assert.ok(!existsSync(join(clientDir, '..', 'escape.txt')));
  assert.deepEqual(readdirSync(clientDir), [], 'the client dir is untouched');
});

test('engineStatus on an empty writable dir: writable, no tag, not present', () => {
  const dir = tmp();
  assert.deepEqual(engineStatus(dir), { writable: true, tag: null, present: false });
  writeFileSync(join(dir, '.release-tag'), 'not a tag $(rm -rf)\n');
  assert.equal(engineStatus(dir).tag, null, 'a mangled tag file reads as unknown');
});

test('startEngineUpdate hands back a pollable token and a terminal error frame', async () => {
  // Fetch is stubbed dead so the run fails at the resolve step: the failure must arrive
  // through the progress map as an error: frame rather than vanishing into a rejected
  // promise — and the test must never touch the real network.
  const dataDir = tmp();
  const clientDir = tmp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('offline test'));
  try {
    const token = startEngineUpdate({ clientDir, dataDir });
    assert.match(token, /^[0-9a-f]{32}$/, 'must satisfy the progress route token shape');
    for (let i = 0; i < 200; i++) {
      const p = getInstallProgress(token);
      if (p && (p.note.startsWith('error:') || p.note.startsWith('done:'))) {
        assert.ok(p.note.startsWith('error:'), `expected a failure offline, got ${p.note}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail('never saw a terminal progress frame');
  } finally {
    globalThis.fetch = realFetch;
  }
});
