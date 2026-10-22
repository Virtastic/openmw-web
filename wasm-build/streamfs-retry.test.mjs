// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// streamfs worker: a dropped range request is retried, a hung one is abandoned per attempt, and a
// 4xx is final. Runs the worker's own rangeFetch (pulled out of play/streamfs.js) against a fake
// fetch.   node wasm-build/streamfs-retry.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../play/streamfs.js', import.meta.url), 'utf8');
// THE FILE ITSELF MUST PARSE. The worker's code is a template literal inside streamfs.js, and this
// test reads it out of the source -- so a backtick in a worker comment ended the template, broke
// every page load (Jenkins #228: 74 of 75 scenarios, "Unexpected identifier 'end'"), and this test
// still passed. Compile the real file, and the worker source as the page builds it.
{
  const vm = await import('node:vm');
  new vm.Script(src, { filename: 'play/streamfs.js' });
  const tpl = src.slice(src.indexOf('return `') + 'return `'.length);
  assert.ok(!tpl.slice(0, tpl.indexOf('`;')).includes('${'), 'no interpolation inside the worker source');
}
const body = src.slice(src.indexOf('const ATTEMPTS'), src.indexOf('onmessage = async'));
assert.ok(body.includes('async function rangeFetch'), 'rangeFetch is where this test expects it');

function load(fetchImpl, attemptMs) {
  const code = body.replace(/ATTEMPT_MS = \d+/, `ATTEMPT_MS = ${attemptMs}`)
    .replace(/400 \* i \* i/, '1');
  return new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', code + '; return rangeFetch;')(
    fetchImpl, AbortController, setTimeout, clearTimeout);
}
const ok = (n) => new Response(new Uint8Array(n), { status: 206, headers: { 'content-range': 'bytes 0-' + (n - 1) + '/*' } });
const status = (code) => new Response(null, { status: code });

// Two network failures, then success.
let calls = 0;
let rf = load(async () => { if (++calls < 3) throw new TypeError('Failed to fetch'); return ok(8); }, 1000);
assert.equal((await rf('u', 0, 8)).length, 8);
assert.equal(calls, 3, 'retried through two drops');

// A 503 then success.
calls = 0;
rf = load(async () => (++calls === 1 ? status(503) : ok(4)), 1000);
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
rf = load(async () => { calls++; return status(404); }, 1000);
await assert.rejects(rf('u', 0, 2), /HTTP 404/);
assert.equal(calls, 1, 'a 404 is not retried');

// Always down: gives up after four attempts.
calls = 0;
rf = load(async () => { calls++; throw new TypeError('Failed to fetch'); }, 1000);
await assert.rejects(rf('u', 0, 2), /Failed to fetch/);
assert.equal(calls, 4);

// THE PREFETCH GETS ONE DEADLINED ATTEMPT. It used a bare fetch with no deadline: stalled, it held
// the read of the same chunk (which waits on it) past the main thread's 60 s timeout.
calls = 0;
rf = load(async () => { calls++; throw new TypeError('Failed to fetch'); }, 1000);
await assert.rejects(rf('u', 0, 2, 1), /Failed to fetch/);
assert.equal(calls, 1, 'tries=1 is one attempt');
{
  const pre = src.slice(src.indexOf('SEQUENTIAL PREFETCH'), src.indexOf('} catch (err) {', src.indexOf('SEQUENTIAL PREFETCH')));
  assert.ok(/rangeFetch\(m\.url, m\.next\.start, m\.next\.end, 1, 10000\)/.test(pre) && !/await fetch\(/.test(pre), 'the prefetch goes through rangeFetch');
}

// A 200 IS THE WHOLE FILE (the Range was ignored): only the requested slice comes back.
rf = load(async () => new Response(Uint8Array.from({ length: 64 }, (_, i) => i), { status: 200 }), 1000);
assert.deepEqual([...(await rf('u', 8, 12))], [8, 9, 10, 11], 'a 200 is sliced to the range');

// A SLOW BODY IS NOT A HUNG ONE (prod 2026-10-18, the boot read of Morrowind.bsa): pieces 30 ms
// apart for 150 ms, under a 50 ms deadline, still complete -- the clock restarts on each piece.
calls = 0;
rf = load(async (url, opts) => { calls++; let k = 0; return new Response(new ReadableStream({
  async pull(c) { await new Promise((r) => setTimeout(r, 30)); if (opts.signal.aborted) return c.error(new Error('aborted')); if (k++ < 5) c.enqueue(new Uint8Array(2)); else c.close(); },
}), { status: 206 }); }, 50);
assert.equal((await rf('u', 0, 10)).length, 10);
assert.equal(calls, 1, 'one attempt, not restarted at the deadline');

// ...BUT THE WHOLE READ HAS A BUDGET: a trickle that would outlast the page's 60 s ceiling is
// cut at the budget, and no retry starts past it.
calls = 0;
rf = load(async (url, opts) => { calls++; return new Response(new ReadableStream({
  async pull(c) { await new Promise((r) => setTimeout(r, 30)); if (opts.signal.aborted) return c.error(new Error('aborted')); c.enqueue(new Uint8Array(1)); },
}), { status: 206 }); }, 1000);
{
  const t0 = Date.now();
  await assert.rejects(rf('u', 0, 1000, 4, 200), /aborted/);
  assert.ok(Date.now() - t0 < 900, 'the budget, not four silence deadlines, ended the read');
  assert.equal(calls, 1, 'no retry past the budget');
}

// The failure says what each attempt saw: status, ranges, bytes, ms.
rf = load(async () => new Response(new Uint8Array(3), { status: 206, headers: { 'content-range': 'bytes 0-2/9' } }), 1000);
await assert.rejects(rf('u', 0, 8), (e) => /short body 3\/8/.test(e.message) && /206 cl=\S+ cr=bytes 0-2\/9 .*got=3 \d+ms/.test(e.message) && e.message.split('; ').length === 4);

// WARM-UP BUDGET (prod 2026-10-17): chunks already in the store cost nothing, so a file mostly
// cached from a past visit is still finished; new bytes stop at the budget.
{
  const warmSrc = body.slice(body.indexOf('let fg = 0'));
  const stored = new Set(['https://sfs.chunk/big/0', 'https://sfs.chunk/big/2']); // 2 of 4 chunks cached
  const puts = [];
  const msgs = [];
  const fakeCaches = { open: async () => ({ match: async (k) => stored.has(k), put: async (k) => { puts.push(k); stored.add(k); } }) };
  const run = new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'caches', 'postMessage', 'Response',
    body.slice(0, body.indexOf('let fg = 0')) + warmSrc + '; return warm;');
  const fetchFake = async (url, opts) => ok(2);
  // Naps run at once; the cache deadline (CACHE_MS) never fires, as for a healthy store.
  const fastTimers = (f, ms) => (ms >= 3000 ? 0 : setTimeout(f, 0));
  let warm = run(fetchFake, AbortController, fastTimers, clearTimeout, fakeCaches, (m) => msgs.push(m), class { constructor(b) { this.b = b; } });
  // 4 chunks of 2 bytes, 2 cached, budget 10 bytes: the 2 missing chunks are fetched (4 bytes).
  await warm([{ url: 'u', pkey: 'big', size: 8 }], 2, 10);
  assert.deepEqual(puts, ['https://sfs.chunk/big/4', 'https://sfs.chunk/big/6'], 'only the missing chunks are fetched');
  assert.deepEqual(msgs.at(-1), { warmed: 0, done: true, err: null }, 'finished within budget');
  // A budget smaller than what is missing stops with 'budget', after what fits.
  stored.clear(); puts.length = 0; msgs.length = 0;
  warm = run(fetchFake, AbortController, fastTimers, clearTimeout, fakeCaches, (m) => msgs.push(m), class { constructor(b) { this.b = b; } });
  await warm([{ url: 'u', pkey: 'big', size: 8 }], 2, 5);
  assert.equal(puts.length, 2, 'two chunks fit a 5-byte budget');
  assert.equal(msgs.at(-1).err, 'budget');
}

// The persistent key: a same-origin file with a bare version tag (?v=2, how index.html mounts the
// hosted base game) is persisted and warmed; a presigned or cross-origin URL is not.
{
  const m = src.match(/const pkey = (u\.origin[\s\S]*?: null);/);
  assert.ok(m, 'pkey expression is where this test expects it');
  const pkeyOf = (href) => new Function('u', 'location', 'size', 'mtime', 'CHUNK', 'return ' + m[1])(
    new URL(href), { origin: 'https://h' }, 10, 0, 2);
  assert.equal(pkeyOf('https://h/mwdata/Morrowind.bsa?v=2'), '/mwdata/Morrowind.bsa?v=2@10@2', 'versioned base game is persisted');
  assert.equal(pkeyOf('https://h/data/openmw-web-assets.bsa'), '/data/openmw-web-assets.bsa@10@2');
  assert.equal(pkeyOf('https://h/locker/x.bsa?X-Amz-Signature=abc&v=2'), null, 'presigned is not persisted');
  assert.equal(pkeyOf('https://s3.example/x.bsa'), null, 'cross-origin is not persisted');
}

// A STALLED CACHE API (prod 2026-10-19: boots died on "read timeout", the network never asked).
// Real timers, the deadline cut to 50 ms.
{
  const src2 = body.slice(0, body.indexOf('async function warm')).replace(/CACHE_MS = \d+/, 'CACHE_MS = 50');
  const mk = (caches, msgs) => new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'caches', 'postMessage', 'Response',
    src2 + '; return { cacheMatch, cacheRead, dead: () => cacheDead };')(
    async () => ok(1), AbortController, setTimeout, clearTimeout, caches, (m) => msgs.push(m), Response);

  // A store that never answers: each lookup is a miss at the deadline; the THIRD in a row
  // switches the store off, said once, and nothing asks it again.
  let opens = 0;
  const msgs = [];
  const c = mk({ open: () => { opens++; return new Promise(() => {}); } }, msgs);
  const t0 = Date.now();
  assert.equal(await c.cacheMatch('k'), undefined, 'a stalled lookup is a miss, not a hang');
  assert.ok(Date.now() - t0 < 1000, 'gave up at the deadline');
  assert.ok(!c.dead(), 'one slow answer is not a dead store');
  await c.cacheRead('k'); await c.cacheRead('k');
  assert.ok(!c.dead(), 'late READS are not strikes: the hedged read already served the game');
  await c.cacheMatch('k', false);
  assert.ok(!c.dead(), 'nor is the read-ahead');
  await c.cacheMatch('k'); await c.cacheMatch('k');
  assert.ok(c.dead(), "three of the warm-up's lookups in a row are");
  assert.deepEqual(msgs, [{ cacheSlow: 1 }], 'said so once');
  const before = opens;
  assert.equal(await c.cacheRead('k2'), undefined);
  assert.equal(opens, before, 'no lookup against a dead store');

  // A POISONED ENTRY: the lookup answers, the body never does (the case that still killed every
  // boot after the first deadline). The read is a miss at the deadline. The entry is NOT deleted:
  // a busy store's late answers looked the same and lost good chunks; the network copy's put
  // overwrites a poisoned one.
  const deleted = [];
  const poisoned = { open: async () => ({ match: async () => ({ arrayBuffer: () => new Promise(() => {}) }), delete: async (k) => { deleted.push(k); } }) };
  const p = mk(poisoned, []);
  const t1 = Date.now();
  assert.equal(await p.cacheRead('bsa@0'), undefined, 'a body that never arrives is a miss, not a hang');
  assert.ok(Date.now() - t1 < 1000, 'gave up at the deadline');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(deleted, [], 'nothing is deleted on lateness');

  // A healthy store answers in time and the bytes come back; a slow answer in between does not
  // count against it once a timely one follows.
  let slow = true;
  const flaky = { open: async () => ({ match: async () => {
    if (slow) { slow = false; return new Promise(() => {}); }
    return { arrayBuffer: async () => new Uint8Array([7, 8]).buffer };
  } }) };
  const f = mk(flaky, []);
  assert.equal(await f.cacheRead('x'), undefined);
  assert.deepEqual([...(await f.cacheRead('x'))], [7, 8], 'bytes from a timely answer');
  await f.cacheRead('x'); await f.cacheRead('x');
  assert.ok(!f.dead(), 'a timely answer resets the count');

  // AN ANSWERED STEP IS NEVER LATE (prod 2026-10-20). The deadline timer outlives the race, and
  // it used to strike and delete regardless: three instant reads killed a healthy store and
  // erased the three chunks they had just read. Wait past the deadline before looking.
  const gone = [];
  const fine = { open: async () => ({ match: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }),
    delete: async (k) => { gone.push(k); } }) };
  const hmsgs = [];
  const h = mk(fine, hmsgs);
  for (const k of ['a', 'b', 'c', 'd']) { await h.cacheRead(k); await h.cacheMatch(k); }
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(!h.dead(), 'a store that answers in time stays on');
  assert.deepEqual(hmsgs, [], 'no cacheSlow for a healthy store');
  assert.deepEqual(gone, [], 'chunks read back in time are kept');
}

// LOOSE AUDIO IS WARMED (prod 2026-10-19: "each new sound, just the first time"). Sound/ and Music/
// are loose files the engine reads with the main thread blocked; index.html's warm-up list must
// queue Fx first, smallest first, then the archives, creatures and music -- and never Sound/Vo.
// The real streamfs.js runs in a sandbox with the patterns index.html passes.
{
  const html = readFileSync(new URL('../play/index.html', import.meta.url), 'utf8');
  const re = html.match(/var WARM_RE = (\/.*\/i);/), first = html.match(/var WARM_FIRST = (\[.*\]);/);
  assert.ok(re && first && /StreamFS\.warm\(WARM_RE, WARM_FIRST\)/.test(html), 'index.html warms WARM_RE in WARM_FIRST order');
  const vm = await import('node:vm');
  const posted = [];
  const ctx = {
    URL, Blob, SharedArrayBuffer, Int32Array, Uint8Array, Map, location: { href: 'https://h/', origin: 'https://h', search: '' },
    navigator: {}, self: { crossOriginIsolated: true }, Worker: class { constructor() { ctx.worker = this; } postMessage(m) { posted.push(m); } },
    caches: {}, setTimeout, clearTimeout, Promise,
    FS: { createFile: () => ({ node_ops: {}, stream_ops: {} }) },
  };
  ctx.window = ctx; ctx.URL = class extends URL { static createObjectURL() { return 'blob:x'; } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  vm.runInContext('StreamFS.init()', ctx);
  const mounts = [['Music/Explore/mx_explore_7.mp3', 3e6], ['Morrowind.bsa', 3e8], ['Sound/Vo/a/f/hlo_001.mp3', 2e4],
    ['Sound/Fx/foot/walkr_lt.wav', 9e3], ['Sound/Fx/item/bookpag1.wav', 4e3], ['Sound/Cr/rat/roar.wav', 5e4], ['Tribunal.bsa', 7e7], ['Splash/Splash_Netch.tga', 3e6],
    ['Sound/Vo/i/m/Hlo_IM064.mp3', 2e4]];
  for (const [p, s] of mounts) ctx.StreamFS.mount('/mwdata/' + p, 'mwdata/' + p + '?v=2', s);
  ctx.StreamFS.mount('/mods/openmw-web-assets.bsa', 'mods/openmw-web-assets.bsa', 1.1e8);
  assert.equal(vm.runInContext('StreamFS.warm(' + re[1] + ', ' + first[1] + ')', ctx), 8, 'eight files queued');
  const order = Array.from(posted.at(-1).warm, (f) => f.url.replace(/^https:\/\/h\/(mwdata|mods)\/|\?v=2$/g, ''));
  // Archives first: the next town comes out of them (prod 2026-10-20: Fx-first left Morrowind.bsa
  // cold at the Seyda Neen dock, a 26.5 s freeze). Then Fx smallest first, creatures, music.
  // The asset pack ahead of Morrowind.bsa (prod 2026-10-21: the pack's chunks were 20 of 26 slow
  // reads stepping onto the dock).
  // Then Seyda Neen's greetings (prod 2026-10-21: Hlo_IM064.mp3, Idl_DF006.mp3 walking through town);
  // a/f (an Ashlander's) and the rest of Sound/Vo stay on demand.
  // The exploration music right after the archives (prod 2026-10-22: mx_explore_*.mp3 first plays).
  assert.deepEqual(order, ['openmw-web-assets.bsa', 'Morrowind.bsa', 'Music/Explore/mx_explore_7.mp3', 'Sound/Vo/i/m/Hlo_IM064.mp3', 'Sound/Fx/item/bookpag1.wav', 'Sound/Fx/foot/walkr_lt.wav',
    'Sound/Cr/rat/roar.wav', 'Tribunal.bsa'], 'archives, explore music, voices, then Fx smallest first, creatures; no other Vo, no Splash');

  // A PRELOADED CHUNK LANDS IN THE LRU under the key the engine's read looks up, so the read is a
  // memory hit (prod 2026-10-21: stored-only chunks were fetched again when the store was busy).
  const esm = ctx.StreamFS.mount('/mwdata/Morrowind.esm', 'mwdata/Morrowind.esm?v=2', 5);
  const done = vm.runInContext("StreamFS.preload([{ path: '/mwdata/Morrowind.esm' }])", ctx);
  const msg = posted.at(-1);
  assert.equal(msg.preload[0].size, 5);
  const before = ctx.StreamFS.stats().cached;
  ctx.worker.onmessage({ data: { preload: msg.id, done: 1, total: 1, bytes: 5, fi: 0, s: 0, buf: new Uint8Array([1, 2, 3, 4, 5]) } });
  ctx.worker.onmessage({ data: { preload: msg.id, end: true, done: 1, total: 1, bytes: 5 } });
  assert.equal((await done).done, 1);
  assert.equal(ctx.StreamFS.stats().cached, before + 1, 'the chunk is in the LRU');
  assert.equal(ctx.StreamFS.stats().preMem, 1);
  // The engine's read of those bytes: served from memory, nothing sent to the worker.
  const sent = posted.length, out = new Uint8Array(5);
  assert.equal(esm.stream_ops.read({}, out, 0, 5, 0), 5);
  assert.deepEqual([...out], [1, 2, 3, 4, 5]);
  assert.equal(posted.length, sent, 'a preloaded chunk does not go back to the worker');
}

// HEDGED READ (prod 2026-10-20: a busy store answered in 0.3-3 s, the network in ~0.1 s; 91 reads
// froze the Seyda Neen dock for 28 s). Real timers; the store's slowness is simulated.
{
  const src3 = body.slice(0, body.indexOf('onmessage = async'));
  const mk = (caches, fetchImpl) => new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'caches', 'postMessage', 'Response',
    src3 + '; return readChunk;')(fetchImpl, AbortController, setTimeout, clearTimeout, caches, () => {}, Response);
  const bytes = (v) => ({ arrayBuffer: async () => new Uint8Array([v, v]).buffer });
  const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  let fetches = 0;
  const net = async () => { fetches++; return ok(2); };
  const failNet = async () => { fetches++; throw new TypeError('Failed to fetch'); };

  // A fast hit: the store's bytes, no network.
  fetches = 0;
  let r = await mk({ open: async () => ({ match: async () => bytes(1) }) }, net)('u', 0, 2, 'k');
  assert.deepEqual([...r.buf], [1, 1]); assert.equal(r.net, false); assert.equal(fetches, 0, 'a hit asks no network');

  // A fast miss: straight to the network, worth storing.
  fetches = 0;
  r = await mk({ open: async () => ({ match: async () => undefined }) }, net)('u', 0, 2, 'k');
  assert.equal(r.net, true); assert.equal(fetches, 1);

  // A busy store (answers in 1 s): the network is asked at the hedge and wins.
  fetches = 0;
  let t0 = Date.now();
  r = await mk({ open: async () => ({ match: () => later(1000, bytes(1)) }) }, net)('u', 0, 2, 'k');
  assert.ok(Date.now() - t0 < 700, 'did not wait for the slow store: ' + (Date.now() - t0) + ' ms');
  assert.equal(r.net, true, 'the network bytes'); assert.equal(fetches, 1);

  // A busy store and a dead network: the store's late answer is used, not an error.
  t0 = Date.now();
  r = await mk({ open: async () => ({ match: () => later(800, bytes(3)) }) }, failNet)('u', 0, 2, 'k');
  assert.deepEqual([...r.buf], [3, 3], 'fell back to the store'); assert.equal(r.net, false);

  // No store at all (pkey null): the network.
  fetches = 0;
  r = await mk({ open: async () => { throw new Error('no store'); } }, net)('u', 0, 2, null);
  assert.equal(r.net, true); assert.equal(fetches, 1);
}

// PRELOAD BEFORE THE ENGINE (prod 2026-10-20: the content files were read a chunk at a time inside
// the engine's blocking start, 12 s median, 130 s worst, a frozen screen). Every chunk of the file
// is fetched and stored with one progress message each; a second run fetches nothing; a chunk that
// fails is skipped (the engine reads it itself) and the run still ends.
{
  const mk = (caches, fetchImpl, msgs) => new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'caches', 'postMessage', 'Response',
    body + '; return preload;')(fetchImpl, AbortController, setTimeout, clearTimeout, caches, (m) => msgs.push(m), Response);
  const stored = new Map();
  const store = { open: async () => ({ match: async (k) => stored.get(k), put: async (k, r) => { stored.set(k, r); } }) };
  let fetches = 0;
  const msgs = [];
  const files = [{ url: 'u', pkey: 'Morrowind.esm@5', size: 5 }];
  await mk(store, async () => { fetches++; return ok(2); }, msgs)(files, 2, 7);
  assert.equal(fetches, 3, 'every chunk of the file, once');
  assert.equal(stored.size, 3);
  assert.deepEqual(msgs.at(-1), { preload: 7, end: true, done: 3, total: 3, bytes: 5 });
  assert.equal(msgs.filter((m) => m.preload !== undefined && !m.end).length, 3, 'one progress message per chunk');
  // Each chunk's bytes go to the page for its in-memory LRU (prod 2026-10-21: stored-only chunks
  // were fetched again by the engine when the store answered late), with where they belong.
  assert.deepEqual(msgs.filter((m) => m.buf).map((m) => [m.fi, m.s, m.buf.length]), [[0, 0, 2], [0, 2, 2], [0, 4, 1]]);
  const again = [];
  fetches = 0;
  await mk(store, async () => { fetches++; return ok(2); }, again)(files, 2, 8);
  assert.equal(fetches, 0, 'stored chunks are not fetched again');
  assert.equal(again.at(-1).bytes, 0);
  assert.equal(again.filter((m) => m.buf).length, 3, 'stored chunks are still handed to the page');
  const failed = [];
  await mk({ open: async () => ({ match: async () => undefined, put: async () => {} }) },
    async () => status(404), failed)([{ url: 'u', pkey: 'x', size: 4, offs: [0, 2] }], 2, 9);
  assert.deepEqual(failed.at(-1), { preload: 9, end: true, done: 2, total: 2, bytes: 0 }, 'a failed chunk is skipped, the run ends');
}

// THE FILE STORE (prod 2026-10-19..21: a Cache API read cost ~224 ms on mid-tier machines, as much
// as the network). A fake origin-private file system: files are growable byte arrays that outlive
// a worker, so a second worker over the same "disk" is a reload.
{
  const disk = new Map();
  const handle = (name) => {
    if (!disk.has(name)) disk.set(name, new Uint8Array(0));
    return {
      getSize: () => disk.get(name).length,
      read: (b, { at }) => { const d = disk.get(name); const n = Math.max(0, Math.min(b.length, d.length - at)); b.set(d.subarray(at, at + n)); return n; },
      write: (b, { at }) => { let d = disk.get(name); if (at + b.length > d.length) { const g = new Uint8Array(at + b.length); g.set(d); d = g; disk.set(name, d); } d.set(b, at); return b.length; },
      flush() {}, close() {},
    };
  };
  const fsNav = { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({
    getFileHandle: async (n) => ({ createSyncAccessHandle: async () => handle(n) }),
  }) }) } };
  const stored = new Map();
  const cacheOf = (m) => ({ open: async () => ({ match: async (k) => m.get(k), put: async (k, r) => { m.set(k, r); }, delete: async (k) => { m.delete(k); } }) });
  const mk = (nav, caches, fetchImpl, msgs = []) => new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'caches', 'postMessage', 'Response', 'navigator',
    body + '; return { opfsGet, opfsPut, opfsHas, preload };')(fetchImpl, AbortController, setTimeout, clearTimeout, caches, (m) => msgs.push(m), Response, nav);

  // Stored, read back, and still there for the next page.
  let w = mk(fsNav, cacheOf(stored), async () => ok(2));
  assert.equal(await w.opfsPut('Morrowind.bsa@9', 4, new Uint8Array([5, 6]), 2), true);
  assert.deepEqual([...await w.opfsGet('Morrowind.bsa@9', 4, 6, 2)], [5, 6]);
  assert.equal(await w.opfsHas('Morrowind.bsa@9', 2, 2), false, 'a chunk never written is absent');
  w = mk(fsNav, cacheOf(stored), async () => ok(2));
  assert.deepEqual([...await w.opfsGet('Morrowind.bsa@9', 4, 6, 2)], [5, 6], 'a reload reads it back');
  // Bytes that landed without their flag (a write cut short) read as absent, never as data.
  const dat = [...disk.keys()].find((k) => k.endsWith('.dat'));
  disk.get(dat).set([9, 9], 0);
  assert.equal(await w.opfsGet('Morrowind.bsa@9', 0, 2, 2), undefined);

  // No file system at all: every call says no, and the Cache API path stands.
  const off = mk({}, cacheOf(new Map()), async () => ok(2));
  assert.equal(await off.opfsPut('x@1', 0, new Uint8Array([1]), 2), false);
  assert.equal(await off.opfsGet('x@1', 0, 1, 2), undefined);

  // Preload stores to the file, not the Cache API; a second preload fetches nothing.
  const cache2 = new Map();
  let fetches = 0;
  const msgs = [];
  w = mk(fsNav, cacheOf(cache2), async () => { fetches++; return ok(2); }, msgs);
  await w.preload([{ url: 'u', pkey: 'Tribunal.esm@4', size: 4 }], 2, 1);
  assert.equal(fetches, 2);
  assert.equal(cache2.size, 0, 'nothing written to the Cache API while the file store is up');
  fetches = 0;
  await mk(fsNav, cacheOf(cache2), async () => { fetches++; return ok(2); }).preload([{ url: 'u', pkey: 'Tribunal.esm@4', size: 4 }], 2, 2);
  assert.equal(fetches, 0, 'stored chunks come from the file');

  // An old Cache API chunk moves across: read from the cache, written to the file, deleted there.
  const cache3 = new Map([['https://sfs.chunk/' + encodeURIComponent('Bloodmoon.esm@2') + '/0', new Response(new Uint8Array([7, 8]))]]);
  fetches = 0;
  await mk(fsNav, cacheOf(cache3), async () => { fetches++; return ok(2); }).preload([{ url: 'u', pkey: 'Bloodmoon.esm@2', size: 2 }], 2, 3);
  assert.equal(fetches, 0, 'the old copy was used, not the network');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cache3.size, 0, 'and removed from the Cache API');
  assert.deepEqual([...await mk(fsNav, cacheOf(new Map()), async () => ok(2)).opfsGet('Bloodmoon.esm@2', 0, 2, 2)], [7, 8], 'it is in the file now');
}

// THE NEXT CELL'S FILES (prod 2026-10-19..21: entering an exterior waited on ~40 chunk downloads,
// 2.9 s median). The engine names model paths; the page resolves them through the archives the
// way the engine's VFS does and asks the worker for exactly those chunks, plus a texture pass.
{
  const vm = await import('node:vm');
  const bsa = (files) => { // a TES3 BSA: header, {size, offset}[], nameOffset[], names, hashes, data
    const n = files.length, names = files.map((f) => Buffer.from(f.name + '\0', 'latin1'));
    const namesLen = names.reduce((a, b) => a + b.length, 0), hashOff = n * 12 + namesLen;
    const dataStart = 12 + hashOff + n * 8, out = Buffer.alloc(dataStart + files.reduce((a, f) => a + f.data.length, 0));
    out.writeUInt32LE(0x100, 0); out.writeUInt32LE(hashOff, 4); out.writeUInt32LE(n, 8);
    let no = 0, d = 0;
    files.forEach((f, i) => {
      out.writeUInt32LE(f.data.length, 12 + i * 8); out.writeUInt32LE(d, 12 + i * 8 + 4);
      out.writeUInt32LE(no, 12 + n * 8 + i * 4); names[i].copy(out, 12 + n * 12 + no); no += names[i].length;
      f.data.copy(out, dataStart + d); d += f.data.length;
    });
    return { bytes: new Uint8Array(out), dataStart };
  };
  const nif = Buffer.concat([Buffer.from([1, 2, 3, 0x0b, 0, 0, 0]), Buffer.from('tx_wood.tga', 'latin1'), Buffer.from([0, 0])]);
  const mw = bsa([{ name: 'meshes\\a.nif', data: nif }, { name: 'meshes\\b.nif', data: Buffer.from('BBBB') }, { name: 'textures\\tx_wood.dds', data: Buffer.from('DDS ') }]);
  const pack = bsa([{ name: 'meshes\\b.nif', data: Buffer.from('PACKB') }]);
  const posted = [];
  const ctx = {
    URL, Blob, SharedArrayBuffer, Int32Array, Uint8Array, DataView, Map, Set, location: { href: 'https://h/', origin: 'https://h', search: '' },
    navigator: {}, self: { crossOriginIsolated: true }, caches: {}, setTimeout, clearTimeout, Promise,
    Worker: class { constructor() { ctx.worker = this; } postMessage(m) { posted.push(m); } },
    FS: { createFile: () => ({ node_ops: {}, stream_ops: {} }) },
  };
  ctx.window = ctx; ctx.URL = class extends URL { static createObjectURL() { return 'blob:x'; } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  vm.runInContext('StreamFS.init()', ctx);
  ctx.StreamFS.mount('/mwdata/Morrowind.bsa', 'mwdata/Morrowind.bsa?v=2', mw.bytes.length);
  ctx.StreamFS.mount('/mods/openmw-web-assets.bsa', 'mods/openmw-web-assets.bsa', pack.bytes.length);
  ctx.StreamFS.mount('/mwdata/Meshes/loose.nif', 'mwdata/Meshes/loose.nif?v=2', 9);
  // The archives' directories are already in memory (the engine read them at boot): hand chunk 0
  // of each to the page's LRU the way a preload does.
  for (const [path, bytes] of [['/mwdata/Morrowind.bsa', mw.bytes], ['/mods/openmw-web-assets.bsa', pack.bytes]]) {
    const done = ctx.StreamFS.preload([{ path, offs: [0] }]);
    const m = posted.at(-1);
    ctx.worker.onmessage({ data: { preload: m.id, done: 1, total: 1, bytes: 0, fi: 0, s: 0, buf: bytes } });
    ctx.worker.onmessage({ data: { preload: m.id, end: true, done: 1, total: 1, bytes: 0 } });
    await done;
  }
  posted.length = 0;
  const n = ctx.StreamFS.prefetchPaths(['meshes/a.nif', 'meshes/b.nif', 'meshes/loose.nif', 'meshes/missing.nif']);
  const req = posted.at(-1);
  assert.ok(req && req.prefetch, 'a prefetch request went to the worker');
  const urls = req.files.map((f) => f.url.replace(/^https:\/\/h\//, ''));
  const scanOf = (url) => JSON.parse(JSON.stringify(req.meshes.filter(([fi]) => urls[fi] === url).map(([, off, size]) => [off, size])));
  // a.nif from Morrowind.bsa; b.nif from the asset pack, which overrides it; the loose file; missing.nif nowhere.
  assert.deepEqual(scanOf('mwdata/Morrowind.bsa?v=2'), [[mw.dataStart, nif.length]]);
  assert.deepEqual(scanOf('mods/openmw-web-assets.bsa'), [[pack.dataStart, 5]], 'the asset pack copy, not Morrowind.bsa\'s');
  assert.deepEqual(scanOf('mwdata/Meshes/loose.nif?v=2'), [[0, 9]]);
  // Only the loose file's chunk is fetched: both archives' chunk 0 is already in memory.
  assert.equal(n, 1);
  assert.equal(JSON.stringify(req.files.map((f) => f.offs)), JSON.stringify(urls.map((u) => (u.startsWith('mwdata/Meshes') ? [0] : []))));
  // The worker's answer: the texture a.nif named. textures/tx_wood.dds exists, so .dds is asked for.
  posted.length = 0;
  ctx.worker.onmessage({ data: { prefetched: req.id, fetched: 2, chunks: 2, tex: ['tx_wood.tga'] } });
  assert.equal(posted.length, 0, 'the texture is in chunk 0 too: nothing more to fetch');
  assert.equal(ctx.StreamFS.stats().pfFetched, 2);
  // Asking again for the same paths fetches nothing twice.
  assert.equal(ctx.StreamFS.prefetchPaths(['meshes/b.nif']), 0);

  // The worker's texture scan finds the names a model carries, and only those.
  const w = new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'caches', 'postMessage', 'Response', 'navigator',
    body + '; return textureNames;')(async () => ok(1), AbortController, setTimeout, clearTimeout, {}, () => {}, Response, {});
  assert.deepEqual(w(new Uint8Array(Buffer.concat([nif, Buffer.from([0, 5, 0, 0, 0]), Buffer.from('Bip01'), Buffer.from([0, 9, 0, 0, 0]), Buffer.from('Textures\\Tx_Rock.DDS', 'latin1')])))
    .sort(), ['textures\\tx_rock.dds', 'tx_wood.tga']);
}

console.log('streamfs retry: ok');
