
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('a system peer is invisible on every human-facing surface', async (t) => {
  // maxPlayers 1 makes the exemption unmissable: a human plus a system peer must both be
  // in world, because the peer does not consume the single slot.
  const server = await startServer({
    dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { server: { maxPlayers: 1 }, limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());

  // Human joins FIRST so the peer's arrival has an audience — that is the case that
  // actually exercises the PlayerJoinWorld suppression. (Peer-first would find nobody to
  // announce to and pass vacuously.)
  const human = await TestClient.connect(server.port);
  const { playerId: humanId } = await human.joinAsNew('Alice');
  await human.waitEvent('PlayerList');

  const peer = await TestClient.connect(server.port);
  peer.system = true;
  const { playerId: peerId } = await peer.joinAsNew('simpeer'); // must NOT be refused SERVER_FULL despite maxPlayers 1
  await peer.waitEvent('PlayerList');
  // Let any (erroneous) join broadcast reach the human before we check.
  await new Promise((r) => setTimeout(r, 300));

  // /status: the peer counts for nothing and is not listed.
  const status = await (await fetch(`http://127.0.0.1:${server.port}/status`)).json() as
    { playerCount: number; players: { id: number; name: string }[] };
  assert.equal(status.playerCount, 1, 'the sim peer must not be counted');
  assert.ok(!status.players.some((p) => p.id === peerId), 'the sim peer must not be listed');
  assert.ok(status.players.some((p) => p.id === humanId), 'the human must be listed');

  // The human, already in-world, must NOT have been told the peer joined — otherwise it
  // spawns a puppet NPC standing where the peer "is".
  const strayJoin = human.inbox.events.filter(
    (e) => e.name === 'PlayerJoinWorld' && (e.value as { id?: number }).id === peerId);
  assert.equal(strayJoin.length, 0, 'the human must not be told the sim peer joined');
});
