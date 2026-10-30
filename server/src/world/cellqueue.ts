// OT3-98: one op queue per cell plus a global lane.
//
// The world used to run every op on ONE promise chain, so a cold cell read for cell A made every
// op in cells B..Z wait. Now an op names the cell it touches and runs behind only that cell's
// earlier ops; an op that spans cells (or none) takes the global lane, which waits for every cell
// lane already queued and holds back every op queued after it. Order WITHIN a cell, and order
// across a global op, are exactly what the single chain gave; only unrelated cells overlap.
//
// A throwing op is logged with its cell and never swallowed silently, and when the caller supplies
// a snapshot/restore pair the cell is put back as it was before the op started (no partial
// mutation). The lane itself always continues.

export interface CellQueueHooks {
  /** Called when an op throws, after rollback. */
  onError(err: unknown, cellKey: string | undefined): void;
  /** Capture the cell's state before a keyed op; the returned value is handed to restore(). */
  snapshot?(cellKey: string): unknown;
  /** Put the cell back as snapshot() found it (called only when the op threw). */
  restore?(cellKey: string, snap: unknown): void;
}

export class CellQueue {
  private lanes = new Map<string, Promise<void>>();
  private global: Promise<void> = Promise.resolve();

  constructor(private readonly hooks: CellQueueHooks) {}

  /** Queue `fn` behind earlier ops on `cellKey` and any earlier global op. */
  run(cellKey: string, fn: () => Promise<void> | void): Promise<void> {
    // A lane tail always starts after the global op that preceded it, so waiting on the lane
    // alone is enough once it exists; a fresh lane waits on the global tail.
    const prev = this.lanes.get(cellKey) ?? this.global;
    const tail: Promise<void> = prev.then(async () => {
      let snap: unknown;
      try { snap = this.hooks.snapshot?.(cellKey); } catch (err) { this.hooks.onError(err, cellKey); }
      try {
        await fn();
      } catch (err) {
        try { this.hooks.restore?.(cellKey, snap); } catch (e2) { this.hooks.onError(e2, cellKey); }
        this.hooks.onError(err, cellKey);
      }
    }).finally(() => { if (this.lanes.get(cellKey) === tail) this.lanes.delete(cellKey); });
    this.lanes.set(cellKey, tail);
    return tail;
  }

  /** Queue `fn` after every op queued so far (any cell); later ops wait for it. */
  runGlobal(fn: () => Promise<void> | void): Promise<void> {
    const waits: Promise<void>[] = [this.global, ...this.lanes.values()];
    const tail: Promise<void> = Promise.all(waits).then(async () => {
      try { await fn(); } catch (err) { this.hooks.onError(err, undefined); }
    });
    this.global = tail;
    // Every lane queued so far is awaited above; later run() calls chain on `global`.
    this.lanes.clear();
    return tail;
  }

  /** Resolves when everything queued so far has applied. */
  drain(): Promise<void> {
    return Promise.all([this.global, ...this.lanes.values()]).then(() => undefined);
  }

  /** Cells with ops in flight (tests, metrics). */
  get busyCells(): number { return this.lanes.size; }
}
