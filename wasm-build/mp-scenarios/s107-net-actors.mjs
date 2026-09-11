// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s107: RUNTIME-SPAWNED ACTORS ARE ONE CREATURE, NOT TWO.
//
// Levelled-list creatures (most of what you meet outdoors), PlaceAtPC/PlaceAtMe spawns and
// summons are placed at runtime with a RefNum the engine mints per process. Before 2026-09-11
// the peer rolled its own, each client rolled its own, and nothing could name one to the
// other: the client's copy was puppeted with its AI off and never got a pose (a statue), the
// peer's copy fought avatars unseen. Players took damage from a statue.
//
// Now the holder NAMES each runtime actor through the object-sync path (ObjectSpawnRequest
// actor=true), every client builds it from the record and puppets it, and the actor family
// addresses it by net id. Clients stop rolling their own once the world is known to be
// simulated (flags.simulated at join).
//
// Proven here, against retail data with the NATIVE peer: two clients snapped into -2,-7 (open
// country on the Pelagiad road; the peer named scrib / kwama forager there in a live run) must
// both (a) report local spawns OFF, (b) build at least one net actor from the holder's naming,
// and (c) see cell actors at all. Without the native peer there is nothing to assert: SKIP.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP_TIMEOUT = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
// Inside cell -2,-7: x in [-16384,-8192), y in [-57344,-49152). Where the peer's avatar stood
// in the live run that named the creatures.
const SPOT = '-12500,-53100,512';

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-7');
  if (!simPeer) {
    ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset). '
      + 'Run under wasm-build/Dockerfile.harness-peer.');
    return;
  }
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for levelled creatures)');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a', '', BOOT),
    ctx.launchClient('bot-b', '', BOOT),
  ]);

  // (a) A simulated world: the client must not roll its own creatures, from the first cell.
  await a.waitFor('window.omw.state.localSpawns === "off"', STEP_TIMEOUT, 'A has local spawns off');
  await b.waitFor('window.omw.state.localSpawns === "off"', STEP_TIMEOUT, 'B has local spawns off');

  // Out of Seyda Neen (content NPCs only) into open country where the lists roll.
  await a.cmd('snapto:' + SPOT);
  await b.cmd('snapto:' + SPOT);

  // (b) The holder named at least one runtime actor and this client BUILT it. The peer needs
  // a moment to anchor the new cell, roll, and be answered by the server.
  await a.waitFor('Number(window.omw.state.netActors||0) > 0', 120_000, 'A built a net actor the peer named');
  await b.waitFor('Number(window.omw.state.netActors||0) > 0', 120_000, 'B built a net actor the peer named');
  const na = Number(await a.eval('window.omw.state.netActors'));
  const nb = Number(await b.eval('window.omw.state.netActors'));
  ctx.log(`net actors built: A=${na} B=${nb}`);
  // Both clients were told about the same naming; a difference of one is a message in flight.
  assert.ok(Math.abs(na - nb) <= 1, `clients disagree on the named actors: A=${na} B=${nb}`);

  // (c) ...and they are actors in the cell, puppeted like the rest.
  await a.waitFor('Number(window.omw.state.actorCount||0) > 0', STEP_TIMEOUT, 'A sees cell actors');
  await b.waitFor('Number(window.omw.state.actorCount||0) > 0', STEP_TIMEOUT, 'B sees cell actors');

  ctx.log('ok: runtime-spawned creatures are the holder\'s, named once, built on every client');
}
