// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Server-side savegames and the filesystem storage backend.
//
// The interesting cases are all boundary cases: with S3 a key is an opaque string, but the
// filesystem backend turns it into a real path, so traversal, the byte cap and cross-account
// reads are the things that must not regress. Range support is here because StreamFS reads
// the game data back with Range requests and a backend that answers 200 to a Range request
// hands the whole multi-hundred-MB file to a client asking for 64 KB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FsStorage, fsStorageFrom, blobRoutes, parseRange } from '../src/data/fsstorage';
import { saveRoutes } from '../src/data/save-routes';
import { tmpDataDir } from './helpers';

// A server carrying both route groups, exactly as the front door chains them.
async function harness(dir: string, sessions: Record<string, string>) {
  let base = '';
  const storage = fsStorageFrom(dir, 'http://127.0.0.1:0');
  const blobs = blobRoutes(storage);
  const saves = saveRoutes({
    storage,
    sessions: { resolve: (t) => sessions[t] },
    dataDir: dir,
    maxBytesPerAccount: 1024,
  });
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base || 'http://x');
      if (await blobs(req, res, url)) return;
      if (await saves(req, res, url)) return;
      res.writeHead(404); res.end();
    })();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  // The presigned URLs are minted against the base the storage was built with, so rewrite
  // them onto the port we actually got. (In production publicBase is the real origin.)
  const fix = (u: string): string => u.replace('http://127.0.0.1:0', base);
  return { base, fix, storage, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

test('a key is never allowed to escape the storage root', () => {
  const dir = tmpDataDir();
  const s = new FsStorage(join(dir, 'blobs'), 'http://x', Buffer.alloc(32, 7));
  for (const bad of [
    'gamedata/../../etc/passwd',
    '../outside',
    '/etc/passwd',
    'gamedata\\..\\x',
    'gamedata/a\0b',
    '',
  ]) {
    assert.throws(() => s.pathFor(bad), `accepted ${JSON.stringify(bad)}`);
  }
  // The shape the locker actually uses still resolves, under the root.
  assert.ok(s.pathFor('gamedata/alice/Morrowind.esm').startsWith(join(dir, 'blobs')));
});

test('a blob token is bound to its method and key', async () => {
  const dir = tmpDataDir();
  const s = new FsStorage(join(dir, 'blobs'), 'http://x', Buffer.alloc(32, 7));
  const url = await s.presignPut('gamedata/alice/a.esm', 100);
  const token = url.split('/blob/')[1]!.split('/')[0]!;
  assert.equal(s.verify(token, 'PUT', 'gamedata/alice/a.esm'), 100);
  assert.equal(s.verify(token, 'GET', 'gamedata/alice/a.esm'), undefined, 'replayed as GET');
  assert.equal(s.verify(token, 'PUT', 'gamedata/bob/a.esm'), undefined, 'repointed at another account');
  const forged = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
  assert.equal(s.verify(forged, 'PUT', 'gamedata/alice/a.esm'), undefined, 'forged mac');
});

test('parseRange covers the three forms and refuses the impossible', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=0-999', 100), { start: 0, end: 99 }); // clamped
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange(undefined, 100), undefined);
  assert.equal(parseRange('items=1-2', 100), undefined);
});

test('a save round-trips, and a Range read comes back as 206', async () => {
  const dir = tmpDataDir();
  const h = await harness(dir, { 'tok-a': 'alice' });
  try {
    const body = Buffer.from('OMWSAVE-BYTES-0123456789');
    const au = await (await fetch(`${h.base}/saves/authorize-upload`, {
      method: 'POST', headers: { authorization: 'Bearer tok-a' },
      body: JSON.stringify({ name: 'Hero - Save 1.omwsave', size: body.length }),
    })).json() as { ok: boolean; url: string };
    assert.equal(au.ok, true);

    assert.equal((await fetch(h.fix(au.url), { method: 'PUT', body })).status, 200);
    await fetch(`${h.base}/saves/uploaded`, {
      method: 'POST', headers: { authorization: 'Bearer tok-a' },
      body: JSON.stringify({ name: 'Hero - Save 1.omwsave', size: body.length, mtime: 42 }),
    });

    const list = await (await fetch(`${h.base}/saves`, { headers: { authorization: 'Bearer tok-a' } }))
      .json() as { files: { name: string; size: number; mtime: number }[] };
    assert.deepEqual(list.files, [{ name: 'Hero - Save 1.omwsave', size: body.length, mtime: 42 }]);

    const dl = await (await fetch(`${h.base}/saves/download?name=${encodeURIComponent('Hero - Save 1.omwsave')}`,
      { headers: { authorization: 'Bearer tok-a' } })).json() as { url: string };
    const whole = await fetch(h.fix(dl.url));
    assert.equal(Buffer.from(await whole.arrayBuffer()).toString(), body.toString());

    const partial = await fetch(h.fix(dl.url), { headers: { Range: 'bytes=8-12' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 8-12/${body.length}`);
    assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), body.subarray(8, 13).toString());
  } finally {
    await h.close();
  }
});

test('one account cannot read, list or delete another account\'s save', async () => {
  const dir = tmpDataDir();
  const h = await harness(dir, { 'tok-a': 'alice', 'tok-b': 'bob' });
  try {
    const body = Buffer.from('mine');
    const au = await (await fetch(`${h.base}/saves/authorize-upload`, {
      method: 'POST', headers: { authorization: 'Bearer tok-a' },
      body: JSON.stringify({ name: 'Alice.omwsave', size: body.length }),
    })).json() as { url: string };
    await fetch(h.fix(au.url), { method: 'PUT', body });
    await fetch(`${h.base}/saves/uploaded`, {
      method: 'POST', headers: { authorization: 'Bearer tok-a' },
      body: JSON.stringify({ name: 'Alice.omwsave', size: body.length }),
    });

    // 404, not 403: the answer must not reveal that somebody else has this save.
    const asBob = await fetch(`${h.base}/saves/download?name=Alice.omwsave`,
      { headers: { authorization: 'Bearer tok-b' } });
    assert.equal(asBob.status, 404);
    const delBob = await fetch(`${h.base}/saves/delete`, {
      method: 'POST', headers: { authorization: 'Bearer tok-b' },
      body: JSON.stringify({ name: 'Alice.omwsave' }),
    });
    assert.equal(delBob.status, 404);
    const bobList = await (await fetch(`${h.base}/saves`, { headers: { authorization: 'Bearer tok-b' } }))
      .json() as { files: unknown[] };
    assert.deepEqual(bobList.files, []);
    // ...and alice still has it after bob's attempts.
    assert.equal((await fetch(`${h.base}/saves/download?name=Alice.omwsave`,
      { headers: { authorization: 'Bearer tok-a' } })).status, 200);

    assert.equal((await fetch(`${h.base}/saves`)).status, 401, 'no token');
  } finally {
    await h.close();
  }
});

test('a name that is not a plain .omwsave filename is refused', async () => {
  const dir = tmpDataDir();
  const h = await harness(dir, { 'tok-a': 'alice' });
  try {
    for (const name of ['../../escape.omwsave', '/etc/passwd', 'x.omwsave/../y.omwsave', 'shell.sh', '']) {
      const r = await fetch(`${h.base}/saves/authorize-upload`, {
        method: 'POST', headers: { authorization: 'Bearer tok-a' },
        body: JSON.stringify({ name, size: 1 }),
      });
      assert.equal(r.status, 400, `accepted ${JSON.stringify(name)}`);
    }
  } finally {
    await h.close();
  }
});

test('an upload past its signed length is cut off and leaves no file', async () => {
  const dir = tmpDataDir();
  const h = await harness(dir, { 'tok-a': 'alice' });
  try {
    const url = h.fix(await h.storage.presignPut('saves/alice/Small.omwsave', 8));
    // 413, or a reset the client sees as a network error — the connection is cut mid-body.
    // Either is a refusal; what must never happen is bytes surviving on the operator's disk.
    const status = await fetch(url, { method: 'PUT', body: Buffer.alloc(4096, 1) })
      .then((r) => r.status, () => 0);
    assert.notEqual(status, 200);
    const path = join(dir, 'locker-blobs', 'saves', 'alice', 'Small.omwsave');
    assert.equal(existsSync(path), false, 'refused bytes were kept');
    // Deliberately NOT asserting the .tmp is gone by now. The 413 is sent BEFORE cleanup so a
    // client whose connection is about to be cut still learns why, which makes the removal
    // genuinely asynchronous — and on a loaded CI box it lost that race twice and failed a
    // test whose actual subject is "no accepted bytes survive". A transient temp is
    // housekeeping; the file above is the security property.
  } finally {
    await h.close();
  }
});

// Both of these took the whole process down under a pressure run, and neither is exotic: a
// mirror retrying while its previous upload is still in flight produces the first, and any
// client that ignores the refusal produces the second.
test('concurrent uploads of one slot do not tear the file or crash the server', async () => {
  const dir = tmpDataDir();
  const h = await harness(dir, { 'tok-a': 'alice' });
  try {
    const bodies = [...Array(8).keys()].map((i) => Buffer.alloc(64, 65 + i));
    await Promise.all(bodies.map(async (body) => {
      const url = h.fix(await h.storage.presignPut('saves/alice/Race.omwsave', body.length));
      assert.equal((await fetch(url, { method: 'PUT', body })).status, 200);
    }));
    // Exactly one of the writers won, whole — never a mix of two, never a half-written file.
    const got = readFileSync(join(dir, 'locker-blobs', 'saves', 'alice', 'Race.omwsave'));
    assert.ok(bodies.some((b) => b.equals(got)), 'the surviving file is a torn mix');
    assert.deepEqual(
      readdirSync(join(dir, 'locker-blobs', 'saves', 'alice')).filter((f) => f.includes('.tmp')), []);
  } finally {
    await h.close();
  }
});

test('a client that keeps sending past the cap is refused without killing the server', async () => {
  const dir = tmpDataDir();
  const h = await harness(dir, { 'tok-a': 'alice' });
  try {
    for (let i = 0; i < 3; i++) {
      const url = h.fix(await h.storage.presignPut(`saves/alice/Cap${i}.omwsave`, 512));
      const status = await fetch(url, { method: 'PUT', body: Buffer.alloc(2 * 1024 * 1024, 1) })
        .then((r) => r.status, () => 0);
      assert.notEqual(status, 200);
    }
    // Still serving afterwards: the refusals must not have taken the process with them.
    assert.equal((await fetch(`${h.base}/saves`, { headers: { authorization: 'Bearer tok-a' } })).status, 200);
    // Only the FINAL names. Cleanup of the temp is asynchronous by design (the 413 goes out
    // first), so asserting on its timing measures the CI box's load, not the server.
    const landed = readdirSync(join(dir, 'locker-blobs', 'saves', 'alice'))
      .filter((f) => /^Cap\d+\.omwsave$/.test(f));
    assert.deepEqual(landed, [], 'refused bytes were kept');
  } finally {
    await h.close();
  }
});

test('the quota counts a replaced slot only once', async () => {
  const dir = tmpDataDir();
  const h = await harness(dir, { 'tok-a': 'alice' }); // maxBytesPerAccount = 1024
  try {
    const put = async (name: string, size: number) =>
      await (await fetch(`${h.base}/saves/authorize-upload`, {
        method: 'POST', headers: { authorization: 'Bearer tok-a' },
        body: JSON.stringify({ name, size }),
      })).json() as { ok: boolean; reason?: string };
    const record = async (name: string, size: number) =>
      fetch(`${h.base}/saves/uploaded`, {
        method: 'POST', headers: { authorization: 'Bearer tok-a' },
        body: JSON.stringify({ name, size }),
      });

    assert.equal((await put('A.omwsave', 900)).ok, true);
    await record('A.omwsave', 900);
    // A second slot does not fit...
    assert.deepEqual(await put('B.omwsave', 900), { ok: false, reason: 'quota' });
    // ...but overwriting the first one does, because its old bytes go away.
    assert.equal((await put('A.omwsave', 1000)).ok, true);
  } finally {
    await h.close();
  }
});

test('deleting a save removes the bytes as well as the row', async () => {
  const dir = tmpDataDir();
  const h = await harness(dir, { 'tok-a': 'alice' });
  try {
    const body = Buffer.from('bytes');
    const au = await (await fetch(`${h.base}/saves/authorize-upload`, {
      method: 'POST', headers: { authorization: 'Bearer tok-a' },
      body: JSON.stringify({ name: 'Gone.omwsave', size: body.length }),
    })).json() as { url: string };
    await fetch(h.fix(au.url), { method: 'PUT', body });
    await fetch(`${h.base}/saves/uploaded`, {
      method: 'POST', headers: { authorization: 'Bearer tok-a' },
      body: JSON.stringify({ name: 'Gone.omwsave', size: body.length }),
    });
    const path = join(dir, 'locker-blobs', 'saves', 'alice', 'Gone.omwsave');
    assert.equal(readFileSync(path).toString(), 'bytes');

    assert.equal((await fetch(`${h.base}/saves/delete`, {
      method: 'POST', headers: { authorization: 'Bearer tok-a' },
      body: JSON.stringify({ name: 'Gone.omwsave' }),
    })).status, 200);
    assert.equal(existsSync(path), false, 'delete left the bytes on disk');
  } finally {
    await h.close();
  }
});
