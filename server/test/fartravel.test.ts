// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE WAY AROUND THE SPEED ENVELOPE, closed as far as it can be without game data.
//
// The envelope forgives a cell change, because a door genuinely is a teleport — which leaves
// "declare a cell change instead of a move" as a free teleport for a modified client. The
// server ships no content and cannot tell a real door from an invented one. It does not have
// to: WALKING is always into an ADJACENT exterior cell, and a door goes through an interior, so
// an exterior-to-exterior jump across the grid is a spell, a silt strider, or a lie.
//
// Those are rare in play, so the rate is bounded rather than the act refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

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

/** Hop `n` times between far-apart exterior cells; report where the server thinks they ended. */
async function hop(server: { port: number; api: { cellOfPlayer?: (id: number) => string | undefined } },
  c: TestClient, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    c.sendCellChange(`${i * 20},${i * 20}`, i * 1000, 0, 0);
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 200));
}

test('lobby: hopping the grid faster than any spell allows stops being believed', async (t) => {
  const dataDir = tmpDataDir();
  await makeCharacter(dataDir, 'Hopper');
  const had = process.env.OMW_WORLD_ID;
  process.env.OMW_WORLD_ID = 'vvardenfell';
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public',
    configOverride: { limits: { farTravelPerMin: 3 } },
  });
  t.after(() => {
    if (had === undefined) delete process.env.OMW_WORLD_ID;
    else process.env.OMW_WORLD_ID = had;
    return server.close();
  });

  const c = await TestClient.connect(server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.login('Hopper', 'hunter22');
  await c.waitJson('SessionWelcome');
  c.sendJson({ t: 'SessionReady' });
  await c.waitEvent('PlayerList');
  await hop(server, c, 10);

  const id = server.api.players().find((p) => p.name === 'Hopper')?.id;
  assert.ok(id !== undefined, 'the player is in world');
  const cell = server.api.cellOfPlayer?.(id);
  // Cap is 3, so the 4th hop onward is refused and the server stops following them.
  assert.notEqual(cell, '180,180', `the server followed every hop to ${cell}`);
  c.close();
});

// NEGATIVE CONTROL. Outside the lobby the identical sequence is followed all the way: a private
// world is the player's own game, and this stays a counted signal there.
test('a private world follows every hop, and only counts them', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    worldMode: 'private', configOverride: { limits: { farTravelPerMin: 3 } },
  });
  t.after(() => server.close());
  const c = await TestClient.connect(server.port);
  await c.joinAsNew('Hopper2');
  await c.waitEvent('PlayerList');
  await hop(server, c, 10);

  const id = server.api.players().find((p) => p.name === 'Hopper2')?.id;
  assert.equal(server.api.cellOfPlayer?.(id!), '180,180',
    'outside the lobby this is a signal, not a gate');
  c.close();
});

// WALKING IS NOT HOPPING. Adjacent exterior cells are ordinary movement and must never count
// against the budget, however many of them a player crosses.
test('walking across many adjacent cells is never limited', async (t) => {
  const dataDir = tmpDataDir();
  await makeCharacter(dataDir, 'Walker');
  const had = process.env.OMW_WORLD_ID;
  process.env.OMW_WORLD_ID = 'vvardenfell';
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public',
    configOverride: { limits: { farTravelPerMin: 3 } },
  });
  t.after(() => {
    if (had === undefined) delete process.env.OMW_WORLD_ID;
    else process.env.OMW_WORLD_ID = had;
    return server.close();
  });
  const c = await TestClient.connect(server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.login('Walker', 'hunter22');
  await c.waitJson('SessionWelcome');
  c.sendJson({ t: 'SessionReady' });
  await c.waitEvent('PlayerList');

  for (let i = 0; i < 12; i++) {
    c.sendCellChange(`${i},0`, i * 100, 0, 0); // one cell at a time: walking
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 200));
  const id = server.api.players().find((p) => p.name === 'Walker')?.id;
  assert.equal(server.api.cellOfPlayer?.(id!), '11,0',
    'a player who walked 12 cells was treated as a teleporter');
  c.close();
});

// A DOOR IS NOT HOPPING EITHER. Interior <-> exterior is how every building works, and neither
// side of it is an exterior-to-exterior jump, so it must never be counted.
test('going in and out of doors is never limited', async (t) => {
  const dataDir = tmpDataDir();
  await makeCharacter(dataDir, 'Doorman');
  const had = process.env.OMW_WORLD_ID;
  process.env.OMW_WORLD_ID = 'vvardenfell';
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public',
    configOverride: { limits: { farTravelPerMin: 3 } },
  });
  t.after(() => {
    if (had === undefined) delete process.env.OMW_WORLD_ID;
    else process.env.OMW_WORLD_ID = had;
    return server.close();
  });
  const c = await TestClient.connect(server.port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.login('Doorman', 'hunter22');
  await c.waitJson('SessionWelcome');
  c.sendJson({ t: 'SessionReady' });
  await c.waitEvent('PlayerList');

  for (let i = 0; i < 12; i++) {
    c.sendCellChange(i % 2 === 0 ? 'balmora, south wall cornerclub' : '-3,-2', 0, 0, 0);
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 200));
  const id = server.api.players().find((p) => p.name === 'Doorman')?.id;
  assert.equal(server.api.cellOfPlayer?.(id!), '-3,-2',
    'a player using a door 12 times was treated as a teleporter');
  c.close();
});
