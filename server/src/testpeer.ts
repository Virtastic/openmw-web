// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A SIM PEER for the BROWSER harness, and nothing else.
//
// WHY THIS FILE EXISTS. `canSimulate` is now `p.system === true`: only a sim peer may hold a
// cell's actor authority. That is right — it stops a player's browser authoring NPC state for
// everyone — but it silently retired the browser coverage of the whole M4/M5 layer.
// `s40-npc`, `s41-authority-handoff`, `s42-crowded-cell` and `s51-npc-combat` all assert that a
// CLIENT holds authority, which can no longer happen, and no browser scenario can stand up a
// peer to hold it instead. They fail with `exactly one holder: 0 !== 1`. Nobody noticed for as
// long as the wasm engine did not build, because the suite had not run.
//
// `testhost.ts` states the intended answer — "a scenario that needs a peer must stand one up
// itself (TestClient.simPeer does exactly this)" — but TestClient is TypeScript under test/,
// and the browser harness is plain .mjs run by node. This bundle is the bridge: the same
// TestClient the server suite uses, built to dist/ so a scenario can import it.
//
// A peer stood up this way HOLDS authority but does not SIMULATE: it answers the protocol, it
// does not run OpenMW. That is enough for anything asserting on routing — a hit reaching the
// cell's owner, an epoch being issued — and not enough for anything asserting NPCs actually
// move. Rewriting the four scenarios wants that distinction kept in mind.
import { TestClient } from '../test/helpers';

export { TestClient };

/**
 * Stand up a sim peer and have it take authority over `cellKey`.
 * Resolves once the Grant for that exact cell has arrived, so the caller can rely on the cell
 * having an owner from here on.
 */
export async function holdCell(
  port: number, serverPassword: string, cellKey: string, name = 'simpeer-harness',
): Promise<{ peer: TestClient; epoch: number }> {
  const peer = await TestClient.simPeer(port, serverPassword, name);
  peer.sendCellChange(cellKey, 0, 0, 0);
  const grant = await peer.waitEvent('ActorAuthorityGrant',
    (v) => (v as { cellKey: string }).cellKey === cellKey);
  return { peer, epoch: (grant.value as { epoch: number }).epoch };
}
