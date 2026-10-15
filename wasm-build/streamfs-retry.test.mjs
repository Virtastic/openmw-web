// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// streamfs worker: a dropped range request is retried, a hung one is abandoned per attempt, and a
// 4xx is final. Runs the worker's own rangeFetch (pulled out of play/streamfs.js) against a fake
// fetch.   node wasm-build/streamfs-retry.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../play/streamfs.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const ATTEMPTS'), src.indexOf('onmessage = async'));
assert.ok(body.includes('async function rangeFetch'), 'rangeFetch is where this test expects it');

function load(fetchImpl, attemptMs) {
  const code = body.replace(/ATTEMPT_MS = \d+/, `ATTEMPT_MS = ${attemptMs}`)
    .replace(/400 \* i \* i/, '1');
  return new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', code + '; return rangeFetch;')(
    fetchImpl, AbortController, setTimeout, clearTimeout);
}
const ok = (n) => ({ ok: false, status: 206, arrayBuffer: async () => new Uint8Array(n).buffer });

// Two network failures, then success.
let calls = 0;
let rf = load(async () => { if (++calls < 3) throw new TypeError('Failed to fetch'); return ok(8); }, 1000);
assert.equal((await rf('u', 0, 8)).length, 8);
assert.equal(calls, 3, 'retried through two drops');

// A 503 then success.
calls = 0;
rf = load(async () => (++calls === 1 ? { ok: false, status: 503 } : ok(4)), 1000);
assert.equal((await rf('u', 0, 4)).length, 4);

// A hung first attempt is aborted on its deadline and the retry answers.
calls = 0;
rf = load((url, opts) => new Promise((res, rej) => {
  if (++calls === 1) opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
  else res(ok(2));
}), 50);
assert.equal((await rf('u', 0, 2)).length, 2);
assert.equal(calls, 2);

// A 404 is an answer: no retry.
calls = 0;
rf = load(async () => { calls++; return { ok: false, status: 404 }; }, 1000);
await assert.rejects(rf('u', 0, 2), /HTTP 404/);
assert.equal(calls, 1, 'a 404 is not retried');

// Always down: gives up after four attempts.
calls = 0;
rf = load(async () => { calls++; throw new TypeError('Failed to fetch'); }, 1000);
await assert.rejects(rf('u', 0, 2), /Failed to fetch/);
assert.equal(calls, 4);

console.log('streamfs retry: ok');
