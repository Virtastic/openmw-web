// OT3-69: the interest index. Who is near a cell, answered without scanning the roster.
//
// movement.ts rebuilds a private CellIndex every tick for the pose broadcaster. Every OTHER relay
// (object/door/container events, actor batches, cell snapshots, kill counts) instead walked
// roster.inWorld() and filtered by cellsVisible -- O(total population) per message. This index is
// maintained incrementally (the roster calls add/moved/remove, and Player.cellKey is an accessor
// that reports every write), so a relay visits the 3x3 of cells around its source and nothing else.
//
// "Near" is exactly cellsVisible: the same cell, or (both exterior) within one cell on each axis.
// The headless sim peer additionally HEARS cells it holds or rings (WorldState.hears): it is kept in
// its own small set and tested by the caller, because who holds what lives in Authority.

import type { Player } from '../core/players';
import { parseExterior } from '../core/movement';

export class Interest {
  private byCell = new Map<string, Set<Player>>();
  /** Indexed players and the bucket each sits in (undefined: in the world but in no cell yet). */
  private at = new Map<Player, string | undefined>();
  private sys = new Set<Player>();

  add(p: Player): void {
    if (this.at.has(p)) return;
    this.at.set(p, p.cellKey);
    this.bucketAdd(p, p.cellKey);
    if (p.system === true) this.sys.add(p);
  }

  remove(p: Player): void {
    if (!this.at.has(p)) return;
    this.bucketDel(p, this.at.get(p));
    this.at.delete(p);
    this.sys.delete(p);
  }

  /** The player's cellKey changed. A player not in the index (not yet in the world) is ignored. */
  moved(p: Player, to: string | undefined): void {
    if (!this.at.has(p)) return;
    const from = this.at.get(p);
    if (from === to) return;
    this.bucketDel(p, from);
    this.at.set(p, to);
    this.bucketAdd(p, to);
  }

  /** Is anybody (peer included) standing IN this cell? */
  occupied(cellKey: string): boolean {
    return (this.byCell.get(cellKey)?.size ?? 0) > 0;
  }

  /** Players standing IN this cell. */
  inCell(cellKey: string): ReadonlySet<Player> | undefined {
    return this.byCell.get(cellKey);
  }

  /** Visit every player in `cellKey` or, for an exterior, in the 8 cells around it. */
  near(cellKey: string, fn: (p: Player) => void): void {
    const own = this.byCell.get(cellKey);
    if (own) for (const p of own) fn(p);
    const e = parseExterior(cellKey);
    if (!e) return;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const set = this.byCell.get(`${e.x + dx},${e.y + dy}`);
        if (set) for (const p of set) fn(p);
      }
    }
  }

  /** Visit every indexed system peer (there is normally one). */
  systems(fn: (p: Player) => void): void {
    for (const p of this.sys) fn(p);
  }

  /** Visit each player that would hear a relay about `cellKey`: the near ones, plus any system peer
   *  `peerHears` accepts (it may hold the cell from far away). Never visits a player twice. */
  hearers(cellKey: string, peerHears: (peer: Player) => boolean, fn: (p: Player) => void): void {
    this.near(cellKey, fn);
    for (const s of this.sys) {
      if (s.cellKey !== undefined && nearCells(s.cellKey, cellKey)) continue; // already visited by near()
      if (peerHears(s)) fn(s);
    }
  }

  get size(): number { return this.at.size; }

  private bucketAdd(p: Player, key: string | undefined): void {
    if (key === undefined) return;
    let set = this.byCell.get(key);
    if (!set) this.byCell.set(key, (set = new Set()));
    set.add(p);
  }

  private bucketDel(p: Player, key: string | undefined): void {
    if (key === undefined) return;
    const set = this.byCell.get(key);
    if (!set) return;
    set.delete(p);
    if (set.size === 0) this.byCell.delete(key);
  }
}

function nearCells(a: string, b: string): boolean {
  if (a === b) return true;
  const ea = parseExterior(a);
  const eb = parseExterior(b);
  return !!ea && !!eb && Math.abs(ea.x - eb.x) <= 1 && Math.abs(ea.y - eb.y) <= 1;
}
