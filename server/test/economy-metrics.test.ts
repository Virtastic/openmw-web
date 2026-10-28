import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metrics, TopMovers } from '../src/metrics';
import { countInventory, countTrade, hintGold, GOLD_HINT_MS } from '../src/core/economy';
import type { Player } from '../src/core/players';

const inv = (o: Record<string, number>) => Object.entries(o).map(([id, n]) => ({ id, n }));
const before = (o: Record<string, number>) => new Map(Object.entries(o));

test('gold change is attributed to the last hint, else other', () => {
  metrics.goldIn.reset(); metrics.goldOut.reset();
  const p = {} as Player;
  countInventory(p, before({ gold_001: 100 }), inv({ gold_001: 150 }), 1000);
  assert.equal(metrics.goldIn.get({ source: 'other' }), 50);
  hintGold(p, 'merchant', 2000);
  countInventory(p, before({ gold_001: 150 }), inv({ gold_001: 90 }), 2000 + GOLD_HINT_MS);
  assert.equal(metrics.goldOut.get({ source: 'merchant' }), 60);
  countInventory(p, before({ gold_001: 90 }), inv({ gold_001: 100 }), 2001 + GOLD_HINT_MS);
  assert.equal(metrics.goldIn.get({ source: 'other' }), 60, 'stale hint falls back to other');
  countInventory(p, before({ gold_001: 100 }), inv({}), 100_000);
  assert.equal(metrics.goldOut.get({ source: 'other' }), 100, 'gold gone from the list is a loss');
});

test('a scripted dupe is a spike on gold_in and on the top movers', () => {
  metrics.goldIn.reset(); metrics.itemMovers.reset();
  const p = {} as Player;
  let g = 0;
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    countInventory(p, before({ gold_001: g, ebony_longsword: i }), inv({ gold_001: g + 900, ebony_longsword: i + 1 }), t0 + i);
    g += 900;
  }
  assert.equal(metrics.goldIn.get({ source: 'other' }), 18_000);
  const text = metrics.itemMovers.toText();
  assert.match(text, /omwmp_item_top_movers\{item="ebony_longsword"\} 20/);
  assert.ok(!text.includes('gold_001'), 'gold is counted by source, not as a mover');
});

test('trade gold counts in and out alike', () => {
  metrics.goldIn.reset(); metrics.goldOut.reset();
  countTrade([inv({ gold_001: 300, iron_dagger: 1 }), inv({ gold_001: 5 })]);
  assert.equal(metrics.goldIn.get({ source: 'trade' }), 305);
  assert.equal(metrics.goldOut.get({ source: 'trade' }), 305);
});

test('top movers keep the top N and age out after two windows', () => {
  const m = new TopMovers('t', 'h', 2, 1000);
  m.add('a', 5, 0); m.add('b', 3, 0); m.add('c', 1, 0);
  const out: string[] = [];
  m.render(out, 500);
  assert.equal(out.filter((l) => !l.startsWith('#')).length, 2);
  assert.ok(!out.join('\n').includes('"c"'));
  const later: string[] = [];
  m.render(later, 1500); // previous window still shown
  assert.ok(later.join('\n').includes('"a"'));
  const gone: string[] = [];
  m.render(gone, 3600);
  assert.equal(gone.filter((l) => !l.startsWith('#')).length, 0);
});
