// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Golden-vector capture for the omw-mp server's LSER codec tests.
//
// The engine (scripts/mp/global.lua, &mpvectors=1) prints one line per canonical value:
//   MPVECTOR:<name>:<base64 of LuaUtil::serialize output>
// Pipe any log containing those lines (e.g. smoke.mjs output) into this script; it writes
// <name>.bin (raw LSER blob) + <name>.json (expected lToJs form, authored here independently
// of the server codec so the test is not circular) into the target directory.
//
// Usage:
//   node wasm-build/smoke.mjs "http://localhost:8910/index.html?nomw&skipintro=1&start=Village\
//     &mp=ws%3A%2F%2Flocalhost%3A9911%2Fws&mpauto=1&mpuser=vecdump&mpvectors=1" 90 vectors \
//     | node wasm-build/mp-vectors.mjs server/test/vectors
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: ... | node wasm-build/mp-vectors.mjs <outDir>');
  process.exit(2);
}

// Expected lToJs forms, kept in lockstep with the value list in scripts/mp/global.lua.
// NOTE: raw JSON text so -0.0 survives (JSON.stringify would collapse it to 0).
const expected = {
  bool_true: 'true',
  bool_false: 'false',
  num_zero: '0',
  num_negzero: '-0.0',
  num_neghalf: '-0.5',
  num_int: '42',
  num_bigint: '4503599627370496',
  num_huge: '1e300',
  str_empty: '""',
  str_short: '"hello"',
  str_31: JSON.stringify('a'.repeat(31)),
  str_32: JSON.stringify('b'.repeat(32)),
  str_255: JSON.stringify('c'.repeat(255)),
  str_unicode: JSON.stringify('héllo wörld — ✓ 日本語'),
  table_empty: '[]', // empty Lua table decodes to an empty map -> lToJs []
  table_flat: JSON.stringify({ a: 1, b: 'two', c: true }),
  table_nested: JSON.stringify({ outer: { inner: { deep: 'value', n: 3 } } }),
  table_array: JSON.stringify([10, 20, 30]),
  // table_mixed is deliberately NOT captured: its lToJs __kv form is entry-order-sensitive
  // (Lua pairs() order), which would make the fixture flaky.
  vec3: JSON.stringify({ __vec3: [1.5, -2.5, 3.25] }),
};

mkdirSync(outDir, { recursive: true });
const seen = new Set();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = /MPVECTOR:([A-Za-z0-9_]+):([A-Za-z0-9+/=]+)/.exec(line);
  if (!m || seen.has(m[1])) return;
  seen.add(m[1]);
  if (!(m[1] in expected)) {
    console.error(`skip ${m[1]} (no expected form authored)`);
    return;
  }
  writeFileSync(`${outDir}/${m[1]}.bin`, Buffer.from(m[2], 'base64'));
  writeFileSync(`${outDir}/${m[1]}.json`, expected[m[1]] + '\n');
  console.error(`wrote ${m[1]}.bin/.json`);
});
rl.on('close', () => {
  const missing = Object.keys(expected).filter((k) => !seen.has(k));
  if (missing.length) console.error('MISSING vectors: ' + missing.join(', '));
  console.error(`captured ${seen.size} vectors -> ${outDir}`);
  process.exit(missing.length ? 1 : 0);
});
