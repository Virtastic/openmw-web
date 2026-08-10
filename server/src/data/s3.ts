// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// S3 driver for the storage locker: SigV4 presigning with no SDK.
//
// WHY NO SDK. The AWS SDK is tens of megabytes of dependency for three operations we
// perform (presign PUT, presign GET, delete by prefix), on a server whose whole point is
// to be cheap to self-host. SigV4 query presigning is ~60 lines of HMAC, it is a stable
// documented format, and it works against any S3-compatible endpoint — Backblaze B2,
// Cloudflare R2, MinIO — which matters because the operator's storage bill is the main
// running cost of the locker.
//
// The bytes never pass through this process: presigned URLs put the transfer between the
// browser and the bucket. That is also better for the legal posture (docs/LEGAL.md §2) —
// we authorize a user's access to their own backup rather than serving copies ourselves.

import { createHmac, createHash } from 'node:crypto';
import { log } from '../log';

export interface S3Settings {
  endpoint: string; // https://s3.us-east-1.amazonaws.com or an S3-compatible host
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Path-style is required by MinIO and most compatible endpoints; AWS accepts either.
  pathStyle?: boolean;
  expirySec?: number;
}

const ALGO = 'AWS4-HMAC-SHA256';

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

// Every path segment is escaped, but the separators are not: S3 treats '/' as structure.
// encodeURIComponent leaves !'()* alone, which S3 does NOT accept unescaped in a
// signature, so they are escaped explicitly — getting this wrong produces a
// SignatureDoesNotMatch that looks like a credentials problem and is not.
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

function amzDate(now: Date): { long: string; short: string } {
  const long = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { long, short: long.slice(0, 8) };
}

export class S3Storage {
  constructor(private readonly s: S3Settings) {}

  private host(): string {
    return new URL(this.s.endpoint).host;
  }

  private objectPath(key: string): string {
    return this.s.pathStyle === false
      ? `/${encodeKey(key)}`
      : `/${encodeURIComponent(this.s.bucket)}/${encodeKey(key)}`;
  }

  // SigV4 query presigning. The signature covers the method, path, query and the signed
  // headers — so a URL minted for PUT cannot be replayed as a GET, and one minted for a
  // key cannot be pointed at another. Expiry is short by default: these are handed to a
  // browser, and a long-lived URL is a credential with no revocation.
  private presign(method: 'GET' | 'PUT' | 'DELETE', key: string, extraQuery: Record<string, string> = {}): string {
    return this.signedUrl(method, this.objectPath(key), extraQuery);
  }

  // The signing core, over an EXPLICIT path. A bucket-level list is a different path than
  // an object (no trailing slash, no key), and the signature must be computed over exactly
  // the path the URL uses — the earlier version signed an object path and then string-
  // replaced it, so the signature no longer matched (OVH answered 403).
  private signedUrl(method: 'GET' | 'PUT' | 'DELETE', path: string, extraQuery: Record<string, string> = {}): string {
    const now = new Date();
    const { long, short } = amzDate(now);
    const credentialScope = `${short}/${this.s.region}/s3/aws4_request`;
    const host = this.host();

    const query: Record<string, string> = {
      'X-Amz-Algorithm': ALGO,
      'X-Amz-Credential': `${this.s.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': long,
      'X-Amz-Expires': String(this.s.expirySec ?? 900),
      'X-Amz-SignedHeaders': 'host',
      ...extraQuery,
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
      .join('&');

    // UNSIGNED-PAYLOAD: the browser streams gigabytes it cannot hash up front, and the
    // integrity guarantee we actually rely on is our own sha256 manifest check, not S3's.
    const canonicalRequest = [
      method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [ALGO, long, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${this.s.secretAccessKey}`, short);
    const kRegion = hmac(kDate, this.s.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return `${new URL(this.s.endpoint).origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  // --- Bucket CORS -------------------------------------------------------------------------
  // The browser PUTs upload bytes DIRECTLY to the bucket using a presigned URL, so the bucket
  // must name this deployment's origin in its CORS policy. When it does not, the browser
  // refuses the request before it is sent: the server logs a clean attestation and zero
  // errors, the page shows every file "failed", and nothing anywhere says the word CORS. It
  // is the least discoverable failure in the whole upload path.
  //
  // So the origin is DERIVED and self-registered rather than hand-copied into a console. Which
  // origin? The one asking — a page can only be blocked on the origin it is served from, and
  // the caller's Origin header is exactly that. The route only passes it after checking it
  // matches the request's own Host, so a forged header cannot register a stranger's origin.
  private corsEnsured = new Set<string>();

  // Header-signed (not query-presigned): PutBucketCors is validated against Content-MD5, and
  // a presigned URL leaves that header unsigned.
  private async bucketRequest(method: 'GET' | 'PUT', body?: string): Promise<Response> {
    const host = this.host();
    const path = `/${encodeURIComponent(this.s.bucket)}/`;
    const now = new Date();
    const { long, short } = amzDate(now);
    const payload = body ?? '';
    const payloadHash = sha256Hex(payload);
    const headers: Record<string, string> = {
      host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': long,
    };
    if (body !== undefined) headers['content-md5'] = createHash('md5').update(body).digest('base64');
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [method, path, 'cors=', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${short}/${this.s.region}/s3/aws4_request`;
    const stringToSign = [ALGO, long, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${this.s.secretAccessKey}`, short);
    const kRegion = hmac(kDate, this.s.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const auth = `${ALGO} Credential=${this.s.accessKeyId}/${credentialScope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const { host: _drop, ...sendable } = headers;
    return fetch(`${new URL(this.s.endpoint).origin}${path}?cors=`, {
      method, headers: { ...sendable, Authorization: auth }, ...(body !== undefined ? { body } : {}),
    });
  }

  /** Add `origin` to the bucket's CORS policy if absent. Additive and idempotent: every
   *  existing origin, method and exposed header is preserved, so one deployment registering
   *  itself never disturbs another sharing the bucket. */
  async ensureCorsOrigin(origin: string): Promise<void> {
    if (this.corsEnsured.has(origin)) return;
    this.corsEnsured.add(origin);   // set first: a failure must not retry on every upload
    try {
      const cur = await this.bucketRequest('GET');
      const xml = cur.status === 200 ? await cur.text() : '';
      const origins = [...xml.matchAll(/<AllowedOrigin>([^<]+)<\/AllowedOrigin>/g)].map((m) => m[1]!);
      if (origins.includes(origin)) return;
      const methods = [...new Set([...xml.matchAll(/<AllowedMethod>([^<]+)<\/AllowedMethod>/g)]
        .map((m) => m[1]!))];
      const expose = [...new Set([...xml.matchAll(/<ExposeHeader>([^<]+)<\/ExposeHeader>/g)]
        .map((m) => m[1]!))];
      // Content-Range is required: the game streams its data back with Range requests.
      for (const need of ['GET', 'PUT']) if (!methods.includes(need)) methods.push(need);
      for (const need of ['Content-Range', 'Content-Length', 'ETag']) {
        if (!expose.includes(need)) expose.push(need);
      }
      const body = '<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n <CORSRule>\n'
        + [...origins, origin].map((o) => `  <AllowedOrigin>${o}</AllowedOrigin>`).join('\n') + '\n'
        + methods.map((m) => `  <AllowedMethod>${m}</AllowedMethod>`).join('\n') + '\n'
        + '  <AllowedHeader>*</AllowedHeader>\n'
        + expose.map((e) => `  <ExposeHeader>${e}</ExposeHeader>`).join('\n') + '\n'
        + '  <MaxAgeSeconds>3600</MaxAgeSeconds>\n </CORSRule>\n</CORSConfiguration>\n';
      const put = await this.bucketRequest('PUT', body);
      if (put.ok) {
        log('info', 'locker.cors_origin_added', { origin, total: origins.length + 1 });
      } else {
        // Most likely the credentials carry Object Read & Write but not PutBucketCors, which
        // is exactly what docs/MULTIPLAYER-SETUP.md tells operators to create. Say what to do.
        log('error', 'locker.cors_add_failed', {
          origin, status: put.status,
          fix: 'grant PutBucketCors to the S3 credentials, or add this origin to the bucket '
             + 'CORS policy by hand — browser uploads from it are blocked until then',
        });
      }
    } catch (err) {
      log('error', 'locker.cors_add_failed', { origin, error: String(err) });
    }
  }

  async presignPut(key: string, _contentLength: number): Promise<string> {
    return this.presign('PUT', key);
  }

  async presignGet(key: string): Promise<string> {
    return this.presign('GET', key);
  }

  // First `length` bytes of an object, read server-side. Range is not in the signed headers
  // (S3 does not require it to be) so a presigned GET + a Range request header suffices; the
  // locker uses this to sniff an upload's real header, which the client cannot forge.
  async getHead(key: string, length: number): Promise<Buffer> {
    const res = await fetch(this.presign('GET', key), {
      headers: { Range: `bytes=0-${Math.max(0, length - 1)}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`getHead ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** The object's real byte length, or undefined when it cannot be read. The save routes trust
   *  a client-declared size for quota accounting otherwise: presign for ten bytes, upload five
   *  gigabytes, report ten. The locker already verifies its uploads this way. */
  async objectSize(key: string): Promise<number | undefined> {
    try {
      const res = await fetch(this.presign('GET', key), {
        method: 'HEAD', signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return undefined;
      const n = Number(res.headers.get('content-length'));
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }

  // Erasure. Listing is a signed GET on the bucket with a prefix; each object is then
  // deleted individually. Slower than a bulk delete and deliberately so — this runs on a
  // delete-my-data request, where being correct matters far more than being quick.
  // The path of a bucket-level operation (list): "/<bucket>" path-style, "/" virtual-host.
  private bucketPath(): string {
    return this.s.pathStyle === false ? '/' : `/${encodeURIComponent(this.s.bucket)}`;
  }

  async delete(prefix: string): Promise<void> {
    const listUrl = this.signedUrl('GET', this.bucketPath(), { 'list-type': '2', prefix });
    try {
      const res = await fetch(listUrl, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        log('error', 's3.list_failed', { status: res.status, prefix });
        return;
      }
      const xml = await res.text();
      const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
      for (const key of keys) {
        const r = await fetch(this.presign('DELETE', key), {
          method: 'DELETE',
          signal: AbortSignal.timeout(30_000),
        });
        if (!r.ok) log('error', 's3.delete_failed', { status: r.status, key });
      }
      log('info', 's3.deleted_prefix', { prefix, objects: keys.length });
    } catch (err) {
      log('error', 's3.delete_threw', { prefix, error: String(err) });
    }
  }
}

// Built from config/env, or undefined when the operator has not configured storage — in
// which case the locker stays inert and clients keep using their own disk.
export function s3FromEnv(cfg: {
  endpoint: string;
  region: string;
  bucket: string;
}): S3Storage | undefined {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? '';
  if (cfg.endpoint === '' || cfg.bucket === '' || accessKeyId === '' || secretAccessKey === '') return undefined;
  log('info', 's3.configured', { endpoint: cfg.endpoint, bucket: cfg.bucket, region: cfg.region });
  // 1h: an upload PUT of a multi-hundred-MB file needs a comfortable window, and a download
  // GET is streamed for a whole play session — the client renews each download URL well
  // before this (StreamFS mounts one URL and reads Ranges against it for hours), so this is
  // the safety margin, not the session bound. Still short enough that a leaked URL dies soon.
  return new S3Storage({ ...cfg, accessKeyId, secretAccessKey, expirySec: 3600 });
}
