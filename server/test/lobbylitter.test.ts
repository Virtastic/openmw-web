// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE SHARED LOBBY IS THE ONE WORLD NOBODY TIDIES. Anything strangers drop there stays on the
// ground forever — its cell docs only ever grow, and every new arrival pays to download the
// accumulated rubbish. [cellReset] cannot cover it: that takes an explicit cell LIST, and
// nobody can enumerate the cells of a game the server has no data for.
//
// This is only safe because the lobby persists nothing (see lobbyloot.test.ts): an item on its
// ground could never have become anyone's property. In a world where loot CAN leave, the same
// sweep would be destroying real progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const CELL = '7,7';

/** A character created in its own world, so the lobby's chargen gate admits it later. */
async function makeCharacter(dataDir: string, name: string): Promise<void> {
  const solo = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'private',
  });
  const a = await TestClient.connect(solo.port);
  await a.joinAsNew(name);
  await a.waitEvent('PlayerList');
  a.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name,
  });
  a.sendEvent('ChargenComplete', {});
  a.close();
  await a.closed;
  await solo.flush();
  await solo.close();
}

async function loginTo(server: { port: number }, name: string): Promise<TestClient> {
  const c = await TestClient.connect(server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.login(name, 'hunter22');
  await c.waitJson('SessionWelcome');
  c.sendJson({ t: 'SessionReady' });
  await c.waitEvent('PlayerList');
  return c;
}

async function withLobby<T>(fn: () => Promise<T>): Promise<T> {
  const had = process.env.OMW_WORLD_ID;
  process.env.OMW_WORLD_ID = 'vvardenfell';
  try {
    return await fn();
  } finally {
    if (had === undefined) delete process.env.OMW_WORLD_ID;
    else process.env.OMW_WORLD_ID = had;
  }
}

/** How many objects the server currently believes are lying in `CELL`.
 *
 *  waitEvent CONSUMES the matched event, and entering a cell already delivers one
 *  WorldCellState — so a resync that did not first drain that one would keep answering with
 *  the empty snapshot taken at entry, and report 0 forever. Drain, then ask. */
async function placedCount(c: TestClient): Promise<number> {
  for (let i = c.inbox.events.length - 1; i >= 0; i--) {
    if (c.inbox.events[i]!.name === 'WorldCellState') c.inbox.events.splice(i, 1);
  }
  c.sendEvent('ResyncRequest', { cellKey: CELL });
  const st = await c.waitEvent('WorldCellState',
    (v) => (v as { cellKey?: string }).cellKey === CELL, 4000);
  const placed = (st.value as { placed?: Record<string, unknown> }).placed ?? {};
  return Object.keys(placed).length;
}

test('the lobby sweeps up what strangers leave on the ground', async (t) => {
  await withLobby(async () => {
    const dataDir = tmpDataDir();
    await makeCharacter(dataDir, 'Litterer');
    const server = await startServer({
      requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
      worldMode: 'public',
      // 1 s so the hourly default does not make this a one-hour test.
      configOverride: { cellReset: { litterSweepSec: 1 } },
    });
    t.after(() => server.close());

    const litterer = await loginTo(server, 'Litterer');
    litterer.sendCellChange(CELL, 0, 0, 0);
    await litterer.waitEvent('PlayerCellChange');
    litterer.sendEvent('ObjectSpawnRequest', {
      tempId: 1, recordId: 'iron_dagger', cellKey: CELL, x: 1, y: 2, z: 3, rotZ: 0, count: 1 });
    await litterer.waitEvent('ObjectSpawnAck');
    assert.equal(await placedCount(litterer), 1, 'the drop was recorded at all');

    // LEAVE. The sweep deliberately skips cells with players standing in them — resetting under
    // someone's feet is a jolt they did not ask for, and a busy cell will just be re-littered.
    litterer.sendCellChange('0,0', 0, 0, 0);
    await litterer.waitEvent('PlayerCellChange');

    const swept = await waitFor(async () => (await placedCount(litterer)) === 0, 8000);
    assert.ok(swept, 'the lobby never swept the abandoned cell');
    litterer.close();
  });
});

test('a cell somebody is standing in is left alone', async (t) => {
  await withLobby(async () => {
    const dataDir = tmpDataDir();
    await makeCharacter(dataDir, 'Stayer');
    const server = await startServer({
      requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
      worldMode: 'public', configOverride: { cellReset: { litterSweepSec: 1 } },
    });
    t.after(() => server.close());

    const c = await loginTo(server, 'Stayer');
    c.sendCellChange(CELL, 0, 0, 0);
    await c.waitEvent('PlayerCellChange');
    c.sendEvent('ObjectSpawnRequest', {
      tempId: 2, recordId: 'iron_dagger', cellKey: CELL, x: 1, y: 2, z: 3, rotZ: 0, count: 1 });
    await c.waitEvent('ObjectSpawnAck');

    // Stay put across several sweep intervals.
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(await placedCount(c), 1, 'the sweep reset a cell with a player in it');
    c.close();
  });
});

// NEGATIVE CONTROL. A PRIVATE world is somebody's campaign — an item on its floor is their
// property, and sweeping it would be destroying real progress. litterSweepSec is only passed
// through for the shared lobby, so the identical drop must survive here.
test('a private world never sweeps: that is somebody property', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    worldMode: 'private', configOverride: { cellReset: { litterSweepSec: 1 } },
  });
  t.after(() => server.close());

  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Owner');
  await c.waitEvent('PlayerList');
  c.sendCellChange(CELL, 0, 0, 0);
  await c.waitEvent('PlayerCellChange');
  c.sendEvent('ObjectSpawnRequest', {
    tempId: 3, recordId: 'ebony_shield', cellKey: CELL, x: 1, y: 2, z: 3, rotZ: 0, count: 1 });
  await c.waitEvent('ObjectSpawnAck');
  c.sendCellChange('0,0', 0, 0, 0);   // walk away, exactly as in the first test
  await c.waitEvent('PlayerCellChange');

  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(await placedCount(c), 1, 'a private world swept away the owner own belongings');
  c.close();
});

/** Poll `cond` until true or the deadline passes. */
async function waitFor(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
