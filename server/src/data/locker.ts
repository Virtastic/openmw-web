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

import { mkdirSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
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
  dataDir: string; // where attestations and per-account manifests live
  maxBytesPerAccount: number;
  // Object storage. Absent = the locker is disabled entirely and the client keeps using
  // its own disk (?src=local), which is the fallback posture in docs/LEGAL.md §8.
  storage?: {
    presignPut(key: string, contentLength: number): Promise<string>;
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
  private readonly dir: string;
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
    this.dir = join(settings.dataDir, 'locker');
    mkdirSync(this.dir, { recursive: true });
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

  private attestPath(accountKey: string): string {
    return join(this.dir, `${encodeURIComponent(accountKey)}.attest.json`);
  }

  private manifestPath(accountKey: string): string {
    return join(this.dir, `${encodeURIComponent(accountKey)}.files.json`);
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
    await writeFile(this.attestPath(accountKey), JSON.stringify(doc, null, 2) + '\n', 'utf8');
    log('info', 'locker.attested', { account: accountKey, files: files.length, manifestHash });
    return doc;
  }

  async attestationOf(accountKey: string): Promise<Attestation | undefined> {
    try {
      return JSON.parse(await readFile(this.attestPath(accountKey), 'utf8')) as Attestation;
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
    if (!this.isAccepted(file)) {
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
        head = await storage.getHead(key, 32);
      } catch (err) {
        log('error', 'locker.head_read_failed', { account: accountKey, name: file.name, error: String(err) });
        return { ok: false, reason: 'not-recognized' };
      }
      if (!sniffMorrowindFile(file.name, head)) {
        log('warn', 'locker.rejected_bad_content', { account: accountKey, name: file.name, size: file.size });
        await storage.delete(key); // do not keep bytes we refused
        return { ok: false, reason: 'not-recognized' };
      }
    }
    const files = await this.filesOf(accountKey);
    const next = files.filter((f) => f.name !== file.name);
    next.push(file);
    await writeFile(this.manifestPath(accountKey), JSON.stringify({ files: next }, null, 2) + '\n', 'utf8');
    return { ok: true };
  }

  async filesOf(accountKey: string): Promise<LockerFile[]> {
    try {
      const doc = JSON.parse(await readFile(this.manifestPath(accountKey), 'utf8')) as { files: LockerFile[] };
      return doc.files ?? [];
    } catch {
      return [];
    }
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
    for (const p of [this.attestPath(accountKey), this.manifestPath(accountKey)]) {
      await writeFile(p, '', 'utf8').catch(() => undefined);
    }
    log('info', 'locker.erased', { account: accountKey });
  }

  async accounts(): Promise<string[]> {
    try {
      return (await readdir(this.dir))
        .filter((n) => n.endsWith('.files.json'))
        .map((n) => decodeURIComponent(n.replace('.files.json', '')));
    } catch {
      return [];
    }
  }
}
