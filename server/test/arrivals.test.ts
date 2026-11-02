// OT3-147: twenty characters leaving the census office within a minute do not stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arrivals, ARRIVAL_LIFT, ARRIVAL_RING_STEP, ARRIVAL_MAX_RINGS, ARRIVAL_WINDOW_MS } from '../src/core/arrivals';

const OFFICE = 'Seyda Neen, Census and Excise Office';
const door = { x: -11000, y: -70000, z: 200 };

test('first arrival keeps its spot; twenty within a minute get distinct, nearby, lifted spots', () => {
  let t = 0;
  const a = new Arrivals(() => t);
  assert.equal(a.place(OFFICE, '-2,-9', door), null);
  const spots: string[] = [];
  for (let i = 1; i < 20; i++) {
    t += 3000;
    const p = a.place(OFFICE, '-2,-9', door);
    assert.ok(p, `arrival ${i} is spread`);
    const d = Math.hypot(p.x - door.x, p.y - door.y);
    assert.ok(d >= ARRIVAL_RING_STEP - 1 && d <= ARRIVAL_RING_STEP * ARRIVAL_MAX_RINGS + 1, `arrival ${i} within the rings (${d})`);
    assert.equal(p.z, door.z + ARRIVAL_LIFT);
    spots.push(`${Math.round(p.x)},${Math.round(p.y)}`);
  }
  assert.equal(new Set(spots).size, spots.length, 'no two arrivals share a spot');
  // Every pair at least a body width apart.
  const pts = spots.map((s) => s.split(',').map(Number));
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
    assert.ok(Math.hypot(pts[i]![0]! - pts[j]![0]!, pts[i]![1]! - pts[j]![1]!) > 60);
});

test('the window empties: a lone arrival a minute later keeps its spot', () => {
  let t = 0;
  const a = new Arrivals(() => t);
  a.place(OFFICE, '-2,-9', door);
  t += ARRIVAL_WINDOW_MS + 1;
  assert.equal(a.place(OFFICE, '-2,-9', door), null);
});

test('only the census office -> exterior step counts', () => {
  const a = new Arrivals(() => 0);
  a.place(OFFICE, '-2,-9', door);
  assert.equal(a.place('Seyda Neen, Arrille\'s Tradehouse', '-2,-9', door), null);
  assert.equal(a.place('Imperial Prison Ship', OFFICE, door), null);
  assert.equal(a.place(OFFICE, 'Seyda Neen, Arrille\'s Tradehouse', door), null);
  assert.equal(a.place(undefined, '-2,-9', door), null);
});
