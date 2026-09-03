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
  sendBinary(type: number, payload: Buffer): boolean; // false = shed (see Connection)
  // Pre-framed variant: the caller already ran packEnvelope, so ONE serialized frame can be
  // handed to every recipient of a broadcast instead of re-enveloping identical bytes per
  // peer. Backpressure/shed rules are identical. See nextBroadcastSeq for why sharing the
  // envelope seq across recipients is safe.
  sendBinaryFrame(type: number, frame: Buffer): boolean;
  disconnect(code: DisconnectCode, detail: string): void;
}

// How recently a client must have sent PlayerInput to count as DRIVING the input tier --
// the predicate behind every "the peer's answer rules this player" gate (poses, bars, PvP
// routing). 5s, not the send cadence: a browser under load stutters (measured: a SwiftShader
// frame gap put 1.17s between inputs and flapped every gate at 1s), and the only cost of a
// longer window is how long a vanished client's last authority lingers.
export const INPUT_DRIVING_MS = 5_000;
// How long the peer's newest pose keeps the CLIENT's 0x0100 frames gated (handleMove) and
// keeps the owner's 0x0103 self-state flowing (movement tick). 2 s, not the old 300 ms:
// with a 300 ms gate a peer hitch longer than that (GC, load) let the client's frame in,
// then the peer's, then the client's -- alternating writers, exactly the jitter the gate
// exists to prevent. 2 s rides through a hitch and still hands movement back to the
// client within two seconds of a peer death. One constant, exported, so it is not a
// literal in two files.
export const PEER_POSE_FRESH_MS = 2_000;

export interface Player {
  id: number;
  name: string; // display casing
  accountKey: string; // nameLower
  // Character slots: the PlayerStore key for this session's active character. Defaults to
  // accountKey (system peers, tests); connection.ts sets the real character id at auth.
  charId: string;
  rank: number;
  peer: Peer;
  ip: string; // M8: needed by /ipban; never leaves the server except into ban/log lines
  inWorld: boolean;
  // M1 movement state. cellKey unset = visible to nobody (client sends PlayerCellChange
  // right after Ready). poseVersion bumps on every accepted pose/cell update so the batch
  // broadcaster can do per-recipient change detection + force-include-on-visibility.
  cellKey?: string;
  // Declared at Hello. Only a client that can actually simulate a cell's actors is eligible
  // to hold authority for one; see Authority.bestCandidate.
  simulatesActors?: boolean;
  // Headless sim peer (Phase H): kept out of every human-facing count/list. See
  // roster.humanCount() / humansInWorld().
  system?: boolean;
  /** DEV/TEST BOT (dev/testbots.ts). Visible everywhere a player is — the Players panel,
   *  friend rows, party rows — because that is what it exists for. But NOT an occupant: it
   *  must not keep a world looking busy (the gateway's idle reaper and the sim peer's sleep
   *  both read the human count), and it must not eat a maxPlayers slot a real player then
   *  cannot use. Visible, not present. */
  bot?: boolean;
  // STILL CREATING A CHARACTER. True from auth until the client reports ChargenComplete
  // (engine chargenstate == -1). While it is set, no cell this player occupies may be
  // simulated by the peer: Morrowind's own scripts drive the opening — the prison ship, the
  // walk to the census office, the guard who escorts you — and the peer puppets those actors
  // and disables their AI, so the sequence stops dead. The cells cannot be identified by NAME
  // (the walk between them is ordinary Seyda Neen exterior), only by who is standing there.
  inChargen?: boolean;
  pose?: PlayerPose;
  moveSeq: number; // last accepted PlayerMove envelope seq (stale-drop)
  // Phase 3 input authority. inputSeq: last accepted PlayerInput ENVELOPE seq (stale-drop,
  // same rule as moveSeq). lastInputSeq: the newest input the PEER reports having consumed
  // for this avatar — echoed to the client in PlayerStateBatch, which is the number its
  // reconciliation hangs off. peerPoseAt: wall-clock of the last peer-authored pose; while
  // fresh, this player's canonical pose is the PEER's answer, not the client's claim.
  inputSeq?: number;
  lastInputSeq?: number;
  // Wall-clock of the newest PlayerInput frame from this connection; the peer's avatar pose
  // only overrides the client-authored one while this is fresh (per-player degraded mode).
  lastInputAt?: number;
  // Wall-clock of the peer's newest avatar-bars report for this player; while fresh the
  // client's own PlayerStatsDynamic assertion is ignored (Phase 4A one-writer rule).
  peerStatsAt?: number;
  // Wall-clock of the peer's newest avatar item-state (wear/charge/soul) report; while fresh
  // the client's own itemStates (inside PlayerInventory) are ignored -- counts still land.
  peerItemStatesAt?: number;
  // Wall-clock of the last resurrect sent to this player. For a short window the peer's
  // dead-avatar bar reports (hp 0) are ignored so the respawned player is not re-killed
  // while the avatar body is being replaced on the peer.
  resurrectedAt?: number;
  // Sliding-window budget for CLIENT-asserted restoration while the peer owns this player's
  // bars (potions, rest, self-heal -- all still client-side until the intent tier). Without a
  // bound, "a raise is a restoration" is an immortality exploit: a modified client claims full
  // health every tick and never dies. See playerstate.ts handleStatsDynamic.
  restoreWindowAt?: number;
  restoreInWindow?: number;
  // Where this player's last cell change / teleport claimed they landed. While set, the
  // peer's avatar poses are ignored for them: the avatar teleports on the RELAY of the cell
  // change, so its stream still says the old place for a while -- and one stale sample is a
  // >256-unit divergence that hard-snaps the player straight back where they teleported
  // from (s51: a 12-far-travels-a-minute bounce loop; s22: a respawned player pinned to
  // their corpse). Cleared the moment the peer streams a pose NEAR this target -- a fixed
  // timer raced the peer's actual catch-up and lost on slow boxes.
  // `seq`: the owner's input seq at the teleport. A stale peer entry can be near the target
  // by coincidence (interior->interior doors: both near the origin), so distance alone is
  // not proof the avatar arrived -- the entry must also have consumed input newer than the
  // teleport. Distance is 3-D for the same reason.
  teleportPose?: { x: number; y: number; z: number; at: number; seq: number };
  avatarPoseLogged?: boolean;
  statsDropLogged?: boolean; // one simpeer.avatar_stats_gated log per streak // simpeer.avatar_first_pose emitted for this session
  peerPoseAt?: number;
  poseVersion: number;
  // Phase 3.6: wall-clock of the last accepted pose, for the plausible-speed envelope.
  lastPoseAt?: number;
  /** CONSECUTIVE implausible speed WINDOWS. A single one is ordinary, so enforcement waits for
   *  a run — which is what tells a bad link apart from a client actually moving that way. */
  implausibleRun?: number;
  /** Baseline for the speed envelope: a pose and the time it was measured.
   *
   *  Speed is measured against THIS rather than against the previous frame, because frame
   *  spacing is ARRIVAL spacing and a stalled connection delivers a burst. Per-frame, that burst
   *  is a normal distance over a near-zero dt — an enormous apparent speed for a player who did
   *  nothing wrong. Over a fixed window the same burst is just the distance actually travelled
   *  in that window, which is the quantity the envelope is about. */
  moveAnchor?: { x: number; y: number; z: number; at: number };
  /** Timestamps of recent NON-ADJACENT exterior cell changes — Recall, Divine Intervention,
   *  Almsivi, a silt strider, or a client inventing its own teleport. Walking is always to an
   *  adjacent cell, and a door goes through an interior, so this list only ever holds real
   *  jumps. Bounded by the rate check that reads it. */
  farJumps?: number[];
  /** Items this character has acquired SINCE its last full PlayerInventory snapshot.
   *
   *  Closes the race that made drop conservation unenforceable: the snapshot is a 2 s diff, so
   *  a player who picks something up and drops it immediately outruns their own declaration and
   *  the server has not yet been told they hold it. That is ordinary play, and refusing it broke
   *  a real scenario — which is why unowned drops were only ever COUNTED. Credit arrives per
   *  event instead, and is cleared by the next snapshot (which now includes it). */
  pendingAcquired?: Map<string, number>;
}

export class Roster {
  private byId = new Map<number, Player>();
  private byAccount = new Map<string, Player>();
  private nextId = 1;
  private inWorldCache?: Player[];

  get count(): number {
    return this.byId.size;
  }

  // Humans only: a headless sim peer (Phase H) is infrastructure, not a participant, so it
  // must not fill a maxPlayers slot, appear in the lobby, or be counted for anyone. Every
  // human-facing surface uses these; the simulation paths (broadcaster, authority) still use
  // count/inWorld() because the peer is very much a real occupant THERE.
  get humanCount(): number {
    // CAPACITY AND LIFECYCLE. Excludes bots as well as system peers: a world holding only
    // bots is an EMPTY world, or it never idles and its headless engine never sleeps.
    let n = 0;
    for (const p of this.byId.values()) if (!p.system && !p.bot) n++;
    return n;
  }

  humansInWorld(): Player[] {
    return this.inWorld().filter((p) => !p.system);
  }

  // Hot: read once per broadcaster tick and once per relayed actor batch. Cached because
  // it allocated and re-filtered the whole roster every time. The membership only changes
  // in joinWorld/remove, which invalidate. CALLERS MUST NOT MUTATE the returned array.
  inWorld(): Player[] {
    return (this.inWorldCache ??= [...this.byId.values()].filter((p) => p.inWorld));
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
      charId: accountKey,
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
    this.inWorldCache = undefined; // before the reads below, or the joiner misses itself
    // A system peer is invisible as a PARTICIPANT: it is never announced and never listed,
    // so no client spawns a puppet NPC of it. But it is announced TO — it needs everyone
    // else's poses to simulate them — and a human joining is still announced normally. So
    // the join broadcast is suppressed only for the peer's own arrival, and the peer is
    // filtered out of every roster others receive.
    if (!player.system)
      for (const p of this.inWorld()) p.peer.sendEvent('PlayerJoinWorld', { id: player.id, name: player.name });
    player.peer.sendEvent('PlayerList', {
      players: this.humansInWorld().map((p) => ({ id: p.id, name: p.name })),
    });
    log('info', 'player.join_world', { id: player.id, name: player.name, system: player.system === true });
  }

  remove(player: Player): void {
    if (!this.byId.delete(player.id)) return; // already removed (supersede + close race)
    this.inWorldCache = undefined;
    if (this.byAccount.get(player.accountKey) === player) this.byAccount.delete(player.accountKey);
    if (player.inWorld) {
      player.inWorld = false;
      // Mirror joinWorld: no client ever spawned a puppet for a system peer, so no client
      // needs a leave for it. Announcing one would name an id they never knew.
      if (!player.system)
        for (const p of this.inWorld()) p.peer.sendEvent('PlayerLeaveWorld', { id: player.id });
      log('info', 'player.leave_world', { id: player.id, name: player.name });
    }
  }
}
