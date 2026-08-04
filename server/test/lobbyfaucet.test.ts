// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE SHARED WORLD IS NOT AN ITEM FAUCET.
//
// Its cells reset on a timer so it does not stay stripped for new arrivals, and what a
// character is carrying now follows them home (it has to, or dropping something there does
// not stick). Those two rules together are an infinite item source: loot a chest, wait for
// the reset, loot it again, walk home with all of it. Nobody has to exploit anything — it is
// simply what the rules do when combined.
//
// So a reset in the shared world clears everything it always did EXCEPT the container
// contents: looted stays looted. A campaign world still restocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CellStore } from '../src/persist/cellstore';
import { tmpDataDir } from './helpers';

const CELL = '0,0';
const KEY = 'c:42:0';

async function lootedCell(store: CellStore) {
  const doc = await store.get(CELL);
  // First sight records `origin`; the player then empties it.
  doc.containers[KEY] = { items: [], stateSeq: 1, origin: [{ id: 'gold_001', n: 100 }] };
  store.markDirty(CELL);
  await store.flushAll();
}

test('a campaign world restocks a looted container on reset', async () => {
  const store = new CellStore(tmpDataDir()); // default: restock
  await lootedCell(store);
  const after = await store.resetCell(CELL);
  assert.deepEqual(after.containers[KEY]?.items, [{ id: 'gold_001', n: 100 }],
    'a private world must restock, or it stays stripped forever');
});

test('the shared world leaves a looted container looted', async () => {
  const store = new CellStore(tmpDataDir(), false); // public world
  await lootedCell(store);
  const after = await store.resetCell(CELL);
  // The looted row is CARRIED FORWARD, still empty — not dropped. A dropped row re-armed the
  // faucet one door over: containerOpen treats a missing row as "first open" and adopts the
  // opener's client-declared contents, so deletion here meant a full re-seed on next open.
  assert.deepEqual(after.containers[KEY]?.items, [],
    'the shared world restocked (or forgot) a container the player had already emptied');
  assert.ok((after.containers[KEY]?.stateSeq ?? 0) > 1, 'seq must keep climbing across the reset');
});
