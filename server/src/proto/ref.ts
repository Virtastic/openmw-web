// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M3 object addressing (PROTOCOL.md §M3): tagged union {ref=<RefNum userdata>} for
// content-file objects | {net=<number>} for server-spawned ones. Canonical string form
// for doc maps and comparisons: "c:<index>:<contentFile>" / "n:<netId>".

import type { LTable, LValue, LRefNum, JsLike } from './lser';

export type ObjRef =
  | { kind: 'ref'; index: number; contentFile: number; key: string }
  | { kind: 'net'; netId: number; key: string };

export function contentRefKey(index: number, contentFile: number): string {
  return `c:${index}:${contentFile}`;
}

export function netRefKey(netId: number): string {
  return `n:${netId}`;
}

function isRefNum(v: LValue | undefined): v is LRefNum {
  return typeof v === 'object' && v !== null && !(v instanceof Map) && '__refnum' in v;
}

// Extracts the union from an event body table; null when absent/malformed/both-present.
export function parseObjRef(body: LTable): ObjRef | null {
  const ref = body.get('ref');
  const net = body.get('net');
  if (isRefNum(ref) && net === undefined) {
    const { index, contentFile } = ref.__refnum;
    return { kind: 'ref', index, contentFile, key: contentRefKey(index, contentFile) };
  }
  if (typeof net === 'number' && Number.isInteger(net) && net >= 1 && net <= 0xffffffff && ref === undefined) {
    return { kind: 'net', netId: net, key: netRefKey(net) };
  }
  return null;
}

// Re-encode the union for relayed/synthesized bodies — symmetric with what arrived
// (content refs travel as RefNum userdata again, never as strings).
export function objRefToJs(ref: ObjRef): Record<string, JsLike> {
  return ref.kind === 'ref'
    ? { ref: { __refnum: { index: ref.index, contentFile: ref.contentFile } } }
    : { net: ref.netId };
}

// Doc-side inverse of refKey for WorldCellState container/lock/door maps (keys stay
// strings in the doc; the wire uses them as plain table keys).
export function parseRefKey(key: string): ObjRef | null {
  const c = /^c:(-?\d+):(-?\d+)$/.exec(key);
  if (c) return { kind: 'ref', index: Number(c[1]), contentFile: Number(c[2]), key };
  const n = /^n:(\d+)$/.exec(key);
  if (n) return { kind: 'net', netId: Number(n[1]), key };
  return null;
}
