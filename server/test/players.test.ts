
import test from 'node:test';
// The peer's only credential; an empty [server].password refuses every system connection.
const PEER_PASS = 'peer-secret-1';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('a system peer is invisible on every human-facing surface', async (t) => {
  // maxPlayers 1 makes the exemption unmissable: a human plus a system peer must both be
  // in world, because the peer does not consume the single slot.
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: {
      server: { maxPlayers: 1, password: PEER_PASS },
      limits: { maxConnsPerIp: 16 },
    },
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
    peer.serverPassword = PEER_PASS;
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

test('OT3-71: name/char indexes follow rename and remove; a duplicate key passes on', async () => {
  const { Roster } = await import('../src/core/players');
  const roster = new Roster();
  const peer = { sendEvent() {} } as never;
  const a = roster.addAuthed('Alice', 'acc-a', 0, peer, '', 'char-1');
  const b = roster.addAuthed('alice', 'acc-b', 0, peer, '', 'char-1');
  assert.equal(roster.findByName('ALICE'), a); // first session wins, as the old scan did
  assert.equal(roster.activeForChar('char-1'), a);
  roster.remove(a);
  assert.equal(roster.findByName('Alice'), b);
  assert.equal(roster.activeForChar('char-1'), b);
  roster.rename(b, 'Bob');
  assert.equal(roster.findByName('alice'), undefined);
  assert.equal(roster.findByName('bob'), b);
  roster.remove(b);
  assert.equal(roster.findByName('bob'), undefined);
  assert.equal(roster.activeForChar('char-1'), undefined);
  assert.equal(roster.activeForChar('acc-a'), undefined); // charId default is the accountKey
});
