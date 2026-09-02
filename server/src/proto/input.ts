// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3 input tier: the server (via the sim peer) becomes authoritative over the player's
// own movement. Three binary types, beside — not replacing — the M1 movement tier, so the
// client-authored path remains the DEGRADED MODE whenever no peer holds the world.
//
//   0x0102 PlayerInput      C->S, ~30 Hz. The player's raw intent, mapping 1:1 onto the
//                           engine's ActorControls (movement/side axes, yaw/pitch, run/
//                           sneak/jump, attack type) so avatar.lua consumes it with no
//                           translation layer. Server->peer it is forwarded with a u16
//                           player id prefix; a client never receives this type.
//   0x0105 AvatarMoveBatch  peer->S. The authoritative result: one pose per avatar the
//                           peer simulated this frame, each stamped with the LAST INPUT
//                           SEQUENCE CONSUMED for that avatar — the number reconciliation
//                           hangs off.
//   0x0103 PlayerStateBatch S->C, the existing 66 ms tick + M9 LOD tiers. Authoritative
//                           pose + lastInputSeq per player. The local player reconciles
//                           against its OWN entry via mp.correctSelf; remote players keep
//                           rendering from PlayerMoveBatch-shaped poses.
//
// AUTHENTICATION IS CONNECTION IDENTITY, deliberately not holder/epoch: this connection
// owns exactly one avatar, so a PlayerInput frame can only ever steer its own. That is a
// different question from ActorMoveBatch's "may you author THIS CELL's actors" — do not
// conflate them. What they share is the outcome: a frame that fails is dropped, counted,
// and relayed to nobody.

import { ProtoError } from './envelope';
import { MOVE_PAYLOAD_BYTES, writeMove, unpackMove, type PlayerPose } from './movement';

export const MSG_PLAYER_INPUT = 0x0102; // C->S (and S->peer with id prefix)
export const MSG_PLAYER_STATE_BATCH = 0x0103; // S->C
export const MSG_AVATAR_MOVE_BATCH = 0x0105; // peer->S

export const INPUT_PAYLOAD_BYTES = 12;

// Input flag bits. Attack type rides bits 4-5 (NoAttack/Chop/Slash/Thrust), mirroring
// MWMechanics::AttackType so the Lua side is a cast, not a mapping.
export const INPUT_RUN = 1 << 0;
export const INPUT_SNEAK = 1 << 1;
export const INPUT_JUMP = 1 << 2; // edge: pressed this frame
export const INPUT_USE = 1 << 3; // attack/use held

export interface PlayerInput {
  seq: number; // u32, client-monotonic; echoed back as lastInputSeq
  move: number; // i8 quantized -1..1 (forward/back)
  side: number; // i8 quantized -1..1 (strafe)
  yaw: number; // u16 quantized, same scale as PlayerPose.yaw
  pitch: number; // u8 quantized, same scale as PlayerPose.pitch
  flags: number; // u8, INPUT_* bits + attack type in bits 4-5
}

const quantAxis = (v: number): number => Math.max(-127, Math.min(127, Math.round(v * 127)));
export const unquantAxis = (q: number): number => Math.max(-1, Math.min(1, q / 127));

export function packInput(input: PlayerInput): Buffer {
  const b = Buffer.allocUnsafe(INPUT_PAYLOAD_BYTES);
  b.writeUInt32LE(input.seq >>> 0, 0);
  b.writeInt8(quantAxis(input.move), 4);
  b.writeInt8(quantAxis(input.side), 5);
  b.writeUInt16LE(input.yaw & 0xffff, 6);
  b.writeUInt8(input.pitch & 0xff, 8);
  b.writeUInt8(input.flags & 0xff, 9);
  b.writeUInt16LE(0, 10); // reserved
  return b;
}

export function unpackInput(payload: Buffer): PlayerInput {
  if (payload.length !== INPUT_PAYLOAD_BYTES)
    throw new ProtoError(`PlayerInput payload must be ${INPUT_PAYLOAD_BYTES} bytes, got ${payload.length}`);
  return {
    seq: payload.readUInt32LE(0),
    move: unquantAxis(payload.readInt8(4)),
    side: unquantAxis(payload.readInt8(5)),
    yaw: payload.readUInt16LE(6),
    pitch: payload.readUInt8(8),
    flags: payload.readUInt8(9),
  };
}

/** Server->peer forward: the same 12 bytes prefixed with the owning player's u16 id. */
export function packInputForward(id: number, rawInput: Buffer): Buffer {
  const b = Buffer.allocUnsafe(2 + rawInput.length);
  b.writeUInt16LE(id & 0xffff, 0);
  rawInput.copy(b, 2);
  return b;
}

// ---------------------------------------------------------- avatar move batch (peer->S)

export interface AvatarMoveEntry {
  id: number; // u16 playerId the avatar embodies
  lastInputSeq: number; // u32: the newest PlayerInput the peer had consumed for this avatar
  pose: PlayerPose;
}

const AVATAR_ENTRY_BYTES = 2 + 4 + MOVE_PAYLOAD_BYTES;

export function packAvatarMoveBatch(entries: AvatarMoveEntry[]): Buffer {
  if (entries.length > 255) throw new ProtoError('AvatarMoveBatch count exceeds u8');
  const b = Buffer.allocUnsafe(1 + entries.length * AVATAR_ENTRY_BYTES);
  b.writeUInt8(entries.length, 0);
  let off = 1;
  for (const e of entries) {
    b.writeUInt16LE(e.id & 0xffff, off);
    b.writeUInt32LE(e.lastInputSeq >>> 0, off + 2);
    writeMove(e.pose, b, off + 6);
    off += AVATAR_ENTRY_BYTES;
  }
  return b;
}

export function unpackAvatarMoveBatch(payload: Buffer): AvatarMoveEntry[] {
  if (payload.length < 1) throw new ProtoError('AvatarMoveBatch payload missing count');
  const count = payload.readUInt8(0);
  if (payload.length !== 1 + count * AVATAR_ENTRY_BYTES)
    throw new ProtoError('AvatarMoveBatch payload size does not match count');
  const entries: AvatarMoveEntry[] = [];
  let off = 1;
  for (let i = 0; i < count; i++) {
    entries.push({
      id: payload.readUInt16LE(off),
      lastInputSeq: payload.readUInt32LE(off + 2),
      pose: unpackMove(payload.subarray(off + 6, off + 6 + MOVE_PAYLOAD_BYTES)),
    });
    off += AVATAR_ENTRY_BYTES;
  }
  return entries;
}

// ---------------------------------------------------------- player state batch (S->C)
// Identical layout to AvatarMoveBatch — the server re-stamps and fans out — but kept as its
// own pack/unpack pair so the two directions can diverge without a silent format fork.

export const packPlayerStateBatch = packAvatarMoveBatch;
export const unpackPlayerStateBatch = unpackAvatarMoveBatch;
