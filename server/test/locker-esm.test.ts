// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// [setup] deliveryModel = "esm": a player proves ownership with the three master files and the
// server streams its own copy of everything else. What must hold: only an EXACT accepted hash
// counts (never name+size), the server hashes what actually landed rather than trusting the
// claim, and the hosted files are refused to anybody without verified ownership.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { ESM_MAX_BYTES, Locker } from '../src/data/locker';
import { esmOwnerGate, MWDATA_COOKIE } from '../src/data/locker-routes';
import { mwDataRoutes } from '../src/net/mwdata-routes';
import { tmpDataDir } from './helpers';

const BYTES = { 'Morrowind.esm': 'TES3 morrowind', 'Tribunal.esm': 'TES3 tribunal', 'Bloodmoon.esm': 'TES3 bloodmoon' };
type EsmName = keyof typeof BYTES;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const rec = (name: string, body = BYTES[name as EsmName] ?? 'x') => ({ name, size: Buffer.byteLength(body), sha256: sha(body) });

/** Storage whose presigned GETs are real URLs on a local server, so recordUploaded's read-back
 *  is the same fetch it does against S3. `oversize` keys stream past ESM_MAX_BYTES lazily. */
async function liveStorage() {
  const blobs = new Map<string, Buffer>();
  const oversize = new Set<string>();
  const deletes: string[] = [];
  const srv: Server = createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '/').slice(1));
    if (oversize.has(key)) {
      res.writeHead(200);
      const chunk = Buffer.alloc(1 << 20);
      let left = ESM_MAX_BYTES / chunk.length + 2;
      const pump = (): void => { while (left-- > 0) if (!res.write(chunk)) { res.once('drain', pump); return; } res.end(); };
      pump();
      return;
    }
    const b = blobs.get(key);
    if (!b) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-length': b.length }); res.end(b);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
  return {
    blobs, oversize, deletes,
    stop: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
    async presignPut(key: string) { return `${base}${encodeURIComponent(key)}?put`; },
    async presignGet(key: string) { return `${base}${encodeURIComponent(key)}`; },
    async delete(key: string) { deletes.push(key); blobs.delete(key); },
    async getHead(): Promise<Buffer> { throw new Error('esm mode must not sniff, it hashes'); },
  };
}

async function mk(esmHashes: string[] = [`Bloodmoon.esm:${sha(BYTES['Bloodmoon.esm'])}`]) {
  const storage = await liveStorage();
  const locker = new Locker({ dataDir: tmpDataDir(), maxBytesPerAccount: 2 ** 30, storage });
  // The server's own copies (its vanilla manifest) hold two of the three; the third comes from
  // [locker] esmHashes, the "other genuine releases" list.
  const vanilla = { files: [rec('Morrowind.esm'), rec('Tribunal.esm'), { name: 'Morrowind.bsa', size: 5, sha256: sha('bsa') }] };
  locker.configureAccepted(vanilla, [], { esmOnly: () => true, esmHashes });
  return { locker, storage, vanilla };
}

/** authorize + "PUT" + confirm, the wizard's three calls. */
async function upload(locker: Locker, storage: Awaited<ReturnType<typeof liveStorage>>, acct: string, name: EsmName, body?: string) {
  const claim = rec(name);
  const auth = await locker.authorizeUpload(acct, claim);
  if (!auth.ok) return auth;
  storage.blobs.set(auth.key, Buffer.from(body ?? BYTES[name]));
  return locker.recordUploaded(acct, claim);
}

test('esm: the checklist is exactly the three ESMs, all required', async () => {
  const { locker, storage } = await mk();
  try {
    assert.equal(locker.esmMode, true);
    assert.deepEqual(locker.requiredManifest().map((n) => [n.name, n.required]),
      [['Morrowind.esm', true], ['Tribunal.esm', true], ['Bloodmoon.esm', true]]);
  } finally { await storage.stop(); }
});

test('esm: a genuine hash is authorized; wrong hash, wrong name and oversize are refused', async () => {
  const { locker, storage } = await mk();
  try {
    await locker.attest('alice', [rec('Morrowind.esm')], 'ip');
    const ok = await locker.authorizeUpload('alice', rec('Morrowind.esm'));
    assert.equal(ok.ok, true);
    // Case is canonicalized, so the key is the one recordUploaded reads.
    const lower = await locker.authorizeUpload('alice', { ...rec('Morrowind.esm'), name: 'morrowind.esm' });
    assert.ok(lower.ok && lower.key.endsWith('/Morrowind.esm'));
    // The extra-list hash counts too.
    assert.equal((await locker.authorizeUpload('alice', rec('Bloodmoon.esm'))).ok, true);

    assert.deepEqual(await locker.authorizeUpload('alice', { ...rec('Morrowind.esm'), sha256: 'f'.repeat(64) }),
      { ok: false, reason: 'not-recognized' });
    // A genuine hash is genuine for ITS file only.
    assert.deepEqual(await locker.authorizeUpload('alice', { ...rec('Morrowind.esm'), name: 'Tribunal.esm' }),
      { ok: false, reason: 'not-recognized' });
    // Not one of the three, even when the server knows the file: esm mode asks for nothing else.
    assert.deepEqual(await locker.authorizeUpload('alice', { name: 'Morrowind.bsa', size: 5, sha256: sha('bsa') }),
      { ok: false, reason: 'not-recognized' });
    assert.deepEqual(await locker.authorizeUpload('alice', { ...rec('Morrowind.esm'), name: 'Evil.esm' }),
      { ok: false, reason: 'not-recognized' });
    assert.deepEqual(await locker.authorizeUpload('alice', { ...rec('Morrowind.esm'), size: ESM_MAX_BYTES + 1 }),
      { ok: false, reason: 'too-large' });
  } finally { await storage.stop(); }
});

test('esm: ownership needs all three verified by the server reading the bytes back', async () => {
  const { locker, storage } = await mk();
  try {
    await locker.attest('alice', [], 'ip');
    assert.deepEqual(await upload(locker, storage, 'alice', 'Morrowind.esm'), { ok: true });
    assert.deepEqual(await upload(locker, storage, 'alice', 'Tribunal.esm'), { ok: true });
    assert.equal(await locker.ownsGame('alice'), false, 'two of three is not ownership');
    assert.deepEqual(await upload(locker, storage, 'alice', 'Bloodmoon.esm'), { ok: true });
    assert.equal(await locker.ownsGame('alice'), true);
    assert.equal(await locker.ownsGame('bob'), false);
    // The bytes are not kept: the server hosts its own copy.
    assert.equal(storage.blobs.size, 0);
    assert.deepEqual(storage.deletes.sort(),
      ['gamedata/alice/Bloodmoon.esm', 'gamedata/alice/Morrowind.esm', 'gamedata/alice/Tribunal.esm']);
    assert.ok((await locker.filesOf('alice')).every((f) => f.verified === true));
  } finally { await storage.stop(); }
});

test('esm: a genuine claim over foreign bytes is refused and records nothing', async () => {
  const { locker, storage } = await mk();
  try {
    await locker.attest('mallory', [], 'ip');
    assert.deepEqual(await upload(locker, storage, 'mallory', 'Morrowind.esm', 'not the game'),
      { ok: false, reason: 'not-recognized' });
    assert.deepEqual(await locker.filesOf('mallory'), []);
    assert.equal(storage.blobs.size, 0, 'refused bytes are deleted');
    // Confirming an upload that never happened is refused the same way.
    assert.deepEqual(await locker.recordUploaded('mallory', rec('Tribunal.esm')), { ok: false, reason: 'not-recognized' });
  } finally { await storage.stop(); }
});

test('esm: bytes past the cap are refused even when the declared size was small', async () => {
  const { locker, storage } = await mk();
  try {
    await locker.attest('mallory', [], 'ip');
    const auth = await locker.authorizeUpload('mallory', rec('Morrowind.esm'));
    assert.ok(auth.ok);
    storage.oversize.add(auth.key);
    assert.deepEqual(await locker.recordUploaded('mallory', rec('Morrowind.esm')), { ok: false, reason: 'too-large' });
    assert.deepEqual(await locker.filesOf('mallory'), []);
  } finally { await storage.stop(); }
});

test('esm: dropping a hash from the accepted set revokes ownership built on it', async () => {
  const { locker, storage, vanilla } = await mk();
  try {
    await locker.attest('alice', [], 'ip');
    for (const n of Object.keys(BYTES) as EsmName[]) await upload(locker, storage, 'alice', n);
    assert.equal(await locker.ownsGame('alice'), true);
    locker.configureAccepted(vanilla, [], { esmOnly: () => true, esmHashes: [] });
    assert.equal(await locker.ownsGame('alice'), false);
  } finally { await storage.stop(); }
});

test('esm: hosted files go only to a verified owner, never cached by a shared cache', async () => {
  const { locker, storage } = await mk();
  const dir = mkdtempSync(join(tmpdir(), 'mwdata-esm-'));
  writeFileSync(join(dir, 'Morrowind.esm'), 'ABCDEFGHIJ');
  const sessions = { resolve: (t: string) => ({ 'tok-alice': 'alice', 'tok-bob': 'bob' } as Record<string, string>)[t] };
  const gate = esmOwnerGate(locker, sessions);
  const routes = {
    gated: mwDataRoutes({ gameDataDir: dir, deliveryModel: () => 'esm', mayServe: gate }),
    // 'esm' without a gate wired fails closed.
    ungated: mwDataRoutes({ gameDataDir: dir, deliveryModel: () => 'esm' }),
  };
  const srv: Server = createServer((req: IncomingMessage, res) => {
    const route = req.url?.startsWith('/ungated/') ? routes.ungated : routes.gated;
    const url = new URL((req.url ?? '/').replace(/^\/ungated/, ''), 'http://x');
    void (async () => { if (!(await route(req, res, url))) { res.writeHead(404); res.end(); } })();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    await locker.attest('alice', [], 'ip');
    for (const n of Object.keys(BYTES) as EsmName[]) await upload(locker, storage, 'alice', n);

    const anon = await fetch(`${base}/mwdata/Morrowind.esm`);
    assert.equal(anon.status, 404);
    assert.equal(anon.headers.get('cache-control'), 'no-store');
    const bob = await fetch(`${base}/mwdata/Morrowind.esm`, { headers: { cookie: `${MWDATA_COOKIE}=tok-bob` } });
    assert.equal(bob.status, 404, 'signed in is not enough: bob never proved ownership');

    // The engine's StreamFS reads carry the cookie, not a Bearer header.
    const owner = await fetch(`${base}/mwdata/Morrowind.esm`, { headers: { cookie: `${MWDATA_COOKIE}=tok-alice` } });
    assert.equal(owner.status, 200);
    assert.equal(await owner.text(), 'ABCDEFGHIJ');
    assert.match(owner.headers.get('cache-control') ?? '', /^private,/);
    const viaBearer = await fetch(`${base}/mwdata-manifest.json`, { headers: { authorization: 'Bearer tok-alice' } });
    assert.equal(viaBearer.status, 200);
    assert.equal(viaBearer.headers.get('cache-control'), 'private, no-cache');

    const ungated = await fetch(`${base}/ungated/mwdata/Morrowind.esm`, { headers: { cookie: `${MWDATA_COOKIE}=tok-alice` } });
    assert.equal(ungated.status, 404);
  } finally {
    await new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); });
    await storage.stop();
  }
});
