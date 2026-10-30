// OT3-76: the presence heartbeat sends a PresenceDelta to the friends and party mates of whoever
// changed, and nothing at all when nobody did (it used to send every player a full PlayerList).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Social } from '../src/core/social';
import { SocialStore } from '../src/core/socialstore';
import type { Player, Roster } from '../src/core/players';

interface Sent { name: string; body: Record<string, unknown> }

function world() {
  const store = new SocialStore(':memory:');
  const players = new Map<string, Player>();
  const sent = new Map<string, Sent[]>();
  const clock = 1_700_000_000_000;
  const add = (acct: string, name: string): Player => {
    const box: Sent[] = [];
    sent.set(acct, box);
    const p = {
      id: players.size + 1, name, accountKey: acct, inWorld: true, cellKey: '0,0',
      pose: { x: 1, y: 2, z: 3 },
      peer: { sendEvent: (n: string, b: Record<string, unknown>) => void box.push({ name: n, body: b }) },
    } as unknown as Player;
    players.set(acct, p);
    return p;
  };
  // Accounts that exist on the SERVER without being in this world — someone in their own
  // game. The shared account index can see them; the local roster cannot, which is the whole
  // distinction the cross-world paths turn on.
  const elsewhere = new Map<string, string>(); // acct -> name
  const register = (acct: string, name: string): string => { elsewhere.set(acct, name); return acct; };
  const byName = (name: string): string | undefined => {
    const lc = name.toLowerCase();
    const here = [...players.values()].find((p) => p.name.toLowerCase() === lc);
    if (here) return here.accountKey;
    for (const [acct, n] of elsewhere) if (n.toLowerCase() === lc) return acct;
    return undefined;
  };
  const roster = {
    activeForAccount: (acct: string) => players.get(acct),
    // In-world only, exactly like the real one: a display name is a thing you see here.
    findByName: (name: string) =>
      [...players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase()),
    // Everyone this world is holding. The presence heartbeat walks this to re-send the panel,
    // which is how a snapshot reaches somebody without them rejoining.
    inWorld: () => [...players.values()],
  } as unknown as Roster;
  const social = new Social({
    store, roster,
    displayName: (acct) => players.get(acct)?.name ?? elsewhere.get(acct),
    resolveName: byName,
    now: () => clock,
  });
  const befriend = (x: Player, y: Player) => {
    social.requestFriend(x, y.name);
    social.requestFriend(y, x.name);
  };
  return {
    store, social, add, befriend, register, clock,
    players,
    all: (acct: string) => sent.get(acct) ?? [],
    clearSent: () => { for (const b of sent.values()) b.length = 0; },
    sentBytes: () => [...sent.values()].reduce((n, b) => n + b.reduce((m, e) => m + JSON.stringify(e).length, 0), 0),
    last: (acct: string, name: string) => (sent.get(acct) ?? []).filter((e) => e.name === name).at(-1),
    close: () => { social.stop(); store.close(); },
  };
}


function publish(w: ReturnType<typeof world>, acct: string, name: string, cell: string) {
  const local = w.players.get(acct);
  if (local) local.cellKey = cell;
  w.store.setPresence(acct, 'default', name, cell, false, w.clock, 'public');
}
const deltas = (w: ReturnType<typeof world>, acct: string) =>
  w.all(acct).filter((e) => e.name === 'PresenceDelta');

test('PresenceDelta: friends hear a cell change and a departure; strangers and the idle hear nothing', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const bob = w.add('bob', 'Bob');
  const cy = w.add('cy', 'Cy'); // a stranger to both
  w.befriend(alice, bob);
  publish(w, 'alice', 'Alice', '0,0');
  publish(w, 'bob', 'Bob', '0,0');
  publish(w, 'cy', 'Cy', '0,0');
  assert.equal(w.social.presenceDeltas(), 0, 'first beat only takes the baseline');
  assert.equal(w.social.presenceDeltas(), 0, 'nothing moved: nothing sent');
  assert.equal(deltas(w, 'alice').length + deltas(w, 'bob').length + deltas(w, 'cy').length, 0);

  publish(w, 'bob', 'Bob', '3,4');
  assert.equal(w.social.presenceDeltas(), 1);
  const got = deltas(w, 'alice');
  assert.equal(got.length, 1);
  const changes = got[0]!.body.changes as { acct: string; online: boolean; cellKey?: string }[];
  assert.deepEqual(changes.map((c) => [c.acct, c.online, c.cellKey]), [['bob', true, '3,4']]);
  assert.equal(deltas(w, 'bob').length, 0, 'the subject is not told about itself');
  assert.equal(deltas(w, 'cy').length, 0, 'a stranger gets nothing');

  // Bob leaves: Alice is told he is offline, with no location.
  w.store.clearPresence('bob', 'default', w.clock);
  w.players.delete('bob');
  w.social.presenceDeltas();
  const last = deltas(w, 'alice').at(-1)!.body.changes as { acct: string; online: boolean; cellKey?: string }[];
  assert.deepEqual(last.map((c) => [c.acct, c.online, c.cellKey]), [['bob', false, undefined]]);
  void cy;
  w.close();
});

test('PresenceDelta: party mates who are not friends hear it too, and a private cell stays hidden', () => {
  const w = world();
  const alice = w.add('alice', 'Alice');
  const dan = w.add('dan', 'Dan');
  assert.equal(w.social.partyInvite(alice, 'dan'), 'ok');
  assert.equal(w.social.partyAccept(dan, 'alice'), 'ok');
  w.store.setPresenceMode('dan', 'public');
  publish(w, 'alice', 'Alice', '0,0');
  publish(w, 'dan', 'Dan', '0,0');
  w.social.presenceDeltas();
  publish(w, 'dan', 'Dan', '7,7');
  w.social.presenceDeltas();
  const c = deltas(w, 'alice').at(-1)!.body.changes as { acct: string; cellKey?: string }[];
  assert.deepEqual(c.map((x) => [x.acct, x.cellKey]), [['dan', '7,7']]);
  w.store.setPresenceMode('dan', 'private');
  publish(w, 'dan', 'Dan', '8,8');
  w.social.presenceDeltas();
  const c2 = deltas(w, 'alice').at(-1)!.body.changes as { acct: string; cellKey?: string }[];
  assert.equal(c2[0]!.cellKey, undefined, 'a private player does not leak their cell through a delta');
  w.close();
});

test('PresenceDelta: idle bytes per player are flat from 50 to 500 players', () => {
  const bytesPerPlayer = (n: number): number => {
    const w = world();
    const ps: Player[] = [];
    for (let i = 0; i < n; i++) {
      ps.push(w.add(`p${i}`, `P${i}`));
      publish(w, `p${i}`, `P${i}`, `${i % 50},0`);
    }
    for (let i = 0; i + 1 < n; i += 2) w.befriend(ps[i]!, ps[i + 1]!);
    w.social.presenceDeltas();
    w.clearSent();
    for (let beat = 0; beat < 6; beat++) w.social.presenceDeltas(); // an idle minute
    const total = w.sentBytes();
    w.close();
    return total / n;
  };
  assert.equal(bytesPerPlayer(50), 0);
  assert.equal(bytesPerPlayer(500), 0);
});
