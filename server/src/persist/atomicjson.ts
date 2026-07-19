// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Atomic JSON persistence: write tmp sibling, fsync, rename over the target.
// Readers never observe a torn file; a crash leaves either old or new content.

import { open, rename, readFile } from 'node:fs/promises';

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

// Returns undefined when the file does not exist; malformed JSON throws.
export async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text) as T;
}
