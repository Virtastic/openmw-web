// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// RFC 6238 TOTP over node:crypto. Sixty lines beats a dependency here: the standard is
// frozen, the whole algorithm is one HMAC plus a base32 alphabet, and this repo already
// refuses CDN/vendor weight everywhere else in the admin surface.
//
// Second factor for the PASSWORD path only. An SSO login has already been through the
// identity provider's own MFA, so demanding a code on top would make the provider path
// strictly more friction than the password path for no gain.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 160-bit secret, the RFC 4226 recommendation, base32 for the authenticator app. */
export function generateSecret(): string {
  let bits = '';
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(secret: string): Buffer {
  let bits = '';
  for (const c of secret.toUpperCase()) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue; // spaces, hyphens and '=' padding people paste in: ignore
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codeAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', decode(secret)).update(buf).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Verify a 6-digit code, accepting one step (30 s) of drift either way — the standard
 * allowance, because a phone's clock is never exactly ours and people take a moment to type.
 */
export function verifyTotp(secret: string, token: string): boolean {
  const cleaned = token.replace(/\D/g, '');
  if (cleaned.length !== 6 || secret === '') return false;
  const now = Math.floor(Date.now() / 30_000);
  const want = Buffer.from(cleaned);
  let ok = false;
  // No early return: check every step so a wrong code always costs the same three HMACs.
  for (const step of [now - 1, now, now + 1]) {
    const got = Buffer.from(codeAt(secret, step));
    if (got.length === want.length && timingSafeEqual(got, want)) ok = true;
  }
  return ok;
}

/** otpauth:// URI an authenticator app scans as a QR code. */
export function totpUri(secret: string, account: string, issuer = 'OpenMW-Web'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
