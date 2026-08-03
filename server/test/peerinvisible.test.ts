// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE SIM PEER HAS AN AVATAR AND IT MUST NEVER BE SEEN.
//
// The peer is a real OpenMW client with a body standing wherever it simulates from. Its pose
// was broadcast like any player's, so every client spawned a PUPPET of it — a silent NPC
// named "player <id>" (the roster excludes system peers, so puppet naming fell back to that)
// standing in the room. During character creation that is a stranger in the prison ship,
// which is exactly what was reported.
//
// Asymmetric by design: the peer must still RECEIVE player positions, because it has to know
// where players are to simulate around them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveBroadcaster } from '../src/core/movement';
import type { Player } from '../src/core/players';

function player(id: number, system: boolean): Player {
  return {
    id, name: `p${id}`, cellKey: '0,0', system,
    pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, animVel: 0, counter: 0 },
    poseVersion: 1, peer: { sendBinaryFrame() {}, sendEvent() {} },
  } as unknown as Player;
}

test('a system peer is never a movement SENDER, but still a recipient', () => {
  const human = player(1, false);
  const peer = player(2, true);
  const sent: number[] = [];
  (peer as unknown as { peer: { sendBinaryFrame: () => void } }).peer.sendBinaryFrame = () => sent.push(2);

  const roster = { inWorld: () => [human, peer] } as unknown as ConstructorParameters<typeof MoveBroadcaster>[0];
  const b = new MoveBroadcaster(roster);
  b.tick();

  // The peer occupies the same cell as the human. If it were a sender, the human's batch
  // would carry its pose and the client would spawn a puppet for id 2.
  const views = (b as unknown as { perRecipient: Map<number, Map<number, unknown>> }).perRecipient;
  const humanSees = views.get(human.id);
  assert.ok(humanSees, 'the human must be a recipient');
  assert.equal(humanSees!.has(peer.id), false, 'a player must never receive the sim peer as a peer view');

  // ...and the peer itself is still a recipient, so it learns where players are.
  assert.ok(views.has(peer.id), 'the peer must still receive player positions');
  assert.equal(views.get(peer.id)!.has(human.id), true, 'the peer must see the human');
});
