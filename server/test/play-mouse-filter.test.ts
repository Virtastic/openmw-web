// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The page's pointer-lock mouse filter and raw-lock request (play/index.html, 1.7.15: "the camera
// flicks to random spots"). Lifted out of the page and run against stub events.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const indexPath = join(process.cwd(), '..', 'play', 'index.html');
const html = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
const opts = html === '' ? { skip: 'play/index.html is not part of the server image' } : {};
const slice = (from: string, to: string) => {
  const a = html.indexOf(from);
  return a < 0 ? '' : html.slice(a, html.indexOf(to, a));
};

test('a single locked spike is withheld from SDL; real motion and a second big event pass', opts, () => {
  const src = slice('  var mouseHist = []', '  // -- mouse filter end');
  assert.ok(src.includes('function mouseFilter'), 'the filter was found in the page');
  const canvas = {};
  const document = { pointerLockElement: canvas as unknown };
  const stats = { big: 0, max: 0, drop: 0, free: 0, raw: '-' };
  const window = { omw: { state: { uiMode: 'none' } } as unknown, __omwUiHold: false };
  const filter = new Function('document', 'window', 'canvasEl', 'mouseStats', `${src}; return mouseFilter;`)(
    document, window, canvas, stats) as (e: unknown) => boolean;
  let t = 0, stopped = 0;
  const move = (x: number, y = 0, target: unknown = canvas) =>
    filter({ movementX: x, movementY: y, timeStamp: (t += 16), target, stopImmediatePropagation: () => stopped++ });

  for (let i = 0; i < 10; i++) assert.equal(move(12, -3), true, 'ordinary look motion passes');
  assert.equal(move(-420, 30), false, 'a 420 px jump out of 12 px motion is withheld');
  assert.equal(stopped, 1);
  assert.equal(move(10), true, 'motion resumes');
  assert.equal(move(380), false);
  assert.equal(move(400), true, 'never two in a row: a second big event is a hand moving');
  for (let i = 0; i < 5; i++) assert.equal(move(150 + i * 40), true, 'a fast flick that ramps up passes');
  assert.deepEqual([stats.big, stats.max, stats.drop], [6, 420, 2]);

  document.pointerLockElement = null;
  assert.equal(move(900), true, 'no lock: nothing is filtered');
  assert.equal(stats.free, 1, 'but a camera turned with no lock held is counted');
  move(5, 0, {}); // over an overlay, not the canvas
  assert.equal(stats.free, 1);
});

test('the lock is asked for raw, and falls back to a plain lock where raw is unsupported', opts, async () => {
  const src = slice('  var mouseStats = window.__omwMouse', '  // OUTLIER FILTER');
  assert.ok(src.includes('unadjustedMovement'), 'the wrapper was found in the page');
  const calls: unknown[] = [];
  let supported = true;
  const proto = {
    requestPointerLock(o?: { unadjustedMovement?: boolean }) {
      calls.push(o);
      if (o && o.unadjustedMovement && !supported) return Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
      return Promise.resolve();
    },
  };
  const window: Record<string, unknown> = {};
  new Function('window', 'Element', src)(window, { prototype: proto });
  const stats = window.__omwMouse as { raw: string };
  await proto.requestPointerLock.call({});
  assert.deepEqual(calls, [{ unadjustedMovement: true }]);
  assert.equal(stats.raw, '1');
  supported = false; calls.length = 0;
  await proto.requestPointerLock.call({});
  assert.deepEqual(calls, [{ unadjustedMovement: true }, undefined]);
  assert.equal(stats.raw, '0');
  window.__omwUiHold = true; calls.length = 0;
  await proto.requestPointerLock.call({});
  assert.equal(calls.length, 0, 'an overlay still denies the lock');
});
