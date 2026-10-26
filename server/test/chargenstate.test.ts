// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// CHARGEN IS A STATE, NOT A PLACE — and the state ENDS.
//
// The opening starts in the Imperial Prison Ship, walks through ordinary Seyda Neen exterior
// (where a guard escorts you to the door), and finishes in the Census and Excise Office. The
// two rooms can be matched by name; the walk between them cannot. Matching only names left
// the peer anchoring that exterior, puppeting the guard and disabling his AI, so he delivered
// his line and never moved.
//
// The half that matters just as much: once creation finishes the cell must go straight back
// to being simulated, or every player would spend the rest of the game in an unsimulated
// world. These assert both directions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isChargenCell } from '../src/core/movement';

type P = { cellKey: string; inChargen?: boolean };

// The rule simPeerTick applies when choosing which occupied cells to anchor.
function anchorable(players: P[]): string[] {
  const inChargen = new Set(players.filter((p) => p.inChargen === true).map((p) => p.cellKey));
  return [...new Set(players.map((p) => p.cellKey))].sort()
    .filter((c) => !isChargenCell(c) && !inChargen.has(c));
}

test('the exterior leg of chargen is protected, though its name says nothing', () => {
  // -2,-9 is Seyda Neen. Nothing in the NAME marks it as part of the opening.
  assert.deepEqual(anchorable([{ cellKey: '-2,-9', inChargen: true }]), [],
    'the cell holding a player mid-creation must not be anchored');
});

test('the same cell IS anchored once creation finishes', () => {
  assert.deepEqual(anchorable([{ cellKey: '-2,-9', inChargen: false }]), ['-2,-9'],
    'after ChargenComplete the peer must simulate normally again');
  assert.deepEqual(anchorable([{ cellKey: '-2,-9' }]), ['-2,-9'],
    'a player with no flag at all is a finished character');
});

test('the named rooms stay protected regardless of the flag', () => {
  // Belt and braces: a returning player walking back through the census office must not
  // re-trigger the tutorial scripts under a peer that has them disabled.
  assert.deepEqual(anchorable([{ cellKey: 'imperial prison ship', inChargen: false }]), []);
});

test('one player creating does not unsimulate everyone else', () => {
  // Only the creator's own cell is excluded. In practice they are alone in a private world —
  // the shared world refuses characters that have not finished creation — but the rule must
  // be narrow regardless.
  assert.deepEqual(
    anchorable([{ cellKey: '-2,-9', inChargen: true }, { cellKey: '3,4' }, { cellKey: '-15,2' }]),
    ['-15,2', '3,4'],
  );
});

// AND THE PLAYER IS TOLD. Creation ends where the player stands -- the exterior the sanctuary
// kept unheld, so they were never made an occupant of it (worldstate.authorityEnter skips a
// creating player). The peer re-claimed on its next pass, Info went to the occupants, and the
// new character was not one: their client kept "no holder" over the peer's puppets (s187).
test('finishing creation makes the player an occupant, so the peer\'s claim reaches them', async (t) => {
  const { startServer } = await import('../src/server');
  const { TestClient, tmpDataDir } = await import('./helpers');
  const PASS = 'peer-secret-1';
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PASS);
  t.after(() => peer.close());

  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  b.hello();
  await b.waitJson('SessionHelloOk');
  b.register('Newbie', 'hunter22', { characterId: 'c' + 'ab'.repeat(12) }); // provisional = in creation
  await b.waitJson('SessionWelcome');
  b.sendJson({ t: 'SessionReady' });
  b.sendCellChange('-2,-9', 0, 0, 0);
  await b.waitEvent('PlayerCellChange');

  b.sendEvent('ChargenComplete', {});
  b.sendEvent('ChatSend', { text: 'fence' });
  await b.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'fence');

  peer.sendCellChange('-2,-9', 0, 0, 0);
  const info = await b.waitEvent('ActorAuthorityInfo', (v) => (v as { cellKey?: string }).cellKey === '-2,-9');
  assert.equal((info.value as { holderId?: number }).holderId, peer.playerId);
});

// AND NO ONE ELSE'S SCRIPT LOCALS (prod 2026-10-26). The dock guard's CharGenRaceNPC keeps
// its step in a member var `state`; the peer's headless copy ran the whole dock sequence to
// -1 in a second and a half, and that -1 -- relayed live, and stored for the cell snapshot --
// skipped the client past Enableracemenu/EnablePlayerControls: controls off, no race menu.
test('a character in creation neither receives nor files script locals; a finished one still does', async (t) => {
  const { startServer } = await import('../src/server');
  const { TestClient, tmpDataDir } = await import('./helpers');
  const PASS = 'peer-secret-1';
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PASS);
  t.after(() => peer.close());
  const mv = (n: string) => (v: unknown) => (v as { name?: string })?.name === n;
  const atDock = (v: unknown) => (v as { cellKey?: string }).cellKey === '-2,-9';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const done = await TestClient.connect(server.port);
  t.after(() => done.close());
  await done.joinAsNew('Veteran');
  await done.waitEvent('PlayerList');
  done.sendCellChange('-2,-9', 0, 0, 0);

  const newbie = async (name: string, hex: string) => {
    const c = await TestClient.connect(server.port);
    t.after(() => c.close());
    c.hello();
    await c.waitJson('SessionHelloOk');
    c.register(name, 'hunter22', { characterId: 'c' + hex.repeat(12) }); // provisional = in creation
    await c.waitJson('SessionWelcome');
    c.sendJson({ t: 'SessionReady' });
    c.sendCellChange('-2,-9', 0, 0, 0);
    return c;
  };
  const b = await newbie('Newbie', 'ab');
  await b.waitEvent('WorldCellState', atDock, 3000);
  await sleep(200);

  // The peer's copy of the guard finishes the sequence.
  peer.sendEvent('MemberVarUpdate', { net: 41, name: 'state', value: -1, cellKey: '-2,-9' });
  const got = await done.waitEvent('MemberVarUpdate', mv('state'), 3000);
  assert.equal((got.value as { value?: number }).value, -1, "a finished character in the cell still gets the peer's locals");
  // The creating client's own guard writes go nowhere.
  b.sendEvent('MemberVarUpdate', { net: 42, name: 'chargen_own', value: 30, cellKey: '-2,-9' });
  b.sendEvent('ChatSend', { text: 'fence' });
  await done.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'fence', 3000);
  await sleep(200);
  assert.equal(b.inbox.events.filter((e) => e.name === 'MemberVarUpdate').length, 0,
    "the peer's guard state must not reach a character still in creation");
  assert.equal(done.inbox.events.filter((e) => e.name === 'MemberVarUpdate' && mv('chargen_own')(e.value)).length, 0,
    "a creating character's locals are not relayed");

  // The stored -1 does not meet the NEXT new character either; a finished one is restored it.
  const c = await newbie('Second', 'cd');
  const snap = await c.waitEvent('WorldCellState', atDock, 3000);
  assert.equal((snap.value as { memberVars?: unknown }).memberVars, undefined, "no stored locals in a creating player's cell snapshot");
  const v = await TestClient.connect(server.port);
  t.after(() => v.close());
  await v.joinAsNew('Later');
  await v.waitEvent('PlayerList');
  v.sendCellChange('-2,-9', 0, 0, 0);
  const vs = await v.waitEvent('WorldCellState', atDock, 3000);
  const vars = (vs.value as { memberVars?: Record<string, Record<string, number>> }).memberVars ?? {};
  assert.deepEqual(Object.values(vars).map((o) => o['state']), [-1], 'a finished character is restored the stored state');
  assert.ok(!Object.values(vars).some((o) => 'chargen_own' in o), 'nothing a creating character wrote was filed');
});
