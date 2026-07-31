// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// test-loadorder.mjs — checks buildLoadOrder() in play/index.html.
//
// Why this one function gets a test: it decides the content= / fallback-archive= lines in
// openmw.cfg, and naming a file the VFS doesn't have is a HARD startup failure, not a warning.
// It is shared by BOTH data paths (the launcher's picked folder and a server-hosted mwdata/),
// so a mistake here breaks both at once — and getting it wrong is exactly what shipped the
// "the zip needs more files than the website" bug: the server-hosted path used to hardcode
// content=Tribunal.esm, so a base-game-only copy could not boot at all.
//
// The function is EXTRACTED FROM index.html rather than duplicated here, so this can't drift
// from the code it claims to test.
//
// Run: node wasm-build/test-loadorder.mjs      (exit 0 = pass; no deps, no framework)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'play/index.html'), 'utf8');

const start = src.indexOf('function buildLoadOrder(rootFiles){');
if (start < 0) { console.error('buildLoadOrder() not found in play/index.html'); process.exit(1); }
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i; break; }
}
const body = src.slice(start, end + 1);

let search = '';
// buildLoadOrder only touches append() and location.search; stub both.
const buildLoadOrder = new Function('append', 'location',
  body + '; return buildLoadOrder;')(() => {}, { get search() { return search; } });

// rootFiles maps lowercased name -> real on-disk name (what both callers build).
const mk = names => new Map(names.map(n => [n.toLowerCase(), n]));

let failed = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { console.log(`  ok   ${label}`); return; }
  failed++;
  console.log(`  FAIL ${label}\n         got  ${a}\n         want ${b}`);
};

// The regression that started this: base game only must not be handed the expansions.
check('base game only', buildLoadOrder(mk(['Morrowind.esm', 'Morrowind.bsa'])),
  { content: ['Morrowind.esm'], fbarch: ['Morrowind.bsa'] });

// Canonical order, regardless of the order the files were discovered in.
check('full GOTY, discovery order ignored',
  buildLoadOrder(mk(['Bloodmoon.bsa', 'Morrowind.esm', 'Tribunal.esm', 'Morrowind.bsa', 'Bloodmoon.esm', 'Tribunal.bsa'])),
  { content: ['Morrowind.esm', 'Tribunal.esm', 'Bloodmoon.esm'],
    fbarch: ['Morrowind.bsa', 'Tribunal.bsa', 'Bloodmoon.bsa'] });

// Mods: official first, then .esm masters, then .esp plugins, each alphabetical.
check('mods after official, esm before esp, alphabetical',
  buildLoadOrder(mk(['Morrowind.esm', 'Morrowind.bsa', 'zMod.esp', 'aMod.esp', 'bMaster.esm', 'Cool.bsa'])),
  { content: ['Morrowind.esm', 'bMaster.esm', 'aMod.esp', 'zMod.esp'],
    fbarch: ['Morrowind.bsa', 'Cool.bsa'] });

search = '?nomods=1';
check('?nomods=1 plays vanilla',
  buildLoadOrder(mk(['Morrowind.esm', 'Morrowind.bsa', 'aMod.esp', 'Cool.bsa'])),
  { content: ['Morrowind.esm'], fbarch: ['Morrowind.bsa'] });
search = '';

// Matching is case-insensitive, but the cfg must name the file as it exists on disk.
check('preserves on-disk casing', buildLoadOrder(mk(['MORROWIND.ESM', 'Morrowind.BSA'])),
  { content: ['MORROWIND.ESM'], fbarch: ['Morrowind.BSA'] });

// A stray expansion archive with no master: register it, but emit no content line for it.
check('archive without its master', buildLoadOrder(mk(['Morrowind.esm', 'Morrowind.bsa', 'Tribunal.bsa'])),
  { content: ['Morrowind.esm'], fbarch: ['Morrowind.bsa', 'Tribunal.bsa'] });

// Nothing usable at all — callers surface this rather than booting into a broken cfg.
check('empty folder yields nothing', buildLoadOrder(new Map()), { content: [], fbarch: [] });

console.log(failed ? `\n  ${failed} FAILED` : '\n  all passed');
process.exit(failed ? 1 : 0);
