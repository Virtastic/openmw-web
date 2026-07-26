// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M1 movement tier per PROTOCOL.md: PlayerMove (0x0100, C->S, 20-byte payload) and
// PlayerMoveBatch (0x0101, S->C, u8 count + count x (u16 playerId + 20-byte payload)).
// All little-endian. Quantization helpers mirror what the client transport does.

import { ProtoError } from './envelope';

export const MOVE_PAYLOAD_BYTES = 20;

export interface PlayerPose {
  x: number; // f32 world units
  y: number;
  z: number;
  yaw: number; // u16, 0..65535 = 0..2pi (wraps)
  pitch: number; // u8, 0..255 = -pi/2..+pi/2
  flags: number; // u8: bit0 run, bit1 sneak, bit2 jump-edge, bit3 inAir, bit4 weaponDrawn, bit5 spellReady
  animVel: number; // u8, 0..255 = 0..2x base walk speed
  counter: number; // u8, reserved 0 in M1
}

// ------------------------------------------------------------- quantization

const TWO_PI = Math.PI * 2;

// Radians -> u16 with wrap (2pi = 0).
export function quantYaw(rad: number): number {
  const norm = ((rad % TWO_PI) + TWO_PI) % TWO_PI;
  return Math.round((norm / TWO_PI) * 65536) & 0xffff;
}

export function unquantYaw(q: number): number {
  return ((q & 0xffff) / 65536) * TWO_PI;
}

// Radians clamped to [-pi/2, +pi/2] -> u8.
export function quantPitch(rad: number): number {
  const clamped = Math.min(Math.PI / 2, Math.max(-Math.PI / 2, rad));
  return Math.min(255, Math.round(((clamped + Math.PI / 2) / Math.PI) * 255));
}

export function unquantPitch(q: number): number {
  return ((q & 0xff) / 255) * Math.PI - Math.PI / 2;
}

// Speed ratio (1.0 = base walk speed) clamped to [0, 2] -> u8.
export function quantAnimVel(ratio: number): number {
  const clamped = Math.min(2, Math.max(0, ratio));
  return Math.min(255, Math.round((clamped / 2) * 255));
}

export function unquantAnimVel(q: number): number {
  return ((q & 0xff) / 255) * 2;
}

// ------------------------------------------------------------------- codec

// Writes a pose in place. Batch packers MUST use this rather than packMove().copy():
// at 64 co-located players the batch path moves ~60k poses/s, and a throwaway 20-byte
// Buffer plus a memcpy per pose was pure garbage-collector load for bytes we were
// already holding a destination for.
export function writeMove(pose: PlayerPose, b: Buffer, off: number): void {
  b.writeFloatLE(pose.x, off);
  b.writeFloatLE(pose.y, off + 4);
  b.writeFloatLE(pose.z, off + 8);
  b.writeUInt16LE(pose.yaw & 0xffff, off + 12);
  b.writeUInt8(pose.pitch & 0xff, off + 14);
  b.writeUInt8(pose.flags & 0xff, off + 15);
  b.writeUInt8(pose.animVel & 0xff, off + 16);
  b.writeUInt8(pose.counter & 0xff, off + 17);
  b.writeUInt16LE(0, off + 18); // padding to the specced 20 bytes (reserved, zero)
}

export function packMove(pose: PlayerPose): Buffer {
  const b = Buffer.allocUnsafe(MOVE_PAYLOAD_BYTES);
  writeMove(pose, b, 0);
  return b;
}

export function unpackMove(payload: Buffer): PlayerPose {
  if (payload.length !== MOVE_PAYLOAD_BYTES)
    throw new ProtoError(`PlayerMove payload must be ${MOVE_PAYLOAD_BYTES} bytes, got ${payload.length}`);
  return {
    x: payload.readFloatLE(0),
    y: payload.readFloatLE(4),
    z: payload.readFloatLE(8),
    yaw: payload.readUInt16LE(12),
    pitch: payload.readUInt8(14),
    flags: payload.readUInt8(15),
    animVel: payload.readUInt8(16),
    counter: payload.readUInt8(17),
  };
}

export interface BatchEntry {
  id: number; // u16 playerId
  pose: PlayerPose;
}

export function packMoveBatch(entries: BatchEntry[]): Buffer {
  if (entries.length > 255) throw new ProtoError('PlayerMoveBatch count exceeds u8');
  const b = Buffer.allocUnsafe(1 + entries.length * (2 + MOVE_PAYLOAD_BYTES));
  b.writeUInt8(entries.length, 0);
  let off = 1;
  for (const e of entries) {
    b.writeUInt16LE(e.id & 0xffff, off);
    writeMove(e.pose, b, off + 2);
    off += 2 + MOVE_PAYLOAD_BYTES;
  }
  return b;
}

export function unpackMoveBatch(payload: Buffer): BatchEntry[] {
  if (payload.length < 1) throw new ProtoError('PlayerMoveBatch payload missing count');
  const count = payload.readUInt8(0);
  if (payload.length !== 1 + count * (2 + MOVE_PAYLOAD_BYTES))
    throw new ProtoError('PlayerMoveBatch payload size does not match count');
  const entries: BatchEntry[] = [];
  let off = 1;
  for (let i = 0; i < count; i++) {
    const id = payload.readUInt16LE(off);
    entries.push({ id, pose: unpackMove(payload.subarray(off + 2, off + 2 + MOVE_PAYLOAD_BYTES)) });
    off += 2 + MOVE_PAYLOAD_BYTES;
  }
  return entries;
}

// M4 ActorMoveBatch (0x0200): [u32 epoch][u8 count] + count × (8-byte ref + 20-byte pose).
// The 8-byte ref is a raw RefNum (u32 index LE + i32 contentFile LE), same layout as the
// LSER "o" userdata payload — actors are content-file objects.
export const ACTOR_REF_BYTES = 8;

export interface ActorRef {
  index: number;
  contentFile: number;
}

export interface ActorEntry {
  ref: ActorRef;
  pose: PlayerPose;
}

export interface ActorMoveBatch {
  epoch: number;
  entries: ActorEntry[];
}

const ACTOR_ENTRY_BYTES = ACTOR_REF_BYTES + MOVE_PAYLOAD_BYTES;

export function packActorMoveBatch(epoch: number, entries: ActorEntry[]): Buffer {
  if (entries.length > 255) throw new ProtoError('ActorMoveBatch count exceeds u8');
  const b = Buffer.allocUnsafe(5 + entries.length * ACTOR_ENTRY_BYTES);
  b.writeUInt32LE(epoch >>> 0, 0);
  b.writeUInt8(entries.length, 4);
  let off = 5;
  for (const e of entries) {
    b.writeUInt32LE(e.ref.index >>> 0, off);
    b.writeInt32LE(e.ref.contentFile | 0, off + 4);
    writeMove(e.pose, b, off + ACTOR_REF_BYTES);
    off += ACTOR_ENTRY_BYTES;
  }
  return b;
}

export function unpackActorMoveBatch(payload: Buffer): ActorMoveBatch {
  if (payload.length < 5) throw new ProtoError('ActorMoveBatch payload shorter than header');
  const epoch = payload.readUInt32LE(0);
  const count = payload.readUInt8(4);
  if (payload.length !== 5 + count * ACTOR_ENTRY_BYTES)
    throw new ProtoError('ActorMoveBatch payload size does not match count');
  const entries: ActorEntry[] = [];
  let off = 5;
  for (let i = 0; i < count; i++) {
    entries.push({
      ref: { index: payload.readUInt32LE(off), contentFile: payload.readInt32LE(off + 4) },
      pose: unpackMove(payload.subarray(off + ACTOR_REF_BYTES, off + ACTOR_ENTRY_BYTES)),
    });
    off += ACTOR_ENTRY_BYTES;
  }
  return { epoch, entries };
}
