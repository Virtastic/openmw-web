// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Roster of authed/in-world players, u16 playerId allocation, join/leave broadcasts.
// Peer abstracts the connection so this module stays import-cycle free.

import type { DisconnectCode } from '../proto/session';
import type { JsLike } from '../proto/lser';
import type { PlayerPose } from '../proto/movement';
import { log } from '../log';

export interface Peer {
  sendEvent(name: string, body: JsLike): void;
  sendBinary(type: number, payload: Buffer): void;
  disconnect(code: DisconnectCode, detail: string): void;
}

export interface Player {
  id: number;
  name: string; // display casing
  accountKey: string; // nameLower
  rank: number;
  peer: Peer;
  ip: string; // M8: needed by /ipban; never leaves the server except into ban/log lines
  inWorld: boolean;
  // M1 movement state. cellKey unset = visible to nobody (client sends PlayerCellChange
  // right after Ready). poseVersion bumps on every accepted pose/cell update so the batch
  // broadcaster can do per-recipient change detection + force-include-on-visibility.
  cellKey?: string;
  pose?: PlayerPose;
  moveSeq: number; // last accepted PlayerMove envelope seq (stale-drop)
  poseVersion: number;
}

export class Roster {
  private byId = new Map<number, Player>();
  private byAccount = new Map<string, Player>();
  private nextId = 1;

  get count(): number {
    return this.byId.size;
  }

  inWorld(): Player[] {
    return [...this.byId.values()].filter((p) => p.inWorld);
  }

  get(id: number): Player | undefined {
    return this.byId.get(id);
  }

  findByName(name: string): Player | undefined {
    const lower = name.toLowerCase();
    return [...this.byId.values()].find((p) => p.name.toLowerCase() === lower);
  }

  activeForAccount(accountKey: string): Player | undefined {
    return this.byAccount.get(accountKey);
  }

  private allocId(): number {
    // u16, skip 0 and in-use ids; wraps long before 65535 concurrent players matters.
    for (let i = 0; i < 0x10000; i++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;
      if (!this.byId.has(id)) return id;
    }
    throw new Error('playerId space exhausted');
  }

  addAuthed(name: string, accountKey: string, rank: number, peer: Peer, ip = ''): Player {
    const player: Player = {
      id: this.allocId(),
      name,
      accountKey,
      rank,
      peer,
      ip,
      inWorld: false,
      moveSeq: 0,
      poseVersion: 0,
    };
    this.byId.set(player.id, player);
    this.byAccount.set(accountKey, player);
    return player;
  }

  // SessionReady: announce to everyone in-world (including the joiner), then give the
  // joiner the full roster snapshot.
  joinWorld(player: Player): void {
    player.inWorld = true;
    for (const p of this.inWorld()) p.peer.sendEvent('PlayerJoinWorld', { id: player.id, name: player.name });
    player.peer.sendEvent('PlayerList', {
      players: this.inWorld().map((p) => ({ id: p.id, name: p.name })),
    });
    log('info', 'player.join_world', { id: player.id, name: player.name });
  }

  remove(player: Player): void {
    if (!this.byId.delete(player.id)) return; // already removed (supersede + close race)
    if (this.byAccount.get(player.accountKey) === player) this.byAccount.delete(player.accountKey);
    if (player.inWorld) {
      player.inWorld = false;
      for (const p of this.inWorld()) p.peer.sendEvent('PlayerLeaveWorld', { id: player.id });
      log('info', 'player.leave_world', { id: player.id, name: player.name });
    }
  }
}
