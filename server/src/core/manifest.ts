// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Content policy gate. M0 simplification (documented in PROTOCOL.md/README): the server
// has no game data, so in "names" mode the FIRST player's manifest becomes the session's
// canonical manifest (exact name+size+order); it is dropped once no session that passed
// the check remains connected. "strict" (sha256) is stubbed and behaves like "names"
// until M1; "off" skips the check entirely.

import type { ManifestEntry } from '../proto/session';
import { log } from '../log';

export type ContentCheck = { ok: true } | { ok: false; detail: string };

export class ContentGate {
  private canonical: ManifestEntry[] | null = null;
  private holders = 0;

  constructor(private readonly mode: 'strict' | 'names' | 'off') {}

  // On ok the caller owns one hold and must release() it on disconnect.
  check(manifest: ManifestEntry[]): ContentCheck {
    if (this.mode === 'off') {
      this.holders++;
      return { ok: true };
    }
    if (this.mode === 'strict') {
      // TODO(M1): verify per-file sha256. Until then strict degrades to names.
      log('warn', 'content.strict_stub', { note: 'strict mode not implemented in M0, using names' });
    }
    if (this.canonical === null) {
      this.canonical = manifest.map((e) => ({ ...e }));
      this.holders++;
      return { ok: true };
    }
    const mismatch = this.diff(this.canonical, manifest);
    if (mismatch) return { ok: false, detail: mismatch };
    this.holders++;
    return { ok: true };
  }

  release(): void {
    if (this.holders > 0) this.holders--;
    if (this.holders === 0) this.canonical = null; // server empty -> next player re-canonicalizes
  }

  private diff(want: ManifestEntry[], got: ManifestEntry[]): string | null {
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      const w = want[i];
      const g = got[i];
      if (!w) return `unexpected extra content file "${g!.name}" at position ${i}`;
      if (!g) return `missing content file "${w.name}" at position ${i}`;
      if (w.name !== g.name) return `content file mismatch at position ${i}: expected "${w.name}", got "${g.name}"`;
      if (w.size !== g.size) return `size mismatch for "${w.name}": expected ${w.size}, got ${g.size}`;
      if (w.idx !== g.idx) return `load-order mismatch for "${w.name}": expected idx ${w.idx}, got ${g.idx}`;
    }
    return null;
  }
}

// Engine-hash gate with the same adopt-first lifetime as ContentGate. An empty client
// hash is unverifiable and always passes (logged).
export class EngineGate {
  private canonical: string | null = null;
  private holders = 0;

  constructor(private readonly mode: 'warn' | 'refuse' | 'off') {}

  check(hash: string): { ok: true } | { ok: false; detail: string } {
    if (this.mode === 'off' || hash === '') {
      if (hash === '' && this.mode !== 'off') log('debug', 'engine.hash_absent', {});
      this.holders++;
      return { ok: true };
    }
    if (this.canonical === null) {
      this.canonical = hash;
      this.holders++;
      return { ok: true };
    }
    if (this.canonical !== hash) {
      if (this.mode === 'refuse')
        return { ok: false, detail: `engine hash ${hash} differs from session's ${this.canonical}` };
      log('warn', 'engine.hash_mismatch', { got: hash, canonical: this.canonical });
    }
    this.holders++;
    return { ok: true };
  }

  release(): void {
    if (this.holders > 0) this.holders--;
    if (this.holders === 0) this.canonical = null;
  }
}
