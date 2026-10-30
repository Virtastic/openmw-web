// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// REGIONS: which sim peer owns which cell (OT3-77 / OT3-202).
//
// One world used to mean one single-threaded peer, and that peer is the ceiling (fixed 1/20 s
// step; a frame over 50 ms slows sim time for everyone). A region is a slice of the map with
// its own peer. This file is the pure part: the map from cell -> region, the split of one
// world-wide anchor set into per-region SimAnchors, and the diff that decides whether a
// SimAnchors message is worth sending. server.ts owns the processes and the sockets.
//
// RULES
//  * Every cell belongs to EXACTLY ONE region (regionOf is total). Authority for a cell is only
//    ever granted to that region's peer, so a creature is simulated by one peer at a time.
//  * An exterior belongs to the first region whose rectangle holds it; the rest go to the
//    default region. An interior belongs to the region of its DOOR (the exterior cell the
//    player came in from, learned on first entry or given in the static table); an interior
//    with no known door goes to the default region.
//  * With no regions configured there is exactly one region, 'world', which owns everything,
//    so a single-region deployment behaves as it did before this file existed.
//  * A player near a border is an ANCHOR for every region that owns a cell of their 3x3 ring,
//    so each peer loads (and ticks) the cells it owns next to that player. The ring cell
//    across the border is loaded by both but CLAIMED only by its owner.

import { parseExterior } from '../core/movement';

export const DEFAULT_REGION = 'world';

/** Inclusive exterior grid rectangle. */
export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface RegionDef { id: string; rects: Rect[] }
export type Pos = { x: number; y: number; z: number };
export type AnchorPlayer = Pos & { cellKey: string };

const REGION_ID = /^[A-Za-z0-9_-]{1,32}$/;

export class RegionMap {
  private readonly defs: RegionDef[];
  private readonly doors = new Map<string, string>(); // interior cellKey -> exterior cellKey
  readonly defaultId: string;

  /**
   * @param defs   hand-cut regions in priority order; the FIRST is also the default owner of
   *               every exterior no rectangle claims. Empty = one region, 'world'.
   * @param doors  static interior -> exterior door cell table (wins over what is learned).
   */
  constructor(defs: RegionDef[] = [], doors: Record<string, string> = {}) {
    const seen = new Set<string>();
    for (const d of defs) {
      if (!REGION_ID.test(d.id)) throw new Error(`region id "${d.id}" must be 1-32 of A-Z a-z 0-9 _ -`);
      if (seen.has(d.id)) throw new Error(`duplicate region id "${d.id}"`);
      seen.add(d.id);
      for (const r of d.rects) {
        if (![r.x0, r.y0, r.x1, r.y1].every(Number.isInteger) || r.x0 > r.x1 || r.y0 > r.y1) {
          throw new Error(`region "${d.id}" has a bad rectangle ${JSON.stringify(r)}`);
        }
      }
    }
    this.defs = defs.length > 0 ? defs.map((d) => ({ id: d.id, rects: d.rects.map((r) => ({ ...r })) }))
      : [{ id: DEFAULT_REGION, rects: [] }];
    this.defaultId = this.defs[0]!.id;
    for (const [k, v] of Object.entries(doors)) this.doors.set(k, v);
  }

  /** Region ids, default first. */
  get ids(): string[] { return this.defs.map((d) => d.id); }
  get size(): number { return this.defs.length; }

  /** Remember the exterior an interior was entered from. The first door seen wins, so an
   *  interior never changes owner under a holder mid-session. Returns true if it was new. */
  learnDoor(interior: string, exteriorCell: string): boolean {
    if (parseExterior(interior) || !parseExterior(exteriorCell) || this.doors.has(interior)) return false;
    this.doors.set(interior, exteriorCell);
    return true;
  }

  doorOf(interior: string): string | undefined { return this.doors.get(interior); }

  private exteriorRegion(x: number, y: number): string {
    for (const d of this.defs) {
      for (const r of d.rects) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return d.id;
    }
    return this.defaultId;
  }

  /** The one region that owns this cell. Total: unknown cells go to the default region. */
  regionOf(cellKey: string): string {
    const e = parseExterior(cellKey);
    if (e) return this.exteriorRegion(e.x, e.y);
    const door = this.doors.get(cellKey);
    const de = door !== undefined ? parseExterior(door) : null;
    return de ? this.exteriorRegion(de.x, de.y) : this.defaultId;
  }

  /** Regions owning any cell of the 3x3 ring around an exterior (or the interior's own). */
  regionsTouching(cellKey: string): string[] {
    const e = parseExterior(cellKey);
    if (!e) return [this.regionOf(cellKey)];
    const out = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.add(this.exteriorRegion(e.x + dx, e.y + dy));
    return [...out];
  }
}

/**
 * Parse `[[simPeer.regions]]` (id, rects = [[x0,y0,x1,y1], ...]). Throws on a malformed entry
 * so a bad config fails at boot rather than leaving cells unowned.
 */
export function parseRegionDefs(raw: unknown): RegionDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('[simPeer].regions must be an array of tables');
  return raw.map((r, i) => {
    const o = r as { id?: unknown; rects?: unknown };
    if (typeof o.id !== 'string') throw new Error(`[[simPeer.regions]] #${i + 1} needs a string id`);
    if (!Array.isArray(o.rects)) throw new Error(`region "${o.id}" needs rects = [[x0,y0,x1,y1], ...]`);
    const rects = o.rects.map((q): Rect => {
      if (!Array.isArray(q) || q.length !== 4 || !q.every((n) => typeof n === 'number')) {
        throw new Error(`region "${o.id}": each rect is [x0, y0, x1, y1]`);
      }
      return { x0: q[0] as number, y0: q[1] as number, x1: q[2] as number, y1: q[3] as number };
    });
    return { id: o.id, rects };
  });
}

export interface RegionAnchors {
  /** Player positions this peer must tick around. */
  anchors: Pos[];
  /** Interiors this peer holds, by name. */
  interiors: string[];
  /** Held cells (exteriors + ring + interiors) whose authority belongs to this peer. */
  claim: string[];
}

/**
 * Split a world-wide anchor set into per-region SimAnchors. Every region id is present in the
 * result (empty = holds nothing). `held` is every cell to simulate (occupied, idle-held, ring).
 * A player anchors EVERY region owning a cell in their ring, so the border is loaded on both
 * sides; a cell is claimed only by its single owner.
 */
export function partitionAnchors(
  map: RegionMap,
  players: AnchorPlayer[],
  held: Iterable<string>,
): Map<string, RegionAnchors> {
  const out = new Map<string, RegionAnchors>();
  for (const id of map.ids) out.set(id, { anchors: [], interiors: [], claim: [] });
  for (const ck of held) {
    const slot = out.get(map.regionOf(ck))!;
    slot.claim.push(ck);
    if (!parseExterior(ck)) slot.interiors.push(ck);
  }
  for (const p of players) {
    if (!parseExterior(p.cellKey)) continue;
    for (const r of map.regionsTouching(p.cellKey)) out.get(r)!.anchors.push({ x: p.x, y: p.y, z: p.z });
  }
  for (const v of out.values()) {
    v.claim.sort();
    v.interiors.sort();
    v.anchors.sort((p, q) => p.x - q.x || p.y - q.y || p.z - q.z);
  }
  return out;
}

/** How far an anchor may drift (world units) before a resend is worth it. The engine's
 *  processing range is 7168 u; 512 u of staleness is invisible and cuts the message rate. */
export const ANCHOR_DRIFT_UNITS = 512;
/** A resend even when nothing moved, so a peer that missed a message converges. */
export const ANCHOR_HEARTBEAT_MS = 6_000;

/**
 * Decides whether a SimAnchors message must go out. Membership changes (an anchor appears or
 * goes, an interior appears or goes) send at once; drift under ANCHOR_DRIFT_UNITS does not; a
 * heartbeat resends the lot. Pure bookkeeping: the caller still sends the FULL list, because
 * the peer replaces its anchor set wholesale (Scene::setSimAnchors).
 */
export class AnchorSender {
  private last?: { anchors: Pos[]; interiors: string; at: number };

  /** Forget what was sent (a new peer process starts from nothing). */
  reset(): void { this.last = undefined; }

  shouldSend(next: { anchors: Pos[]; interiors: string[] }, now: number, force = false): boolean {
    const interiors = next.interiors.join('\n');
    const prev = this.last;
    let send = force || prev === undefined || prev.interiors !== interiors
      || prev.anchors.length !== next.anchors.length || now - prev.at >= ANCHOR_HEARTBEAT_MS;
    if (!send && prev) {
      // Same count, same order (the list is sorted): compare pairwise. A sort flip from a small
      // move is harmless, it just sends.
      for (let i = 0; i < next.anchors.length; i++) {
        const a = prev.anchors[i]!, b = next.anchors[i]!;
        if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > ANCHOR_DRIFT_UNITS) { send = true; break; }
      }
    }
    if (send) this.last = { anchors: next.anchors.map((a) => ({ ...a })), interiors, at: now };
    return send;
  }
}
