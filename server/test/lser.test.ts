// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// LSER codec: round-trips, adversarial inputs, and engine-produced fixture vectors
// (test/vectors/*.bin + *.json — skipped with a note until the engine emits them).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lserEncode,
  lserDecode,
  lToJs,
  jsToL,
  LserError,
  type LValue,
  type LTable,
} from '../src/proto/lser';

function roundtrip(v: LValue): LValue | undefined {
  return lserDecode(lserEncode(v));
}

test('lser round-trips scalars', () => {
  assert.equal(roundtrip(0), 0);
  assert.equal(roundtrip(-1.5), -1.5);
  assert.equal(roundtrip(1e300), 1e300);
  assert.equal(roundtrip(-0.000001), -0.000001);
  assert.equal(roundtrip(true), true);
  assert.equal(roundtrip(false), false);
  assert.equal(roundtrip(''), '');
  assert.equal(roundtrip('hello'), 'hello');
  assert.equal(roundtrip('Балмора — Хлаалу'), 'Балмора — Хлаалу'); // unicode, long-string path
  assert.equal(roundtrip('灰'), '灰'); // multi-byte short string
  assert.equal(roundtrip('x'.repeat(31)), 'x'.repeat(31)); // short-string boundary
  assert.equal(roundtrip('x'.repeat(32)), 'x'.repeat(32)); // long-string boundary
  assert.equal(lserDecode(Buffer.alloc(0)), undefined); // empty blob = nil
});

test('lser short/long string encoding boundary is byte length', () => {
  // 16 two-byte chars = 32 bytes -> must take the LONG_STRING path.
  const s = 'ы'.repeat(16);
  const blob = lserEncode(s);
  assert.equal(blob[1], 0x01); // T_LONG_STRING
  assert.equal(roundtrip(s), s);
});

test('lser round-trips tables (nested, number-and-string keys, empty)', () => {
  const empty: LTable = new Map();
  assert.deepEqual(roundtrip(empty), empty);

  const t: LTable = new Map<LValue, LValue>([
    ['name', 'Alice'],
    [1, 'first'],
    ['1', 'string-one'], // distinct from numeric 1
    [2.5, true],
    ['nested', new Map<LValue, LValue>([['deep', new Map<LValue, LValue>([[1, -42]])]])],
  ]);
  const back = roundtrip(t) as LTable;
  assert.equal(back.get('name'), 'Alice');
  assert.equal(back.get(1), 'first');
  assert.equal(back.get('1'), 'string-one');
  assert.equal(back.get(2.5), true);
  const nested = back.get('nested') as LTable;
  assert.equal((nested.get('deep') as LTable).get(1), -42);
});

test('lser round-trips userdata (refnum, vectors, color)', () => {
  const refnum = { __refnum: { index: 0xdeadbeef, contentFile: -1 } };
  assert.deepEqual(roundtrip(refnum), refnum);
  assert.deepEqual(roundtrip({ __vec2: [1.5, -2.5] }), { __vec2: [1.5, -2.5] });
  assert.deepEqual(roundtrip({ __vec3: [1, 2, 3] }), { __vec3: [1, 2, 3] });
  assert.deepEqual(roundtrip({ __vec4: [1, 2, 3, 4] }), { __vec4: [1, 2, 3, 4] });
  assert.deepEqual(roundtrip({ __transformQ: [0, 0, 0, 1] }), { __transformQ: [0, 0, 0, 1] });
  const m = { __transformM: Array.from({ length: 16 }, (_, i) => i * 0.5) };
  assert.deepEqual(roundtrip(m), m);
  assert.deepEqual(roundtrip({ __color: [1, 0.5, 0, 1] }), { __color: [1, 0.5, 0, 1] });
});

test('lser refnum wire layout matches the engine (compact custom form)', () => {
  const blob = lserEncode({ __refnum: { index: 5, contentFile: 2 } });
  // version, 0b1_1000_000 (dataSize 8, typeName len 1), "o", u32 index LE, i32 contentFile LE
  assert.deepEqual(
    [...blob],
    [0x00, 0xc0, 0x6f, 0x05, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00],
  );
});

test('lser rejects every truncation of a valid blob', () => {
  const t: LTable = new Map<LValue, LValue>([
    ['k', 'a longer string that takes the LONG_STRING path'.repeat(2)],
    [1, new Map<LValue, LValue>([[true, { __refnum: { index: 1, contentFile: 0 } }]])],
    [2, 3.14159],
  ]);
  const blob = lserEncode(t);
  for (let i = 1; i < blob.length; i++) {
    assert.throws(() => lserDecode(blob.subarray(0, i)), LserError, `truncated at ${i}`);
  }
});

test('lser rejects bad version, trailing data, and stray table end', () => {
  assert.throws(() => lserDecode(Buffer.from([0x07, 0x02, 0x01])), (e: unknown) => (e as LserError).code === 'BAD_VERSION');
  const withTrailing = Buffer.concat([lserEncode(true), Buffer.from([0x00])]);
  assert.throws(() => lserDecode(withTrailing), (e: unknown) => (e as LserError).code === 'TRAILING');
  assert.throws(() => lserDecode(Buffer.from([0x00, 0x04])), (e: unknown) => (e as LserError).code === 'BAD_TAG');
});

test('lser rejects a depth bomb', () => {
  // version + 20 nested TABLE_STARTs (as values of key 1) blows the 16 cap.
  const parts: number[] = [0x00];
  for (let i = 0; i < 20; i++) parts.push(0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f); // TABLE_START, key=1.0
  assert.throws(() => lserDecode(Buffer.from(parts)), (e: unknown) => (e as LserError).code === 'DEPTH');

  // Encoder enforces the same cap.
  let nested: LValue = new Map();
  for (let i = 0; i < 20; i++) nested = new Map<LValue, LValue>([[1, nested]]);
  assert.throws(() => lserEncode(nested), (e: unknown) => (e as LserError).code === 'DEPTH');
});

test('lser rejects huge length fields and node bombs', () => {
  // LONG_STRING claiming 4 GiB.
  const huge = Buffer.from([0x00, 0x01, 0xff, 0xff, 0xff, 0xff, 0x61]);
  assert.throws(() => lserDecode(huge), (e: unknown) => (e as LserError).code === 'TRUNCATED');
  // Custom full form claiming a huge payload.
  const hugeCustom = Buffer.from([0x00, 0x40, 0xff, 0xff, 0xff, 0x7f, 0x6f]);
  assert.throws(() => lserDecode(hugeCustom), (e: unknown) => (e as LserError).code === 'TRUNCATED');
  // Node bomb: one table with 40k boolean pairs = >65536 decoded nodes.
  const pair = Buffer.from([0x02, 0x01, 0x02, 0x01]); // key=true, value=true
  const bomb = Buffer.concat([Buffer.from([0x00, 0x03]), ...Array(40000).fill(pair), Buffer.from([0x04])]);
  assert.throws(() => lserDecode(bomb), (e: unknown) => (e as LserError).code === 'NODES');
});

test('lser rejects unknown userdata and unknown tags', () => {
  // Compact custom, typeName "z", 0 bytes payload.
  const unknownUd = Buffer.from([0x00, 0x80, 0x7a]);
  assert.throws(() => lserDecode(unknownUd), (e: unknown) => (e as LserError).code === 'BAD_USERDATA');
  assert.throws(() => lserDecode(Buffer.from([0x00, 0x1f])), (e: unknown) => (e as LserError).code === 'BAD_TAG');
});

test('jsToL/lToJs conveniences preserve shape', () => {
  const body = jsToL({ players: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], nilKey: null });
  const back = lserDecode(lserEncode(body)) as LTable;
  assert.equal(back.has('nilKey'), false); // null -> absent (Lua nil)
  const js = lToJs(back) as { players: { id: number; name: string }[] };
  assert.deepEqual(js.players, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
});

test('lser fixture vectors from the engine', (t) => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'vectors');
  const bins = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.bin')) : [];
  if (bins.length === 0) {
    t.skip('no engine vectors yet — drop *.bin + *.json into test/vectors/');
    return;
  }
  for (const bin of bins) {
    const blob = readFileSync(join(dir, bin));
    const expected = JSON.parse(readFileSync(join(dir, bin.replace(/\.bin$/, '.json')), 'utf8'));
    assert.deepEqual(lToJs(lserDecode(blob)), expected, bin);
  }
});
