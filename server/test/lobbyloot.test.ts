// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// LOOT IS LOBBY-LOCAL. The gateway's public world is a social lobby with no quest progress and
// no stakes — but inventory used to persist straight out of it, and quest items never deplete
// from a container (core/quests.ts), so N strangers could each take the same Dwemer Puzzle Box
// and keep it on their real character forever. The comment guarding this claimed the lobby was
// safe because "its cells reset by construction"; [cellReset] cells is empty by default.
//
// Containment, not policing: in lobby mode the character doc is never written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerStore } from '../src/persist/playerstore';
import { tmpDataDir } from './helpers';

const CHAR = 'char-ann';

test('lobby mode: what you pick up in the lobby never reaches the character on disk', async () => {
  const dir = tmpDataDir();

  // At home: the character owns one dagger, written for real.
  const home = new PlayerStore(dir, 'priv-ann');
  home.update(CHAR, (d) => { d.inventory = [{ id: 'iron_dagger', n: 1 }]; }, 'now');
  await home.flushKey(CHAR);
  await home.close();

  // In the lobby: they loot the Puzzle Box and flush at every opportunity.
  const lobby = new PlayerStore(dir, 'vvardenfell', { lobby: true });
  assert.equal(lobby.isLobby, true, 'the mode was actually applied');
  const carried = await lobby.get(CHAR);
  assert.deepEqual(carried?.inventory, [{ id: 'iron_dagger', n: 1 }], 'arrives with their gear');
  lobby.update(CHAR, (d) => {
    d.inventory = [{ id: 'iron_dagger', n: 1 }, { id: 'dwemer puzzle box', n: 1 }];
  }, 'now');
  await lobby.flushKey(CHAR);
  await lobby.flushAll();
  await lobby.close(); // shutdown is a flush point too, and must not be a leak

  // Home again: exactly what they walked in with.
  const back = new PlayerStore(dir, 'priv-ann');
  const doc = await back.get(CHAR);
  assert.deepEqual(doc?.inventory, [{ id: 'iron_dagger', n: 1 }],
    'the puzzle box did not follow them out of the lobby');
  await back.close();
});

// THE OTHER DIRECTION, which is what sank the previous attempt at this. An item LOST in the
// lobby must also not follow you home — you leave with exactly what you had, both ways. That is
// only sound because neither copy can escape the lobby, which is the whole containment argument.
test('lobby mode: what you lose in the lobby does not follow you home either', async () => {
  const dir = tmpDataDir();
  const home = new PlayerStore(dir, 'priv-bob');
  home.update(CHAR, (d) => { d.inventory = [{ id: 'ebony_shield', n: 1 }]; }, 'now');
  await home.flushKey(CHAR);
  await home.close();

  const lobby = new PlayerStore(dir, 'vvardenfell', { lobby: true });
  lobby.update(CHAR, (d) => { d.inventory = []; }, 'now'); // dropped it in the lobby
  await lobby.flushAll();
  await lobby.close();

  const back = new PlayerStore(dir, 'priv-bob');
  assert.deepEqual((await back.get(CHAR))?.inventory, [{ id: 'ebony_shield', n: 1 }],
    'still theirs: the loss was lobby-local too');
  await back.close();
});

// A RECONNECT IS NOT A RESET. Nothing is on disk to re-read, so releasing the doc outright
// would make a three-second blip look like the lobby confiscating everything picked up.
test('lobby mode: a reconnect inside the retain window keeps the lobby session', async () => {
  const dir = tmpDataDir();
  const lobby = new PlayerStore(dir, 'vvardenfell', { lobby: true, lobbyRetainMs: 60_000 });
  lobby.update(CHAR, (d) => { d.inventory = [{ id: 'lobby_loot', n: 1 }]; }, 'now');
  await lobby.releaseCached(CHAR); // the disconnect path
  const rejoined = await lobby.get(CHAR);
  assert.deepEqual(rejoined?.inventory, [{ id: 'lobby_loot', n: 1 }],
    'came straight back to what they were holding');
  await lobby.close();
});

// ...but a RETURN is. Past the window the held doc is dropped, so a player coming back later
// gets their real character rather than a stale lobby snapshot masquerading as a second save.
test('lobby mode: past the retain window the real character is served instead', async () => {
  const dir = tmpDataDir();
  const home = new PlayerStore(dir, 'priv-cid');
  home.update(CHAR, (d) => { d.inventory = [{ id: 'real_sword', n: 1 }]; }, 'now');
  await home.flushKey(CHAR);
  await home.close();

  const lobby = new PlayerStore(dir, 'vvardenfell', { lobby: true, lobbyRetainMs: 0 });
  lobby.update(CHAR, (d) => { d.inventory = [{ id: 'lobby_loot', n: 1 }]; }, 'now');
  await lobby.releaseCached(CHAR);
  await new Promise((r) => setTimeout(r, 5)); // outlive a zero-length window
  assert.deepEqual((await lobby.get(CHAR))?.inventory, [{ id: 'real_sword', n: 1 }],
    'the stale lobby doc was not resurrected');
  await lobby.close();
});

// NEGATIVE CONTROL. The SAME writes, with lobby mode off, DO persist — so the tests above are
// containment working, not the store silently failing to save anything. Removing the `lobby`
// check in flushKey makes the first test fail and this one keep passing.
test('a normal world still persists exactly these writes', async () => {
  const dir = tmpDataDir();
  const world = new PlayerStore(dir, 'priv-dee');
  world.update(CHAR, (d) => { d.inventory = [{ id: 'dwemer puzzle box', n: 1 }]; }, 'now');
  await world.flushKey(CHAR);
  await world.close();

  const again = new PlayerStore(dir, 'priv-dee');
  assert.deepEqual((await again.get(CHAR))?.inventory, [{ id: 'dwemer puzzle box', n: 1 }],
    'a real world saves what the lobby discards');
  await again.close();
});
