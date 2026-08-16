// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Filesystem backend for the storage locker: the same interface S3Storage implements,
// backed by a directory on the server.
//
// WHY. Without an S3 endpoint the locker was inert — every /locker/* answered 503 and a
// self-hoster with a disk and no object-storage account got nothing at all. The bytes are
// the operator's own disk either way; the only thing S3 was buying is somewhere to put
// them. So this is the fallback, chosen automatically when endpoint/bucket/keys are absent.
//
// PRESIGNING WITHOUT S3. The browser PUTs and Ranges directly against the URL it is handed,
// with no Authorization header (StreamFS mounts one URL and reads Ranges against it for
// hours). So the capability has to live IN the URL: an HMAC over method + key + expiry +
// byte cap, verified by blobRoutes below. Same properties as a SigV4 presigned URL — a URL
// minted for PUT cannot be replayed as a GET, one minted for a key cannot be pointed at
// another, and it dies on its own.
//
// The secret is a file in the shared dir rather than per-process randomness because the
// front door and every world process must verify each other's URLs.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { rm, mkdir, rename, stat } from 'node:fs/promises';
import { join, resolve, sep, dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpRoute } from '../net/http';
import { S3Storage, s3FromEnv } from './s3';
import { log } from '../log';

const EXPIRY_SEC = 3600; // matches s3FromEnv: long enough for a multi-hundred-MB PUT

export class FsStorage {
  constructor(
    private readonly root: string,
    private readonly publicBase: string,
    private readonly secret: Buffer,
  ) {
    mkdirSync(root, { recursive: true });
  }

  // The ONE place a key becomes a path. On S3 a key is an opaque string; here it is a real
  // filesystem path, so '..', an absolute path, a backslash or a NUL is a traversal into
  // another account's data. Resolve, then prove the result is still under the root — a
  // prefix check on the raw string is not enough (symlinks, '..' segments, sibling dirs
  // sharing a name prefix), which is why this compares against root + separator.
  pathFor(key: string): string {
    if (key === '' || key.includes('\0') || key.includes('\\')) throw new Error('bad key');
    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error('bad key');
    return full;
  }

  private sign(method: 'GET' | 'PUT', key: string, exp: number, max: number): string {
    return createHmac('sha256', this.secret)
      .update(`${method}\n${key}\n${exp}\n${max}`)
      .digest('hex');
  }

  private url(method: 'GET' | 'PUT', key: string, max: number): string {
    this.pathFor(key); // refuse to mint a URL for a key we would refuse to serve
    const exp = Math.floor(Date.now() / 1000) + EXPIRY_SEC;
    const token = `${method[0]}${exp}.${max}.${this.sign(method, key, exp, max)}`;
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${this.publicBase}/locker/blob/${token}/${encoded}`;
  }

  /** Verify a URL token. Returns the byte cap for a PUT, or undefined when invalid. */
  verify(token: string, method: 'GET' | 'PUT', key: string): number | undefined {
    const m = /^([GP])(\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(token);
    if (!m || m[1] !== method[0]) return undefined;
    const exp = Number(m[2]);
    const max = Number(m[3]);
    if (exp * 1000 < Date.now()) return undefined;
    const want = Buffer.from(this.sign(method, key, exp, max), 'hex');
    const got = Buffer.from(m[4]!, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    return max;
  }

  async presignPut(key: string, contentLength: number): Promise<string> {
    // The cap rides in the signature, so the route can cut off a client that declared 80 MB
    // and then streams 8 GB. With S3 that check is impossible (the PUT is UNSIGNED-PAYLOAD
    // and the quota is only ever advisory); here it is free, so it is enforced.
    return this.url('PUT', key, Math.max(0, Math.floor(contentLength)));
  }

  async presignGet(key: string): Promise<string> {
    return this.url('GET', key, 0);
  }

  async getHead(key: string, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(Math.max(0, length));
    const fd = openSync(this.pathFor(key), 'r');
    try {
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  }

  /** See S3Storage.objectSize. */
  async objectSize(key: string): Promise<number | undefined> {
    try {
      return (await stat(this.pathFor(key))).size;
    } catch {
      return undefined;
    }
  }

  // S3 semantics: `prefix` is either one object key or a directory prefix ending in '/'.
  async delete(prefix: string): Promise<void> {
    const p = this.pathFor(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    await rm(p, { recursive: true, force: true });
  }

  /** Bytes stored under a prefix. Used by the save store, which has no manifest to sum. */
  async sizeOf(key: string): Promise<number> {
    try {
      return (await stat(this.pathFor(key))).size;
    } catch {
      return 0;
    }
  }

  async write(key: string, body: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    await rename(tmp, p);
  }
}

// The signing key, shared across the front door and every world process. Created once,
// 0600, and never logged: it is the credential every blob URL is derived from.
function blobSecret(dir: string): Buffer {
  const path = join(dir, 'blob-secret');
  if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
  const secret = randomBytes(32);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, secret.toString('hex'), { mode: 0o600 });
  return secret;
}

/** The locker's storage when no S3 endpoint is configured: a directory on this server. */
export function fsStorageFrom(sharedDir: string, publicBase: string): FsStorage {
  const root = join(sharedDir, 'locker-blobs');
  log('info', 'locker.filesystem_storage', { root, publicBase });
  return new FsStorage(root, publicBase.replace(/\/+$/, ''), blobSecret(sharedDir));
}

/** S3 when the operator configured it, this server's disk otherwise. The locker is never
 *  inert now: an operator with no object-storage account still gets uploads and saves. */
export function lockerStorageFrom(
  cfg: { endpoint: string; region: string; bucket: string; publicBase: string },
  sharedDir: string,
  fallbackBase: string,
): S3Storage | FsStorage {
  const s3 = s3FromEnv({ endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket });
  if (s3) return s3;
  if (cfg.endpoint !== '') {
    // The operator ASKED for S3 (endpoint in config) but the env keys are absent, so this
    // boot is about to silently fall back to disk. That fallback is not harmless: filesystem
    // URLs go through the site origin, and a proxy in front of it (Cloudflare's free plan
    // caps request bodies at 100 MB) can refuse the big uploads at the edge — where nothing
    // ever reaches this server's logs. Production ran that way for a month, every player's
    // BSA upload dying with a generic failure while every boot logged one info line. An
    // explicit endpoint with no keys is a broken deployment, so say so at error level, and
    // deploy-mp.yml fails the deploy when it sees this event.
    log('error', 'locker.s3_creds_missing', {
      endpoint: cfg.endpoint, bucket: cfg.bucket,
      fix: 'set S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY in the container env (prod: /opt/openmw-mp/data/s3.env), or clear [locker] endpoint to choose filesystem storage deliberately',
    });
  }
  if (cfg.publicBase === '') {
    // Server-side reads (the media-pack verify) still work; a browser on another machine
    // cannot reach a localhost URL, so say so once rather than letting every upload fail
    // with a network error that names nothing.
    log('warn', 'locker.no_public_base', {
      using: fallbackBase,
      fix: 'set [locker] publicBase to the origin players reach this server on',
    });
  }
  return fsStorageFrom(sharedDir, cfg.publicBase || fallbackBase);
}

// ------------------------------------------------------------------ blob routes

// GET /locker/blob/<token>/<key>  — Range-capable read
// PUT /locker/blob/<token>/<key>  — streamed write, capped at the signed length
//
// Deliberately under /locker/ so the reverse proxy rules that already route the locker
// route these too. Chained AHEAD of lockerRoutes, which would otherwise demand the Bearer
// header these URLs exist precisely to avoid needing.
export function blobRoutes(storage: FsStorage | undefined): HttpRoute {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/locker/blob/')) return false;
    if (!storage) { res.writeHead(503); res.end(); return true; }
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-methods', 'GET, PUT, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    // Content-Range must be EXPOSED or the browser hides it from the fetch response and
    // StreamFS cannot tell a partial read from a whole file.
    res.setHeader('access-control-expose-headers', 'content-range, content-length');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

    const rest = url.pathname.slice('/locker/blob/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) { res.writeHead(404); res.end(); return true; }
    const token = rest.slice(0, slash);
    let key: string;
    let path: string;
    try {
      key = decodeURIComponent(rest.slice(slash + 1));
      path = storage.pathFor(key);
    } catch {
      res.writeHead(404); res.end(); return true;
    }

    if (req.method === 'PUT') {
      const cap = storage.verify(token, 'PUT', key);
      if (cap === undefined) { res.writeHead(403); res.end(); return true; }
      await putBlob(req, res, path, cap);
      return true;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (storage.verify(token, 'GET', key) === undefined) { res.writeHead(403); res.end(); return true; }
      await getBlob(req, res, path);
      return true;
    }
    res.writeHead(405); res.end();
    return true;
  };
}

// Write to a temp then rename: a reader never sees a half-written file. The temp name is
// unique PER REQUEST, not just per process — two concurrent PUTs of the same slot (a mirror
// retrying while the previous upload is still in flight, or a second tab) shared one temp
// name, so the first rename moved it away and the second failed with ENOENT. A pressure run
// of twelve concurrent overwrites hit it every time.
//
// Over the signed cap the stream is destroyed and the temp removed — a refused upload must
// not leave bytes on the operator's disk.
let putSeq = 0;
async function putBlob(req: IncomingMessage, res: ServerResponse, path: string, cap: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${putSeq++}.tmp`;
  const out = createWriteStream(tmp);
  let written = 0;
  let over = false;
  try {
    await new Promise<void>((ok, fail) => {
      req.on('data', (chunk: Buffer) => {
        // destroy() does not stop chunks already buffered from being delivered, so this
        // handler runs again AFTER the refusal below has answered. Without this guard the
        // second one throws ERR_HTTP_HEADERS_SENT and kills the process.
        if (over) return;
        written += chunk.length;
        // Answer BEFORE killing the connection, so a client that is still reading learns
        // why. Some will only see the reset — that is the cost of not accepting 8 GB from
        // someone who declared 80 MB, and the cap is the point.
        if (written > cap) {
          over = true;
          res.writeHead(413); res.end();
          out.destroy(); req.destroy();
          fail(new Error('over cap'));
          return;
        }
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('error', fail);
      req.on('end', () => out.end(ok));
      out.on('error', fail);
    });
    // Inside the try: a failed rename used to escape as an unhandled rejection and take the
    // whole process down, which is a far worse outcome than one refused upload.
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    if (over) { log('warn', 'blob.put_over_cap', { cap, written }); return; } // already answered
    log('error', 'blob.put_failed', { error: String(err) });
    if (!res.headersSent) { res.writeHead(500); res.end(); }
    return;
  }
  res.writeHead(200); res.end();
}

async function getBlob(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    res.writeHead(404); res.end(); return;
  }
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
  };
  if (range) {
    headers['content-length'] = String(range.end - range.start + 1);
    headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
  } else {
    headers['content-length'] = String(size);
  }
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  await new Promise<void>((ok) => {
    const s = range ? createReadStream(path, { start: range.start, end: range.end }) : createReadStream(path);
    s.on('error', () => { res.destroy(); ok(); });
    s.on('close', ok);
    s.pipe(res);
  });
}

// bytes=a-b | bytes=a- | bytes=-n. Anything else is treated as no range, which is what a
// server is allowed to do with a header it does not understand.
export function parseRange(header: string | undefined, size: number):
  { start: number; end: number } | undefined | 'unsatisfiable' {
  if (typeof header !== 'string') return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === '' && b === '') return undefined;
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
