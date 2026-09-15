// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// DEATH BY A REAL CAUSE. The death scenarios (s22/s77/s131) killed with sethp:0 -- a client
// claim -- so death-from-damage on the peer-ruled body was never exercised (backlog 241).
// Drowning is the shorter of the two honest idioms: it needs no spell (s147's levitate
// climb) and works from wherever the scenario stands, since the sea bed is a snap away. Cell
// -3,-9 west of Seyda Neen is 1136 units deep (s149); sneak is swim-down, holding the body
// under. fHoldBreathTime is 20 s, then fSuffocationDamage (3 hp/s): a fresh character dies
// within about a minute of the peer's clock. Library, not a scenario (leading underscore).
export const SEABED = { x: -19264, y: -72128, z: -400 };

// Put the body under and hold it there. The caller waits for its own death signal (the
// respawn teleport, the host's puppet falling, the server's respawn.sent line).
export async function drown(c, ctx, holdMs = 300_000) {
  await c.cmd(`snapto:${SEABED.x},${SEABED.y},${SEABED.z}`);
  await c.waitFor('JSON.parse(window.omw.state.pose||"{}").z < -250', 30_000, 'the body is deep under water');
  await c.cmd(`walk:0,0,${holdMs}:sneak`);
  ctx.log(`under water at z=${JSON.parse(await c.eval('window.omw.state.pose||"{}"')).z.toFixed(0)}, holding until it drowns`);
}
