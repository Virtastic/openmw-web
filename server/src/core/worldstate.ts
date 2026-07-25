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
import { cellsVisible, MAX_ABS_COORD } from './movement';
import { unpackActorMoveBatch } from '../proto/movement';
import { MSG_ACTOR_MOVE_BATCH } from '../proto/envelope';
import { Authority, type ActorSnapshot } from './authority';
import { CellStore, emptyCellDoc, type CellDoc, type ContainerItems } from '../persist/cellstore';
import { log } from '../log';

const MAX_RECORD_ID = 64;
const MAX_COUNT = 10000;
const MAX_CELL_KEY = 128;
const MAX_CONTAINER_ENTRIES = 512;

const WORLD_EVENTS = new Set([
  'ObjectSpawnRequest',
  'ObjectDelete',
  'ObjectMove',
  'ObjectLock',
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

  constructor(
    private readonly roster: Roster,
    private readonly cells: CellStore,
  ) {
    this.authority = new Authority({
      grant: (playerId, cellKey, epoch, snapshot) =>
        this.roster.get(playerId)?.peer.sendEvent('ActorAuthorityGrant', { cellKey, epoch, snapshot }),
      revoke: (playerId, cellKey, epoch) =>
        this.roster.get(playerId)?.peer.sendEvent('ActorAuthorityRevoke', { cellKey, epoch }),
      info: (playerId, cellKey, holderId) =>
        this.roster.get(playerId)?.peer.sendEvent('ActorAuthorityInfo', { cellKey, holderId }),
      loadOverrides: async (cellKey) => {
        const doc = await this.cells.get(cellKey);
        return (doc.actorOverrides as ActorSnapshot | undefined) ?? { actors: [] };
      },
      foldOverrides: async (cellKey, snapshot) => {
        const doc = await this.cells.get(cellKey);
        doc.actorOverrides = snapshot;
        this.cells.markDirty(cellKey);
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
  authorityEnter(player: Player, cellKey: string): void {
    this.enqueue(() => this.authority.onEnter(player.id, cellKey));
  }

  // Cell change out or disconnect. Captured id/cell because the roster entry may already
  // be gone by the time the queued turn runs.
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
    // Kill attribution: count on the killed actor's base recordId when a killer is named.
    const killer = finite(body.get('killerPlayerId'));
    const killedRecordId = str(body.get('killedRecordId'), MAX_RECORD_ID);
    if (killer !== undefined && killedRecordId) {
      const count = this.cells.bumpKill(killedRecordId);
      for (const p of this.roster.inWorld()) p.peer.sendEvent('WorldKillCount', { refId: killedRecordId, count });
      log('info', 'world.kill', { refId: killedRecordId, count, by: player.name });
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
      if (!cellKey || this.authority.holderOf(cellKey) !== player.id || this.authority.currentEpoch(cellKey) !== epoch) {
        return; // non-holder or stale epoch
      }
      for (const p of this.roster.inWorld()) {
        if (p.id !== player.id && cellsVisible(p.cellKey, cellKey)) p.peer.sendBinary(MSG_ACTOR_MOVE_BATCH, payload);
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
      cont = { items: contents, stateSeq: 1 };
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
    const item = cont.items.find((i) => i.id === itemId);
    if (op === 'take') {
      if (!item || item.n < n) {
        reply(false, 'gone', cont.stateSeq); // losing racer / stale client view
        return;
      }
      item.n -= n;
      if (item.n === 0) cont.items.splice(cont.items.indexOf(item), 1);
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
      });
    });
  }

  // Cell-empty flush point: called when a cell may have lost its last occupant.
  onCellVacated(cellKey: string): void {
    if (this.roster.inWorld().some((p) => p.cellKey === cellKey)) return;
    this.enqueue(() => this.cells.flushKey(cellKey));
  }
}
