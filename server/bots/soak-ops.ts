// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The soak bots' container and loose-item traffic (backlog 87), as plain messages so a unit
// test can prove they VALIDATE against the server's handlers: a soak that only ever sent
// invalid bodies would measure the invalid-message counter and still print PASS.
// soak.ts sends these; soak-ops.test.ts sends the same against a real server.

import type { JsLike } from '../src/proto/lser';

/** One fake content ref per cell: the soak's shared chest. */
export const SOAK_CONTAINER = { __refnum: { index: 4242, contentFile: 0 } };

/** Open the chest (first opener's contents become canonical), take one gold, put one yam. */
export function containerCycle(tick: number, cellKey: string): { name: string; body: JsLike }[] {
  const ref = SOAK_CONTAINER;
  return [
    { name: 'ContainerOpen', body: { ref, cellKey, contents: [{ id: 'gold_001', n: 1000 }, { id: 'ingred_ash_yam_01', n: 50 }] } },
    { name: 'ContainerOpRequest', body: { ref, cellKey, opId: tick * 2, op: 'take', itemId: 'gold_001', n: 1 } },
    { name: 'ContainerOpRequest', body: { ref, cellKey, opId: tick * 2 + 1, op: 'put', itemId: 'ingred_ash_yam_01', n: 1 } },
  ];
}

/** Drop an item at the bot's feet; the pick-up follows once the ack names the net id. */
export function dropOp(tick: number, cellKey: string, x: number, y: number, z: number): { name: string; body: JsLike } {
  return { name: 'ObjectSpawnRequest', body: { tempId: tick, recordId: 'misc_soak_item', cellKey, x, y, z, rotZ: 0, count: 1 } };
}

export function pickOp(tick: number, cellKey: string, netId: number): { name: string; body: JsLike } {
  return { name: 'ObjectTakeRequest', body: { opId: tick, net: netId, cellKey } };
}
