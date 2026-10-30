// OT3-69: world/interest.ts -- relays reach only the 3x3 occupants, the index follows every
// cellKey write, and 500 players over 50 cells stay cheap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Roster, type Peer, type Player } from '../src/core/players';

function peer(counter: { n: number }): Peer {
  return {
    sendEvent: () => { counter.n++; },
    sendBinary: () => true,
    sendBinaryFrame: () => true,
    disconnect: () => undefined,
  };
}

function join(roster: Roster, name: string, cell: string | undefined, hits: { n: number }): Player {
  const p = roster.addAuthed(name, name.toLowerCase(), 0, peer(hits));
  roster.joinWorld(p);
  p.cellKey = cell;
  return p;
}

const near = (roster: Roster, cell: string): Player[] => {
  const out: Player[] = [];
  roster.interest.near(cell, (p) => out.push(p));
  return out;
};

test('the index follows joins, cell writes and leaves', () => {
  const r = new Roster();
  const h = { n: 0 };
  const a = join(r, 'A', '0,0', h);
  const b = join(r, 'B', '1,1', h);
  const c = join(r, 'C', '5,5', h);
  const d = join(r, 'D', 'Balmora, Temple', h);
  assert.deepEqual(near(r, '0,0').map((p) => p.name).sort(), ['A', 'B']);
  assert.deepEqual(near(r, 'Balmora, Temple').map((p) => p.name), ['D']);
  c.cellKey = '1,-1'; // a write site the index was never told about
  assert.deepEqual(near(r, '0,0').map((p) => p.name).sort(), ['A', 'B', 'C']);
  assert.equal(r.interest.occupied('5,5'), false);
  d.cellKey = undefined;
  assert.equal(r.interest.occupied('Balmora, Temple'), false);
  r.remove(b);
  assert.deepEqual(near(r, '0,0').map((p) => p.name).sort(), ['A', 'C']);
  assert.equal(r.interest.size, 3);
  void a;
});

test('a player who has not joined the world is not indexed, and joins with its current cell', () => {
  const r = new Roster();
  const h = { n: 0 };
  const p = r.addAuthed('Early', 'early', 0, peer(h));
  p.cellKey = '3,3';
  assert.equal(r.interest.occupied('3,3'), false);
  r.joinWorld(p);
  assert.equal(r.interest.occupied('3,3'), true);
});

test('hearers adds a sim peer that holds the cell from afar, once', () => {
  const r = new Roster();
  const h = { n: 0 };
  join(r, 'Near', '0,0', h);
  const sys = r.addAuthed('Peer', 'peer', 0, peer(h));
  sys.system = true;
  r.joinWorld(sys);
  sys.cellKey = '9,9';
  const seen: string[] = [];
  r.interest.hearers('0,0', () => true, (p) => seen.push(p.name));
  assert.deepEqual(seen.sort(), ['Near', 'Peer']);
  seen.length = 0;
  r.interest.hearers('0,0', () => false, (p) => seen.push(p.name));
  assert.deepEqual(seen, ['Near']);
  seen.length = 0;
  sys.cellKey = '1,0'; // already near: visited by near(), not again by the peer pass
  r.interest.hearers('0,0', () => true, (p) => seen.push(p.name));
  assert.deepEqual(seen.sort(), ['Near', 'Peer']);
});

test('GATE: 500 players over 50 cells -- each event reaches only its 3x3 occupants, loop lag p99 under 20 ms', () => {
  const r = new Roster();
  const hits = Array.from({ length: 500 }, () => ({ n: 0 }));
  const cells: string[] = [];
  // 50 exterior cells, 3 apart on both axes so no two 3x3 neighbourhoods overlap
  for (let i = 0; i < 10; i++) for (let j = 0; j < 5; j++) cells.push(`${i * 3},${j * 3}`);
  const players: Player[] = [];
  for (let i = 0; i < 500; i++) players.push(join(r, `Bot${i}`, cells[i % 50], hits[i]!));
  assert.equal(r.interest.size, 500);

  const lag: number[] = []; // each relay is one synchronous slice of the loop
  for (const x of hits) x.n = 0; // join announcements are not relays
  // every cell relays 200 events (a 20 Hz stream over 10 s), each must touch exactly its 10 occupants
  let relays = 0;
  const t0 = performance.now();
  for (let round = 0; round < 200; round++) {
    for (const cell of cells) {
      let reached = 0;
      const s0 = performance.now();
      r.interest.hearers(cell, () => false, (p) => { p.peer.sendEvent('X', {}); reached++; });
      lag.push(performance.now() - s0);
      assert.equal(reached, 10);
      relays++;
    }
  }
  const ms = performance.now() - t0;
  assert.equal(relays, 10_000);
  // no cross-cell leakage: each bot heard exactly one event per round of its own cell
  for (const x of hits) assert.equal(x.n, 200);
  lag.sort((x, y) => x - y);
  const p99ms = lag[Math.floor(lag.length * 0.99)]!;
  assert.ok(ms < 1000, `10k relays took ${ms.toFixed(1)} ms`);
  assert.ok(p99ms < 20, `relay slice p99 ${p99ms} ms`);
  console.log(`interest gate: 500 players/50 cells, 10k relays in ${ms.toFixed(1)} ms, per-relay p99 ${p99ms.toFixed(4)} ms`);
  // moving a whole cell's population one cell over keeps the index exact
  for (const p of players.filter((_, i) => i % 50 === 0)) p.cellKey = '100,100';
  assert.equal(near(r, '100,100').length, 10);
  assert.equal(near(r, '0,0').length, 0);
});
