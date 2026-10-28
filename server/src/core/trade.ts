// OT3-177: player-to-player trade with a double confirm and a server-side swap.
//
// The inventory is client-declared (playerstate.ts handleInventory), so "escrow" here means the
// SERVER decides the swap: both offers are checked against the persisted docs, both docs are
// rewritten in one synchronous step (nothing else can run between the two writes), the swap is
// written to the ledger, and only then are the two clients told what to remove and add
// (TradeApply). While that is in flight their inventory declarations are held (`tradeHoldUntil`),
// so a declaration sent before the apply landed cannot write the pre-trade inventory back.
//
// Flow: TradeRequest{name} -> TradeAsk to them; TradeAccept{name} opens it; TradeOffer{payload:
// JSON [{id,n}]} sets your side and resets BOTH confirms; TradeConfirm twice each (1 = lock,
// 2 = accept, only once both locked); TradeCancel / leaving / a cell change ends it.
// ponytail: an offer is checked against the doc, which trails the client by up to one 2 s
// declaration. An item dropped in that window still reaches the other side; the giver's apply
// then reports it short and it is logged as an anomaly. A real fix is client-side escrow.

import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openDb } from '../persist/sqlite';
import type { Player } from './players';
import type { LValue } from '../proto/lser';
import { log } from '../log';

export type Item = { id: string; n: number };

export interface TradeDeps {
  findByName(name: string): Player | undefined;
  inventoryOf(charId: string): Item[];
  setInventory(charId: string, inv: Item[]): void;
  send(p: Player, event: string, body: Record<string, unknown>): void;
  ledger(entry: LedgerEntry): void;
  noteAnomaly?(accountKey: string, kind: string): void;
  /** OT3-178 (binding.ts): absent = everything tradeable. */
  binding?: { mayTrade(from: string, to: string, id: string): boolean; handedOver(from: string, to: string, id: string): void };
  now(): number;
}

export interface LedgerEntry {
  id: number; ts: number;
  a: { char: string; name: string; gave: Item[] };
  b: { char: string; name: string; gave: Item[] };
}

interface Side { p: Player; offer: Item[]; stage: 0 | 1 | 2 }
interface Trade { id: number; a: Side; b: Side }

const MAX_LINES = 12;          // distinct stacks per offer
const ASK_TTL_MS = 30_000;
export const HOLD_MS = 20_000; // longest a declaration waits on an unacked apply
const ACK_GRACE_MS = 2_500;    // the apply's adds land a frame late; one more declaration's worth

export class Trades {
  private seq = 0;
  private readonly byPlayer = new Map<number, Trade>();
  private readonly asks = new Map<number, { from: number; at: number }[]>(); // to -> asks

  constructor(private readonly d: TradeDeps) {}

  handleEvent(p: Player, name: string, value: LValue | undefined): boolean {
    if (!name.startsWith('Trade')) return false;
    const body = value instanceof Map ? value : undefined;
    const str = (k: string): string => { const v = body?.get(k); return typeof v === 'string' ? v : ''; };
    switch (name) {
      case 'TradeRequest': this.request(p, str('name')); return true;
      case 'TradeAccept': this.accept(p, str('name')); return true;
      case 'TradeOffer': this.offer(p, str('payload')); return true;
      case 'TradeConfirm': this.confirm(p); return true;
      case 'TradeCancel': this.cancel(p, 'cancelled'); return true;
      case 'TradeApplied': this.applied(p, body?.get('short')); return true;
      default: return false;
    }
  }

  /** Leaving, dying into a respawn, changing cell: a trade needs both standing there. */
  end(p: Player, why: string): void { this.cancel(p, why); this.asks.delete(p.id); }

  private request(p: Player, name: string): void {
    const t = this.d.findByName(name);
    if (!t || t.id === p.id || !t.inWorld) return this.fail(p, 'no_such_player');
    if (t.cellKey !== p.cellKey) return this.fail(p, 'too_far');
    if (this.byPlayer.has(t.id) || this.byPlayer.has(p.id)) return this.fail(p, 'busy');
    const now = this.d.now();
    const list = (this.asks.get(t.id) ?? []).filter((a) => now - a.at < ASK_TTL_MS && a.from !== p.id);
    list.push({ from: p.id, at: now });
    this.asks.set(t.id, list);
    this.d.send(t, 'TradeAsk', { fromName: p.name });
  }

  private accept(p: Player, name: string): void {
    const from = this.d.findByName(name);
    const now = this.d.now();
    const ask = from && (this.asks.get(p.id) ?? []).find((a) => a.from === from.id && now - a.at < ASK_TTL_MS);
    if (!from || !ask) return this.fail(p, 'no_request');
    if (from.cellKey !== p.cellKey) return this.fail(p, 'too_far');
    if (this.byPlayer.has(from.id) || this.byPlayer.has(p.id)) return this.fail(p, 'busy');
    this.asks.set(p.id, (this.asks.get(p.id) ?? []).filter((a) => a !== ask));
    const t: Trade = { id: ++this.seq, a: { p: from, offer: [], stage: 0 }, b: { p, offer: [], stage: 0 } };
    this.byPlayer.set(from.id, t);
    this.byPlayer.set(p.id, t);
    this.push(t);
  }

  private offer(p: Player, payload: string): void {
    const t = this.byPlayer.get(p.id);
    if (!t) return this.fail(p, 'no_trade');
    const items = parseOffer(payload);
    if (!items) return this.fail(p, 'bad_offer');
    const short = shortOf(items, this.d.inventoryOf(p.charId));
    if (short) return this.fail(p, `not_held:${short}`);
    const to = theirs(t, p).p.charId;
    const bound = items.find((i) => this.d.binding && !this.d.binding.mayTrade(p.charId, to, i.id));
    if (bound) return this.fail(p, `bound:${bound.id}`);
    mine(t, p).offer = items;
    // Any change re-opens the deal for both: what you locked is no longer what is on the table.
    t.a.stage = 0; t.b.stage = 0;
    this.push(t);
  }

  private confirm(p: Player): void {
    const t = this.byPlayer.get(p.id);
    if (!t) return this.fail(p, 'no_trade');
    const me = mine(t, p), them = theirs(t, p);
    if (me.stage === 0) me.stage = 1;
    else if (me.stage === 1 && them.stage >= 1) me.stage = 2;
    else return; // a second accept before they locked, or a resend
    if (t.a.stage === 2 && t.b.stage === 2) this.execute(t);
    else this.push(t);
  }

  /** Both sides accepted the locked deal: check, swap both docs in one step, ledger, apply. */
  private execute(t: Trade): void {
    this.close(t);
    const invA = this.d.inventoryOf(t.a.p.charId), invB = this.d.inventoryOf(t.b.p.charId);
    const short = shortOf(t.a.offer, invA) ?? shortOf(t.b.offer, invB);
    if (short) {
      for (const s of [t.a, t.b]) this.d.send(s.p, 'TradeEnd', { ok: false, why: `not_held:${short}` });
      return;
    }
    const nextA = add(sub(invA, t.a.offer), t.b.offer);
    const nextB = add(sub(invB, t.b.offer), t.a.offer);
    // ATOMIC: two synchronous writes, no await between them. The ledger row goes first so a
    // crash between it and the doc flush leaves a record of what was meant to happen.
    const entry: LedgerEntry = {
      id: t.id, ts: this.d.now(),
      a: { char: t.a.p.charId, name: t.a.p.name, gave: t.a.offer },
      b: { char: t.b.p.charId, name: t.b.p.name, gave: t.b.offer },
    };
    this.d.ledger(entry);
    this.d.setInventory(t.a.p.charId, nextA);
    this.d.setInventory(t.b.p.charId, nextB);
    for (const [s, o] of [[t.a, t.b], [t.b, t.a]] as const) {
      for (const i of s.offer) this.d.binding?.handedOver(s.p.charId, o.p.charId, i.id);
    }
    log('info', 'trade.done', { id: t.id, a: t.a.p.name, b: t.b.p.name, aGave: t.a.offer, bGave: t.b.offer });
    const hold = this.d.now() + HOLD_MS;
    for (const [s, o] of [[t.a, t.b], [t.b, t.a]] as const) {
      s.p.tradeHoldUntil = hold;
      this.d.send(s.p, 'TradeApply', { id: t.id, remove: s.offer, add: o.offer });
      this.d.send(s.p, 'TradeEnd', { ok: true });
    }
  }

  /** The client applied a TradeApply. `short`: what it was told to remove and did not hold. */
  private applied(p: Player, short: LValue | undefined): void {
    if (p.tradeHoldUntil === undefined) return;
    p.tradeHoldUntil = Math.min(p.tradeHoldUntil, this.d.now() + ACK_GRACE_MS);
    if (short instanceof Map && short.size > 0) {
      this.d.noteAnomaly?.(p.accountKey, 'trade_short');
      log('warn', 'trade.short', { player: p.name, short: [...short.values()].length });
    }
  }

  private cancel(p: Player, why: string): void {
    const t = this.byPlayer.get(p.id);
    if (!t) return;
    this.close(t);
    for (const s of [t.a, t.b]) if (s.p.id !== p.id || why === 'cancelled') this.d.send(s.p, 'TradeEnd', { ok: false, why });
  }

  private close(t: Trade): void { this.byPlayer.delete(t.a.p.id); this.byPlayer.delete(t.b.p.id); }

  private push(t: Trade): void {
    for (const [me, them] of [[t.a, t.b], [t.b, t.a]] as const) {
      this.d.send(me.p, 'TradeState', {
        id: t.id, with: them.p.name,
        mine: me.offer, theirs: them.offer, myStage: me.stage, theirStage: them.stage,
      });
    }
  }

  private fail(p: Player, why: string): void { this.d.send(p, 'TradeEnd', { ok: false, why }); }

  /** Test seam. */
  activeTrades(): number { return new Set(this.byPlayer.values()).size; }
}

const mine = (t: Trade, p: Player): Side => (t.a.p.id === p.id ? t.a : t.b);
const theirs = (t: Trade, p: Player): Side => (t.a.p.id === p.id ? t.b : t.a);

export function parseOffer(payload: string): Item[] | undefined {
  if (payload === '') return [];
  let raw: unknown;
  try { raw = JSON.parse(payload); } catch { return undefined; }
  if (!Array.isArray(raw) || raw.length > MAX_LINES) return undefined;
  const sum = new Map<string, number>();
  for (const e of raw) {
    const id = (e as Item)?.id, n = (e as Item)?.n;
    if (typeof id !== 'string' || id === '' || id.length > 64 || !Number.isInteger(n) || n < 1) return undefined;
    sum.set(id.toLowerCase(), (sum.get(id.toLowerCase()) ?? 0) + n);
  }
  return [...sum].map(([id, n]) => ({ id, n }));
}

/** The first offered id the inventory does not cover, or undefined. */
function shortOf(offer: Item[], inv: Item[]): string | undefined {
  const have = new Map<string, number>();
  for (const i of inv) have.set(i.id.toLowerCase(), (have.get(i.id.toLowerCase()) ?? 0) + i.n);
  return offer.find((o) => (have.get(o.id) ?? 0) < o.n)?.id;
}

function sub(inv: Item[], take: Item[]): Item[] {
  const left = new Map(take.map((t) => [t.id, t.n]));
  const out: Item[] = [];
  for (const i of inv) {
    const k = i.id.toLowerCase();
    const cut = Math.min(i.n, left.get(k) ?? 0);
    if (cut > 0) left.set(k, (left.get(k) ?? 0) - cut);
    if (i.n - cut > 0) out.push({ id: i.id, n: i.n - cut });
  }
  return out;
}

function add(inv: Item[], give: Item[]): Item[] {
  const out = inv.map((i) => ({ ...i }));
  for (const g of give) {
    const hit = out.find((i) => i.id.toLowerCase() === g.id);
    if (hit) hit.n += g.n; else out.push({ id: g.id, n: g.n });
  }
  return out;
}

/** The append-only trade ledger, trades.db next to the player store. */
export class TradeLedger {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    this.db = openDb(join(dataDir, 'trades.db'), [{
      name: '001-trades',
      up: (db: DatabaseSync) => db.exec(
        'CREATE TABLE trades (rowid INTEGER PRIMARY KEY, ts INTEGER NOT NULL, doc TEXT NOT NULL)'),
    }]);
  }
  write(e: LedgerEntry): void {
    this.db.prepare('INSERT INTO trades (ts, doc) VALUES (?, ?)').run(e.ts, JSON.stringify(e));
  }
  recent(limit = 50): LedgerEntry[] {
    return (this.db.prepare('SELECT doc FROM trades ORDER BY rowid DESC LIMIT ?').all(limit) as { doc: string }[])
      .map((r) => JSON.parse(r.doc) as LedgerEntry);
  }
}
