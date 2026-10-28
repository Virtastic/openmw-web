// OT3-189: where gold enters and leaves player inventories, and which items are being gained
// fastest, so a dupe or an inflation source shows up on /metrics instead of in a forum post.
//
// The inventory is client-declared, so a declaration only says "gold went from A to B". The
// SOURCE is the most recent server-seen event that explains a gold change (a merchant purse
// op, a container take/put of gold, a journal entry, an admin give) within GOLD_HINT_MS;
// nothing recent = 'other'. A dupe therefore lands on 'other' (or on whatever it rode on) as a
// spike. Trades rewrite both docs server-side and are counted where they execute (trade.ts).
// ponytail: last-hint-wins attribution; a sale and a quest reward in the same 30 s both go to
// the later one. Exact per-event accounting needs the client to tag each gold change.

import { metrics } from '../metrics';
import type { Player } from './players';

export type GoldSource = 'loot' | 'merchant' | 'quest' | 'trade' | 'admin' | 'other';
export const GOLD_ID = 'gold_001';
export const GOLD_HINT_MS = 30_000;

export function hintGold(p: Player, source: GoldSource, now = Date.now()): void {
  p.goldHint = { source, at: now };
}

/** One accepted inventory declaration: count the gold change and every item gained. */
export function countInventory(p: Player, before: Map<string, number>, after: { id: string; n: number }[], now = Date.now()): void {
  for (const { id, n } of after) {
    const gain = n - (before.get(id) ?? 0);
    if (id !== GOLD_ID && gain > 0) metrics.itemMovers.add(id, gain, now);
  }
  const delta = (after.find((i) => i.id === GOLD_ID)?.n ?? 0) - (before.get(GOLD_ID) ?? 0);
  if (delta === 0) return;
  const h = p.goldHint;
  const source: GoldSource = h && now - h.at <= GOLD_HINT_MS ? h.source : 'other';
  if (delta > 0) metrics.goldIn.inc({ source }, delta);
  else metrics.goldOut.inc({ source }, -delta);
}

/** A server-executed trade: each side's gold leaves one inventory and enters the other. */
export function countTrade(offers: { id: string; n: number }[][]): void {
  for (const offer of offers) {
    for (const i of offer) {
      if (i.id !== GOLD_ID) continue;
      metrics.goldOut.inc({ source: 'trade' }, i.n);
      metrics.goldIn.inc({ source: 'trade' }, i.n);
    }
  }
}
