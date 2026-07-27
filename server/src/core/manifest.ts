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
  // Set when the SERVER owns the world's data (tier 2). The canonical list then comes from
  // the sim peer — a real engine running the server's data, so its content list is computed
  // by the same code as every player's — and is never adopted from a client nor dropped when
  // the server empties.
  private authoritative = false;

  constructor(private readonly mode: 'strict' | 'names' | 'off') {}

  get isAuthoritative(): boolean {
    return this.authoritative;
  }

  // Tier 2: pin the world's content list. Called once the sim peer reports its manifest.
  //
  // Deriving this list server-side is NOT possible and the attempt was measured: a real
  // client sends `builtin.omwscripts#0, openmw-template.omwgame#1, ...`, and both of those
  // live in the ENGINE's resources, not in the game data folder. Any folder scan or cfg
  // parse would omit them and refuse 100% of clients.
  setAuthoritative(entries: ManifestEntry[]): void {
    this.canonical = entries.map((e) => ({ ...e }));
    this.authoritative = true;
    log('info', 'content.authoritative', { files: entries.map((e) => e.name).join(',') });
  }

  // On ok the caller owns one hold and must release() it on disconnect.
  check(manifest: ManifestEntry[]): ContentCheck {
    if (this.mode === 'off') {
      this.holders++;
      return { ok: true };
    }
    if (this.mode === 'strict') {
      // TODO: verify per-file sha256 (needs a client-side hash binding). Until then strict
      // degrades to names, which catches added/removed/reordered files but NOT a file
      // edited in place.
      log('warn', 'content.strict_stub', { note: 'strict mode not implemented, using names' });
    }
    if (this.canonical === null) {
      // Adopt-first (tier 1): the server has no data of its own, so the first player defines
      // the session. Never reached once setAuthoritative has run.
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
    // An authoritative list belongs to the WORLD, not to whoever happens to be connected, so
    // an empty server must not forget it. Tier 1 still re-canonicalizes on the next player.
    if (this.holders === 0 && !this.authoritative) this.canonical = null;
  }

  private diff(want: ManifestEntry[], got: ManifestEntry[]): string | null {
    // Player-facing first: name the FILES that differ, because "load-order mismatch at
    // position 3" tells a player nothing they can act on. The positional detail below still
    // runs for anything the set difference cannot explain (pure reordering).
    const wantNames = new Set(want.map((e) => e.name));
    const gotNames = new Set(got.map((e) => e.name));
    const missing = want.filter((e) => !gotNames.has(e.name)).map((e) => e.name);
    const extra = got.filter((e) => !wantNames.has(e.name)).map((e) => e.name);
    if (missing.length || extra.length) {
      const runs = want.map((e) => e.name).join(' + ');
      const parts: string[] = [];
      if (missing.length) parts.push(`your game is missing ${missing.join(', ')}`);
      if (extra.length) parts.push(`your game has extra content: ${extra.join(', ')}`);
      return `this world runs ${runs}; ${parts.join('; ')}`;
    }

    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      const w = want[i];
      const g = got[i];
      if (!w) return `unexpected extra content file "${g!.name}" at position ${i}`;
      if (!g) return `missing content file "${w.name}" at position ${i}`;
      if (w.name !== g.name)
        return `load order differs: expected "${w.name}" at position ${i}, got "${g.name}"`;
      // Size is only comparable when BOTH sides report one. Clients always send 0 because
      // Lua cannot read file sizes (net.lua buildManifest), so comparing against a real
      // server-side size would refuse every client. Same idiom as EngineGate's empty hash.
      if (w.size !== 0 && g.size !== 0 && w.size !== g.size)
        return `size mismatch for "${w.name}": expected ${w.size}, got ${g.size}`;
      if (w.idx !== g.idx)
        return `load order differs for "${w.name}": expected position ${w.idx}, got ${g.idx}`;
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
