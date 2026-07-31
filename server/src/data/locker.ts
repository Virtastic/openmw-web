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
];
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { log } from '../log';

// Retail Morrowind, by sha256. A file the user uploads must be one of these (or an
// approved mod file) — that is what keeps a backup locker from becoming a warez drop.
//
// EMPTY BY DEFAULT AND THAT IS DELIBERATE: we do not ship Bethesda's hashes as a
// convenience for people who do not own the game. An operator generates this from their
// own legally acquired copy (tools/gen-vanilla-manifest), which is also the only way the
// list is correct for their region and release.
export interface VanillaManifest {
  files: { name: string; size: number; sha256: string }[];
}

export interface Attestation {
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
}

export type UploadRefusal =
  | 'no-attestation'
  | 'not-recognized'
  | 'too-large'
  | 'quota';

export interface LockerSettings {
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
    // Read the first `length` bytes of an object (server-side, signed) — the header sniff
    // needs the bytes that actually landed, not the client's word for them.
    getHead(key: string, length: number): Promise<Buffer>;
  };
}

const ATTEST_STATEMENT =
  'These are my own backup copies of files from my legally purchased game.';

// Structural sniff of a file's first bytes: is this actually a Morrowind data file, or
// arbitrary bytes wearing a Morrowind filename? Run server-side on the bytes that ACTUALLY
// landed in the bucket (read back via storage.getHead), so — unlike name/size/hash, all of
// which the client asserts — the client cannot lie about it. Offsets verified against real
// Morrowind/Tribunal/Bloodmoon files. Not cryptographic (a forger could prepend a valid
// header) but it defeats using the locker as general file storage, which is its whole job.
// The one packed media object per account (voice/music/videos/fonts/splashes as a USTAR).
export const MEDIA_PACK = 'media.tar';

export function sniffMorrowindFile(name: string, head: Buffer): boolean {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'esm' || ext === 'esp' || ext === 'omwaddon') {
    // TES3 plugin: 'TES3' record tag at 0, first subrecord tag 'HEDR' at 16, and a format
    // version float (1.2 or 1.3 across all official files) at 24.
    if (head.length < 28) return false;
    if (head.toString('latin1', 0, 4) !== 'TES3') return false;
    if (head.toString('latin1', 16, 20) !== 'HEDR') return false;
    const ver = head.readFloatLE(24);
    return ver > 1.0 && ver < 1.5;
  }
  if (ext === 'bsa') {
    // Morrowind BSA: u32 version == 0x100, then a hash-table offset and file count that a
    // real archive always has above zero.
    if (head.length < 12) return false;
    if (head.readUInt32LE(0) !== 0x100) return false;
    return head.readUInt32LE(4) > 0 && head.readUInt32LE(8) > 0;
  }
  // Loose retail media (Video/, Music/, Splash/, Fonts/). These reach the locker only when
  // the manifest already matched them by hash or name+size, so the sniff is the same
  // "is this really that kind of file" backstop the plugins get — not the primary gate.
  if (head.length < 4) return false;
  const magic4 = head.toString('latin1', 0, 4);
  if (ext === 'bik') return magic4.startsWith('BIK'); // Bink video: 'BIKb'/'BIKi'/...
  if (ext === 'mp3') {
    // MP3: an ID3 tag, or a raw MPEG audio frame sync (0xFF Ex/Fx).
    return magic4.startsWith('ID3') || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0);
  }
  if (ext === 'wav') return magic4 === 'RIFF';
  if (ext === 'dds') return magic4 === 'DDS ';
  if (ext === 'bmp') return head.toString('latin1', 0, 2) === 'BM';
  if (ext === 'tga') return true;  // TGA has no leading magic; the manifest match is the gate
  if (ext === 'fnt' || ext === 'tex') return true; // Bethesda font/texture pairs, no magic
  return false;
}

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
  // sha256 -> true: an EXACT match against a known distribution (the strong path).
  private accepted = new Set<string>();
  // Different retail distributions (Steam / GOG / disc / localized) ship byte-DIFFERENT
  // copies of the same file, so an exact-hash gate built from one copy would reject a
  // friend's legitimate copy from another store. So we also accept by (canonical filename +
  // plausible size): nameLower -> the known sizes for that file. A movie renamed to
  // Morrowind.esm is not ~79.8MB, so this still keeps the locker from becoming file hosting.
  // Refusals are logged with name+size+hash so an operator can add a genuinely new copy.
  private knownSizes = new Map<string, number[]>();
  private acceptByNameAndSize = true;
  private sizeTolerance = 0.05; // ±5% covers minor per-distribution differences

  constructor(private readonly settings: LockerSettings) {
    this.db = openDb(join(settings.dataDir, 'locker.db'), LOCKER_MIGRATIONS);
  }

  get enabled(): boolean {
    return this.settings.storage !== undefined;
  }

  static get statement(): string {
    return ATTEST_STATEMENT;
  }

  // The set of files this deployment will accept: retail hashes plus any approved mod
  // files. Called at boot; an empty set means uploads are refused outright, which is the
  // correct behaviour for an operator who has not generated a manifest.
  configureAccepted(
    vanilla: VanillaManifest,
    modHashes: Iterable<string> = [],
    opts: { acceptByNameAndSize?: boolean } = {},
  ): void {
    this.vanilla = vanilla;
    this.accepted = new Set([
      ...vanilla.files.map((f) => f.sha256.toLowerCase()),
      ...[...modHashes].map((h) => h.toLowerCase()),
    ]);
    this.knownSizes = new Map();
    for (const f of vanilla.files) {
      const k = f.name.toLowerCase();
      const sizes = this.knownSizes.get(k) ?? [];
      if (!sizes.includes(f.size)) sizes.push(f.size);
      this.knownSizes.set(k, sizes);
    }
    if (opts.acceptByNameAndSize !== undefined) this.acceptByNameAndSize = opts.acceptByNameAndSize;
    log('info', 'locker.accepted_configured', {
      vanilla: vanilla.files.length, hashes: this.accepted.size, names: this.knownSizes.size,
      byNameAndSize: this.acceptByNameAndSize,
    });
  }

  /** The configured backend, for callers that must reach it directly (CORS registration). */
  get storage(): LockerSettings['storage'] { return this.settings.storage; }

  // Is this file one a legitimate Morrowind owner would have? Exact hash first (any known
  // distribution), then name+plausible-size for a distribution we do not have on file.
  //
  // We deliberately do NOT remember an unknown hash that passed on name+size: "learning" it
  // would let the FIRST uploader of a byte-mismatched file whitelist it permanently, so a
  // single bad upload would open the exact-hash fast path for everyone. Name+size is only
  // ever a per-upload decision; the exact-hash set only grows from the operator's manifest.
  // The real content check on that path is the header sniff done on the UPLOADED bytes
  // (verifyUploadedContent) — the client cannot lie about what actually landed in the bucket.
  private isAccepted(file: LockerFile): boolean {
    if (this.accepted.has(file.sha256.toLowerCase())) return true;
    if (!this.acceptByNameAndSize) return false;
    const sizes = this.knownSizes.get(file.name.toLowerCase());
    if (!sizes) return false;
    return sizes.some((s) => Math.abs(file.size - s) <= s * this.sizeTolerance);
  }

  // Loose media splits by SHAPE, not by category:
  //   Sound/**  ~6,400 files averaging 28 KB -> ONE packed upload (media.tar). Per-file would
  //             be ~19k requests to upload and ~6.4k presigned GETs to load: latency-bound to
  //             the point of being unusable, and a 6.4k-entry manifest per account.
  //   Music/, Video/, Splash/, Fonts/  41 files, most of them megabytes -> the SAME per-file
  //             path the ESM/BSA files already use. No new machinery, cached individually.
  private static readonly PACKED_DIR = /^sound\//i;

  private mediaEntries(): { name: string; size: number; sha256: string }[] {
    return this.vanilla.files.filter((f) => Locker.PACKED_DIR.test(f.name));
  }

  // Loose media that uploads file-by-file (everything with a path that is not packed).
  private looseMediaEntries(): { name: string; size: number; sha256: string }[] {
    return this.vanilla.files.filter((f) => f.name.includes('/') && !Locker.PACKED_DIR.test(f.name));
  }

  private mediaBytes(): number {
    return this.mediaEntries().reduce((a, f) => a + f.size, 0);
  }

  // The size ceiling for a media pack: the media bytes plus USTAR overhead (a 512-byte
  // header per file + padding) with a little slack for distribution differences.
  private mediaPackCap(): number {
    const entries = this.mediaEntries();
    return Math.ceil(entries.reduce((a, f) => a + f.size, 0) * 1.10) + entries.length * 1536 + 16_000_000;
  }

  // The checklist the upload wizard renders: one entry per distinct game file the operator's
  // manifest knows, with the base game marked required and the expansions optional (a player
  // who owns only Morrowind must not be blocked on Tribunal/Bloodmoon). Sizes are the display
  // hint; hashes are deliberately not exposed here. Loose media collapses to one synthetic
  // "media.tar" row (voice/music/videos) that the wizard builds from a folder pick.
  // EVERYTHING the operator's manifest lists is required. The manifest IS this server's
  // content set: a client missing Tribunal/Bloodmoon (or the media) cannot match the world
  // the server authors, so "optional" was never a real category here — it just produced
  // players with silent, half-loaded games. An operator who wants a Morrowind-only server
  // generates a Morrowind-only manifest.
  requiredManifest(): { name: string; size: number; required: boolean; media?: boolean }[] {
    const byName = new Map<string, { name: string; size: number }>();
    for (const f of this.vanilla.files) {
      if (f.name.includes('/')) continue; // media is summarised as folder rows below
      const k = f.name.toLowerCase();
      const prev = byName.get(k);
      // If distributions differ in size, show the smallest (any real copy clears the ±5% gate).
      if (!prev || f.size < prev.size) byName.set(k, { name: f.name, size: f.size });
    }
    const out: { name: string; size: number; required: boolean; media?: boolean }[] = [...byName.values()]
      .map((f) => ({ ...f, required: true }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Media as ONE ROW PER FOLDER rather than 6,443 rows nobody can read. These are REQUIRED:
    // without them the game has no voice, no music and no videos, which is not "the game with
    // an option turned off" — dialogue auto-skips and the intro never plays. The row name is
    // the folder prefix ("Music/"); a locker satisfies it by holding any file under it (voice
    // by holding the pack), and the wizard fills them all from one folder pick.
    const folders = new Map<string, number>();
    for (const f of this.looseMediaEntries()) {
      const dir = f.name.split('/')[0]!;
      folders.set(dir, (folders.get(dir) ?? 0) + f.size);
    }
    for (const [dir, size] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({ name: `${dir}/`, size, required: true, media: true });
    }
    const mediaBytes = this.mediaBytes();
    if (mediaBytes > 0) {
      out.push({ name: MEDIA_PACK, size: mediaBytes, required: true, media: true });
    }
    return out;
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
    if (file.name === MEDIA_PACK) {
      // The pack's own hash cannot be in the vanilla manifest (it is built client-side), so
      // its gates are: the manifest must actually list media, and the size must be plausible
      // for that media. The REAL check is verifyMediaPack after upload — every packed file is
      // hashed against the manifest, and a pack with anything foreign in it is deleted.
      if (this.mediaBytes() === 0 || file.size > this.mediaPackCap()) {
        log('warn', 'locker.refused_media_pack', { account: accountKey, size: file.size, cap: this.mediaPackCap() });
        return { ok: false, reason: 'not-recognized' };
      }
    } else if (!this.isAccepted(file)) {
      log('warn', 'locker.refused_unrecognized', { account: accountKey, name: file.name, size: file.size, sha256: file.sha256 });
      return { ok: false, reason: 'not-recognized' };
    }
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

  // Confirm an upload. Before recording it, sniff the bytes that ACTUALLY landed in the
  // bucket: a file that passed name+size (or even hash) but whose real content is not a
  // Morrowind file is deleted and refused here. This is the check the client cannot forge,
  // because it reads back from storage rather than trusting the confirm request.
  async recordUploaded(
    accountKey: string,
    file: LockerFile,
  ): Promise<{ ok: true } | { ok: false; reason: UploadRefusal }> {
    const key = `gamedata/${accountKey}/${file.name}`;
    const storage = this.settings.storage;
    if (storage) {
      let head: Buffer;
      try {
        head = await storage.getHead(key, file.name === MEDIA_PACK ? 512 : 32);
      } catch (err) {
        log('error', 'locker.head_read_failed', { account: accountKey, name: file.name, error: String(err) });
        return { ok: false, reason: 'not-recognized' };
      }
      const sniffOk = file.name === MEDIA_PACK
        // USTAR magic sits at offset 257 of the first header block.
        ? head.length >= 262 && head.toString('latin1', 257, 262) === 'ustar'
        : sniffMorrowindFile(file.name, head);
      if (!sniffOk) {
        log('warn', 'locker.rejected_bad_content', { account: accountKey, name: file.name, size: file.size });
        await storage.delete(key); // do not keep bytes we refused
        return { ok: false, reason: 'not-recognized' };
      }
    }
    const files = await this.filesOf(accountKey);
    const next = files.filter((f) => f.name !== file.name);
    next.push(file);
    this.putFiles(accountKey, next);
    // Media pack: the content check the client cannot forge runs ASYNC (streaming ~300MB back
    // from storage and hashing every entry takes a minute; the wizard must not hang on it).
    // A pack that fails is deleted and struck from the account's list.
    if (file.name === MEDIA_PACK && storage) {
      void this.verifyMediaPack(accountKey).catch((err) =>
        log('error', 'locker.media_verify_crashed', { account: accountKey, error: String(err) }));
    }
    return { ok: true };
  }

  // Stream the uploaded media.tar back from storage and prove every entry is a file the
  // vanilla manifest knows (exact path + exact hash, or name+size tolerance when enabled).
  // ANY foreign entry disqualifies the whole pack: delete it and unrecord it. This is what
  // keeps the pack from being a tunnel around the per-file gate.
  async verifyMediaPack(accountKey: string): Promise<void> {
    const storage = this.settings.storage;
    if (!storage) return;
    const key = `gamedata/${accountKey}/${MEDIA_PACK}`;
    const media = new Map(this.mediaEntries().map((f) => [f.name.toLowerCase(), f]));
    const fail = async (reason: string, detail: Record<string, unknown> = {}): Promise<void> => {
      log('warn', 'locker.media_pack_rejected', { account: accountKey, reason, ...detail });
      try { await storage.delete(key); } catch { /* already gone is fine */ }
      const files = await this.filesOf(accountKey);
      this.putFiles(accountKey, files.filter((f) => f.name !== MEDIA_PACK));
    };
    let url: string;
    try { url = await storage.presignGet(key); } catch (err) { return fail('presign', { error: String(err) }); }
    const r = await fetch(url).catch(() => undefined);
    if (!r || !r.ok || !r.body) return fail('fetch', { status: r?.status });

    // Incremental USTAR walk: 512-byte headers, content padded to 512, two zero blocks end.
    const reader = r.body.getReader();
    let buf = Buffer.alloc(0);
    let done = false;
    const need = async (n: number): Promise<boolean> => {
      while (buf.length < n && !done) {
        const x = await reader.read();
        if (x.done) { done = true; break; }
        buf = Buffer.concat([buf, Buffer.from(x.value)]);
      }
      return buf.length >= n;
    };
    let entries = 0;
    for (;;) {
      if (!(await need(512))) break;
      const hdr = buf.subarray(0, 512);
      if (hdr.every((b) => b === 0)) break; // end-of-archive
      if (hdr.toString('latin1', 257, 262) !== 'ustar') return fail('bad_header', { entries });
      const nameField = hdr.toString('latin1', 0, 100).replace(/\0.*$/, '');
      const prefix = hdr.toString('latin1', 345, 500).replace(/\0.*$/, '');
      const name = (prefix ? prefix + '/' + nameField : nameField).replace(/\\/g, '/');
      const size = parseInt(hdr.toString('latin1', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
      const typeflag = hdr.toString('latin1', 156, 157);
      const padded = Math.ceil(size / 512) * 512;
      if (!(await need(512 + padded))) return fail('truncated', { name, entries });
      const content = buf.subarray(512, 512 + size);
      if (typeflag === '0' || typeflag === '\0') {
        entries++;
        if (entries > 10_000) return fail('too_many_entries', {});
        const want = media.get(name.toLowerCase());
        if (!want) return fail('unknown_entry', { name });
        const hash = createHash('sha256').update(content).digest('hex');
        const hashOk = hash === want.sha256.toLowerCase();
        const sizeOk = this.acceptByNameAndSize && Math.abs(size - want.size) <= want.size * this.sizeTolerance;
        if (!hashOk && !sizeOk) return fail('entry_mismatch', { name, size });
      } else if (typeflag !== '5') {
        return fail('bad_typeflag', { name, typeflag }); // only files + directories belong here
      }
      buf = buf.subarray(512 + padded);
    }
    log('info', 'locker.media_pack_verified', { account: accountKey, entries });
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

  // Verify a client's claimed content list against what it actually uploaded. This is what
  // makes the strict ContentGate meaningful for locker users: the server is not trusting
  // the client's word about its own files, it is comparing against what it stored.
  async verifyAgainstLocker(accountKey: string, claimed: { name: string; sha256?: string }[]): Promise<string | null> {
    const stored = new Map((await this.filesOf(accountKey)).map((f) => [f.name.toLowerCase(), f]));
    if (stored.size === 0) return null; // not a locker user; the normal gate applies
    for (const c of claimed) {
      const s = stored.get(c.name.toLowerCase());
      if (!s) continue; // a file we never stored is the content gate's business, not ours
      if (c.sha256 && c.sha256.toLowerCase() !== s.sha256.toLowerCase()) {
        return `${c.name} does not match the copy in your library`;
      }
    }
    return null;
  }

  // Erasure (docs/LEGAL.md §5): the locker, its manifest and the attestation all go.
  async erase(accountKey: string): Promise<void> {
    await this.settings.storage?.delete(`gamedata/${accountKey}/`);
    // Both rows go. The attestation names the person, so keeping it after an erasure request
    // would be keeping a record about someone who asked to be forgotten.
    this.db.prepare('DELETE FROM locker_files WHERE accountKey = ?').run(accountKey);
    this.db.prepare('DELETE FROM locker_attestations WHERE accountKey = ?').run(accountKey);
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
