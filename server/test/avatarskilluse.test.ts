// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Backlog 307: the peer's avatar takes a hit on its armour or blocks; the use reaches the
// OWNER as SelfSkillUse so their I.SkillProgression counts it. Armour/block family only,
// world peer only, bounded per owner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

const PEER_PASS = 'peer-secret-1';

async function world(t: { after(fn: () => unknown): void }) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { password: PEER_PASS }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const peer = await TestClient.simPeer(server.port, PEER_PASS);
  t.after(() => peer.close());
  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  const welcome = await a.joinAsNew('Tank');
  a.playerId = welcome['playerId'] as number;
  await a.waitEvent('PlayerList');
  a.sendCellChange('0,0', 0, 0, 0);
  return { server, peer, a };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

test('an armour/block use on the avatar reaches the owner; other skills and forgeries do not', async (t) => {
  const { server, peer, a } = await world(t);
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Forger');
  await b.waitEvent('PlayerList');

  peer.sendEvent('AvatarSkillUse', { id: a.playerId, skill: 'heavyarmor', useType: 0 });
  const got = await a.waitEvent('SelfSkillUse');
  assert.deepEqual(got.value, { skill: 'heavyarmor', useType: 0 });

  peer.sendEvent('AvatarSkillUse', { id: a.playerId, skill: 'longblade', useType: 0 }); // not the family
  peer.sendEvent('AvatarSkillUse', { id: a.playerId, skill: 'block', useType: 7 }); // no such use type
  b.sendEvent('AvatarSkillUse', { id: a.playerId, skill: 'block', useType: 0 }); // not the peer
  await settle();
  await assert.rejects(a.waitEvent('SelfSkillUse', () => true, 200), 'nothing else must be forwarded');
});

test('the per-owner budget caps a flood at 10 per second', async (t) => {
  const { peer, a } = await world(t);
  for (let i = 0; i < 30; i++) peer.sendEvent('AvatarSkillUse', { id: a.playerId, skill: 'block', useType: 0 });
  await settle();
  let n = 0;
  for (;;) {
    try { await a.waitEvent('SelfSkillUse', () => true, 100); n++; } catch { break; }
  }
  assert.equal(n, 10);
});
