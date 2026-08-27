// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// TypeScript mirror of the engine's Lua-value serializer ("LSER"):
// openmw/components/lua/serialization.cpp, FORMAT_VERSION 0. Blob = version byte + one value;
// the empty blob is nil. Hardened per PROTOCOL.md: depth <= 16, nodes <= 65536, every length
// field bounded by the remaining buffer (the engine allows 32 nested tables; the server's
// tighter cap is the protocol contract).

export const LSER_FORMAT_VERSION = 0;
export const LSER_MAX_DEPTH = 16;
export const LSER_MAX_NODES = 65536;

// Single-byte tags < 0x20 (see SerializedType in serialization.cpp).
const T_NUMBER = 0x00; // f64 LE
const T_LONG_STRING = 0x01; // u32 LE length + bytes
const T_BOOLEAN = 0x02; // 1 byte, nonzero = true
const T_TABLE_START = 0x03; // (key value)* then TABLE_END
const T_TABLE_END = 0x04;
const T_VEC2 = 0x10; // 2 x f64 LE
const T_VEC3 = 0x11; // 3 x f64 LE
const T_TRANSFORM_M = 0x12; // 16 x f64 LE, row-major m(i,j)
const T_TRANSFORM_Q = 0x13; // 4 x f64 LE (x,y,z,w)
const T_VEC4 = 0x14; // 4 x f64 LE
const T_COLOR = 0x15; // 4 x f32 LE (r,g,b,a)
const SHORT_STRING_FLAG = 0x20; // 0b001SSSSS, SSSSS = byte length < 32
const CUSTOM_FULL_FLAG = 0x40; // 0b01TTTTTT + u32 dataSize; TTTTTT = typeName size - 1
const CUSTOM_COMPACT_FLAG = 0x80; // 0b1SSSSTTT; SSSS = dataSize < 16, TTT = typeName size - 1

// RefNum is the one custom userdata the engine's BasicSerializer registers:
// typeName "o", 8 bytes = u32 index LE + i32 contentFile LE.
const REFNUM_TYPENAME = 'o';

export type LserErrorCode =
  | 'BAD_VERSION'
  | 'TRUNCATED'
  | 'TRAILING'
  | 'DEPTH'
  | 'NODES'
  | 'BAD_TAG'
  | 'BAD_USERDATA'
  | 'UNSUPPORTED';

export class LserError extends Error {
  constructor(
    public readonly code: LserErrorCode,
    message: string,
  ) {
    super(`lser: ${message}`);
    this.name = 'LserError';
  }
}

export interface LRefNum {
  __refnum: { index: number; contentFile: number };
}
export interface LVec2 {
  __vec2: [number, number];
}
export interface LVec3 {
  __vec3: [number, number, number];
}
export interface LVec4 {
  __vec4: [number, number, number, number];
}
export interface LTransformM {
  __transformM: number[]; // 16 entries, row-major
}
export interface LTransformQ {
  __transformQ: [number, number, number, number];
}
export interface LColor {
  __color: [number, number, number, number];
}
export type LUserdata = LRefNum | LVec2 | LVec3 | LVec4 | LTransformM | LTransformQ | LColor;
// Map preserves key type (Lua distinguishes t[1] from t["1"]) and insertion order.
export type LTable = Map<LValue, LValue>;
export type LValue = number | string | boolean | LTable | LUserdata;

// ---------------------------------------------------------------- encode

class Writer {
  private chunks: Buffer[] = [];
  push(b: Buffer): void {
    this.chunks.push(b);
  }
  byte(v: number): void {
    this.chunks.push(Buffer.from([v & 0xff]));
  }
  f64(v: number): void {
    const b = Buffer.allocUnsafe(8);
    b.writeDoubleLE(v, 0);
    this.chunks.push(b);
  }
  f32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatLE(v, 0);
    this.chunks.push(b);
  }
  u32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.chunks.push(b);
  }
  i32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(v | 0, 0);
    this.chunks.push(b);
  }
  concat(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function encodeString(w: Writer, s: string): void {
  const bytes = Buffer.from(s, 'utf8');
  if (bytes.length < 32) {
    w.byte(SHORT_STRING_FLAG | bytes.length);
  } else {
    w.byte(T_LONG_STRING);
    w.u32(bytes.length);
  }
  w.push(bytes);
}

function encodeF64Seq(w: Writer, tag: number, values: readonly number[], count: number): void {
  if (values.length !== count) throw new LserError('UNSUPPORTED', `userdata needs ${count} components`);
  w.byte(tag);
  for (const v of values) w.f64(v);
}

function encodeValue(w: Writer, v: LValue, depth: number): void {
  switch (typeof v) {
    case 'number':
      w.byte(T_NUMBER);
      w.f64(v);
      return;
    case 'string':
      encodeString(w, v);
      return;
    case 'boolean':
      w.byte(T_BOOLEAN);
      w.byte(v ? 1 : 0);
      return;
    case 'object':
      break;
    default:
      throw new LserError('UNSUPPORTED', `cannot encode ${typeof v}`);
  }
  if (v instanceof Map) {
    if (depth >= LSER_MAX_DEPTH) throw new LserError('DEPTH', `more than ${LSER_MAX_DEPTH} nested tables`);
    w.byte(T_TABLE_START);
    for (const [key, value] of v) {
      encodeValue(w, key, depth + 1);
      encodeValue(w, value, depth + 1);
    }
    w.byte(T_TABLE_END);
    return;
  }
  if ('__refnum' in v) {
    // Compact custom form: dataSize 8, typeName length 1 -> 0b1_1000_000 = 0xC0.
    w.byte(CUSTOM_COMPACT_FLAG | (8 << 3) | (REFNUM_TYPENAME.length - 1));
    w.push(Buffer.from(REFNUM_TYPENAME, 'ascii'));
    w.u32(v.__refnum.index);
    w.i32(v.__refnum.contentFile);
    return;
  }
  if ('__vec2' in v) return encodeF64Seq(w, T_VEC2, v.__vec2, 2);
  if ('__vec3' in v) return encodeF64Seq(w, T_VEC3, v.__vec3, 3);
  if ('__vec4' in v) return encodeF64Seq(w, T_VEC4, v.__vec4, 4);
  if ('__transformM' in v) return encodeF64Seq(w, T_TRANSFORM_M, v.__transformM, 16);
  if ('__transformQ' in v) return encodeF64Seq(w, T_TRANSFORM_Q, v.__transformQ, 4);
  if ('__color' in v) {
    w.byte(T_COLOR);
    for (const c of v.__color) w.f32(c);
    return;
  }
  // NAME THE SHAPE. This threw with no clue what it was looking at, so 17 identical lines on the
  // dev server said only that something, somewhere, failed to encode. The keys are enough to
  // identify the payload immediately and cost nothing on a path that is about to throw anyway.
  throw new LserError('UNSUPPORTED',
    'cannot encode object (not a Map or known userdata wrapper); keys: '
      + JSON.stringify(Object.keys(v as object).slice(0, 12)));
}

// undefined encodes to the empty blob, mirroring the engine's nil handling.
export function lserEncode(value: LValue | undefined): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  const w = new Writer();
  w.byte(LSER_FORMAT_VERSION);
  encodeValue(w, value, 0);
  return w.concat();
}

// ---------------------------------------------------------------- decode

class Reader {
  off = 0;
  nodes = 0;
  constructor(private readonly buf: Buffer) {}
  get remaining(): number {
    return this.buf.length - this.off;
  }
  need(n: number): void {
    if (this.remaining < n) throw new LserError('TRUNCATED', 'unexpected end of serialized data');
  }
  byte(): number {
    this.need(1);
    return this.buf[this.off++]!;
  }
  peek(): number {
    this.need(1);
    return this.buf[this.off]!;
  }
  f64(): number {
    this.need(8);
    const v = this.buf.readDoubleLE(this.off);
    this.off += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.buf.readFloatLE(this.off);
    this.off += 4;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
}

function decodeUserdata(r: Reader, typeName: string, data: Buffer): LUserdata {
  if (typeName === REFNUM_TYPENAME) {
    if (data.length !== 8) throw new LserError('BAD_USERDATA', 'RefNum payload must be 8 bytes');
    return { __refnum: { index: data.readUInt32LE(0), contentFile: data.readInt32LE(4) } };
  }
  throw new LserError('BAD_USERDATA', `unknown userdata type "${typeName}"`);
}

function decodeValue(r: Reader, depth: number): LValue {
  if (++r.nodes > LSER_MAX_NODES) throw new LserError('NODES', `more than ${LSER_MAX_NODES} nodes`);
  const tag = r.byte();
  if (tag & (CUSTOM_COMPACT_FLAG | CUSTOM_FULL_FLAG)) {
    let typeNameSize: number, dataSize: number;
    if (tag & CUSTOM_COMPACT_FLAG) {
      typeNameSize = (tag & 7) + 1;
      dataSize = (tag >> 3) & 15;
    } else {
      typeNameSize = (tag & 63) + 1;
      dataSize = r.u32();
    }
    if (dataSize > r.remaining) throw new LserError('TRUNCATED', 'userdata length exceeds buffer');
    const typeName = r.bytes(typeNameSize).toString('latin1');
    const data = r.bytes(dataSize);
    return decodeUserdata(r, typeName, data);
  }
  if (tag & SHORT_STRING_FLAG) {
    return r.bytes(tag & 0x1f).toString('utf8');
  }
  switch (tag) {
    case T_NUMBER:
      return r.f64();
    case T_BOOLEAN:
      return r.byte() !== 0;
    case T_LONG_STRING: {
      const size = r.u32();
      if (size > r.remaining) throw new LserError('TRUNCATED', 'string length exceeds buffer');
      return r.bytes(size).toString('utf8');
    }
    case T_TABLE_START: {
      if (depth >= LSER_MAX_DEPTH) throw new LserError('DEPTH', `more than ${LSER_MAX_DEPTH} nested tables`);
      const table: LTable = new Map();
      while (r.peek() !== T_TABLE_END) {
        const key = decodeValue(r, depth + 1);
        const value = decodeValue(r, depth + 1);
        table.set(key, value);
      }
      r.byte(); // consume TABLE_END
      return table;
    }
    case T_TABLE_END:
      throw new LserError('BAD_TAG', 'unexpected end of table');
    case T_VEC2:
      return { __vec2: [r.f64(), r.f64()] };
    case T_VEC3:
      return { __vec3: [r.f64(), r.f64(), r.f64()] };
    case T_VEC4:
      return { __vec4: [r.f64(), r.f64(), r.f64(), r.f64()] };
    case T_TRANSFORM_M: {
      const m: number[] = [];
      for (let i = 0; i < 16; i++) m.push(r.f64());
      return { __transformM: m };
    }
    case T_TRANSFORM_Q:
      return { __transformQ: [r.f64(), r.f64(), r.f64(), r.f64()] };
    case T_COLOR:
      return { __color: [r.f32(), r.f32(), r.f32(), r.f32()] };
    default:
      throw new LserError('BAD_TAG', `unknown type tag 0x${tag.toString(16)}`);
  }
}

// The empty blob decodes to undefined (nil), mirroring the engine.
export function lserDecode(buf: Buffer): LValue | undefined {
  if (buf.length === 0) return undefined;
  if (buf[0] !== LSER_FORMAT_VERSION)
    throw new LserError('BAD_VERSION', `incorrect format version ${buf[0]}`);
  const r = new Reader(buf);
  r.off = 1;
  const value = decodeValue(r, 0);
  if (r.remaining !== 0) throw new LserError('TRAILING', 'unexpected data after serialized object');
  return value;
}

// ------------------------------------------------- JS-shape conveniences

// Server-built event bodies are plain-table shaped; these helpers convert between
// LValue and idiomatic JS. Arrays become 1-based integer-keyed tables (Lua convention),
// plain objects become string-keyed tables; null/undefined object values are omitted (nil).
export type JsLike =
  | number
  | string
  | boolean
  | null
  | undefined
  | JsLike[]
  | { [key: string]: JsLike }
  | LValue;

export function jsToL(v: JsLike): LValue {
  if (v === null || v === undefined) throw new LserError('UNSUPPORTED', 'nil is not a value (omit the key)');
  if (typeof v !== 'object') return v;
  if (v instanceof Map) return v;
  if (Array.isArray(v)) {
    const t: LTable = new Map();
    v.forEach((item, i) => t.set(i + 1, jsToL(item)));
    return t;
  }
  const keys = Object.keys(v);
  // THE __kv ROUND TRIP. lToJs renders a table whose keys are neither 1..n nor all-string as
  // `{__kv: [[k, v], ...]}`, and this function used to wave anything with a `__` key through as
  // a userdata wrapper -- so the encoder, which knows only __refnum/__vec/__transform/__color,
  // reached the end of its list and threw "cannot encode object". Any relayed payload holding a
  // mixed-key table therefore failed to encode and the whole world op was lost.
  //
  // It surfaces as silence rather than an error to the player: the op is dropped, the message
  // never reaches the cell owner, and whatever it carried simply does not happen. Seen live as
  // repeated `world.op_failed` on the dev server.
  //
  // lToJs and jsToL have to be inverses. Reconstructing the Map here makes them so.
  if (Array.isArray((v as { __kv?: unknown }).__kv)) {
    const t: LTable = new Map();
    for (const pair of (v as unknown as { __kv: [JsLike, JsLike][] }).__kv) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [k, item] = pair;
      if (item === null || item === undefined) continue; // nil -> absent key, as below
      t.set(jsToL(k) as string | number, jsToL(item));
    }
    return t;
  }
  if (keys.some((k) => k.startsWith('__'))) return v as LUserdata; // userdata wrapper passes through
  const t: LTable = new Map();
  for (const k of keys) {
    const item = (v as { [key: string]: JsLike })[k];
    if (item === null || item === undefined) continue; // nil -> absent key
    t.set(k, jsToL(item));
  }
  return t;
}

// Canonical JSON-able form (used by lser-dump and test fixtures):
// tables with keys exactly 1..n (in order) -> array; all-string keys -> object;
// anything else -> {"__kv": [[key, value], ...]}. Userdata wrappers pass through.
export function lToJs(v: LValue | undefined): unknown {
  if (v === undefined) return null;
  if (!(v instanceof Map)) return v;
  const entries = [...v.entries()];
  if (entries.every(([k], i) => k === i + 1)) return entries.map(([, val]) => lToJs(val));
  if (entries.every(([k]) => typeof k === 'string')) {
    const obj: { [key: string]: unknown } = {};
    for (const [k, val] of entries) obj[k as string] = lToJs(val);
    return obj;
  }
  return { __kv: entries.map(([k, val]) => [lToJs(k), lToJs(val)]) };
}
