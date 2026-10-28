// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.5/3.55: the game-data storage locker.
//
// A player uploads their own Morrowind files once and streams them back on any device.
// The legal framing is a PRIVATE BACKUP LOCKER for files the user already owns, and the
// mechanics below are not implementation details — they are what makes that framing true
// (docs/LEGAL.md §2). Changing any of them re-opens the takedown pattern that killed DOS
// Zone's browser GTA:
//
//   * per-account prefix, always: gamedata/<accountId>/...
//   * ZERO dedup — each account stores its own bytes. Dedup would turn "their backup" into
//     our master copy, which is the entire distinction.
//   * streaming only to the authenticated owner: no public URLs, no sharing, ever
//   * an upload attestation is recorded before any byte is accepted
//   * the vanilla-manifest gate means we accept only the retail files the user attests to
//     owning, so this cannot become general file hosting
//
// This module is the CONTROL PLANE: attestation, per-file authorization, and manifest
// verification. The bytes themselves go straight between the browser and object storage
// via presigned URLs — routing 4 GB through the relay would be pointless cost and would
// make us the distributor in a way the presigned model does not.

import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../persist/sqlite';

const LOCKER_MIGRATIONS = [
  {
    name: '001-locker',
    up: (db: DatabaseSync) => {
      // ONE ROW PER ACCOUNT, holding that account's own file list. Deliberately NOT a
      // content-addressed table keyed by hash: docs/LEGAL.md requires per-account copies with
      // zero dedup, and a schema that joined accounts by file hash would be legally wrong as
      // well as technically convenient.
      db.exec(`CREATE TABLE locker_files (
        accountKey TEXT PRIMARY KEY,
        files      TEXT NOT NULL   -- JSON array of LockerFile
      )`);
      // The attestation is what the user actually agreed to before a byte was accepted — the
      // DMCA evidence trail (docs/LEGAL.md §4). It is written by the SERVER at runtime, so it
      // is a store like any other and belongs here. Erasure DELETEs the row: an erasure that
      // leaves the record naming the person is not an erasure.
      db.exec(`CREATE TABLE locker_attestations (
        accountKey TEXT PRIMARY KEY,
        doc        TEXT NOT NULL
      )`);
    },
  },
  {
    // Dead since CL2 (v2 is esm-only, no media pack) but kept: the migration list is append-only.
    name: '002-media-pack-status',
    up: (db: DatabaseSync) => {
      db.exec(`CREATE TABLE locker_media_status (
        accountKey TEXT PRIMARY KEY,
        reason     TEXT NOT NULL,
        detail     TEXT,
        at         TEXT NOT NULL
      )`);
    },
  },
];
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { log } from '../log';

// Retail Morrowind, by sha256. Only the three ESMs are ever accepted, and only by exact hash —
// that is what keeps a backup locker from becoming a warez drop.
//
// EMPTY BY DEFAULT AND THAT IS DELIBERATE: we do not ship Bethesda's hashes as a
// convenience for people who do not own the game. An operator generates this from their
// own legally acquired copy (tools/gen-vanilla-manifest), which is also the only way the
// list is correct for their region and release.
export interface VanillaManifest {
  files: { name: string; size: number; sha256: string }[];
}

interface Attestation {
  accountKey: string;
  at: string; // ISO
  // The exact words the user checked. Stored verbatim: what matters in a dispute is what
  // they were shown, not what the current build happens to say.
  statement: string;
  manifestHash: string; // hash of the file list they attested to
  ip: string;
}

export interface LockerFile {
  name: string;
  size: number;
  sha256: string;
  /** The server hashed the bytes that landed and they matched. */
  verified?: boolean;
}

/** One row of the upload wizard's checklist. */
interface LockerNeed {
  name: string;
  size: number;
  /** The world this server runs loads this file. Never relaxed — see requiredManifest. */
  required: boolean;
}

// Proof of ownership is these three plugins, nothing else. The server
// hosts the rest, so a player uploads ~95 MB once instead of the whole Data Files folder.
const ESM_NAMES = ['Morrowind.esm', 'Tribunal.esm', 'Bloodmoon.esm'];
// GOTY Morrowind.esm is ~80 MB; anything far past that is not one of these files.
export const ESM_MAX_BYTES = 128 * 2 ** 20;

type UploadRefusal =
  | 'no-attestation'
  | 'not-recognized'
  | 'too-large'
  | 'quota';

interface LockerSettings {
  dataDir: string; // where locker.db (file lists + attestations) lives
  maxBytesPerAccount: number;
  // Object storage. Absent = the locker is disabled entirely and the client keeps using
  // its own disk (?src=local), which is the fallback posture in docs/LEGAL.md §8.
  storage?: {
    presignPut(key: string, contentLength: number): Promise<string>;
    /** Register a browser origin with the bucket's CORS policy. Optional: a storage backend
     *  that is not a real S3 (tests, local disk) has no such concept. */
    ensureCorsOrigin?(origin: string): Promise<void>;
    presignGet(key: string): Promise<string>;
    delete(prefix: string): Promise<void>;
  };
}

const ATTEST_STATEMENT =
  'These are my own backup copies of files from my legally purchased game.';

// <sharedDir>/vanilla-manifest.json, else an empty set (uploads refused until an operator
// generates one from their own legal copy — tools/gen-vanilla-manifest). A missing file is
// not an error: the locker simply accepts nothing, which is the safe default.
export async function loadVanillaManifest(dir: string): Promise<VanillaManifest> {
  try {
    const doc = JSON.parse(await readFile(join(dir, 'vanilla-manifest.json'), 'utf8')) as VanillaManifest;
    return { files: Array.isArray(doc.files) ? doc.files : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('error', 'locker.bad_vanilla_manifest', { error: String(err) });
    }
    return { files: [] };
  }
}

export class Locker {
  private readonly db: DatabaseSync;
  private vanilla: VanillaManifest = { files: [] };
  private esmAccepted = new Map<string, Set<string>>(); // nameLower -> accepted sha256s

  constructor(private readonly settings: LockerSettings) {
    this.db = openDb(join(settings.dataDir, 'locker.db'), LOCKER_MIGRATIONS);
  }

  get enabled(): boolean {
    return this.settings.storage !== undefined;
  }

  static get statement(): string {
    return ATTEST_STATEMENT;
  }

  // The ESM hashes this deployment accepts. Called at boot. Default: the hashes of the server's
  // OWN copies (the vanilla manifest is generated from its game-data folder), plus
  // "<Name>.esm:<sha256>" extras for other genuine releases. Never name+size: a verified ESM
  // unlocks the server's hosted copy of everything else.
  configureAccepted(vanilla: VanillaManifest, opts: { esmHashes?: readonly string[] } = {}): void {
    this.vanilla = vanilla;
    this.esmAccepted = new Map(ESM_NAMES.map((n) => [n.toLowerCase(), new Set<string>()]));
    const extra = (opts.esmHashes ?? []).map((e) => {
      const m = /^([^:]+):([0-9a-f]{64})$/i.exec(e.trim());
      if (!m) log('error', 'locker.bad_esm_hash', { entry: e });
      return m ? { name: m[1]!, sha256: m[2]! } : undefined;
    });
    for (const f of [...vanilla.files, ...extra]) {
      if (f) this.esmAccepted.get(f.name.toLowerCase())?.add(f.sha256.toLowerCase());
    }
    log('info', 'locker.accepted_configured', { vanilla: vanilla.files.length });
  }

  /** The configured backend, for callers that must reach it directly (CORS registration). */
  get storage(): LockerSettings['storage'] { return this.settings.storage; }

  // The upload wizard's checklist: the three ESMs. All three are required — the hosted world
  // loads all three. Sizes are the display hint; hashes are deliberately not exposed here.
  requiredManifest(): LockerNeed[] {
    return ESM_NAMES.map((name) => ({
      name,
      size: this.vanilla.files.find((f) => f.name.toLowerCase() === name.toLowerCase())?.size ?? 0,
      required: true,
    }));
  }

  private putFiles(accountKey: string, files: LockerFile[]): void {
    this.db
      .prepare('INSERT OR REPLACE INTO locker_files (accountKey, files) VALUES (?, ?)')
      .run(accountKey, JSON.stringify(files));
  }

  // Recorded BEFORE any byte is accepted, with the statement the user actually saw. This
  // record — not a ToS clause — is the evidence trail (docs/LEGAL.md §4).
  async attest(accountKey: string, files: LockerFile[], ip: string): Promise<Attestation> {
    const manifestHash = createHash('sha256')
      .update(files.map((f) => `${f.name}:${f.size}:${f.sha256}`).sort().join('\n'))
      .digest('hex');
    const doc: Attestation = {
      accountKey,
      at: new Date().toISOString(),
      statement: ATTEST_STATEMENT,
      manifestHash,
      ip,
    };
    this.db
      .prepare('INSERT OR REPLACE INTO locker_attestations (accountKey, doc) VALUES (?, ?)')
      .run(accountKey, JSON.stringify(doc));
    log('info', 'locker.attested', { account: accountKey, files: files.length, manifestHash });
    return doc;
  }

  async attestationOf(accountKey: string): Promise<Attestation | undefined> {
    await Promise.resolve();
    const row = this.db
      .prepare('SELECT doc FROM locker_attestations WHERE accountKey = ?')
      .get(accountKey) as { doc: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.doc) as Attestation;
    } catch {
      return undefined;
    }
  }

  // May this account upload this file? Refusals are specific so the client can say
  // something actionable — "that is not a Morrowind file we recognize" is a very different
  // problem for a player than "you are out of space".
  async authorizeUpload(
    accountKey: string,
    file: LockerFile,
  ): Promise<{ ok: true; url: string; key: string } | { ok: false; reason: UploadRefusal }> {
    if (!this.settings.storage) return { ok: false, reason: 'not-recognized' };
    if (!(await this.attestationOf(accountKey))) return { ok: false, reason: 'no-attestation' };
    const name = ESM_NAMES.find((n) => n.toLowerCase() === file.name.toLowerCase());
    if (!name) return { ok: false, reason: 'not-recognized' };
    if (file.size > ESM_MAX_BYTES) return { ok: false, reason: 'too-large' };
    if (!this.esmAccepted.get(name.toLowerCase())?.has(String(file.sha256).toLowerCase())) {
      log('warn', 'locker.refused_esm', { account: accountKey, name: file.name, size: file.size, sha256: file.sha256 });
      return { ok: false, reason: 'not-recognized' };
    }
    file = { ...file, name };
    const existing = await this.filesOf(accountKey);
    const used = existing.reduce((a, f) => a + f.size, 0);
    if (used + file.size > this.settings.maxBytesPerAccount) return { ok: false, reason: 'quota' };
    // Per-account prefix. Never a shared or content-addressed key: dedup across accounts
    // is precisely what would make this our copy rather than theirs.
    const key = `gamedata/${accountKey}/${file.name}`;
    return { ok: true, url: await this.settings.storage.presignPut(key, file.size), key };
  }

  // Read access is owner-only, always. There is no sharing feature and no public URL to
  // add one later without deleting this comment first.
  async authorizeDownload(accountKey: string, name: string): Promise<string | undefined> {
    if (!this.settings.storage) return undefined;
    const files = await this.filesOf(accountKey);
    if (!files.some((f) => f.name === name)) return undefined;
    return this.settings.storage.presignGet(`gamedata/${accountKey}/${name}`);
  }

  // Confirm an upload: hash the WHOLE object that landed, server-side. The client's claimed
  // hash only bought a presigned PUT; this read is what it cannot forge. A match records
  // verified ownership; either way the bytes are then deleted — the server hosts its own copy,
  // so keeping ~95 MB per player would be pure cost.
  async recordUploaded(
    accountKey: string, file: LockerFile,
  ): Promise<{ ok: true } | { ok: false; reason: UploadRefusal }> {
    const storage = this.settings.storage;
    const name = ESM_NAMES.find((n) => n.toLowerCase() === file.name.toLowerCase());
    if (!storage || !name) return { ok: false, reason: 'not-recognized' };
    const key = `gamedata/${accountKey}/${name}`; // the canonical name authorizeUpload signed
    let sha256 = '';
    let size = 0;
    try {
      const r = await fetch(await storage.presignGet(key));
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const h = createHash('sha256');
      for await (const chunk of r.body) {
        size += chunk.byteLength;
        if (size > ESM_MAX_BYTES) break;
        h.update(chunk);
      }
      sha256 = h.digest('hex');
    } catch (err) {
      log('error', 'locker.esm_read_failed', { account: accountKey, name, error: String(err) });
    }
    try { await storage.delete(key); } catch { /* already gone is fine */ }
    const accepted = this.esmAccepted.get(name.toLowerCase());
    if (size > ESM_MAX_BYTES) return { ok: false, reason: 'too-large' };
    if (!sha256 || !accepted?.has(sha256)) {
      log('warn', 'locker.rejected_esm_content', { account: accountKey, name, size, sha256 });
      return { ok: false, reason: 'not-recognized' };
    }
    const files = (await this.filesOf(accountKey)).filter((f) => f.name.toLowerCase() !== name.toLowerCase());
    files.push({ name, size, sha256, verified: true });
    this.putFiles(accountKey, files);
    log('info', 'locker.esm_verified', { account: accountKey, name });
    return { ok: true };
  }

  // Verified ownership of all three ESMs, against the CURRENT accepted set (an operator who
  // drops a hash revokes it). This, not a sign-in alone, is what unlocks the hosted files.
  async ownsGame(accountKey: string): Promise<boolean> {
    const files = await this.filesOf(accountKey);
    return ESM_NAMES.every((n) => files.some((f) => f.verified === true
      && f.name.toLowerCase() === n.toLowerCase()
      && this.esmAccepted.get(n.toLowerCase())?.has(f.sha256.toLowerCase())));
  }

  async filesOf(accountKey: string): Promise<LockerFile[]> {
    const row = this.db
      .prepare('SELECT files FROM locker_files WHERE accountKey = ?')
      .get(accountKey) as { files: string } | undefined;
    if (row) {
      try {
        return JSON.parse(row.files) as LockerFile[];
      } catch {
        return [];
      }
    }
    return [];
  }

  // Erasure (docs/LEGAL.md §5): the locker, its manifest and the attestation all go.
  async erase(accountKey: string): Promise<void> {
    await this.settings.storage?.delete(`gamedata/${accountKey}/`);
    // Both rows go. The attestation names the person, so keeping it after an erasure request
    // would be keeping a record about someone who asked to be forgotten.
    this.db.prepare('DELETE FROM locker_files WHERE accountKey = ?').run(accountKey);
    this.db.prepare('DELETE FROM locker_attestations WHERE accountKey = ?').run(accountKey);
    this.db.prepare('DELETE FROM locker_media_status WHERE accountKey = ?').run(accountKey);
    log('info', 'locker.erased', { account: accountKey });
  }

  async accounts(): Promise<string[]> {
    try {
      const rows = this.db.prepare('SELECT accountKey FROM locker_files').all() as
        { accountKey: string }[];
      return rows.map((r) => r.accountKey);
    } catch {
      return [];
    }
  }
}
