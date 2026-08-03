// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// SigV4 presigning. The properties that matter are the security ones: a URL is bound to
// its method and its key, it expires, and the secret never appears in it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { S3Storage, s3FromEnv } from '../src/data/s3';

const s3 = new S3Storage({
  endpoint: 'https://s3.us-east-1.amazonaws.com',
  region: 'us-east-1',
  bucket: 'omw-lockers',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'supersecretkey',
});

test('a presigned URL carries the signature fields and never the secret', async () => {
  const url = await s3.presignGet('gamedata/alice/Morrowind.esm');
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(url, /X-Amz-Credential=AKIAEXAMPLE/);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.match(url, /X-Amz-Expires=\d+/);
  assert.ok(!url.includes('supersecretkey'), 'the secret key must never reach a browser');
});

test('signatures are bound to the method and to the key', async () => {
  const get = await s3.presignGet('gamedata/alice/Morrowind.esm');
  const put = await s3.presignPut('gamedata/alice/Morrowind.esm', 100);
  const other = await s3.presignGet('gamedata/bob/Morrowind.esm');
  const sig = (u: string) => /X-Amz-Signature=([0-9a-f]{64})/.exec(u)![1];

  assert.notEqual(sig(get), sig(put), 'a read URL must not be replayable as a write');
  assert.notEqual(sig(get), sig(other), 'a URL for one account must not address another');
  assert.match(get, /\/omw-lockers\/gamedata\/alice\/Morrowind\.esm/, 'path-style by default');
});

test('keys with spaces and punctuation are escaped without breaking the path', async () => {
  const url = await s3.presignGet("gamedata/alice/Bloodmoon (GOTY)'s Data.esm");
  assert.ok(url.includes('/gamedata/alice/'), 'separators stay separators');
  assert.ok(!/[ ()']/.test(new URL(url).pathname), 'characters S3 rejects unescaped are escaped');
});

test('storage is undefined until the operator actually configures it', () => {
  const before = { id: process.env.S3_ACCESS_KEY_ID, secret: process.env.S3_SECRET_ACCESS_KEY };
  delete process.env.S3_ACCESS_KEY_ID;
  delete process.env.S3_SECRET_ACCESS_KEY;
  assert.equal(s3FromEnv({ endpoint: 'https://x', region: 'r', bucket: 'b' }), undefined,
    'no credentials means no locker, and the client keeps using its own disk');

  process.env.S3_ACCESS_KEY_ID = 'k';
  process.env.S3_SECRET_ACCESS_KEY = 's';
  assert.equal(s3FromEnv({ endpoint: '', region: 'r', bucket: 'b' }), undefined, 'endpoint required');
  assert.ok(s3FromEnv({ endpoint: 'https://x', region: 'r', bucket: 'b' }));

  if (before.id === undefined) delete process.env.S3_ACCESS_KEY_ID;
  else process.env.S3_ACCESS_KEY_ID = before.id;
  if (before.secret === undefined) delete process.env.S3_SECRET_ACCESS_KEY;
  else process.env.S3_SECRET_ACCESS_KEY = before.secret;
});
