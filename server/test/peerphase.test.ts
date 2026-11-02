// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-206: the peer gets the base cell and every active phase overlay side by side, each ref
// that differs tagged with the phase keys it is present in; an unphased cell is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { peerPhaseView, BASE_PHASE } from '../src/phase/peertags';
import { withPeerPhases } from '../src/core/worldstate';

test('no active overlay: no view (the body stays as today)', () => {
  assert.equal(peerPhaseView({ enabled: ['c:1:0'], disabled: ['c:2:0'] }, undefined), undefined);
  assert.equal(peerPhaseView({ enabled: [], disabled: [] }, {}), undefined);
  const body = { cellKey: 'Raven Rock', enabled: ['c:1:0'], disabled: ['c:2:0'] };
  withPeerPhases(body, undefined);
  assert.deepEqual(body, { cellKey: 'Raven Rock', enabled: ['c:1:0'], disabled: ['c:2:0'] });
});

test('a cell with two active phases holds both ref sets, each tagged', () => {
  // Stage A builds the bar (c:10), stage B the mine (c:20) and pulls down the tent (c:30).
  const view = peerPhaseView({ enabled: [], disabled: [] }, {
    stageA: { enabled: ['c:10:0'] },
    stageB: { enabled: ['c:20:0'], disabled: ['c:30:0'] },
  })!;
  assert.deepEqual(view.phaseRefs, {
    'c:10:0': ['stageA'],
    'c:20:0': ['stageB'],
    'c:30:0': [BASE_PHASE, 'stageA'],
  });
  // The peer holds every phase's refs at once.
  assert.deepEqual(view.enabled.sort(), ['c:10:0', 'c:20:0', 'c:30:0']);
  assert.deepEqual(view.disabled, []);
});

test('a ref every phase has is a base ref (untagged); one no phase has stays off', () => {
  const view = peerPhaseView({ enabled: [], disabled: ['c:5:0'] }, {
    a: { enabled: ['c:1:0'] },
    b: { enabled: ['c:1:0'] },
  })!;
  // c:1 is off in the base (overlays turn it on), so it is tagged a+b, not base.
  assert.deepEqual(view.phaseRefs, { 'c:1:0': ['a', 'b'] });
  const all = peerPhaseView({ enabled: ['c:1:0'], disabled: [] }, { a: { enabled: ['c:1:0'] } })!;
  assert.deepEqual(all.phaseRefs, {});
  const none = peerPhaseView({ enabled: ['c:7:0'], disabled: [] }, { a: { disabled: ['c:9:0'] } })!;
  assert.deepEqual(none.phaseRefs, { 'c:9:0': [BASE_PHASE] });
  assert.deepEqual(view.disabled, ['c:5:0']);
});

test('a ref every active phase turns off is disabled on the peer', () => {
  const view = peerPhaseView({ enabled: ['c:1:0'], disabled: [] }, { a: { disabled: ['c:1:0'] } })!;
  assert.deepEqual(view.phaseRefs, { 'c:1:0': [BASE_PHASE] });
  const gone = peerPhaseView({ enabled: [], disabled: ['c:1:0'] }, { a: { disabled: ['c:1:0'] } })!;
  assert.deepEqual(gone.phaseRefs, {});
  assert.deepEqual(gone.disabled, ['c:1:0']);
});

test('withPeerPhases rewrites the peer body and adds phaseRefs', () => {
  const body: Record<string, never[] | string[] | string> = { cellKey: 'x', enabled: [], disabled: [] };
  withPeerPhases(body as never, { a: { enabled: ['c:1:0'] } });
  assert.deepEqual(body['phaseRefs' as never], { 'c:1:0': ['a'] });
  assert.deepEqual(body['enabled'], ['c:1:0']);
});
