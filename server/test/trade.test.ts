// OT3-177: the trade escrow. The acceptance gate is 1,000 scripted trades with no item duplicated
// or lost, disconnects mid-trade included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Trades, parseOffer, type Item, type LedgerEntry } from '../src/core/trade';
import type { Player } from '../src/core/players';

type Sent = { to: number; event: string; body: Record<string, unknown> };

function world(n: number, seed = 1) {
  let s = seed;
  const rnd = (k: number) => { s = (s * 1103515245 + 12345) % 2 ** 31; return s % k; };
  const players: Player[] = [];
  const docs = new Map<string, Item[]>();
  const client = new Map<number, Map<string, number>>(); // what each engine holds
  for (let i = 1; i <= n; i++) {
    players.push({ id: i, name: `P${i}`, charId: `c${i}`, accountKey: `a${i}`, cellKey: '0,0', inWorld: true } as Player);
    const inv = [{ id: 'gold_001', n: 500 }, { id: `sword_${i}`, n: 1 }, { id: 'arrow', n: 50 + i }];
    docs.set(`c${i}`, inv);
    client.set(i, new Map(inv.map((x) => [x.id, x.n])));
  }
  const sent: Sent[] = [];
  const ledger: LedgerEntry[] = [];
  const trades = new Trades({
    findByName: (name) => players.find((p) => p.name === name && p.inWorld),
    inventoryOf: (c) => docs.get(c) ?? [],
    setInventory: (c, inv) => docs.set(c, inv),
    send: (p, event, body) => sent.push({ to: p.id, event, body }),
    ledger: (e) => ledger.push(e),
    now: () => 0,
  });
  const ev = (p: Player, name: string, body: Record<string, string> = {}) =>
    trades.handleEvent(p, name, new Map(Object.entries(body)));
  return { players, docs, client, sent, ledger, trades, ev, rnd };
}

const totals = (docs: Map<string, Item[]>) => {
  const t = new Map<string, number>();
  for (const inv of docs.values()) for (const i of inv) t.set(i.id, (t.get(i.id) ?? 0) + i.n);
  return t;
};

test('a locked offer needs both accepts; changing it re-opens the deal', () => {
  const w = world(2);
  const [a, b] = w.players;
  w.ev(a!, 'TradeRequest', { name: 'P2' });
  w.ev(b!, 'TradeAccept', { name: 'P1' });
  w.ev(a!, 'TradeOffer', { payload: JSON.stringify([{ id: 'gold_001', n: 100 }]) });
  w.ev(a!, 'TradeConfirm'); w.ev(a!, 'TradeConfirm'); // second accept before they locked: ignored
  w.ev(b!, 'TradeConfirm');
  w.ev(b!, 'TradeOffer', { payload: JSON.stringify([{ id: 'arrow', n: 5 }]) }); // resets both
  w.ev(a!, 'TradeConfirm'); w.ev(b!, 'TradeConfirm'); w.ev(a!, 'TradeConfirm');
  assert.equal(w.ledger.length, 0, 'one accept is not a deal');
  w.ev(b!, 'TradeConfirm');
  assert.equal(w.ledger.length, 1);
  assert.deepEqual(w.docs.get('c1')!.find((i) => i.id === 'arrow'), { id: 'arrow', n: 56 });
  assert.deepEqual(w.docs.get('c2')!.find((i) => i.id === 'gold_001'), { id: 'gold_001', n: 600 });
  const apply = w.sent.filter((x) => x.event === 'TradeApply' && x.to === 2)[0]!.body;
  assert.deepEqual(apply.add, [{ id: 'gold_001', n: 100 }]);
  assert.equal(a!.tradeHoldUntil !== undefined && b!.tradeHoldUntil !== undefined, true);
});

test('an offer beyond what the doc holds is refused; bad payloads too', () => {
  const w = world(2);
  const [a, b] = w.players;
  w.ev(a!, 'TradeRequest', { name: 'P2' });
  w.ev(b!, 'TradeAccept', { name: 'P1' });
  w.ev(a!, 'TradeOffer', { payload: JSON.stringify([{ id: 'sword_2', n: 1 }]) });
  assert.match(String(w.sent.at(-1)!.body.why), /not_held/);
  assert.equal(parseOffer('[{"id":"x","n":-1}]'), undefined);
  assert.equal(parseOffer('nope'), undefined);
  assert.deepEqual(parseOffer('[{"id":"A","n":1},{"id":"a","n":2}]'), [{ id: 'a', n: 3 }]);
});

test('1,000 scripted trades: nothing duplicated or lost, disconnects mid-trade included', () => {
  const w = world(6, 7);
  const start = totals(w.docs);
  let done = 0, dropped = 0;
  const pickOffer = (p: Player): Item[] => {
    const inv = w.docs.get(p.charId)!;
    if (inv.length === 0 || w.rnd(5) === 0) return [];
    const it = inv[w.rnd(inv.length)]!;
    return [{ id: it.id, n: 1 + w.rnd(it.n) }];
  };
  // Engines apply what they were sent; one that "disconnected" reloads from its doc instead.
  const flush = () => {
    for (const s of w.sent.splice(0)) {
      if (s.event !== 'TradeApply') continue;
      const inv = w.client.get(s.to)!;
      for (const r of s.body.remove as Item[]) inv.set(r.id, (inv.get(r.id) ?? 0) - r.n);
      for (const r of s.body.add as Item[]) inv.set(r.id, (inv.get(r.id) ?? 0) + r.n);
      w.trades.handleEvent(w.players[s.to - 1]!, 'TradeApplied', new Map());
    }
  };
  for (let i = 0; i < 1000; i++) {
    const a = w.players[w.rnd(6)]!;
    let b = w.players[w.rnd(6)]!;
    if (b === a) b = w.players[(a.id) % 6]!;
    w.ev(a, 'TradeRequest', { name: b.name });
    w.ev(b, 'TradeAccept', { name: a.name });
    const steps: (() => void)[] = [
      () => w.ev(a, 'TradeOffer', { payload: JSON.stringify(pickOffer(a)) }),
      () => w.ev(b, 'TradeOffer', { payload: JSON.stringify(pickOffer(b)) }),
      () => w.ev(a, 'TradeConfirm'), () => w.ev(b, 'TradeConfirm'),
      () => w.ev(a, 'TradeConfirm'), () => w.ev(b, 'TradeConfirm'),
    ];
    const cut = w.rnd(10) === 0 ? w.rnd(steps.length) : -1; // ~10% drop at a random step
    const before = w.ledger.length;
    for (let k = 0; k < steps.length; k++) {
      if (k === cut) {
        const who = w.rnd(2) ? a : b;
        w.trades.end(who, 'left');
        // Reconnect: a fresh engine is restored from the doc (global.lua restoreTick).
        w.client.set(who.id, new Map(w.docs.get(who.charId)!.map((x) => [x.id, x.n])));
        dropped++;
        break;
      }
      steps[k]!();
    }
    w.trades.handleEvent(a, 'TradeCancel', undefined); // whatever is left open
    flush();
    if (w.ledger.length > before) done++;
    assert.deepEqual(totals(w.docs), start, `trade ${i}: the world's items changed`);
  }
  for (const p of w.players) {
    const doc = new Map(w.docs.get(p.charId)!.map((x) => [x.id, x.n]));
    const eng = new Map([...w.client.get(p.id)!].filter(([, n]) => n !== 0));
    assert.deepEqual(eng, doc, `${p.name}'s engine and doc agree`);
  }
  assert.equal(w.trades.activeTrades(), 0);
  assert.ok(done > 500, `most trades completed (${done})`);
  assert.ok(dropped > 50, `disconnects exercised (${dropped})`);
});
