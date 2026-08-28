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
  const CHUNK = _n(/[?&]chunk=(\d+)/, 1024) * 1024;   // 1MB default (was 4MB)
  const LRU_MAX = _n(/[?&]lru=(\d+)/, 128);           // 128 slots (was 32) -- same ~128MB ceiling

  // cache is a Map used as an LRU: insertion order IS the recency order (delete+set moves to end),
  // so eviction pops the first (oldest) key. No separate order array → O(1) hit path, no linear scan.
  const S = { worker: null, ctrl: null, data: null, cache: new Map(), nextId: 1, urlSrcs: new Map() };

  // Streaming cost counters, exposed as window.__streamfsStats. Chunk misses block the main thread
  // (see fetchChunkSync), so this is the only place the stall is observable. Two adds per read —
  // cheap enough to leave always-on, unlike the flag-gated ?glcount/?perfstats probes.
  const ST = { hits: 0, misses: 0, stallMs: 0, evictions: 0, bytes: 0 };

  function workerSource() {
    return `
      let ctrl, data;
      const handles = new Map();   // id -> FileSystemFileHandle
      const files = new Map();     // id -> File (cached getFile() result)
      onmessage = async (e) => {
        const m = e.data;
        if (m.init) { ctrl = new Int32Array(m.ctrl); data = new Uint8Array(m.data); return; }
        if (m.mountLocal) { handles.set(m.mountLocal.id, m.mountLocal.handle); return; }
        // A Blob (BSA from the Cache API) reads exactly like a File (slice + arrayBuffer), so it
        // goes straight into the files map and the m.id read path below slices it locally.
        if (m.mountBlob) { files.set(m.mountBlob.id, m.mountBlob.blob); return; }
        // m: {url|id, start, end, gen}
        try {
          let buf;
          if (m.id !== undefined) {
            let f = files.get(m.id);
            if (!f) { f = await handles.get(m.id).getFile(); files.set(m.id, f); }
            buf = new Uint8Array(await f.slice(m.start, m.end).arrayBuffer());
          } else {
            const r = await fetch(m.url, { headers: { Range: 'bytes=' + m.start + '-' + (m.end - 1) } });
            if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
            buf = new Uint8Array(await r.arrayBuffer());
          }
          data.set(buf.subarray(0, Math.min(buf.length, data.length)), 0);
          ctrl[1] = buf.length;         // bytes delivered
          Atomics.store(ctrl, 0, m.gen);  // completion flag = generation
          Atomics.notify(ctrl, 0);
        } catch (err) {
          ctrl[1] = -1;
          Atomics.store(ctrl, 0, m.gen);
          Atomics.notify(ctrl, 0);
        }
      };`;
  }

  let generation = 0;
  // src: {url} for a range-fetched URL, or {id} for a local file handle. cacheKey uniquely
  // identifies the (source, offset) chunk across both modes.
  function fetchChunkSync(src, cacheKey, start, end) {
    const hit = S.cache.get(cacheKey);
    if (hit) {
      S.cache.delete(cacheKey); S.cache.set(cacheKey, hit); // move-to-end (most-recently-used)
      ST.hits++;
      return hit;
    }
    const gen = ++generation;
    S.worker.postMessage(Object.assign({ start, end, gen }, src));
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
      if (performance.now() - t0 > 30000) throw new Error('streamfs: read timeout ' + cacheKey + '@' + start);
    }
    ST.misses++; ST.stallMs += performance.now() - t0;
    const n = S.ctrl[1];
    if (n < 0) throw new Error('streamfs: read failed ' + cacheKey + '@' + start);
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
      const chunk = fetchChunkSync(src, keyPrefix + ':' + cs, cs, ce);
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
      if (!self.crossOriginIsolated) throw new Error('streamfs needs crossOriginIsolated (COOP/COEP)');
      const ctrlBuf = new SharedArrayBuffer(8);
      const dataBuf = new SharedArrayBuffer(CHUNK);
      S.ctrl = new Int32Array(ctrlBuf);
      S.data = new Uint8Array(dataBuf);
      S.worker = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' })));
      S.worker.postMessage({ init: 1, ctrl: ctrlBuf, data: dataBuf });
      try { Object.defineProperty(window, '__streamfsStats', { get: () => window.StreamFS.stats() }); } catch (e) {}
    },

    // Mount `url` (absolute-ized against the page) at FS path `path` with known byte size.
    mount(path, url, size) {
      const abs = new URL(url, location.href).href;
      const src = { url: abs };
      // Registered so the URL can be refreshed later (presigned locker URLs expire): the cache
      // key stays `abs` (stable across renewals — the bytes are the same file), only src.url
      // changes, so a re-signed URL is used for future Range fetches without dropping the cache.
      S.urlSrcs.set(path, src);
      return makeNode(path, size, function (buffer, offset, length, position) {
        return readSync(src, abs, size, buffer, offset, length, position);
      });
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
