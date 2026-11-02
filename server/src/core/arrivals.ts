// OT3-147: stagger new characters stepping out of the census office.
//
// Chargen is solo (isChargenCell), but every finished character walks through the same door
// and lands on the same spot in Seyda Neen. On launch day twenty of them inside a minute stack
// on the doorstep and block it. The first arrival in a window keeps its spot; each later one
// is nudged onto a ring around it (eight slots per ring, rings 96 units apart), relative to
// where the engine actually put them, so no map coordinates are invented here.
//
// "Nobody spawns in the void": the ring is small (at most ARRIVAL_MAX_RINGS * 96 units out,
// on the flat ground in front of the office) and the target is lifted ARRIVAL_LIFT units, so
// a slightly higher patch of ground is still landed on from above; a short drop costs nothing.

import { parseExterior } from './movement';

const CENSUS_OFFICE = 'seyda neen, census and excise office';
export const ARRIVAL_WINDOW_MS = 60_000;
export const ARRIVAL_RING_STEP = 96;
export const ARRIVAL_PER_RING = 8;
export const ARRIVAL_MAX_RINGS = 3;
export const ARRIVAL_LIFT = 64;

export interface Pose { x: number; y: number; z: number }

export class Arrivals {
  private recent: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Where to move a player who just changed cell, or null to leave them where they landed.
   *  Only the census office -> Seyda Neen exterior step counts. */
  place(from: string | undefined, to: string, landed: Pose): Pose | null {
    if (String(from ?? '').toLowerCase() !== CENSUS_OFFICE || !parseExterior(to)) return null;
    const t = this.now();
    this.recent = this.recent.filter((at) => t - at < ARRIVAL_WINDOW_MS);
    const k = this.recent.length;
    this.recent.push(t);
    if (k === 0) return null;
    // Slots 1..N cycle through the rings; past the last ring they wrap round to the first,
    // by which point the earliest arrivals have long walked off the doorstep.
    const slot = (k - 1) % (ARRIVAL_PER_RING * ARRIVAL_MAX_RINGS);
    const ring = Math.floor(slot / ARRIVAL_PER_RING) + 1;
    const angle = ((slot % ARRIVAL_PER_RING) + (ring - 1) * 0.5) * (2 * Math.PI / ARRIVAL_PER_RING);
    const r = ring * ARRIVAL_RING_STEP;
    return { x: landed.x + r * Math.cos(angle), y: landed.y + r * Math.sin(angle), z: landed.z + ARRIVAL_LIFT };
  }
}
