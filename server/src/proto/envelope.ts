// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Binary-frame envelope per PROTOCOL.md: [u16 type LE][u32 seq LE][payload].
// Event (0x0002) payload: [u8 nameLen][name ASCII][body: LSER blob].

export const MSG_EVENT = 0x0002;
// Reserved for later milestones; listed so the router can drop them knowingly.
export const MSG_PLAYER_MOVE = 0x0100; // M1
export const MSG_PLAYER_MOVE_BATCH = 0x0101; // M1
export const MSG_ACTOR_MOVE_BATCH = 0x0200; // M4

export class ProtoError extends Error {
  constructor(message: string) {
    super(`proto: ${message}`);
    this.name = 'ProtoError';
  }
}

export interface Envelope {
  type: number;
  seq: number;
  payload: Buffer;
}

export function packEnvelope(type: number, seq: number, payload: Buffer): Buffer {
  const head = Buffer.allocUnsafe(6);
  head.writeUInt16LE(type, 0);
  head.writeUInt32LE(seq >>> 0, 2);
  return Buffer.concat([head, payload]);
}

export function unpackEnvelope(buf: Buffer): Envelope {
  if (buf.length < 6) throw new ProtoError('frame shorter than 6-byte header');
  return { type: buf.readUInt16LE(0), seq: buf.readUInt32LE(2), payload: buf.subarray(6) };
}

const EVENT_NAME_RE = /^[A-Za-z0-9_]+$/;

export function packEvent(seq: number, name: string, body: Buffer): Buffer {
  if (!EVENT_NAME_RE.test(name) || name.length > 255) throw new ProtoError(`bad event name "${name}"`);
  const nameBuf = Buffer.from(name, 'ascii');
  return packEnvelope(MSG_EVENT, seq, Buffer.concat([Buffer.from([nameBuf.length]), nameBuf, body]));
}

export function unpackEvent(payload: Buffer): { name: string; body: Buffer } {
  if (payload.length < 1) throw new ProtoError('event payload missing nameLen');
  const nameLen = payload[0]!;
  if (nameLen === 0 || 1 + nameLen > payload.length) throw new ProtoError('event nameLen exceeds payload');
  const name = payload.subarray(1, 1 + nameLen).toString('ascii');
  if (!EVENT_NAME_RE.test(name)) throw new ProtoError('event name has invalid characters');
  return { name, body: payload.subarray(1 + nameLen) };
}
