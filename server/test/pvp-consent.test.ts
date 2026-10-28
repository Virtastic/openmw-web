// OT3-163: players hurt each other only in an accepted duel, both flagged, or in the Arena.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PvpConsent, FLAG_COOLDOWN_MS } from '../src/core/pvp-consent';
import { pvp } from '../src/plugins/builtin/pvp';
import type { Player } from '../src/core/players';
import type { PluginApi } from '../src/plugins/api';

function world() {
  let now = 1_000_000;
  const told: string[] = [];
  const mk = (id: number, name: string, cellKey: string) => ({ id, name, cellKey, inWorld: true }) as unknown as Player;
  const ps = [mk(1, 'Alice', 'Balmora, Eight Plates'), mk(2, 'Bob', 'Balmora, Eight Plates'), mk(3, 'Carl', '12,4')];
  const c = new PvpConsent({
    findByName: (n) => ps.find((p) => p.name.toLowerCase() === n.toLowerCase()),
    byId: (id) => ps.find((p) => p.id === id),
    tell: (p, t) => told.push(`${p.name}: ${t}`),
    now: () => now,
  });
  const ev = (p: Player, name: string, k: string, v: string) => c.handleEvent(p, name, new Map([[k, v]]) as never);
  return { c, ps, told, ev, tick: (ms: number) => { now += ms; } };
}

test('a duel needs both to ask; it ends on a death, and that death is waived', () => {
  const { c, ps: [a, b], ev, told } = world();
  ev(a!, 'DuelRequest', 'name', 'Bob');
  assert.equal(c.consent(1, 2), undefined, 'a challenge alone is not consent');
  ev(b!, 'DuelRequest', 'name', 'Alice');
  assert.equal(c.consent(1, 2), 'duel');
  assert.equal(c.consent(2, 1), 'duel');
  assert.equal(c.diedInDuel(2), true);
  assert.equal(c.diedInDuel(2), true, 'idempotent: respawn asks again');
  assert.equal(c.consent(1, 2), undefined, 'the duel is over');
  assert.ok(told.some((t) => /Alice won the duel/.test(t)));
});

test('the flag toggles only in town interiors, both must carry it, and it has a cooldown', () => {
  const { c, ps: [a, b, carl], ev, tick, told } = world();
  ev(carl!, 'PvpFlag', 'state', 'on');
  assert.match(told.pop()!, /temple or a town building/);
  ev(a!, 'PvpFlag', 'state', 'on');
  assert.equal(c.consent(1, 2), undefined, 'one flag is not consent');
  ev(b!, 'PvpFlag', 'state', 'toggle');
  assert.equal(c.consent(1, 2), 'flag');
  ev(a!, 'PvpFlag', 'state', 'off');
  assert.match(told.pop()!, /recently/);
  tick(FLAG_COOLDOWN_MS);
  ev(a!, 'PvpFlag', 'state', 'off');
  assert.equal(c.consent(1, 2), undefined);
});

test('the gate: no consent blocks; a duel bypasses zones, a flag does not', () => {
  const api = (consent: string | undefined, zone = 'none') => ({
    config: { rules: { pvp: true, pvpZone: zone, safeCells: [] } }, log: () => {},
    pvpConsent: () => consent, cellOfPlayer: () => '12,4', levelOfPlayer: () => 10,
  }) as unknown as PluginApi;
  const hit = (a: PluginApi) => pvp.onPlayerHit!(a, { id: 1, name: 'Alice', rank: 0 }, 2, 'CombatHit');
  assert.equal(hit(api(undefined, 'all')), false);
  assert.equal(hit(api('duel')), true);
  assert.equal(hit(api('arena')), true);
  assert.equal(hit(api('flag')), false, 'zone none still applies to the flag');
  assert.equal(hit(api('flag', 'all')), true);
});
