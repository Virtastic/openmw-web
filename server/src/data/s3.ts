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
    const now = new Date();
    const { long, short } = amzDate(now);
    const credentialScope = `${short}/${this.s.region}/s3/aws4_request`;
    const path = this.objectPath(key);
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

  async presignPut(key: string, _contentLength: number): Promise<string> {
    return this.presign('PUT', key);
  }

  async presignGet(key: string): Promise<string> {
    return this.presign('GET', key);
  }

  // Erasure. Listing is a signed GET on the bucket with a prefix; each object is then
  // deleted individually. Slower than a bulk delete and deliberately so — this runs on a
  // delete-my-data request, where being correct matters far more than being quick.
  async delete(prefix: string): Promise<void> {
    const listUrl = this.presign('GET', '', {
      'list-type': '2',
      prefix,
    }).replace(this.objectPath(''), this.s.pathStyle === false ? '/' : `/${encodeURIComponent(this.s.bucket)}`);
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
  return new S3Storage({ ...cfg, accessKeyId, secretAccessKey });
}
