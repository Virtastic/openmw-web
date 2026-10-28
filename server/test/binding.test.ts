// OT3-178: a bound item cannot leave its owner by trade; a notable loot window is party-only and 2 h.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Binding, LOOT_WINDOW_MS } from '../src/core/binding';
import { Trades } from '../src/core/trade';
import type { Player } from '../src/core/players';

test('quest items never trade; notable loot trades within the party for 2 h, then binds', () => {
  let now = 0;
  const b = new Binding(new Set(['puzzle_box']), new Set(['umbra_sword']), () => now);
  assert.equal(b.isBound('Puzzle_Box'), true);
  assert.equal(b.isBound('umbra_sword'), true);
  assert.equal(b.isBound('iron_dagger'), false);
  assert.equal(b.mayTrade('c1', 'c2', 'puzzle_box'), false);
  assert.equal(b.mayTrade('c1', 'c2', 'iron_dagger'), true);
  assert.equal(b.mayTrade('c1', 'c2', 'umbra_sword'), false, 'not looted in a window: bound');
  b.noteLoot('c1', 'Umbra_Sword', ['c2']);
  assert.equal(b.mayTrade('c1', 'c2', 'umbra_sword'), true);
  assert.equal(b.mayTrade('c1', 'c3', 'umbra_sword'), false, 'not in the party at the drop');
  b.handedOver('c1', 'c2', 'umbra_sword');
  assert.equal(b.mayTrade('c2', 'c1', 'umbra_sword'), true, 'the window travels with the item');
  now = LOOT_WINDOW_MS + 1;
  assert.equal(b.mayTrade('c1', 'c2', 'umbra_sword'), false);
  assert.equal(b.mayTrade('c2', 'c1', 'umbra_sword'), false);
});

test('a trade offer with a bound item is refused before anything locks', () => {
  const players = [1, 2].map((i) => ({ id: i, name: `P${i}`, charId: `c${i}`, accountKey: `a${i}`, cellKey: '0,0', inWorld: true } as Player));
  const sent: { event: string; body: Record<string, unknown> }[] = [];
  const trades = new Trades({
    findByName: (n) => players.find((p) => p.name === n),
    inventoryOf: () => [{ id: 'puzzle_box', n: 1 }],
    setInventory: () => {},
    send: (_p, event, body) => sent.push({ event, body }),
    ledger: () => {},
    binding: new Binding(new Set(['puzzle_box']), new Set()),
    now: () => 0,
  });
  trades.handleEvent(players[0]!, 'TradeRequest', new Map([['name', 'P2']]));
  trades.handleEvent(players[1]!, 'TradeAccept', new Map([['name', 'P1']]));
  trades.handleEvent(players[0]!, 'TradeOffer', new Map([['payload', '[{"id":"puzzle_box","n":1}]']]));
  assert.equal(sent.at(-1)!.body.why, 'bound:puzzle_box');
});
