// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s32 (M3): rotating doors + locks over CONTENT refs (the demo Village's WhiteFortDoor*
// instances — this exercises the RefNum ref path end to end: GObject -> LSER 'o' ->
// server refKey -> relayed 'o' -> GObject on the peer).
// A toggles the nearest door -> B sees it open; A locks it -> B sees locked; unlock relays.
import assert from 'node:assert/strict';

const STEP_TIMEOUT = 15_000;

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a'),
    ctx.launchClient('bot-b'),
  ]);
  // Both spawn at the same point, so "nearest door" resolves to the SAME content ref.
  await a.waitFor('(window.__omwMP||{}).doorOpen === "false"', STEP_TIMEOUT, 'door mirror live on A');
  await b.waitFor('(window.__omwMP||{}).doorOpen === "false"', STEP_TIMEOUT, 'door mirror live on B');

  // Open.
  await a.eval(`Module.__omwMPCmd='door:toggle'`);
  await a.waitFor('(window.__omwMP||{}).doorOpen === "true"', STEP_TIMEOUT, 'door opens locally on A');
  const t0 = Date.now();
  await b.waitFor('(window.__omwMP||{}).doorOpen === "true"', STEP_TIMEOUT, 'door opens on B (relay)');
  ctx.log(`ok: door open relayed in ~${Date.now() - t0}ms`);

  // Lock (a locked door in MW auto-closes; lock state is the assert here).
  await a.eval(`Module.__omwMPCmd='door:lock:50'`);
  await a.waitFor('(window.__omwMP||{}).doorLocked === "true"', STEP_TIMEOUT, 'door locked on A');
  await b.waitFor('(window.__omwMP||{}).doorLocked === "true"', STEP_TIMEOUT, 'lock relayed to B');

  // Unlock.
  await b.eval(`Module.__omwMPCmd='door:unlock'`);
  await b.waitFor('(window.__omwMP||{}).doorLocked === "false"', STEP_TIMEOUT, 'door unlocked on B');
  await a.waitFor('(window.__omwMP||{}).doorLocked === "false"', STEP_TIMEOUT, 'unlock relayed to A');
  ctx.log('ok: lock/unlock relayed both directions');
}
