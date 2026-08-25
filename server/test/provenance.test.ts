// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// "You cannot drop what you do not have" — finally enforceable.
//
// Two things blocked it. fromInventory fixed the first (this op is the generic "place an
// object", which scripts use for things nobody carries). The second was a RACE: the server
// judged against a 2 s inventory snapshot, so a player who picks something up and drops it
// immediately outruns their own declaration. Enforcement built on that stale picture was
// implemented and backed out. PlayerItemAcquired credits acquisitions per event, so the
// question can now be answered in time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const CELL = '0,0';

async function joined(server: { port: number }, name: string): Promise<TestClient> {
  const c = await TestClient.connect(server.port);
  await c.joinAsNew(name);
  await c.waitEvent('PlayerList');
  c.sendCellChange(CELL, 0, 0, 0);
  await c.waitEvent('PlayerCellChange');
  return c;
}

async function serverWith(t: { after: (fn: () => unknown) => void }, refuse: boolean) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { economy: { refuseUnownedDrops: refuse } },
  });
  t.after(() => server.close());
  return server;
}

/** Ask to drop `n` of `recordId` and report whether the server acknowledged the spawn.
 *  Matched on tempId because one client makes several requests here, and a refusal is the
 *  ABSENCE of an ack — so the wait must be short and its timeout is the expected outcome. */
async function tryDrop(c: TestClient, recordId: string, n: number, tempId: number): Promise<boolean> {
  c.sendEvent('ObjectSpawnRequest', {
    tempId, recordId, cellKey: CELL, x: 0, y: 0, z: 0, rotZ: 0, count: n, fromInventory: true,
  });
  const ack = await c
    .waitEvent('ObjectSpawnAck', (v) => (v as { tempId?: number }).tempId === tempId, 1000)
    .catch(() => undefined);
  return ack !== undefined;
}

test('a drop of something never declared is refused when enforcement is on', async (t) => {
  const server = await serverWith(t, true);
  const c = await joined(server, 'Faker');
  c.sendEvent('PlayerInventory', { items: [{ id: 'iron_dagger', n: 1 }] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await tryDrop(c, 'daedric_claymore', 1, 1), false, 'dropped a sword it never had');
  assert.equal(await tryDrop(c, 'iron_dagger', 1, 2), true, 'and the real dagger still drops');
  c.close();
});

// THE RACE THIS EXISTS TO CLOSE, and the reason enforcement was backed out last time. Picking
// something up and dropping it before the 2 s snapshot catches up is ORDINARY PLAY. With the
// per-event credit the server knows in time; without it this is a false refusal on a real player.
test('pick up then drop immediately: credited by the acquisition report, not refused', async (t) => {
  const server = await serverWith(t, true);
  const c = await joined(server, 'Quick');
  c.sendEvent('PlayerInventory', { items: [] });          // declared: nothing
  await new Promise((r) => setTimeout(r, 100));
  c.sendEvent('PlayerItemAcquired', { id: 'ebony_shield', n: 1 }); // just picked it up
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await tryDrop(c, 'ebony_shield', 1, 3), true,
    'refused a drop the player had legitimately just acquired');
  c.close();
});

// The credit is spent by the snapshot that supersedes it. Otherwise one pickup would fund
// unlimited drops, since the ledger would keep crediting an item the snapshot already counts.
test('credit is cleared by the snapshot that includes it', async (t) => {
  const server = await serverWith(t, true);
  const c = await joined(server, 'Doubler');
  c.sendEvent('PlayerInventory', { items: [] });
  c.sendEvent('PlayerItemAcquired', { id: 'gold_001', n: 5 });
  await new Promise((r) => setTimeout(r, 50));
  // The snapshot now accounts for those 5 and supersedes the credit.
  c.sendEvent('PlayerInventory', { items: [{ id: 'gold_001', n: 5 }] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await tryDrop(c, 'gold_001', 5, 4), true, 'the 5 they actually hold');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await tryDrop(c, 'gold_001', 20, 5), false, 'but not four times that');
  c.close();
});

// NEGATIVE CONTROL. With enforcement off — the shipped default — the SAME forged drop is
// allowed through and merely counted, which is the behaviour every existing scenario relies on.
// Proves the refusals above are the new gate rather than something else dropping the frames.
test('with enforcement off the forged drop is allowed, and only counted', async (t) => {
  const server = await serverWith(t, false);
  const c = await joined(server, 'Unpoliced');
  c.sendEvent('PlayerInventory', { items: [{ id: 'iron_dagger', n: 1 }] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await tryDrop(c, 'daedric_claymore', 1, 6), true,
    'the default must stay permissive until the scenarios have proven the credit path');
  c.close();
});

// A CREDIT IS SPENT WHEN IT IS USED, and this is the hole that made me look twice.
//
// The credit exists because the inventory snapshot is a 2 s diff. But a snapshot is only sent
// when the inventory CHANGES — and acquire-then-drop leaves it unchanged. So no snapshot ever
// arrives to supersede the credit, it sits there indefinitely, and it funds a SECOND drop of a
// thing that was only ever picked up once. That is a dupe with extra steps.
test('one pickup funds exactly one drop, not an unlimited supply', async (t) => {
  const server = await serverWith(t, true);
  const c = await joined(server, 'Doubler2');
  c.sendEvent('PlayerInventory', { items: [] });
  await new Promise((r) => setTimeout(r, 100));
  c.sendEvent('PlayerItemAcquired', { id: 'silver_dagger', n: 1 });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(await tryDrop(c, 'silver_dagger', 1, 20), true, 'the one they actually picked up');
  await new Promise((r) => setTimeout(r, 50));
  // No PlayerInventory in between: acquire-then-drop is a net no-op, so the client has no
  // reason to send one. The credit must already be gone regardless.
  assert.equal(await tryDrop(c, 'silver_dagger', 1, 21), false,
    'the same pickup was spent twice — that is a dupe');
  c.close();
});

// ...and a PARTIAL spend leaves the remainder. Picking up five and dropping two must not
// forfeit the other three, or the guard becomes a punishment for ordinary play.
test('a partial drop leaves the rest of the credit intact', async (t) => {
  const server = await serverWith(t, true);
  const c = await joined(server, 'Partial');
  c.sendEvent('PlayerInventory', { items: [] });
  await new Promise((r) => setTimeout(r, 100));
  c.sendEvent('PlayerItemAcquired', { id: 'gold_001', n: 5 });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(await tryDrop(c, 'gold_001', 2, 22), true, 'two of the five');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await tryDrop(c, 'gold_001', 3, 23), true, 'and the remaining three');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await tryDrop(c, 'gold_001', 1, 24), false, 'but not a sixth');
  c.close();
});
