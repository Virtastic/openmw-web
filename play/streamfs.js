// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// SPDX-License-Identifier: GPL-3.0-or-later
// Part of openmw-web.
//
// streamfs.js — synchronous-read streaming files for the openmw-web build.
//
// Mounts a byte source as a read-only file in the emscripten FS whose bytes are fetched ON
// DEMAND in chunks by a helper Web Worker. The engine's synchronous main-thread read()
// spin-waits on a SharedArrayBuffer flag while the worker does the async read — the standard
// emscripten sync-over-async pattern (requires crossOriginIsolated, which server.py's
// COOP/COEP headers provide). Fetched chunks are LRU-cached in JS memory.
//
// Two byte sources are supported by the same machinery:
//   - a URL, read via HTTP Range requests (server-hosted mwdata) — StreamFS.mount()
//   - a local FileSystemFileHandle, read via getFile().slice() (user-picked Data Files) —
//     StreamFS.mountLocal()
//
// Why: modern Chrome forbids synchronous binary XHR on the main thread (so
// FS.createLazyFile aborts), and OpenMW reads BSAs synchronously on the main thread.
//
// Usage (from index.html preRun, after FS exists):
//   StreamFS.init();                                       // once
//   StreamFS.mount('/mwdata/Morrowind.bsa', 'mwdata/Morrowind.bsa', sizeBytes);
//   StreamFS.mountLocal('/mwdata/Morrowind.bsa', fileHandle, sizeBytes);
(function () {
  'use strict';
  // Chunk size and cache depth. MEASURED on a Balmora boot with retail data (see
  // window.__streamfsStats): at 4MB x 32 slots the cache THRASHED -- 27 evictions against 32 slots,
  // 59 misses, 1269ms of main-thread stall, for 229MB read. A BSA read is a mesh or a texture:
  // small, and scattered all over the archive. Pulling 4MB to serve a 20KB texture meant a handful
  // of live regions could not stay resident at once.
  //
  // Same ~128MB budget, four times as many distinct regions. Smaller chunks also make each miss
  // cheaper, and a miss BLOCKS the main thread (fetchChunkSync spins -- Atomics.wait is banned on
  // the main thread), so miss cost is frame time, not just bandwidth.
  //
  // Tunable at runtime for A/B without a rebuild: ?chunk=<KB>&lru=<slots>.
  const _q = (typeof location !== 'undefined' && location.search) || '';
  const _n = (re, dflt) => { const m = re.exec(_q); return m ? (parseInt(m[1], 10) || dflt) : dflt; };
  // CHUNK AND LRU MUST BE TUNED TOGETHER -- measured 2026-08-28, Balmora boot, at a constant
  // ~384MB cache budget so the comparison is memory-neutral:
  //
  //     1MB x 384 slots : 259 cold misses, 2253ms stall, 270MB fetched, NIF load 2457ms
  //     2MB x 192 slots : 150 cold misses, 1380ms stall, 307MB fetched, NIF load 1568ms  <-- best
  //     4MB x  96 slots :  89 cold misses, 1346ms stall, 337MB fetched, NIF load 1613ms
  //
  // With the LRU large enough that evictions are 0, every remaining miss is a COLD miss, and the
  // only way to cut those is to cover more bytes per fetch. 2MB folds neighbouring cold misses
  // into one round trip (-42% misses, -39% stall) and takes 36% off total mesh load time, since
  // ~59% of that is I/O (see components/resource/nifstats.hpp). 4MB keeps cutting misses but each
  // fetch costs more and pulls more unused bytes, so stall stops improving and boot gets worse.
  //
  // This supersedes the original F4 note below, which found 1MB beat 4MB -- that was measured at a
  // 32-to-128 slot LRU, where 4MB chunks thrashed. The chunk size was never the whole story.
  const CHUNK = _n(/[?&]chunk=(\d+)/, 2048) * 1024;   // 2MB default
  // Slot count is TIER-DEPENDENT and resolved lazily in init(), not here: index.html picks the
  // tier from navigator.deviceMemory and publishes window.__omwLruDefault, and this file is parsed
  // before that runs. 0 means "not decided yet"; an explicit ?lru= always wins.
  //
  // MEASURED 2026-08-28 (Balmora, matched workload -- hits within 0.1%): 128 slots was thrashing.
  //     lru=128 -> 215 evictions, 343 misses, 2684ms main-thread stall, 356MB fetched
  //     lru=384 ->   0 evictions, 259 misses, 1923ms main-thread stall, 268MB fetched
  // -28% stall and -25% bytes. The working set settles at 259 chunks, so 384 is headroom rather
  // than a guess. A miss BLOCKS the main thread (fetchChunkSync spins), so this is frame time.
  let LRU_MAX = _n(/[?&]lru=(\d+)/, 0);

  // cache is a Map used as an LRU: insertion order IS the recency order (delete+set moves to end),
  // so eviction pops the first (oldest) key. No separate order array → O(1) hit path, no linear scan.
  const S = { worker: null, ctrl: null, data: null, cache: new Map(), nextId: 1, urlSrcs: new Map(), preloads: new Map(), rec: new Set(), recDone: null };

  // Streaming cost counters, exposed as window.__streamfsStats. Chunk misses block the main thread
  // (see fetchChunkSync), so this is the only place the stall is observable. Two adds per read —
  // cheap enough to leave always-on, unlike the flag-gated ?glcount/?perfstats probes.
  const ST = { hits: 0, misses: 0, stallMs: 0, evictions: 0, bytes: 0 };

  function workerSource() {
    return `
      let ctrl, data;
      const handles = new Map();   // id -> FileSystemFileHandle
      const files = new Map();     // id -> File (cached getFile() result)
      let prefetch = null;         // {ckey, done}: the one outstanding sequential prefetch (backlog 389)
      // ONE DROPPED REQUEST WAS FATAL. A range read that failed threw straight into the engine
      // ("read failed"), and one that hung became "read timeout" after 30 s: prod 2026-10-15, a
      // player on a slow link stuck on the loading screen for five minutes, another's game dead
      // mid-session. Each attempt gets its own deadline; network errors, 408/429 and 5xx are
      // retried with a short backoff. A 4xx is an answer, not a blip, and is not retried.
      //
      // THE DEADLINE IS FOR SILENCE, NOT FOR THE WHOLE READ. Prod 2026-10-17/18: the first read
      // of Morrowind.bsa at boot (offset 0, 2 MB) failed in ~54 s -- exactly four 12 s attempts
      // plus backoff -- for ~15 of 24 never-joined worlds, while the same CDN answers that range
      // in 0.2-0.6 s cold or warm. A body still arriving slowly (a boot link busy with the engine's
      // own downloads) was cut at 12 s and started over from byte 0 every time. The clock now
      // restarts on every piece received; only 12 s of nothing aborts.
      // A 200 is the WHOLE FILE (the Range was ignored): it used to be returned whole, so a read at
      // any offset but 0 got the file's first bytes, and the main thread was told the chunk was
      // hundreds of MB. Read only up to end, cancel the rest, and slice.
      // ponytail: a 200 at a deep offset still downloads everything before it; ranges are honoured today.
      // Each attempt's outcome rides the error (status, ranges, bytes, ms): the page ships it.
      // AND THE WHOLE READ HAS A BUDGET under the main thread's 60 s ceiling (fetchChunkSync).
      // With the silence clock restarting on every piece, one trickling attempt could outlast
      // that ceiling: the page threw "read timeout" with a retry still to come, and the worker
      // went on writing into the shared buffer after the page had given up on it.
      const ATTEMPTS = 4, ATTEMPT_MS = 12000, BUDGET_MS = 48000;
      async function rangeFetch(url, start, end, tries = ATTEMPTS, budget = BUDGET_MS) {
        let last;
        const seen = [];
        const fail = (err) => new Error(String(err && err.message || err) + ' [' + seen.join('; ') + ']');
        const begun = Date.now();
        const clock = () => Math.max(0, Math.min(ATTEMPT_MS, budget - (Date.now() - begun)));
        for (let i = 0; i < tries; i++) {
          if (i) await new Promise((r) => setTimeout(r, 400 * i * i));
          if (Date.now() - begun >= budget) break;
          const ac = new AbortController();
          let t = setTimeout(() => ac.abort(), clock());
          const t0 = Date.now();
          let what = '', got = 0;
          try {
            const r = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + (end - 1) }, signal: ac.signal });
            what = r.status + ' cl=' + r.headers.get('content-length') + ' cr=' + r.headers.get('content-range');
            if (r.ok || r.status === 206) {
              const whole = r.status !== 206, want = whole ? end : end - start;
              const buf = new Uint8Array(want), rd = r.body.getReader();
              while (got < want) {
                const { done, value } = await rd.read();
                if (done) break;
                clearTimeout(t); t = setTimeout(() => ac.abort(), clock());
                const n = Math.min(value.length, want - got);
                buf.set(value.subarray(0, n), got); got += n;
              }
              if (got < want) throw new Error('short body ' + got + '/' + want);
              if (whole) rd.cancel().catch(() => {});
              return whole ? buf.subarray(start, end) : buf;
            }
            last = new Error('HTTP ' + r.status);
            last.http = r.status;
          } catch (err) { last = err; }
          finally { clearTimeout(t); }
          seen.push((what || 'no response') + ' ' + (last && (last.name + ': ' + last.message) || '').slice(0, 60) + ' got=' + got + ' ' + (Date.now() - t0) + 'ms');
          // A 4xx is an answer, not a blip: no retry (408/429 are blips).
          if (last.http >= 400 && last.http < 500 && last.http !== 408 && last.http !== 429) throw fail(last);
        }
        throw fail(last);
      }
      // BACKGROUND WARM-UP. A first read of any chunk is a network round trip with the game's
      // main thread blocked on it (fetchChunkSync), which is the mid-play hitch players see when
      // something new comes into view (prod 2026-10-15: 270 windows of 0.5-1 s stalls, most with
      // no area change). Once in the world, fill the persistent chunk cache from the archives in
      // the background so those reads are local. One chunk at a time, and only while the game
      // has not asked for anything for 1.5 s: it never competes with a read the game is waiting on.
      let fg = 0, lastFg = 0, warming = false;
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      // EVERY CACHE STEP HAS A DEADLINE. Every read awaits the chunk store before the network, and
      // a Cache API that stalls never answers: the read waited the main thread's full timeout and
      // the game died on "read timeout" with the network never asked (prod 2026-10-19). The
      // lookup alone was not enough: after the first deadline shipped, boots in the same browsers
      // still died, every one on the FIRST chunk (Morrowind.bsa@0) with no read failure at all --
      // an entry whose lookup answers but whose BODY never arrives (a put cut off when the page
      // died). So the body read has the deadline too, and such an entry is deleted.
      // ...AND ONE SLOW ANSWER IS NOT A DEAD STORE. A single late lookup used to switch the store
      // off for the page: a busy cache (the boot's own unawaited writes queue ahead of it) lost
      // every warmed chunk and stopped the warm-up (prod: 3 of 3 sessions, one with 428 MB warmed).
      // Three in a row now; any answer in time resets the count.
      let cacheDead = false, cacheStrikes = 0;
      const CACHE_MS = 3000;
      const cacheLate = () => { if (++cacheStrikes >= 3 && !cacheDead) { cacheDead = true; postMessage({ cacheSlow: 1 }); } };
      const cacheOk = (v) => { cacheStrikes = 0; return v; };
      const store = () => caches.open('mwdata-chunks-v1');
      // LATE MEANS STILL UNANSWERED AT THE DEADLINE. race() does not cancel the losing timer, so
      // late() used to run 3 s after EVERY cache step, answered or not: a healthy store was
      // declared dead within seconds of boot and every chunk read back from it was deleted
      // (prod 2026-10-20: sfsCacheSlow=1 and sfsWarm=0 in every session since the hotfix, up to a
      // 29 s freeze stepping off the boat into Seyda Neen, every reload downloading again).
      const inTime = (p, late) => {
        let settled = false;
        const q = p.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
        return Promise.race([q, nap(CACHE_MS).then(() => { if (!settled) late(); return undefined; })]);
      };
      // Is the chunk stored? (no body needed). Only the warm-up's lateness strikes: it is the one
      // caller that would otherwise download everything into a store that keeps nothing. The
      // read-ahead's late answer is a miss it simply fetches (see cacheRead).
      const cacheMatch = (key, strike = true) => cacheDead ? Promise.resolve(undefined)
        : inTime(store().then((c) => c.match(key)).then(cacheOk), strike ? cacheLate : () => {});
      // The chunk's bytes, or undefined: lookup AND body inside one deadline.
      // A LATE READ IS NOT A STRIKE, AND NOTHING IS DELETED. Reads are hedged (readChunk): past
      // HEDGE_MS the network serves the game, so a slow store costs the player nothing -- but it
      // still struck out and deleted the chunk, and a store merely busy with the boot's own writes
      // was switched off for the session: nothing saved, no warm-up, the next visit downloading
      // everything again (prod 2026-10-20 after the hedge shipped: cacheSlow in 5 of 13 sessions,
      // 4 of them with nothing warmed, up to 13 s stepping onto the Seyda Neen dock). A poisoned
      // entry -- a body that never arrives -- is overwritten by the network copy's put instead.
      const cacheRead = (key) => cacheDead ? Promise.resolve(undefined)
        : inTime(store().then((c) => c.match(key)).then((r) => r ? r.arrayBuffer().then((b) => cacheOk(new Uint8Array(b))) : cacheOk(undefined)),
          () => {});
      const cachePut = (key, buf) => cacheDead ? Promise.resolve()
        : Promise.race([store().then((c) => c.put(key, new Response(buf))), nap(CACHE_MS)]);
      async function warm(files, chunk, budget) {
        if (warming) return;
        warming = true;
        let fetched = 0, fetchFails = 0, stop = null;
        // BYTES WE MAY STILL ADD, not bytes the files weigh: a chunk already in the store costs
        // nothing (see warm() on the main thread).
        let left = typeof budget === 'number' ? budget : Infinity;
        try {
          const c = await caches.open('mwdata-chunks-v1');
          outer: for (const f of files) {
            for (let s = 0; s < f.size; s += chunk) {
              while (fg > 0 || Date.now() - lastFg < 1500) await nap(250);
              const ckey = 'https://sfs.chunk/' + encodeURIComponent(f.pkey) + '/' + s;
              if (cacheDead) { stop = 'cache slow'; break outer; } // nothing would be stored
              if (await cacheMatch(ckey)) continue;
              // STOP ON A FULL STORE. A put that fails is almost always the origin's quota: every
              // later chunk would be downloaded and thrown away (prod 2026-10-15: warm-up stuck at
              // 38 chunks for two hours, every retry a 2 MB download for nothing).
              let buf;
              try { buf = await rangeFetch(f.url, s, Math.min(s + chunk, f.size)); }
              catch (err) {
                if (++fetchFails >= 5) { stop = 'fetch: ' + String(err && err.message || err).slice(0, 60); break outer; }
                await nap(5000); continue;
              }
              fetchFails = 0;
              if (buf.length > left) { stop = 'budget'; break outer; }
              try { await c.put(ckey, new Response(buf)); }
              catch (err) { stop = 'store: ' + String(err && err.name || err).slice(0, 60); break outer; }
              left -= buf.length;
              fetched++; postMessage({ warmed: 1 });
              await nap(30);
            }
          }
        } catch (err) { stop = 'cache api: ' + String(err && err.name || err).slice(0, 60); }
        warming = false;
        postMessage({ warmed: 0, done: true, err: stop });
      }
      // HEDGED READ. The store answers in milliseconds when it is idle, but under load -- the
      // warm-up writing, the boot's own puts -- a read took 0.3 to 3 s, slower than the network,
      // which serves a 2 MB chunk in about 0.1 s (prod 2026-10-20: 594 chunks warmed on the ship,
      // then 91 reads and a 28 s freeze stepping onto the Seyda Neen dock; a 1.6.1 player with no
      // store at all fetched the same burst at 0.09 s a chunk). Past HEDGE_MS without an answer,
      // ask the network too and take whichever arrives first. A network failure still waits for
      // the store. Returns { buf, net } -- net: the bytes came from the network (worth storing).
      const HEDGE_MS = 150;
      async function readChunk(url, start, end, ckey) {
        if (ckey) {
          let settled = false;
          const fromStore = Promise.resolve().then(() => cacheRead(ckey))
            .then((b) => { settled = true; return b; }, () => { settled = true; return undefined; });
          const early = await Promise.race([fromStore, nap(HEDGE_MS).then(() => undefined)]);
          if (early) return { buf: early, net: false };
          if (settled) {
            const v = await fromStore; // answered just as the hedge timer fired
            if (v) return { buf: v, net: false };
          } else {
            const fromNet = rangeFetch(url, start, end).then((b) => ({ b }), (err) => ({ err }));
            const first = await Promise.race([fromStore.then((b) => (b ? { b, store: true } : fromNet)), fromNet]);
            if (first.b) return { buf: first.b, net: !first.store };
            const late = await fromStore; // the network failed: the store is the last chance
            if (late) return { buf: late, net: false };
            throw first.err;
          }
        }
        return { buf: await rangeFetch(url, start, end), net: true };
      }
      // BEFORE THE ENGINE STARTS (index.html, boot): fill the store with what the engine is about to
      // read in one blocking call, while the page can still show it. Four lanes in parallel, every
      // chunk already stored skipped, one progress message per chunk. Best effort throughout: a
      // chunk that fails here is read by the engine itself, as before.
      async function preload(files, chunk, id) {
        const jobs = [];
        for (const f of files) {
          const offs = f.offs || [];
          if (!f.offs) for (let s = 0; s < f.size; s += chunk) offs.push(s);
          for (const s of offs) if (s < f.size) jobs.push({ f, s });
        }
        let done = 0, bytes = 0, next = 0;
        const total = jobs.length;
        const one = async (j) => {
          const ckey = 'https://sfs.chunk/' + encodeURIComponent(j.f.pkey) + '/' + j.s;
          try {
            if (!(await cacheMatch(ckey, false))) {
              const buf = await rangeFetch(j.f.url, j.s, Math.min(j.s + chunk, j.f.size));
              await cachePut(ckey, buf);
              bytes += buf.length;
            }
          } catch (err) { /* the engine's own read fetches it */ }
          done++;
          postMessage({ preload: id, done, total, bytes });
        };
        const lane = async () => { while (next < jobs.length && !cacheDead) await one(jobs[next++]); };
        await Promise.all([lane(), lane(), lane(), lane()]);
        postMessage({ preload: id, end: true, done, total, bytes });
      }
      onmessage = async (e) => {
        const m = e.data;
        if (m.preload) { preload(m.preload, m.chunk, m.id); return; }
        if (m.init) { ctrl = new Int32Array(m.ctrl); data = new Uint8Array(m.data); return; }
        if (m.warm) { warm(m.warm, m.chunk, m.budget); return; }
        if (m.mountLocal) { handles.set(m.mountLocal.id, m.mountLocal.handle); return; }
        // A Blob (BSA from the Cache API) reads exactly like a File (slice + arrayBuffer), so it
        // goes straight into the files map and the m.id read path below slices it locally.
        if (m.mountBlob) { files.set(m.mountBlob.id, m.mountBlob.blob); return; }
        // m: {url|id, start, end, gen}
        fg++; lastFg = Date.now(); // the game is waiting on this: the warm-up stands aside
        try {
          let buf;
          if (m.id !== undefined) {
            let f = files.get(m.id);
            if (!f) { f = await handles.get(m.id).getFile(); files.set(m.id, f); }
            buf = new Uint8Array(await f.slice(m.start, m.end).arrayBuffer());
          } else {
            // Persistent chunk cache. The in-memory LRU dies with the page, so without this
            // every boot re-downloaded every byte the engine touched (~300MB measured). Keyed
            // by m.pkey — the ORIGINAL mount URL plus file size, so a renewed presigned URL
            // still hits, and a re-uploaded file of a new size misses. pkey is null for URLs
            // that should not persist (cross-origin or query-carrying, i.e. presigned S3).
            const ckey = m.pkey ? 'https://sfs.chunk/' + encodeURIComponent(m.pkey) + '/' + m.start : null;
            if (ckey && prefetch && prefetch.ckey === ckey) {
              // A prefetch of exactly this chunk may be in flight (backlog 389): wait for it
              // rather than fetching the same bytes twice -- but no longer than a cache step: the
              // prefetch has its own 10 s fetch and two cache steps, and stacking them under this
              // read ran the worker past the page's limit.
              try { await Promise.race([prefetch.done, nap(CACHE_MS)]); } catch (e) { /* best effort */ }
            }
            const got = await readChunk(m.url, m.start, m.end, ckey);
            buf = got.buf;
            // Not awaited: the copy into the shared buffer below reads buf, the put keeps its own
            // reference, and nothing mutates buf afterwards.
            if (got.net && ckey) cachePut(ckey, buf).catch(() => {});
          }
          data.set(buf.subarray(0, Math.min(buf.length, data.length)), 0);
          ctrl[1] = buf.length;         // bytes delivered
          Atomics.store(ctrl, 0, m.gen);  // completion flag = generation
          Atomics.notify(ctrl, 0);
          // SEQUENTIAL PREFETCH (backlog 389): the main thread says this miss followed the
          // previous chunk of the same file (m.next = the chunk after it), which is what a
          // first TR boot looks like -- ~500 serial range requests, each a full round trip
          // of main-thread stall. Pull the next chunk into the persistent cache now, off the
          // critical path, so the next miss is a Cache API hit. One outstanding at a time,
          // and only for persistable (same-origin, unsigned) URLs: the cache key is the
          // same formula the read path uses, so nothing else changes.
          if (m.next && m.pkey && !prefetch) {
            const nkey = 'https://sfs.chunk/' + encodeURIComponent(m.pkey) + '/' + m.next.start;
            prefetch = { ckey: nkey, done: (async () => {
              try {
                // The read path awaits this, so every cache call here has the deadline too.
                if (await cacheMatch(nkey, false)) return;
                // ONE rangeFetch attempt, not a bare fetch: a bare fetch had no deadline, so a stalled
                // prefetch held the read of this very chunk (which awaits it above) past the 60 s
                // main-thread timeout -- the game died on "read timeout" -- and a 200 stored the
                // whole file as this chunk.
                await cachePut(nkey, await rangeFetch(m.url, m.next.start, m.next.end, 1, 10000));
              } catch (e) { /* best effort: the read path fetches it itself */ }
              finally { prefetch = null; }
            })() };
          }
        } catch (err) {
          // WHY, for the page's error line: ASCII in the shared buffer, its length as -1 - n.
          const why = String(err && err.message || err).replace(/[^\x20-\x7e]/g, '?').slice(0, 400);
          for (let k = 0; k < why.length; k++) data[k] = why.charCodeAt(k);
          ctrl[1] = -1 - why.length;
          Atomics.store(ctrl, 0, m.gen);
          Atomics.notify(ctrl, 0);
        } finally { fg--; lastFg = Date.now(); }
      };`;
  }

  let generation = 0;
  // src: {url} for a range-fetched URL, or {id} for a local file handle. cacheKey uniquely
  // identifies the (source, offset) chunk across both modes.
  function fetchChunkSync(src, cacheKey, start, end, size) {
    if (S.rec) S.rec.add(cacheKey);
    const hit = S.cache.get(cacheKey);
    if (hit) {
      S.cache.delete(cacheKey); S.cache.set(cacheKey, hit); // move-to-end (most-recently-used)
      ST.hits++;
      return hit;
    }
    const gen = ++generation;
    // Backlog 389: a miss right after the previous chunk of the same file is a sequential
    // walk; tell the worker which chunk comes next so it can prefetch it (URL sources only).
    const seq = S.lastMiss && S.lastMiss.key === cacheKey.slice(0, cacheKey.lastIndexOf(':')) && S.lastMiss.end === start;
    S.lastMiss = { key: cacheKey.slice(0, cacheKey.lastIndexOf(':')), end };
    const next = seq && src.url && end - start === CHUNK && end < size ? { start: end, end: Math.min(end + CHUNK, size) } : null;
    S.worker.postMessage(Object.assign({ start, end, gen, next }, src));
    // Spin until the worker signals completion. The worker thread runs independently, so
    // this terminates; local reads complete in ~1-5ms. (Atomics.wait is disallowed on
    // the main thread, so poll.)
    //
    // NB this BLOCKS the main thread for the whole worker round-trip. For a local file handle
    // that is a disk read; for an HTTP source it is a network round-trip, so a miss here stalls
    // the frame. ST.stallMs is what makes that cost visible (window.__streamfsStats) — an
    // eviction-thrashing working set shows up as misses climbing without bytes growing.
    const t0 = performance.now();
    while (Atomics.load(S.ctrl, 0) !== gen) {
      // Above the worker's whole budget (a prefetch wait, 3 s, a cache read, 3 s, its own fetch,
      // 48 s, plus the backoff between attempts, ~6 s): a slow network fails as "read failed" with
      // the reason, never as a bare timeout here.
      // so a read that is still being retried is never abandoned here first.
      if (performance.now() - t0 > 70000) throw new Error('streamfs: read timeout ' + cacheKey + '@' + start);
    }
    const waited = performance.now() - t0;
    ST.misses++; ST.stallMs += waited;
    // WHICH FILE THE GAME WAITED ON (telemetry sfsSlow): a read over 50 ms went to the network,
    // not the persistent store, and the file says whether the warm-up should have had it.
    if (waited > 50) { ST.slow = (ST.slow || 0) + 1; const fk = cacheKey.slice(0, cacheKey.lastIndexOf(':')).split('/').pop(); (ST.slowBy || (ST.slowBy = {}))[fk] = (ST.slowBy[fk] || 0) + 1; }
    const n = S.ctrl[1];
    if (n < 0) throw new Error('streamfs: read failed ' + cacheKey + '@' + start + ' after ' + Math.round(waited) + 'ms: '
      + String.fromCharCode.apply(null, S.data.subarray(0, -1 - n)));
    const chunk = new Uint8Array(n);
    chunk.set(S.data.subarray(0, n));
    S.cache.set(cacheKey, chunk);
    ST.bytes += n;
    if (S.cache.size > LRU_MAX) { S.cache.delete(S.cache.keys().next().value); ST.evictions++; } // evict oldest
    return chunk;
  }

  function readSync(src, keyPrefix, size, buffer, offset, length, position) {
    let done = 0;
    while (done < length && position + done < size) {
      const pos = position + done;
      const cs = Math.floor(pos / CHUNK) * CHUNK;
      const ce = Math.min(cs + CHUNK, size);
      const chunk = fetchChunkSync(src, keyPrefix + ':' + cs, cs, ce, size);
      const within = pos - cs;
      const n = Math.min(length - done, chunk.length - within);
      if (n <= 0) break;
      buffer.set(chunk.subarray(within, within + n), offset + done);
      done += n;
    }
    return done;
  }

  // Shared lazy read-only FS node: reports `size` for stat/seek, forces the read() path
  // (no mmap), and routes reads through `doRead(buffer, offset, length, position)`.
  function makeNode(path, size, doRead) {
    const name = path.substring(path.lastIndexOf('/') + 1);
    const dir = path.substring(0, path.lastIndexOf('/')) || '/';
    const node = FS.createFile(dir, name, {}, /*canRead*/ true, /*canWrite*/ false);
    node.usedBytes = size; // some FS paths consult this
    const getattr = node.node_ops.getattr;
    node.node_ops = Object.assign({}, node.node_ops, {
      getattr(n) { const a = getattr(n); a.size = size; return a; },
    });
    node.stream_ops = Object.assign({}, node.stream_ops, {
      llseek(stream, off, whence) {
        let p = off;
        if (whence === 1) p += stream.position;
        else if (whence === 2) p += size;
        if (p < 0) throw new FS.ErrnoError(28 /*EINVAL*/);
        return p;
      },
      read(stream, buffer, offset, length, position) {
        return doRead(buffer, offset, length, position);
      },
      write() { throw new FS.ErrnoError(63 /*EROFS*/); },
      mmap() { throw new FS.ErrnoError(52 /*ENOSYS: force read() path*/); },
    });
    return node;
  }

  window.StreamFS = {
    // Live streaming cost: misses each blocked the main thread for a worker round-trip.
    // High misses + high evictions = the working set exceeds LRU_MAX and is thrashing.
    stats() { return Object.assign({ cached: S.cache.size, lruMax: LRU_MAX }, ST); },

    init() {
      if (S.worker) return;
      // Resolve the tier default now that index.html has run. Slots are ~1MB each, so this is
      // also the JS-side memory ceiling: 384MB high / 192MB mid / 96MB low, on top of the wasm heap.
      if (!LRU_MAX) LRU_MAX = (typeof window !== 'undefined' && window.__omwLruDefault | 0) || 128;
      if (!self.crossOriginIsolated) throw new Error('streamfs needs crossOriginIsolated (COOP/COEP)');
      const ctrlBuf = new SharedArrayBuffer(8);
      const dataBuf = new SharedArrayBuffer(CHUNK);
      S.ctrl = new Int32Array(ctrlBuf);
      S.data = new Uint8Array(dataBuf);
      S.worker = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' })));
      S.worker.postMessage({ init: 1, ctrl: ctrlBuf, data: dataBuf });
      S.worker.onmessage = (e) => { if (e.data && e.data.preload !== undefined) { const p = S.preloads.get(e.data.preload); if (p) p(e.data); return; } if (e.data && e.data.cacheSlow) ST.cacheSlow = 1; if (e.data && e.data.warmed !== undefined) { ST.warmed = (ST.warmed || 0) + e.data.warmed; if (e.data.done) { ST.warmDone = true; if (e.data.err) ST.warmErr = e.data.err; } } };
      try { Object.defineProperty(window, '__streamfsStats', { get: () => window.StreamFS.stats() }); } catch (e) {}
    },

    // Mount `url` (absolute-ized against the page) at FS path `path` with known byte size.
    // `mtime` (ms, from the manifest's `m`) joins the persistent cache key when given: a
    // re-installed mod file of identical size otherwise served the old chunks forever.
    mount(path, url, size, mtime) {
      const abs = new URL(url, location.href).href;
      const u = new URL(abs);
      // Persist chunks only for plain same-origin files (server-hosted mwdata). A URL with a
      // query is presigned and expiring — its bytes are cached by the locker's own layer, and
      // keying on a signature would never hit twice.
      // CHUNK is part of the key: chunks are cached at fetch granularity, and a ?chunk= retune
      // would otherwise hit a cached chunk shorter than the read loop expects — a short read
      // the engine treats as EOF mid-file.
      // A bare version tag (?v=2, index.html's base-game mounts) is NOT a signature: it is part of
      // the key, not a reason to skip it. Treating any query as presigned left Morrowind.bsa and
      // every hosted base file with no key from 2026-10-14 on: never persisted, never warmed
      // (prod 2026-10-19: sfsWarm stuck at the asset pack's 38 chunks, ~250 ms per new-area read).
      const pkey = u.origin === location.origin && (!u.search || /^\?v=[\w.-]+$/.test(u.search))
        ? u.pathname + u.search + '@' + size + (mtime ? '@' + mtime : '') + '@' + CHUNK : null;
      const src = { url: abs, pkey, size };
      // Registered so the URL can be refreshed later (presigned locker URLs expire): the cache
      // key stays `abs` (stable across renewals — the bytes are the same file), only src.url
      // changes, so a re-signed URL is used for future Range fetches without dropping the cache.
      S.urlSrcs.set(path, src);
      return makeNode(path, size, function (buffer, offset, length, position) {
        return readSync(src, abs, size, buffer, offset, length, position);
      });
    },

    // Fill the persistent chunk cache from every mounted file whose path matches `re`, in the
    // background (see warm() in the worker). Persistable (hosted, same-origin) files only; the
    // order of `first` decides which archive warms first. Skipped on a Save-Data connection.
    warm(re, first) {
      if (!S.worker || (navigator.connection && navigator.connection.saveData)) return 0;
      const files = [];
      for (const [path, src] of S.urlSrcs) if (src.pkey && src.size && re.test(path)) files.push({ path, url: src.url, pkey: src.pkey, size: src.size });
      const rank = (p) => { const i = (first || []).findIndex((r) => r.test(p)); return i < 0 ? 99 : i; };
      files.sort((a, b) => rank(a.path) - rank(b.path) || a.size - b.size); // smallest first within a group: most files local soonest
      // ONLY WHAT FITS -- COUNTED IN NEW BYTES. Warming past the origin's quota downloads chunks
      // only to fail storing them, so the worker gets a budget of 80% of what is free and spends
      // it only on chunks it actually adds. It used to drop any WHOLE FILE larger than the free
      // room -- and a returning player's usage already holds most of Morrowind.bsa, so the main
      // archive "did not fit", the warm-up reported done after the small archives (38 chunks),
      // and every new area waited on the network (prod 2026-10-17, c3iqmpok: 173 misses at
      // ~0.7 s each on an 87 fps machine). Every file is queued; a big one warms as far as fits.
      const send = (budget) => { if (files.length) S.worker.postMessage({ warm: files.map(({ url, pkey, size }) => ({ url, pkey, size })), chunk: CHUNK, budget }); };
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then((est) => {
          const free = Math.max(0, (est.quota || 0) - (est.usage || 0));
          ST.roomMb = Math.round(free / 1048576);
          if (free * 0.8 < CHUNK) ST.warmErr = 'no room: ' + ST.roomMb + ' MB free';
          send(free * 0.8);
        }, () => send(undefined));
      } else send(undefined);
      return files.length;
    },

    // Fill the persistent store with `items` ([{path, offs?}]: offs = chunk offsets, or every chunk
    // when absent) before the engine reads them. onProgress({done, total, bytes}) per chunk. Resolves
    // when finished, or after maxMs regardless: a boot never waits on this longer than that.
    // Persistable files only (same origin, unsigned); nothing on Save-Data or without a store.
    preload(items, onProgress, maxMs) {
      const files = [];
      for (const it of items) {
        const src = S.urlSrcs.get(it.path);
        if (src && src.pkey && src.size) files.push({ url: src.url, pkey: src.pkey, size: src.size, offs: it.offs || null });
      }
      if (!S.worker || !files.length || typeof caches === 'undefined' || (navigator.connection && navigator.connection.saveData)) return Promise.resolve(null);
      const id = ++S.nextId;
      return new Promise((resolve) => {
        const end = (v) => { S.preloads.delete(id); resolve(v); };
        const timer = setTimeout(() => end(null), maxMs || 180000);
        S.preloads.set(id, (d) => { if (onProgress) try { onProgress(d); } catch (e) {} if (d.end) { clearTimeout(timer); end(d); } });
        S.worker.postMessage({ preload: files, chunk: CHUNK, id });
      });
    },
    // Which chunks the engine read while recording, as [{path, offs}] -- the list preload() takes.
    // Recording starts at init and ends with record(false) (index.html: when the boot is released).
    get chunk() { return CHUNK; },
    mounted(re) { return [...S.urlSrcs.keys()].filter((p) => re.test(p)); },
    record(on) { if (on) S.rec = S.rec || new Set(); else if (S.rec) { S.recDone = S.rec; S.rec = null; } },
    bootSet() {
      const byUrl = new Map();
      for (const [path, src] of S.urlSrcs) byUrl.set(new URL(src.url).origin + new URL(src.url).pathname, path);
      const out = new Map();
      for (const k of (S.rec || S.recDone || [])) {
        const i = k.lastIndexOf(':'), u = new URL(k.slice(0, i)), path = byUrl.get(u.origin + u.pathname);
        if (!path) continue;
        if (!out.has(path)) out.set(path, []);
        out.get(path).push(+k.slice(i + 1));
      }
      return [...out].map(([path, offs]) => ({ path, offs: offs.sort((a, b) => a - b) }));
    },

    // Swap in a freshly-signed URL for an already-mounted path. The read path is synchronous
    // (it blocks on the worker), so it cannot re-sign on a 403; instead the app renews each
    // locker URL on a timer, before expiry, by calling this.
    setUrl(path, url) {
      const src = S.urlSrcs.get(path);
      if (src) src.url = new URL(url, location.href).href;
    },

    // Mount a local `FileSystemFileHandle` at FS path `path` with known byte size. The handle
    // is posted to the worker once (keyed by a per-file id); reads slice bytes from disk on
    // demand — nothing is copied into browser memory up front.
    mountLocal(path, handle, size) {
      const id = S.nextId++;
      S.worker.postMessage({ mountLocal: { id, handle } });
      const src = { id };
      return makeNode(path, size, function (buffer, offset, length, position) {
        return readSync(src, 'id' + id, size, buffer, offset, length, position);
      });
    },

    // Mount a Blob (e.g. a BSA held in the browser Cache API) at FS path `path`. Reads slice
    // bytes from the Blob on demand — a LOCAL read (disk-backed Cache blob), so no network and
    // no main-thread stall, unlike streaming from S3. The Blob is posted to the worker once.
    mountBlob(path, blob, size) {
      const id = S.nextId++;
      S.worker.postMessage({ mountBlob: { id, blob } });
      const src = { id };
      return makeNode(path, size, function (buffer, offset, length, position) {
        return readSync(src, 'id' + id, size, buffer, offset, length, position);
      });
    },
  };
})();
