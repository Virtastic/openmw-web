// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Savegames, from the operator's side: see them, take a copy out, put one back.
//
// WHY THE DASHBOARD NEEDS THIS AT ALL. Saves live in object storage under a per-account prefix,
// and the only way to reach one was to be that player, in a browser, with a locker session. So
// an operator could not answer the two questions people actually ask — "how much of my storage
// is savegames" and "can I get my character out of here" — and a player who broke their save
// had nobody who could put a working one back.
//
// EVERYTHING HERE REUSES THE PLAYER PATH. SaveStore is the same table the game writes to, and
// the same key layout (data/save-routes.ts saveKey) addresses the same objects. This module
// adds an operator-authenticated door to them, not a second copy of them: a save imported here
// is indistinguishable from one the game uploaded, which is the point.
//
// AN OPERATOR CAN READ ANY ACCOUNT'S SAVES. That is a real privilege and it is deliberate —
// they own the disk either way, and restoring somebody's character is the whole feature — but
// it is owner-only, and every download and import is logged with the account it touched.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SaveStore, saveKey } from '../../data/save-routes';
import { log } from '../../log';

/** Matches the player path's own rule: a save name is a filename and nothing else. */
const SAVE_NAME = /^[A-Za-z0-9 ._'()\-]{1,128}\.omwsave$/;
/** 'mp' is the original layout and 'solo' the cloud-locker one; anything else is not a scope. */
const SCOPES = ['mp', 'solo'] as const;

export interface SaveStorage {
  presignGet(key: string): Promise<string>;
  presignPut(key: string, contentLength: number): Promise<string>;
  objectSize?(key: string): Promise<number | undefined>;
}

export interface SavesDeps {
  dataDir: string;
  storage: SaveStorage | undefined;
  maxBytesPerAccount: number;
}

export type SavesResult =
  | { ok: true; body: unknown }
  | { ok: true; redirect: string }
  | { ok: false; status: number; error: string };

const bad = (status: number, error: string): SavesResult => ({ ok: false, status, error });

/**
 * A presigned URL the dashboard's browser can actually reach.
 *
 * The filesystem backend builds its URLs from [locker].publicBase, and with no domain set that
 * falls back to http://127.0.0.1:<port> — the address the SERVER hears itself on, inside a
 * container, on a port that is not published. A browser handed that gets nothing. The bytes are
 * really served by this same process at /locker/blob/..., behind the same proxy the dashboard
 * was loaded from, so the origin is not merely unnecessary here: it is the only wrong part.
 *
 * Stripped to a path, which the browser resolves against wherever it actually is. An S3 URL
 * points at a different host and is returned untouched — there the origin IS the answer.
 */
function browserUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/locker/blob/') ? `${u.pathname}${u.search}` : url;
  } catch {
    return url; // already relative
  }
}

const scopeOf = (v: string | null): 'mp' | 'solo' | undefined =>
  (SCOPES as readonly string[]).includes(v ?? '') ? (v as 'mp' | 'solo') : undefined;

/** What one account has, across both scopes, with the quota it counts against. */
export function listSaves(deps: SavesDeps, account: string): SavesResult {
  if (account === '') return bad(400, 'No account given.');
  const store = new SaveStore(deps.dataDir);
  const saves = SCOPES.flatMap((scope) =>
    store.list(account, scope).map((s) => ({ scope, ...s })));
  return {
    ok: true,
    body: {
      account,
      saves,
      usedBytes: store.used(account),
      quotaBytes: deps.maxBytesPerAccount,
      // Storage absent means the locker is switched off entirely, and there is nothing to
      // download even for saves the table still remembers. Say so rather than offering a
      // button that cannot work.
      storage: deps.storage !== undefined,
    },
  };
}

/**
 * A link to one save's bytes.
 *
 * Answered as a redirect to a presigned URL rather than proxied through this process: the
 * storage layer already mints capability URLs that expire, both backends implement it, and
 * streaming a file through the admin API to re-implement what presigning does would be a
 * second path to keep correct.
 */
export async function saveDownload(
  deps: SavesDeps,
  account: string,
  scopeRaw: string | null,
  name: string,
): Promise<SavesResult> {
  const scope = scopeOf(scopeRaw);
  if (account === '' || !scope) return bad(400, 'Which save?');
  if (!SAVE_NAME.test(name)) return bad(400, 'That is not a save name.');
  if (!deps.storage) return bad(503, 'File storage is not configured, so there is nothing to download.');

  // The TABLE is the authority on what exists, not the storage key: asking storage directly
  // would let a guessed name probe for objects this account does not own.
  const store = new SaveStore(deps.dataDir);
  if (!store.has(account, scope, name)) return bad(404, 'No such save.');

  const url = await deps.storage.presignGet(saveKey(account, scope, name));
  log('info', 'admin.save_downloaded', { account, scope, name });
  return { ok: true, redirect: browserUrl(url) };
}

/**
 * Where to PUT a save being imported, and the quota check that guards it.
 *
 * Two steps like the player's own upload, and for the same reason: the browser sends the bytes
 * straight to storage, so a multi-hundred-megabyte save never travels through this process.
 */
export function saveUploadUrl(
  deps: SavesDeps,
  account: string,
  scopeRaw: string | null,
  name: string,
  size: number,
): Promise<SavesResult> | SavesResult {
  const scope = scopeOf(scopeRaw);
  if (account === '' || !scope) return bad(400, 'Which save?');
  if (!SAVE_NAME.test(name)) {
    return bad(400, 'A save must be a .omwsave file, named as the game named it.');
  }
  if (!Number.isFinite(size) || size <= 0) return bad(400, 'That file is empty.');
  if (!deps.storage) return bad(503, 'File storage is not configured, so a save cannot be stored.');

  const store = new SaveStore(deps.dataDir);
  // Replacing an existing save should not be charged twice against the quota.
  const existing = store.list(account, scope).find((s) => s.name === name);
  const after = store.used(account) - (existing?.size ?? 0) + size;
  if (after > deps.maxBytesPerAccount) {
    return bad(409, 'That would put the account over its save storage limit.');
  }
  const key = saveKey(account, scope, name);
  return deps.storage.presignPut(key, size)
    .then((url) => ({ ok: true as const, body: { url: browserUrl(url), key } }));
}

/** Record a save that has landed. Verifies the bytes are really there before believing it. */
export async function saveUploaded(
  deps: SavesDeps,
  account: string,
  scopeRaw: string | null,
  name: string,
  size: number,
): Promise<SavesResult> {
  const scope = scopeOf(scopeRaw);
  if (account === '' || !scope) return bad(400, 'Which save?');
  if (!SAVE_NAME.test(name)) return bad(400, 'That is not a save name.');
  if (!deps.storage) return bad(503, 'File storage is not configured.');

  // TRUST THE BUCKET, NOT THE BROWSER. The declared size decided the quota check above; this
  // reads back what actually arrived, so a client that lied about the length cannot leave the
  // table describing an object that is a different size or is not there at all.
  let real = size;
  if (deps.storage.objectSize) {
    const got = await deps.storage.objectSize(saveKey(account, scope, name));
    if (got === undefined) return bad(400, 'That save did not arrive.');
    real = got;
  }
  new SaveStore(deps.dataDir).put(account, scope, { name, size: real, mtime: Date.now() });
  log('info', 'admin.save_imported', { account, scope, name, bytes: real });
  return { ok: true, body: { ok: true, name, size: real } };
}
