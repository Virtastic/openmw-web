// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M3 world objects & containers (PROTOCOL.md §M3). The server is the serialization
// point: every op runs through a single promise queue, so ops apply and rebroadcast in
// server-arrival order even though cell docs load lazily from disk. Relays are
// cell-scoped (same visibility rule as movement) and carry the sender id. Containers
// are transactional: first-opener contents become canonical, take/put conserve items,
// the losing racer gets ok=false.

import { lToJs, type LTable, type LValue, type JsLike } from '../proto/lser';
import { parseObjRef, objRefToJs, netRefKey, type ObjRef } from '../proto/ref';
import type { Player, Roster } from './players';
import { cellsVisible, lodStride, parseExterior, MAX_ABS_COORD, type InterestSettings, loadedCells, isChargenCell } from './movement';
import { unpackActorMoveBatch } from '../proto/movement';
import { MSG_ACTOR_MOVE_BATCH, packEnvelope, nextBroadcastSeq } from '../proto/envelope';
import { Authority, type ActorSnapshot } from './authority';
import { CellStore, emptyCellDoc, type CellDoc, type ContainerItems } from '../persist/cellstore';
import { log } from '../log';
import { metrics } from '../metrics';

const MAX_RECORD_ID = 64;
const MAX_COUNT = 10000;
const MAX_CELL_KEY = 128;
const MAX_CONTAINER_ENTRIES = 512;

const WORLD_EVENTS = new Set([
  'ObjectSpawnRequest',
  'ObjectDelete',
  'ObjectMove',
  'ObjectLock',
  'ObjectEnabled',
  'DoorState',
  'ContainerOpen',
  'ContainerOpRequest',
  'ResyncRequest',
]);

// M4 actor events (all holder-only, epoch-guarded). ActorSnapshot is stored, not relayed;
// ActorDeath is deduped/persisted/tallied; the rest relay cell-scoped (excluding sender).
const ACTOR_RELAY_EVENTS = new Set(['ActorStatsDynamic', 'ActorEquip', 'ActorAI']);
const ACTOR_EVENTS = new Set([...ACTOR_RELAY_EVENTS, 'ActorSnapshot', 'ActorDeath']);

function str(v: LValue | undefined, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

function coord(v: LValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_ABS_COORD ? v : undefined;
}

function finite(v: LValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function itemCount(v: LValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_COUNT ? v : undefined;
}

function parseItems(v: LValue | undefined): ContainerItems | undefined {
  if (!(v instanceof Map) || v.size > MAX_CONTAINER_ENTRIES) return undefined;
  const out: ContainerItems = [];
  for (const [, entry] of v) {
    const t = entry instanceof Map ? entry : undefined;
    const id = t ? str(t.get('id'), MAX_RECORD_ID) : undefined;
    const n = t ? itemCount(t.get('n')) : undefined;
    if (!id || n === undefined) return undefined;
    out.push({ id, n });
  }
  return out;
}

export class WorldState {
  private queue: Promise<void> = Promise.resolve();
  private readonly authority: Authority;
  // cellKey -> count of ActorMoveBatch frames relayed for that cell, the phase source for
  // actor LOD striding. Cleared when the cell empties.
  private readonly actorBatchNo = new Map<string, number>();

  // Phase 4: lowercased record ids of quest-critical items that must never deplete from a
  // container (see containerOp). Loaded from the content table; empty = vanilla behaviour.
  private questItems: ReadonlySet<string> = new Set();
  // Phase 3 public economy: named/unique actors whose corpses drop nothing in a world
  // that respawns everything, and whether this world enforces that rule at all.
  private uniqueActors: ReadonlySet<string> = new Set();
  private noDrop = false;

  setQuestItems(ids: Iterable<string>): void {
    this.questItems = new Set([...ids].map((s) => s.toLowerCase()));
  }

  // Public-realm rules: unique NPCs respawn (the world is stateless) and therefore must
  // not be farmable. Off by default — a private or party campaign keeps vanilla loot.
  /** Turn the unowned-drop SIGNAL into a refusal. Requires clients that report acquisitions
   *  per event (PlayerItemAcquired); see the spawn handler for why it is not on by default. */
  private refuseUnownedDrops = false;

  setDropEnforcement(on: boolean): void {
    this.refuseUnownedDrops = on;
  }

  setEconomyRules(opts: { uniqueActors: Iterable<string>; noDrop: boolean }): void {
    this.uniqueActors = new Set([...opts.uniqueActors].map((s) => s.toLowerCase()));
    this.noDrop = opts.noDrop;
  }

  // Phase 4 party loot rules (gold split, roll-on-rare). Absent = vanilla free-for-all.
  private partyRules?: import('./party-rules').PartyRules;
  private goldIds = new Set(['gold_001', 'gold_005', 'gold_010', 'gold_025', 'gold_100']);

  setPartyRules(rules: import('./party-rules').PartyRules): void {
    this.partyRules = rules;
  }

  // Conservation on drop. ObjectSpawnRequest takes a recordId and a count and places them in
  // the world for everyone — with no check that the sender owns any. That is the direct route
  // for a modified client to put anything into the shared world, in front of 256 people, and
  // it was completely unguarded (noDrop only strips unique-actor CORPSES).
  //
  // Injected: worldstate does not own character docs. Returns how many of `recordId` the
  // player is believed to hold, or undefined when we have no doc to judge by (never punish
  // missing information).
  private heldCount?: (player: Player, recordId: string) => number | undefined;

  setInventoryOracle(fn: (player: Player, recordId: string) => number | undefined): void {
    this.heldCount = fn;
  }

  // SPENDING the per-event acquisition credit, which is not optional bookkeeping.
  //
  // The credit exists because the inventory snapshot is a 2 s diff and a player can pick
  // something up and drop it before their own declaration catches up. But a snapshot is only
  // sent when the inventory CHANGES, and acquire-then-drop leaves it unchanged — so no snapshot
  // arrives, the credit is never superseded, and it sits there funding a second drop of
  // something that was only ever acquired once. Consume it at the point it is used.
  private debitAcquired?: (player: Player, recordId: string, count: number) => void;

  setInventoryDebit(fn: (player: Player, recordId: string, count: number) => void): void {
    this.debitAcquired = fn;
  }

  private moderationNote?: (accountKey: string, kind: string) => void;

  setModerationNote(fn: (accountKey: string, kind: string) => void): void {
    this.moderationNote = fn;
  }

  // CONTAINMENT. Character state is client-declared (playerstate.ts) and the server can only
  // DETECT implausible declarations, not prevent them. So instead of trying to verify every
  // item — which needs acquisition paths the server cannot yet see (barter, alchemy, world
  // pickups) — bound the blast radius: an account that has declared impossible state cannot
  // hand anything to anyone else in the SHARED world. They may still cheat their own
  // campaign, which harms nobody.
  //
  // Per-item provenance now EXISTS (PlayerItemAcquired + refuseUnownedDrops), but it is off by
  // default and covers drops only. Containment stays: it is the backstop for every acquisition
  // path the ledger does not see, and for the case where the ledger is switched off.
  private quarantined?: (accountKey: string) => boolean;

  setQuarantineCheck(fn: (accountKey: string) => boolean): void {
    this.quarantined = fn;
  }

  // Shared world only: `noDrop` is already "this world enforces public-economy rules".
  private contained(player: Player): boolean {
    return this.noDrop && this.quarantined?.(player.accountKey) === true;
  }

  /** Set by the server: a cell gained an authority holder. See the grant callback below. */
  onHolderGained?: (cellKey: string) => void;

  constructor(
    private readonly roster: Roster,
    private readonly cells: CellStore,
    private readonly interest?: InterestSettings,
    // Multiplayer (SSO) servers are server-authoritative ONLY: the sim peer is the sole entity
    // that may hold cell authority. Off (dev/test without SSO) keeps the legacy behaviour where
    // a capable client can hold, so the existing authority-mechanism tests still exercise it.
  ) {
    this.authority = new Authority({
      grant: (playerId, cellKey, epoch, snapshot) => {
        this.roster.get(playerId)?.peer.sendEvent('ActorAuthorityGrant', { cellKey, epoch, snapshot });
        // A cell that just got a simulator may have swings parked on it (combat.ts `hold`),
        // from the window where it had none. Deliver them now rather than having cost those
        // players the attack.
        this.onHolderGained?.(cellKey);
      },
      revoke: (playerId, cellKey, epoch) =>
        this.roster.get(playerId)?.peer.sendEvent('ActorAuthorityRevoke', { cellKey, epoch }),
      info: (playerId, cellKey, holderId, epoch) =>
        this.roster.get(playerId)?.peer.sendEvent('ActorAuthorityInfo', { cellKey, holderId, epoch }),
      loadOverrides: async (cellKey) => {
        const doc = await this.cells.get(cellKey);
        return (doc.actorOverrides as ActorSnapshot | undefined) ?? { actors: [] };
      },
      foldOverrides: async (cellKey, snapshot) => {
        const doc = await this.cells.get(cellKey);
        doc.actorOverrides = snapshot;
        this.cells.markDirty(cellKey);
      },
    }, {
      // SERVER-AUTHORITATIVE ONLY: the sole entity that may hold a cell's actor authority is
      // the sim peer (a system peer). A normal client is NEVER eligible — even if it declares
      // simulatesActors — so NPC simulation cannot be authored by a player's machine. Cells the
      // sim peer does not cover simply have no holder and wait for the server (Authority returns
      // no candidate); there is no client-simulation fallback. This is the single-mechanism model.
      caps: {
        canSimulate: (playerId) => {
          const p = this.roster.get(playerId);
          if (!p) return false;
          // ONLY the sim peer may hold a cell. Not a knob: it was tied to auth.requireSso,
          // which has nothing to do with who simulates NPCs — so a non-SSO server silently
          // fell back to letting a PLAYER'S BROWSER author NPC state for everyone, which is
          // the exact thing server authority exists to prevent. A cell the peer does not
          // cover simply has no holder and waits for it.
          return p.system === true;
        },
      },
    });
  }

  // Serializes all world mutations/reads; errors are logged, never break the chain.
  private enqueue(fn: () => Promise<void> | void): void {
    this.queue = this.queue.then(fn).catch((err) => log('error', 'world.op_failed', { error: String(err) }));
  }

  // Tests/shutdown: resolves when every enqueued op so far has applied.
  drain(): Promise<void> {
    return this.queue;
  }

  private relayCell(cellKey: string, name: string, body: JsLike): void {
    for (const p of this.roster.inWorld()) {
      if (cellsVisible(p.cellKey, cellKey)) p.peer.sendEvent(name, body);
    }
  }

  // Actor relays exclude the sender: the holder simulates locally and doesn't puppet its
  // own actors.
  private relayCellExcept(cellKey: string, exceptId: number, name: string, body: JsLike): void {
    for (const p of this.roster.inWorld()) {
      if (p.id !== exceptId && cellsVisible(p.cellKey, cellKey)) p.peer.sendEvent(name, body);
    }
  }

  private invalid(player: Player, name: string): void {
    log('warn', 'world.invalid_body', { from: player.name, name });
  }

  // Sync router called from the connection; returns true when `name` is ours.
  handleEvent(player: Player, name: string, value: LValue | undefined): boolean {
    if (ACTOR_EVENTS.has(name)) {
      const body = value instanceof Map ? value : undefined;
      if (!body) this.invalid(player, name);
      else this.enqueue(() => this.actorEvent(player, name, body));
      return true;
    }
    if (!WORLD_EVENTS.has(name)) return false;
    const body = value instanceof Map ? value : undefined;
    if (!body) {
      this.invalid(player, name);
      return true;
    }
    switch (name) {
      case 'ObjectSpawnRequest': this.enqueue(() => this.spawn(player, body)); break;
      case 'ObjectDelete': this.enqueue(() => this.delete(player, body)); break;
      case 'ObjectMove': this.enqueue(() => this.move(player, body)); break;
      case 'ObjectLock': this.enqueue(() => this.lock(player, body)); break;
      case 'ObjectEnabled': this.enqueue(() => this.enabled(player, body)); break;
      case 'DoorState': this.enqueue(() => this.door(player, body)); break;
      case 'ContainerOpen': this.enqueue(() => this.containerOpen(player, body)); break;
      case 'ContainerOpRequest': this.enqueue(() => this.containerOp(player, body)); break;
      case 'ResyncRequest': {
        const cellKey = str(body.get('cellKey'), MAX_CELL_KEY);
        if (cellKey) this.sendCellState(player, cellKey);
        else this.invalid(player, name);
        break;
      }
    }
    return true;
  }

  // Authority accessors for the M5 combat router (actor targets are holder+epoch gated).
  holderOf(cellKey: string): number | undefined {
    return this.authority.holderOf(cellKey);
  }

  epochOf(cellKey: string): number | undefined {
    return this.authority.currentEpoch(cellKey);
  }

  // ------------------------------------------------------- authority (M4)

  // Called from the PlayerCellChange path (enqueued so contested entry serializes here).
  // A PLAYER occupies exactly the cell it stands in. THE SIM PEER occupies every cell it has
  // loaded — itself plus the eight exterior neighbours — because that is what a running engine
  // actually simulates. Without this the peer held ONE cell per world and every other occupied
  // cell had no holder at all, so NPCs were frozen for anyone who walked a cell away from
  // wherever the peer happened to be standing.
  authorityEnter(player: Player, cellKey: string): void {
    // THE CHARGEN SANCTUARY, ENFORCED HERE because this is the choke point every claim goes
    // through — the anchor list in simPeerTick is only one caller, and the peer ALSO claims a
    // cell the ordinary way when it walks into one (connection.ts PlayerCellChange). Filtering
    // only the anchor list left that path wide open, which is how the peer ended up holding
    // the Imperial Prison Ship after following a player indoors.
    //
    // Holding it is what breaks the opening: the client then attaches puppets over the chargen
    // actors and disables their AI, so Morrowind's own scripts — the only thing that advances
    // chargenstate — run in the peer's world, where creation is already finished. The guard
    // never comes for you because on the peer he already did.
    // AND IT MUST REVOKE, NOT ONLY REFUSE. The filter below stops the peer CLAIMING a cell a
    // chargen player already stands in. It does nothing about the reverse order — peer first,
    // player second — which used to be nearly impossible (the peer was only started once a
    // human was already in a cell, so their chargen state was known before it could claim
    // anything) and became the common case the moment the peer started booting on CONNECT.
    // It now spawns into Seyda Neen while the player is still loading, claims it, and the
    // player then walks into their own creation sequence with the guard already puppeted and
    // his AI switched off: he stands there, the escort never fires, and the player is stuck.
    if (!player.system && player.inChargen === true) {
      const holder = this.authority.holderOf(cellKey);
      if (holder !== undefined && this.roster.get(holder)?.system === true) {
        log('info', 'authority.chargen_evict', { cellKey, holder, player: player.name });
        this.authorityLeave(holder, cellKey, true);
      }
    }
    const cells = (player.system ? loadedCells(cellKey) : [cellKey])
      .filter((c) => !isChargenCell(c) && !this.hasPlayerInChargen(c));
    if (cells.length === 0) return;
    this.enqueue(async () => {
      for (const c of cells) await this.authority.onEnter(player.id, c);
    });
  }

  // Is anyone in this cell still creating their character? Chargen is not a place, it is a
  // STATE: it starts in the Imperial Prison Ship, walks through ordinary Seyda Neen exterior —
  // where the guard escorts you to the door — and ends in the Census and Excise Office. The
  // two rooms can be matched by name; the walk between them cannot, and that is exactly where
  // the escort stalled, because the peer anchored the exterior and puppeted the guard.
  hasPlayerInChargen(cellKey: string): boolean {
    for (const p of this.roster.inWorld()) {
      if (p.inChargen === true && p.cellKey === cellKey) return true;
    }
    return false;
  }

  // Cell change out or disconnect. Captured id/cell because the roster entry may already
  // be gone by the time the queued turn runs.
  // Mirrors authorityEnter: a peer releases its whole footprint, not just the anchor cell,
  // or cells it has walked out of would keep it listed as their holder forever.
  authorityLeaveAll(playerId: number, cellKey: string, connected: boolean, system: boolean): void {
    const cells = system ? loadedCells(cellKey) : [cellKey];
    for (const c of cells) this.authorityLeave(playerId, c, connected);
  }

  authorityLeave(playerId: number, cellKey: string, connected: boolean): void {
    this.enqueue(() => this.authority.onLeave(playerId, cellKey, connected));
  }

  // Validates {cellKey, epoch} against the current authority for the sender's cell.
  // Actors are content refs only.
  private authCheck(player: Player, body: LTable, name: string): { cellKey: string; ref: ObjRef } | undefined {
    const cellKey = str(body.get('cellKey'), MAX_CELL_KEY);
    const epoch = finite(body.get('epoch'));
    const ref = parseObjRef(body);
    if (!cellKey || epoch === undefined || !ref || ref.kind !== 'ref') {
      this.invalid(player, name);
      return undefined;
    }
    if (this.authority.holderOf(cellKey) !== player.id || this.authority.currentEpoch(cellKey) !== epoch) {
      log('warn', 'actor.dropped', { from: player.name, name, cellKey, epoch }); // stale/non-holder
      return undefined;
    }
    return { cellKey, ref };
  }

  private async actorEvent(player: Player, name: string, body: LTable): Promise<void> {
    if (name === 'ActorSnapshot') {
      // Snapshot has no single ref; validate cell+epoch+holder directly, then store.
      const cellKey = str(body.get('cellKey'), MAX_CELL_KEY);
      const epoch = finite(body.get('epoch'));
      const actors = body.get('actors');
      if (!cellKey || epoch === undefined || !(actors instanceof Map)) {
        this.invalid(player, name);
        return;
      }
      if (this.authority.holderOf(cellKey) !== player.id || this.authority.currentEpoch(cellKey) !== epoch) {
        log('warn', 'actor.dropped', { from: player.name, name, cellKey, epoch });
        return;
      }
      this.authority.setSnapshot(cellKey, { actors: lToJs(actors) as JsLike });
      return;
    }
    const checked = this.authCheck(player, body, name);
    if (!checked) return;
    const { cellKey, ref } = checked;
    if (name === 'ActorDeath') {
      await this.actorDeath(player, cellKey, ref, body);
      return;
    }
    // Stats/Equip/AI: relay verbatim cell-scoped (excluding the holder).
    this.relayCellExcept(cellKey, player.id, name, { ...lToJs(body) as Record<string, JsLike> });
  }

  private async actorDeath(player: Player, cellKey: string, ref: ObjRef, body: LTable): Promise<void> {
    const deathNo = finite(body.get('deathNo'));
    if (deathNo === undefined) {
      this.invalid(player, 'ActorDeath');
      return;
    }
    const doc = await this.cells.get(cellKey);
    const deaths = (doc.actorDeaths ??= {});
    if ((deaths[ref.key] ?? -Infinity) >= deathNo) return; // duplicate death event
    deaths[ref.key] = deathNo;
    this.cells.markDirty(cellKey);
    this.relayCellExcept(cellKey, player.id, 'ActorDeath', lToJs(body) as Record<string, JsLike>);
    // Shared kill tally. Counted for EVERY death that names a record, not only
    // player-attributed ones: vanilla `GetDeadCount` counts deaths of a record regardless
    // of cause, and quest gates depend on that. An NPC finished off by a guard, a trap, a
    // fall or another creature still has to satisfy "kill the smugglers", so gating this
    // on killerPlayerId would silently strand co-op quests. killerPlayerId stays as
    // optional attribution for logs and future per-player stats.
    const killer = finite(body.get('killerPlayerId'));
    const killedRecordId = str(body.get('killedRecordId'), MAX_RECORD_ID);
    // Phase 3 public economy: in a world that resets by construction, a named NPC is an
    // infinite loot faucet. Killing Vivec with twenty strangers stays a spectacle; it is
    // just not a payday. The corpse is stripped for EVERYONE in the cell (an event, not a
    // per-player view) so no client can opt out of the rule by ignoring it.
    if (this.noDrop && killedRecordId && this.uniqueActors.has(killedRecordId.toLowerCase())) {
      this.relayCell(cellKey, 'ActorStripLoot', { ...objRefToJs(ref), cellKey, reason: 'unique' });
      log('info', 'world.unique_no_drop', { refId: killedRecordId, cellKey });
    }
    if (killedRecordId) {
      const count = this.cells.bumpKill(killedRecordId);
      for (const p of this.roster.inWorld()) p.peer.sendEvent('WorldKillCount', { refId: killedRecordId, count });
      log('info', 'world.kill', { refId: killedRecordId, count, by: killer !== undefined ? player.name : 'unattributed' });
    }
  }

  // ActorMoveBatch (binary 0x0200): validate holder+epoch, relay the raw payload
  // cell-scoped (excluding the holder). Enqueued so it orders against authority changes.
  handleActorMoveBatch(player: Player, payload: Buffer): void {
    this.enqueue(() => {
      let epoch: number;
      try {
        epoch = unpackActorMoveBatch(payload).epoch;
      } catch (err) {
        log('warn', 'actor.bad_batch', { from: player.name, error: String(err) });
        return;
      }
      const cellKey = player.cellKey;
      if (!cellKey || this.authority.holderOf(cellKey) !== player.id) {
        // The anti-cheat chokepoint: only the cell's holder may author its actors. Counted
        // (not just dropped) so forgery is VISIBLE — a modified client trying to move
        // everyone's NPCs shows up in /metrics instead of failing silently.
        metrics.actorBatchRejected.inc({ reason: cellKey ? 'not_holder' : 'no_cell' });
        return;
      }
      if (this.authority.currentEpoch(cellKey) !== epoch) {
        metrics.actorBatchRejected.inc({ reason: 'stale_epoch' });
        return;
      }
      // Liveness: this holder is demonstrably doing the job. Recorded only for ACCEPTED
      // frames, so a stale-epoch sender cannot keep a dead cell looking alive.
      this.authority.noteActorFrame(cellKey);
      {
      }
      const batchNo = (this.actorBatchNo.get(cellKey) ?? 0) + 1;
      this.actorBatchNo.set(cellKey, batchNo);
      // Distance is only comparable between exterior cells (same reason as pose interest
      // management); interiors keep the flat cell-granular stream.
      const holderPose = this.interest && parseExterior(cellKey) ? player.pose : undefined;
      // Serialized ONCE for the whole fan-out: unlike pose batches (whose entry list differs
      // per recipient), every peer gets byte-identical actor bytes, so re-enveloping per peer
      // was pure copying. Safe because the envelope seq is server-global, not per-connection.
      let frame: Buffer | undefined;
      for (const p of this.roster.inWorld()) {
        if (p.id === player.id || !cellsVisible(p.cellKey, cellKey)) continue;
        // LOD: a player across the cell does not need 15 Hz NPC updates. Rate only, NEVER
        // culled — actors have no leave-view signal, so cutting the stream would freeze
        // NPC puppets in place instead of removing them.
        if (holderPose && p.pose) {
          const dx = p.pose.x - holderPose.x;
          const dy = p.pose.y - holderPose.y;
          const dz = p.pose.z - holderPose.z;
          const st = lodStride(dx * dx + dy * dy + dz * dz, this.interest!);
          if (st > 1 && (batchNo + p.id) % st !== 0) continue;
        }
        frame ??= packEnvelope(MSG_ACTOR_MOVE_BATCH, nextBroadcastSeq(), payload);
        p.peer.sendBinaryFrame(MSG_ACTOR_MOVE_BATCH, frame);
      }
    });
  }

  // ---------------------------------------------------------------- objects

  private async spawn(player: Player, body: LTable): Promise<void> {
    const tempId = finite(body.get('tempId'));
    const recordId = str(body.get('recordId'), MAX_RECORD_ID);
    const cellKey = str(body.get('cellKey'), MAX_CELL_KEY);
    const x = coord(body.get('x'));
    const y = coord(body.get('y'));
    const z = coord(body.get('z'));
    const rotZ = finite(body.get('rotZ'));
    const count = itemCount(body.get('count'));
    if (tempId === undefined || !recordId || !cellKey || x === undefined || y === undefined || z === undefined
      || rotZ === undefined || count === undefined) {
      this.invalid(player, 'ObjectSpawnRequest');
      return;
    }
    // You cannot drop what you do not have. `held === undefined` means we have no doc to
    // judge by, which is never treated as guilt.
    //
    // fromInventory distinguishes a DROP from a PLACEMENT. Without it this op is just
    // "put an object in the world", which scripts and tools use for things nobody carries
    // (s31 spawns a chest) — so conservation could only ever be counted, never enforced.
    const fromInventory = body.get('fromInventory') === true;
    // COUNTED, NOT REFUSED — and that is a measured decision, not caution.
    //
    // Refusing unowned spawns in the shared world was implemented and then backed out: this
    // op is the generic "place an object", not "drop an item from my inventory". Scripts and
    // tools legitimately spawn things nobody carries (s31 spawns a CHEST), so conservation
    // refused them and the scenario broke. The protocol has no way to tell a drop from a
    // placement, so enforcement needs a client change first — a distinct op, or a flag on the
    // request saying this came out of an inventory.
    //
    // Until then this is the signal, and it is a sharp one: a drop of something the sender
    // never declared has no innocent explanation for a real client.
    const held = this.heldCount?.(player, recordId);
    if (held !== undefined && held < count) {
      metrics.unownedDrops.inc();
      this.moderationNote?.(player.accountKey, 'unowned_drop');
      log('warn', 'object.unowned_drop', {
        player: player.name, account: player.accountKey, recordId, count, held,
        fromInventory, refused: fromInventory && this.noDrop,
      });
      // REFUSABLE AT LAST — both blockers are gone, and it took both.
      //
      // fromInventory fixed the first false positive: this op is the generic "place an object",
      // which scripts and tools use for things nobody carries (s30/s31 spawn a CHEST), so
      // without it conservation refused legitimate placements.
      //
      // The second was a RACE, not a rule: a player who picks something up and drops it
      // immediately outruns their own 2 s inventory diff, so the server had not yet been told
      // they held it. PlayerItemAcquired now credits acquisitions per event and the oracle adds
      // them, so "you cannot drop what you do not have" is finally a question the server can
      // answer in time. That is what `refuseUnownedDrops` turns on.
      //
      // OFF BY DEFAULT, and that is deliberate rather than timid: the credit path is only as
      // complete as the client that reports it, and this repo has already backed this
      // enforcement out once. It stays a signal until the browser scenarios have exercised
      // every acquisition path against a real engine. Account-level containment (contained())
      // is unchanged and still the working defence in the meantime.
      if (this.refuseUnownedDrops && fromInventory) {
        metrics.unownedDropsRefused.inc();
        log('warn', 'object.unowned_drop_refused', {
          player: player.name, account: player.accountKey, recordId, count, held,
        });
        return; // no ack, no placement
      }
    }
    if (this.contained(player)) {
      metrics.containedActions.inc({ action: 'drop' });
      log('warn', 'contain.drop_refused', { player: player.name, account: player.accountKey, recordId });
      return; // no ack, no placement: nothing they declared reaches the shared world
    }
    // The drop is going ahead, so whatever credit backed it is now spent (see setInventoryDebit).
    if (fromInventory) this.debitAcquired?.(player, recordId, count);
    const doc = await this.cells.get(cellKey);
    const netId = this.cells.allocNetId();
    const placed = { netId, recordId, cellKey, x, y, z, rotZ, count, byId: player.id };
    doc.placed[netRefKey(netId)] = placed;
    this.cells.markDirty(cellKey);
    // Ack first: the requester is in the cell-scoped broadcast set, and per-connection
    // WS FIFO guarantees it maps tempId->netId before its own ObjectPlace arrives.
    player.peer.sendEvent('ObjectSpawnAck', { tempId, netId });
    this.relayCell(cellKey, 'ObjectPlace', placed);
    log('info', 'world.spawn', { netId, recordId, cellKey, by: player.name });
  }

  // Loads the doc and parses the union; drops ops addressing tombstoned objects.
  private async docAndRef(
    player: Player, body: LTable, name: string,
  ): Promise<{ doc: CellDoc; ref: ObjRef; cellKey: string } | undefined> {
    const ref = parseObjRef(body);
    const cellKey = str(body.get('cellKey'), MAX_CELL_KEY);
    if (!ref || !cellKey) {
      this.invalid(player, name);
      return undefined;
    }
    // REACH. The actor family checks holder+epoch; this family checked NOTHING, so any authed
    // client could delete, move, lock or unlock any object in any cell in the world, from
    // anywhere, persisted (delete writes a permanent tombstone). Holder+epoch is the wrong
    // instrument here — object edits are authored by ordinary players in their own cell, not
    // by the authority holder — but PROXIMITY is exactly right and already the rule every
    // relay uses: you may edit what you could see. The sim peer is exempt: it legitimately
    // acts on cells it does not stand in (anchored interiors), and it is server-run.
    if (!player.system && !cellsVisible(player.cellKey, cellKey)) {
      log('warn', 'object.out_of_reach', { from: player.name, name, at: player.cellKey ?? null, cellKey });
      return undefined;
    }
    const doc = await this.cells.get(cellKey);
    if (name !== 'ObjectDelete' && doc.deleted.includes(ref.key)) return undefined; // dead object
    return { doc, ref, cellKey };
  }

  private async delete(player: Player, body: LTable): Promise<void> {
    const got = await this.docAndRef(player, body, 'ObjectDelete');
    if (!got) return;
    const { doc, ref, cellKey } = got;
    // A deleted spawned object drops its placed entry AND leaves a tombstone; all
    // per-object state dies with it. Idempotent: re-deletes change nothing.
    delete doc.placed[ref.key];
    delete doc.moved[ref.key];
    delete doc.locks[ref.key];
    delete doc.doors[ref.key];
    delete doc.containers[ref.key];
    if (!doc.deleted.includes(ref.key)) doc.deleted.push(ref.key);
    this.cells.markDirty(cellKey);
    this.relayCell(cellKey, 'ObjectDelete', { ...objRefToJs(ref), cellKey, byId: player.id });
  }

  private async move(player: Player, body: LTable): Promise<void> {
    const got = await this.docAndRef(player, body, 'ObjectMove');
    if (!got) return;
    const { doc, ref, cellKey } = got;
    const x = coord(body.get('x'));
    const y = coord(body.get('y'));
    const z = coord(body.get('z'));
    const rotZ = finite(body.get('rotZ'));
    if (x === undefined || y === undefined || z === undefined || rotZ === undefined) {
      this.invalid(player, 'ObjectMove');
      return;
    }
    const placed = doc.placed[ref.key];
    if (placed) Object.assign(placed, { x, y, z, rotZ }); // spawned: placed entry is truth
    else doc.moved[ref.key] = { x, y, z, rotZ };
    this.cells.markDirty(cellKey);
    this.relayCell(cellKey, 'ObjectMove', { ...objRefToJs(ref), cellKey, x, y, z, rotZ, byId: player.id });
  }

  private async lock(player: Player, body: LTable): Promise<void> {
    const got = await this.docAndRef(player, body, 'ObjectLock');
    if (!got) return;
    const { doc, ref, cellKey } = got;
    const raw = body.get('lockLevel'); // omitted = nil = unlocked
    const lockLevel = raw === undefined ? null : finite(raw);
    if (lockLevel === undefined) {
      this.invalid(player, 'ObjectLock');
      return;
    }
    doc.locks[ref.key] = lockLevel;
    this.cells.markDirty(cellKey);
    this.relayCell(cellKey, 'ObjectLock', {
      ...objRefToJs(ref),
      cellKey,
      ...(lockLevel === null ? {} : { lockLevel }),
      byId: player.id,
    });
  }

  // Phase 4: enable/disable of a placed ref. Morrowind's quest scripts reveal and hide
  // world objects constantly (the Ghostfence coming down, a quest NPC appearing, a door
  // becoming real) — none of it was synced before this, so one player's scripted reveal
  // was invisible to everyone else in the cell. Persisted like locks so a late joiner
  // and a cell reload both see the current truth.
  private async enabled(player: Player, body: LTable): Promise<void> {
    const got = await this.docAndRef(player, body, 'ObjectEnabled');
    if (!got) return;
    const { doc, ref, cellKey } = got;
    const on = body.get('enabled');
    if (typeof on !== 'boolean') {
      this.invalid(player, 'ObjectEnabled');
      return;
    }
    const map = (doc.enabled ??= {});
    // Enabled is the vanilla default: record only the DISABLED state, so the doc does not
    // grow a row for every object a script ever touches.
    if (on) delete map[ref.key];
    else map[ref.key] = false;
    this.cells.markDirty(cellKey);
    this.relayCell(cellKey, 'ObjectEnabled', { ...objRefToJs(ref), cellKey, enabled: on, byId: player.id });
  }

  private async door(player: Player, body: LTable): Promise<void> {
    const got = await this.docAndRef(player, body, 'DoorState');
    if (!got) return;
    const { doc, ref, cellKey } = got;
    const open = body.get('open');
    if (ref.kind !== 'ref' || typeof open !== 'boolean') { // doors are content refs only
      this.invalid(player, 'DoorState');
      return;
    }
    doc.doors[ref.key] = open;
    this.cells.markDirty(cellKey);
    this.relayCell(cellKey, 'DoorState', { ...objRefToJs(ref), cellKey, open, byId: player.id });
  }

  // ------------------------------------------------------------- containers

  private async containerOpen(player: Player, body: LTable): Promise<void> {
    const got = await this.docAndRef(player, body, 'ContainerOpen');
    if (!got) return;
    const { doc, ref, cellKey } = got;
    let cont = doc.containers[ref.key];
    if (!cont) {
      // First opener's contents are the leveled-loot roll and become canonical; an
      // absent list captures an empty container. Later opens never overwrite.
      const contents = body.get('contents') === undefined ? [] : parseItems(body.get('contents'));
      if (contents === undefined) {
        this.invalid(player, 'ContainerOpen');
        return;
      }
      // origin: a copy, not an alias — `items` is mutated in place by every take/put.
      cont = { items: contents, stateSeq: 1, origin: contents.map((i) => ({ ...i })) };
      doc.containers[ref.key] = cont;
      this.cells.markDirty(cellKey);
    }
    player.peer.sendEvent('ContainerState', {
      ...objRefToJs(ref),
      items: cont.items.map((i) => ({ ...i })),
      stateSeq: cont.stateSeq,
    });
  }

  private async containerOp(player: Player, body: LTable): Promise<void> {
    const got = await this.docAndRef(player, body, 'ContainerOpRequest');
    if (!got) return;
    const { doc, ref, cellKey } = got;
    const opId = finite(body.get('opId'));
    const op = body.get('op');
    const itemId = str(body.get('itemId'), MAX_RECORD_ID);
    const n = itemCount(body.get('n'));
    if (opId === undefined || (op !== 'take' && op !== 'put') || !itemId || n === undefined) {
      this.invalid(player, 'ContainerOpRequest');
      return;
    }
    const cont = doc.containers[ref.key];
    const reply = (ok: boolean, reason: string | undefined, stateSeq: number) =>
      player.peer.sendEvent('ContainerOpResult', { opId, ok, ...(reason ? { reason } : {}), stateSeq });
    if (!cont) {
      reply(false, 'nostate', 0); // container never opened -> no canonical to transact on
      return;
    }
    if (op === 'put' && this.contained(player)) {
      metrics.containedActions.inc({ action: 'put' });
      log('warn', 'contain.put_refused', { player: player.name, account: player.accountKey, itemId });
      reply(false, 'contained', cont.stateSeq); // a container is how an item reaches someone else
      return;
    }
    const item = cont.items.find((i) => i.id === itemId);
    if (op === 'take') {
      if (!item || item.n < n) {
        reply(false, 'gone', cont.stateSeq); // losing racer / stale client view
        return;
      }
      // Phase 4: quest-critical items NEVER deplete. Morrowind puts exactly one Dwemer
      // Puzzle Box in Arkngthand; with per-character journals the second player still
      // needs to find one, and TES3MP's answer (it is simply gone) is the single most
      // reported co-op quest break. The taker gets their copy, the container keeps its
      // own, and no ContainerUpdate is relayed — nothing changed for anyone else.
      if (this.questItems.has(itemId.toLowerCase())) {
        reply(true, undefined, cont.stateSeq);
        log('debug', 'world.quest_item_kept', { itemId, by: player.name, cellKey });
        return;
      }
      // Phase 4: a notable item may be ROLLED for instead of taken outright (leader
      // setting, off by default). The take is refused and everyone co-present is asked;
      // the winner receives it when the roll settles.
      if (this.partyRules?.shouldRoll(player, itemId)) {
        const { rollId } = this.partyRules.startRoll(player, itemId);
        reply(false, 'rolling', cont.stateSeq);
        log('info', 'world.loot_roll', { itemId, rollId, by: player.name });
        return;
      }
      item.n -= n;
      if (item.n === 0) cont.items.splice(cont.items.indexOf(item), 1);
      // Gold splits among co-present party members — the one drop where first-grab
      // reliably breeds resentment. Everything else stays free-for-all.
      if (this.goldIds.has(itemId.toLowerCase())) {
        const split = this.partyRules?.splitGold(player, n);
        if (split) {
          for (const s of split) {
            const p = this.roster.inWorld().find((x) => x.accountKey === s.acct);
            p?.peer.sendEvent('LootShare', { itemId, n: s.share, from: player.name });
          }
          log('info', 'world.gold_split', { total: n, ways: split.length, by: player.name });
        }
      }
    } else {
      // put: always accepted except hard caps (conservation guard, not gameplay).
      if (item && item.n + n > MAX_COUNT) {
        reply(false, 'full', cont.stateSeq);
        return;
      }
      if (!item && cont.items.length >= MAX_CONTAINER_ENTRIES) {
        reply(false, 'full', cont.stateSeq);
        return;
      }
      if (item) item.n += n;
      else cont.items.push({ id: itemId, n });
    }
    cont.stateSeq++;
    this.cells.markDirty(cellKey);
    // Result to the requester first (FIFO: it resolves opId before its own Update),
    // then one Update to the whole cell INCLUDING the requester — a single apply path.
    reply(true, undefined, cont.stateSeq);
    this.relayCell(cellKey, 'ContainerUpdate', {
      ...objRefToJs(ref),
      delta: { itemId, dn: op === 'take' ? -n : n },
      stateSeq: cont.stateSeq,
    });
  }

  // ------------------------------------------------------------- cell state

  // Sent on every PlayerCellChange and ResyncRequest — ALWAYS, even for an untouched
  // cell (empty maps): the client gets one deterministic "cell delta applied" point.
  sendCellState(player: Player, cellKey: string): void {
    this.enqueue(async () => {
      const doc = this.cells.getCached(cellKey) ?? (await this.cells.get(cellKey)) ?? emptyCellDoc();
      const locks: Record<string, JsLike> = {};
      for (const [key, level] of Object.entries(doc.locks)) locks[key] = level === null ? {} : { lockLevel: level };
      player.peer.sendEvent('WorldCellState', {
        cellKey,
        placed: Object.values(doc.placed).map((p) => ({ ...p })),
        deleted: [...doc.deleted],
        moved: { ...doc.moved },
        locks,
        doors: { ...doc.doors },
        containers: Object.fromEntries(
          Object.entries(doc.containers).map(([key, c]) => [key, { items: c.items.map((i) => ({ ...i })), stateSeq: c.stateSeq }]),
        ),
        // Phase 4: refKeys a script disabled. Sent as a list because only disables are
        // recorded — an absent key means enabled, the vanilla default.
        disabled: Object.keys(doc.enabled ?? {}),
      });
    });
  }

  // Phase 3.7: authoritative full-cell resync applied IN PLACE by connected clients.
  //
  // This is the primitive TES3MP never had. Its protocol is delta-only, so a reset could
  // not be rescinded on a client that had already applied the old deltas — the community's
  // workaround is to KICK everyone in the cell (and issue #698 is that going wrong). We
  // own both ends of the wire, so a reset can instead say "here is the truth, discard what
  // you have for this cell": containers restocked, disabled objects re-enabled, spawned
  // objects gone. Sent to everyone who can see the cell, including the resetter.
  sendCellSnapshot(cellKey: string, doc: CellDoc): void {
    for (const p of this.roster.inWorld()) {
      if (!cellsVisible(p.cellKey, cellKey)) continue;
      p.peer.sendEvent('CellSnapshotReplace', {
        cellKey,
        placed: Object.values(doc.placed).map((x) => ({ ...x })),
        deleted: [...doc.deleted],
        moved: { ...doc.moved },
        doors: { ...doc.doors },
        containers: Object.fromEntries(
          Object.entries(doc.containers).map(([key, c]) => [key, { items: c.items.map((i) => ({ ...i })), stateSeq: c.stateSeq }]),
        ),
        disabled: Object.keys(doc.enabled ?? {}),
      });
    }
    log('info', 'world.cell_snapshot_replace', { cellKey, containers: Object.keys(doc.containers).length });
  }

  // Cell-empty flush point: called when a cell may have lost its last occupant.
  onCellVacated(cellKey: string): void {
    if (this.roster.inWorld().some((p) => p.cellKey === cellKey)) return;
    this.actorBatchNo.delete(cellKey); // no occupants -> no holder -> no stride phase to keep
    this.enqueue(() => this.cells.flushKey(cellKey));
  }
}
