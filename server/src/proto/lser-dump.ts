// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// LSER blob -> JSON pretty printer. CLI: npm run lser-dump -- <file>
// Form: 1..n integer-keyed tables print as arrays, string-keyed as objects, mixed as
// {"__kv":[[k,v],...]}; userdata as {"__refnum":...} etc. Empty blob prints null (nil).

import { readFileSync } from 'node:fs';
import { lserDecode, lToJs } from './lser';

export function lserDumpJson(blob: Buffer): string {
  return JSON.stringify(lToJs(lserDecode(blob)), null, 2);
}

// tsx runs this file directly for the npm script; guard so importing it stays side-effect free.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: lser-dump <file.bin>');
    process.exit(2);
  }
  console.log(lserDumpJson(readFileSync(file)));
}
