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
  const S = { worker: null, ctrl: null, data: null, cache: new Map(), nextId: 1, urlSrcs: new Map(), preloads: new Map(), rec: new Set(), recDone: null, pfQueue: [], pfBusy: false, pfSeen: new Set() };

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
      // THE CHUNK STORE IS A FILE, NOT A CACHE. The Cache API keeps every chunk as its own HTTP
      // response, and on mid-tier machines reading one back cost about what the network did:
      // 224 ms a miss with the area warmed (prod 2026-10-19..21, lru=96 devices; 13 ms on high-tier
      // ones), so cell loads stalled even for players who had it all. The origin-private file
      // system with a synchronous handle in this worker reads a chunk in a few ms: one sparse file
      // per source file (chunk at its own offset) plus a flag byte per chunk, the flag written only
      // after the data is flushed, so a write cut short reads as absent, never as wrong bytes.
      // Where it is not available (another tab holds the handles, an old browser) every call
      // answers "no" and the Cache API path below runs exactly as before. A chunk found there is
      // moved across as it is read (opfsAdopt).
      let opfsRoot = null, opfsOff = false, opfsSaid = false;
      const opfsFiles = new Map(); // pkey -> Promise<{h, m, flags}|null>
      const opfsName = (pkey) => {
        let h = 2166136261;
        for (let i = 0; i < pkey.length; i++) { h ^= pkey.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
        return pkey.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(-80) + '.' + h.toString(16); // no backslash: this is a template literal
      };
      function opfsFile(pkey) {
        if (opfsOff || !pkey) return Promise.resolve(null);
        let f = opfsFiles.get(pkey);
        if (f) return f;
        f = (async () => {
          if (!opfsRoot) opfsRoot = await (await navigator.storage.getDirectory()).getDirectoryHandle('sfs-chunks-v1', { create: true });
          const name = opfsName(pkey);
          const h = await (await opfsRoot.getFileHandle(name + '.dat', { create: true })).createSyncAccessHandle();
          let m;
          try { m = await (await opfsRoot.getFileHandle(name + '.map', { create: true })).createSyncAccessHandle(); }
          catch (err) { h.close(); throw err; }
          const flags = new Uint8Array(Math.max(64, m.getSize()));
          m.read(flags.subarray(0, m.getSize()), { at: 0 });
          if (!opfsSaid) { opfsSaid = true; postMessage({ store: 'file' }); }
          return { h, m, flags };
        })().catch((err) => {
          // No OPFS at all (no API, or blocked): off for the page. One file held by another tab:
          // only that file falls back.
          if (!(err && err.name === 'NoModificationAllowedError')) { if (!opfsOff) postMessage({ store: 'cache' }); opfsOff = true; }
          return null;
        });
        opfsFiles.set(pkey, f);
        return f;
      }
      async function opfsGet(pkey, start, end, chunk) {
        const f = await opfsFile(pkey);
        const i = start / chunk;
        if (!f || i >= f.flags.length || !f.flags[i]) return undefined;
        const b = new Uint8Array(end - start);
        try { if (f.h.read(b, { at: start }) === b.length) return b; } catch (err) { /* a miss */ }
        return undefined;
      }
      async function opfsHas(pkey, start, chunk) {
        const f = await opfsFile(pkey);
        const i = start / chunk;
        return !!(f && i < f.flags.length && f.flags[i]);
      }
      // True when stored here (the caller then skips the Cache API put).
      async function opfsPut(pkey, start, buf, chunk) {
        const f = await opfsFile(pkey);
        if (!f) return false;
        try {
          const i = start / chunk;
          if (i >= f.flags.length) { const g = new Uint8Array(Math.max(i + 1, f.flags.length * 2)); g.set(f.flags); f.flags = g; }
          if (f.h.write(buf, { at: start }) !== buf.length) return false;
          f.h.flush();
          f.flags[i] = 1;
          f.m.write(f.flags.subarray(i, i + 1), { at: i });
          f.m.flush();
          return true;
        } catch (err) { return false; } // full, or the handle went away: the Cache API takes it
      }
      // A chunk read from the Cache API moves to the file store and out of the cache.
      const opfsAdopt = (pkey, ckey, start, buf, chunk) => opfsPut(pkey, start, buf, chunk)
        .then((ok) => { if (ok && !cacheDead) store().then((c) => c.delete(ckey)).catch(() => {}); return ok; });
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
              if (await opfsHas(f.pkey, s, chunk)) continue;
              if (await opfsFile(f.pkey)) {
                // The file store is up: an old Cache API copy moves across, else the network.
                const old = cacheDead ? undefined : await cacheRead(ckey);
                if (old) { await opfsAdopt(f.pkey, ckey, s, old, chunk); continue; }
                let nb;
                try { nb = await rangeFetch(f.url, s, Math.min(s + chunk, f.size)); }
                catch (err) {
                  if (++fetchFails >= 5) { stop = 'fetch: ' + String(err && err.message || err).slice(0, 60); break outer; }
                  await nap(5000); continue;
                }
                fetchFails = 0;
                if (nb.length > left) { stop = 'budget'; break outer; }
                if (!(await opfsPut(f.pkey, s, nb, chunk))) { stop = 'store: file store full'; break outer; }
                left -= nb.length;
                fetched++; postMessage({ warmed: 1 });
                await nap(30);
                continue;
              }
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
      // EVERY CHUNK ALSO GOES TO THE PAGE, for its in-memory LRU. Stored was not enough: right after
      // 241 MB of writes the store answered slower than the hedge, so the engine fetched the whole
      // of Morrowind.esm again, a chunk at a time (prod 2026-10-21: 126/126 preloaded, then 21 slow
      // reads of 0.4-5.6 s and a 117 s engine start). A memory hit has no store and no worker in it.
      async function preload(files, chunk, id) {
        const jobs = [];
        files.forEach((f, fi) => {
          const offs = f.offs || [];
          if (!f.offs) for (let s = 0; s < f.size; s += chunk) offs.push(s);
          for (const s of offs) if (s < f.size) jobs.push({ f, s, fi });
        });
        let done = 0, bytes = 0, next = 0;
        const total = jobs.length;
        const one = async (j) => {
          const ckey = 'https://sfs.chunk/' + encodeURIComponent(j.f.pkey) + '/' + j.s;
          let buf;
          try {
            const end = Math.min(j.s + chunk, j.f.size);
            buf = await opfsGet(j.f.pkey, j.s, end, chunk);
            if (!buf) {
              buf = await cacheRead(ckey);
              if (buf) await opfsAdopt(j.f.pkey, ckey, j.s, buf, chunk);
            }
            if (!buf) {
              buf = await rangeFetch(j.f.url, j.s, end);
              bytes += buf.length;
              if (!(await opfsPut(j.f.pkey, j.s, buf, chunk))) await cachePut(ckey, buf);
            }
          } catch (err) { buf = undefined; /* the engine's own read fetches it */ }
          done++;
          if (!buf) { postMessage({ preload: id, done, total, bytes }); return; }
          const copy = buf.slice(); // its own buffer, transferred; the store keeps the original
          postMessage({ preload: id, done, total, bytes, fi: j.fi, s: j.s, buf: copy }, [copy.buffer]);
        };
        const lane = async () => { while (next < jobs.length) await one(jobs[next++]); };
        await Promise.all([lane(), lane(), lane(), lane()]);
        postMessage({ preload: id, end: true, done, total, bytes });
      }
      // THE NEXT CELL'S FILES, BEFORE IT IS ENTERED (Scene::prefetchNearbyFiles via the page).
      // Two lanes, standing aside while the game waits on a read of its own. Every chunk lands in
      // the store (file, else Cache API); none is handed to the page's memory. The models' own
      // bytes are then scanned for the texture names they carry (NIF strings are length-prefixed
      // runs of printable bytes): the page resolves and fetches those next.
      // No regex and no backslash here: this is a template literal.
      const TEX_ENDS = ['.dds', '.tga', '.bmp'];
      function textureNames(bytes) {
        const out = new Set();
        let run = '';
        for (let i = 0; i <= bytes.length; i++) {
          const c = i < bytes.length ? bytes[i] : 0;
          if (c >= 32 && c < 127) { if (run.length < 200) run += String.fromCharCode(c); continue; }
          const low = run.toLowerCase();
          if (run.length > 4 && TEX_ENDS.some((x) => low.endsWith(x))) out.add(low);
          run = '';
        }
        return [...out];
      }
      async function prefetchFiles(m) {
        const chunk = m.chunk, jobs = [], keep = new Map(), want = new Set();
        m.files.forEach((f, fi) => { for (const s of f.offs) jobs.push({ f, fi, s }); });
        for (const [fi, off, size] of m.meshes || []) for (let s = Math.floor(off / chunk) * chunk; s < off + size; s += chunk) want.add(fi + ':' + s);
        let next = 0, fetched = 0;
        const one = async (j) => {
          while (fg > 0) await nap(25); // the game is waiting on a read: it goes first
          const end = Math.min(j.s + chunk, j.f.size);
          const ckey = 'https://sfs.chunk/' + encodeURIComponent(j.f.pkey) + '/' + j.s;
          let buf;
          try {
            buf = await opfsGet(j.f.pkey, j.s, end, chunk);
            if (!buf) {
              buf = cacheDead ? undefined : await cacheRead(ckey);
              if (buf) await opfsAdopt(j.f.pkey, ckey, j.s, buf, chunk);
            }
            if (!buf) {
              buf = await rangeFetch(j.f.url, j.s, end, 2, 20000);
              fetched++;
              if (!(await opfsPut(j.f.pkey, j.s, buf, chunk))) await cachePut(ckey, buf);
            }
          } catch (err) { buf = undefined; /* the engine reads it itself on entry */ }
          if (buf && want.has(j.fi + ':' + j.s)) keep.set(j.fi + ':' + j.s, buf);
        };
        const lane = async () => { while (next < jobs.length) await one(jobs[next++]); };
        await Promise.all([lane(), lane()]);
        const tex = new Set();
        for (const [fi, off, size] of m.meshes || []) {
          const bytes = new Uint8Array(size);
          let ok = true;
          for (let s = Math.floor(off / chunk) * chunk; s < off + size && ok; s += chunk) {
            const b = keep.get(fi + ':' + s);
            if (!b) { ok = false; break; }
            const from = Math.max(off, s), to = Math.min(off + size, s + b.length);
            bytes.set(b.subarray(from - s, to - s), from - off);
          }
          if (ok) for (const t of textureNames(bytes)) tex.add(t);
        }
        postMessage({ prefetched: m.id, fetched, chunks: jobs.length, tex: [...tex] });
      }
      onmessage = async (e) => {
        const m = e.data;
        if (m.prefetch) { prefetchFiles(m); return; }
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
            const fromFile = ckey ? await opfsGet(m.pkey, m.start, m.end, m.chunk) : undefined;
            const got = fromFile ? { buf: fromFile, net: false, file: true } : await readChunk(m.url, m.start, m.end, ckey);
            buf = got.buf;
            // Not awaited: the copy into the shared buffer below reads buf, the store keeps its own
            // reference, and nothing mutates buf afterwards. A chunk from the network or the old
            // Cache API goes to the file store; the Cache API takes it only where that is off.
            if (ckey && !got.file) {
              const keep = got.net ? opfsPut(m.pkey, m.start, buf, m.chunk) : opfsAdopt(m.pkey, ckey, m.start, buf, m.chunk);
              keep.then((ok) => { if (!ok && got.net) return cachePut(ckey, buf); }).catch(() => {});
            }
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
    S.worker.postMessage(Object.assign({ start, end, gen, next, chunk: CHUNK }, src));
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
    // NAMED OR NOT (telemetry sfsSlowPf=named/unnamed): had the cell prefetch already asked for this
    // chunk? Named and still slow = the prefetch was too late or too slow; unnamed = it never knew
    // the file (prod 2026-10-23: 26 of 50 hitch windows waited 300 ms+ on streamed files).
    const named = S.pfSeen.has(cacheKey);
    if (waited > 50) {
      ST.slow = (ST.slow || 0) + 1; const fk = cacheKey.slice(0, cacheKey.lastIndexOf(':')).split('/').pop(); (ST.slowBy || (ST.slowBy = {}))[fk] = (ST.slowBy[fk] || 0) + 1;
      if (named) ST.slowPf = (ST.slowPf || 0) + 1; else ST.slowNoPf = (ST.slowNoPf || 0) + 1;
    }
    // EACH READ THE PLAYER FELT, by name (index.html ships it). The 5 s telemetry keeps only the top
    // two files per session, which cannot say what a hitch mid-game was waiting on (prod 2026-10-21:
    // 0.5-0.9 s single misses with the archives already warmed).
    if (waited > 300 && typeof window !== 'undefined' && typeof window.__omwSlowRead === 'function') {
      try { window.__omwSlowRead(decodeURIComponent(cacheKey.slice(0, cacheKey.lastIndexOf(':')).split('/').pop()).replace(/\?.*$/, ''), start, Math.round(waited), named); } catch (e) {}
    }
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

  // ---- prefetch: archive directories and VFS path resolution (main thread) ----
  // A TES3 BSA: a 12-byte header (0x100, hash-table offset, file count), then per file
  // {size, offset}, then per file a name offset, then the names, then the hashes; file data
  // starts after the hashes. The directory sits in the archive's first chunk(s), which the
  // engine read at boot, so this is a local read.
  const bsaDirs = new Map();
  function bsaDir(path) {
    if (bsaDirs.has(path)) return bsaDirs.get(path);
    let dir = null;
    try {
      const src = S.urlSrcs.get(path), h = new Uint8Array(12);
      readSync(src, src.key, src.size, h, 0, 12, 0);
      const dv = new DataView(h.buffer);
      if (dv.getUint32(0, true) === 0x100) {
        const hashOff = dv.getUint32(4, true), n = dv.getUint32(8, true);
        const b = new Uint8Array(hashOff);
        readSync(src, src.key, src.size, b, 0, hashOff, 12);
        const v = new DataView(b.buffer), namesAt = n * 12, dataStart = 12 + hashOff + n * 8;
        dir = new Map();
        for (let i = 0; i < n; i++) {
          let p = namesAt + v.getUint32(n * 8 + i * 4, true), name = '';
          while (p < b.length && b[p]) name += String.fromCharCode(b[p++]);
          dir.set(name.toLowerCase().replace(/\\/g, '/'), [dataStart + v.getUint32(i * 8 + 4, true), v.getUint32(i * 8, true)]);
        }
      }
    } catch (e) { dir = null; }
    bsaDirs.set(path, dir);
    return dir;
  }
  const archiveRank = (p) => (/morrowind\.bsa$/i.test(p) ? 0 : /tribunal\.bsa$/i.test(p) ? 1 : /bloodmoon\.bsa$/i.test(p) ? 2 : 3);
  let looseIdx = null;
  function resolveVfs(raw) {
    const v = String(raw).toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!looseIdx) {
      looseIdx = new Map();
      for (const [p, src] of S.urlSrcs) {
        const m = /^\/mwdata\/(.+)$/i.exec(p);
        if (m && !/\.(bsa|esm|esp|omwaddon)$/i.test(p)) looseIdx.set(m[1].toLowerCase(), src);
      }
    }
    const loose = looseIdx.get(v);
    if (loose) return { src: loose, off: 0, size: loose.size };
    const archives = [...S.urlSrcs.keys()].filter((p) => /\.bsa$/i.test(p)).sort((a, b) => archiveRank(b) - archiveRank(a));
    for (const a of archives) {
      const d = bsaDir(a), e = d && d.get(v);
      if (e) return { src: S.urlSrcs.get(a), off: e[0], size: e[1] };
    }
    return null;
  }
  // The worker named the textures its models carry: the engine's texture lookup is textures/<name>
  // with .dds preferred over the name's own extension.
  function texturePaths(names) {
    const out = [];
    for (let t of names) {
      t = t.replace(/\\/g, '/').replace(/^data files\//, '');
      if (!t.startsWith('textures/')) t = 'textures/' + t;
      const dds = t.replace(/\.[^./]+$/, '.dds');
      out.push(resolveVfs(dds) ? dds : t);
    }
    return out;
  }
  function pfNext() {
    if (S.pfBusy || !S.pfQueue.length) return;
    S.pfBusy = true;
    const m = S.pfQueue.shift();
    m.id = ++S.nextId;
    S.preloads.set(m.id, (d) => {
      S.preloads.delete(m.id);
      ST.pfFetched = (ST.pfFetched || 0) + (d.fetched || 0);
      S.pfBusy = false;
      if (d.tex && d.tex.length) window.StreamFS.prefetchPaths(texturePaths(d.tex), false);
      pfNext();
    });
    S.worker.postMessage(m);
  }

  window.StreamFS = {
    // WHAT INSIDE AN ARCHIVE a slow read was for: the entries of BSA `name` (its file name, as the
    // slow-read line gives it) overlapping the chunk at `off`, at most `max`. Morrowind.bsa reads
    // that no prefetch named (prod 2026-10-24: 9 of 26) cannot be fixed without knowing the file.
    entriesAt(name, off, max) {
      const want = String(name).toLowerCase(), out = [];
      for (const p of S.urlSrcs.keys()) {
        if (!/\.bsa$/i.test(p) || p.split('/').pop().toLowerCase() !== want) continue;
        const d = bsaDir(p);
        if (!d) return out;
        const end = off + CHUNK;
        for (const [file, e] of d) {
          if (e[0] < end && e[0] + e[1] > off) { out.push(file); if (out.length >= (max || 3)) break; }
        }
        return out;
      }
      return out;
    },

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
      S.worker.onmessage = (e) => { if (e.data && e.data.prefetched !== undefined) { const p = S.preloads.get(e.data.prefetched); if (p) p(e.data); return; } if (e.data && e.data.preload !== undefined) { const p = S.preloads.get(e.data.preload); if (p) p(e.data); return; } if (e.data && e.data.cacheSlow) ST.cacheSlow = 1; if (e.data && e.data.store && ST.store !== 'file') ST.store = e.data.store; if (e.data && e.data.warmed !== undefined) { ST.warmed = (ST.warmed || 0) + e.data.warmed; if (e.data.done) { ST.warmDone = true; if (e.data.err) ST.warmErr = e.data.err; } } };
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
      const src = { url: abs, pkey, size, key: abs }; // key: the LRU prefix readSync uses
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
        if (src && src.pkey && src.size) files.push({ url: src.url, pkey: src.pkey, size: src.size, offs: it.offs || null, key: src.key });
      }
      if (!S.worker || !files.length || typeof caches === 'undefined' || (navigator.connection && navigator.connection.saveData)) return Promise.resolve(null);
      const id = ++S.nextId;
      return new Promise((resolve) => {
        const end = (v) => { S.preloads.delete(id); resolve(v); };
        const timer = setTimeout(() => end(null), maxMs || 180000);
        // Into the LRU in arrival order while it has room (the content files come first in `items`),
        // under the key readSync looks up. What does not fit stays in the store.
        S.preloads.set(id, (d) => {
          if (d.buf && S.cache.size < LRU_MAX - 8) { S.cache.set(files[d.fi].key + ':' + d.s, d.buf); ST.preMem = (ST.preMem || 0) + 1; }
          delete d.buf;
          if (onProgress) try { onProgress(d); } catch (e) {} if (d.end) { clearTimeout(timer); end(d); } });
        S.worker.postMessage({ preload: files.map(({ url, pkey, size, offs }) => ({ url, pkey, size, offs })), chunk: CHUNK, id });
      });
    },
    // A FILE THE ENGINE WILL ASK FOR, BY ITS VFS PATH ("meshes/x/ex_hlaalu_b_01.nif"): fetch its
    // bytes into the store in the background (Scene::prefetchNearbyFiles names the nearby door
    // destinations' and exterior cells' models; their textures follow from the worker's scan).
    // Resolution follows the engine's VFS: a loose file over any archive, a later archive over an
    // earlier one (the asset pack over Bloodmoon over Tribunal over Morrowind). Persistable sources
    // only; one request in flight, the rest queued.
    prefetchPaths(paths, meshes) {
      if (!S.worker || !paths || !paths.length) return 0;
      const files = [], at = new Map(), scan = [];
      const add = (src, off, size, isMesh) => {
        let fi = at.get(src.key);
        if (fi === undefined) { fi = files.length; at.set(src.key, fi); files.push({ url: src.url, pkey: src.pkey, size: src.size, offs: [] }); }
        for (let s = Math.floor(off / CHUNK) * CHUNK; s < off + size; s += CHUNK) {
          const k = src.key + ':' + s;
          if (S.cache.has(k) || S.pfSeen.has(k)) continue;
          S.pfSeen.add(k);
          files[fi].offs.push(s);
        }
        if (isMesh) scan.push([fi, off, size]);
      };
      for (const raw of paths) {
        const hit = resolveVfs(raw);
        if (hit && hit.src.pkey) add(hit.src, hit.off, hit.size, meshes !== false && /\.nif$/i.test(raw));
      }
      const live = files.filter((f) => f.offs.length);
      if (!live.length && !scan.length) return 0;
      ST.pfFiles = (ST.pfFiles || 0) + paths.length;
      S.pfQueue.push({ prefetch: 1, files, chunk: CHUNK, meshes: scan });
      pfNext();
      return live.reduce((n, f) => n + f.offs.length, 0);
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
