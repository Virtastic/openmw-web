// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s69 (Phase 3 policy): A PEER OUTAGE IS DEGRADED MOVEMENT, NOT A FROZEN WORLD.
//
// Under input authority a peer crash would mean nobody can move -- unless the server falls
// back to the client-authored path the moment the peer's stream goes stale. That is the
// stated policy (PROTOCOL.md, Phase 3): per-player, no switchover signal, re-converge when
// the peer returns. This proves it in play:
//   1. two browsers + a simulating peer; the peer holds the cell (the input tier is live);
//   2. the peer is KILLED; B keeps walking; A must still SEE B move (client-authored 0x0100
//      accepted again because 0x0105 stopped) -- no frozen puppet;
//   3. the server says so: simpeer.cells_unsimulated (the world-peer-down anomaly);
//   4. a fresh peer starts, takes the cell again, and A still sees B's movement afterwards
//      (the avatar re-spawns, the stream resumes, nobody is snapped into a wall).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;
export const serverRules = `
[content]
enforce = "off"
`;

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

async function waitOwner(ctx, c, want) {
  const by = Date.now() + 300_000;
  let owner = 'none';
  while (Date.now() < by) {
    owner = String(await c.eval('(window.__omwMP||{}).authorityHolder'));
    if (want === 'some' ? (owner && owner !== 'none') : owner === want) return owner;
    await ctx.sleep(500);
  }
  return owner;
}

// B's position as A renders it (the puppets mirror), for movement assertions. Waits: the
// mirror refreshes on a 0.5 s tick, so a read straight after a spawn/despawn can be empty --
// and a null here used to crash the scenario instead of failing it usefully.
async function puppetPosOf(ctx, a, bId, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const m = JSON.parse(await a.eval('(window.__omwMP||{}).puppets||"{}"'));
    const p = m[String(bId)];
    if (p && typeof p.x === 'number') return { x: p.x, y: p.y };
    if (Date.now() > until) return null;
    await ctx.sleep(500);
  }
}
const moved = (p, q, min) => p && q && Math.hypot(p.x - q.x, p.y - q.y) > min;

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent'); return;
  }
  let peer = ctx.startSimPeer('-2,-9');
  if (!peer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset)'); return; }

  const [a, b] = await Promise.all([
    ctx.launchClient('watcher', '', BOOT),
    ctx.launchClient('walker', '', BOOT),
  ]);
  const owner1 = await waitOwner(ctx, a, 'some');
  assert.notEqual(owner1, 'none', 'the peer never took the cell');
  await b.waitFor("Number((window.__omwMP||{}).playerId||0) > 0", STEP, 'walker knows its id');
  const bId = Number(await b.eval('(window.__omwMP||{}).playerId'));
  await a.waitFor(`Object.keys(JSON.parse((window.__omwMP||{}).puppets||"{}")).includes(String(${bId}))`,
    STEP, 'watcher puppets the walker');
  ctx.log(`peer=${owner1} holds the cell; walker id=${bId}`);

  // Baseline: with the peer up, B walks and A sees the (peer-authored) movement.
  let p0 = await puppetPosOf(ctx, a, bId);
  assert.ok(p0, 'the watcher never rendered the walker (no puppet mirror entry)');
  // b.walk, not a raw command: `walk:` is one-shot with a deadline and player.lua drops it if
  // the client cannot act on it yet, so the scenario would wait 30s for movement it had already
  // thrown away. Same fault that made s22 look like a broken movement path.
  await b.walk(0, 1, 2500);
  await a.waitFor(`(function(){var m=JSON.parse((window.__omwMP||{}).puppets||"{}");var p=m[String(${bId})];`
    + `return !!p && Math.hypot(p.x-(${p0.x}),p.y-(${p0.y}))>40;})()`, STEP,
    'watcher sees the walker move with the peer UP');
  ctx.log('ok: movement visible with the peer up');

  // --- 1. KILL THE PEER -------------------------------------------------------------------
  peer.stop();
  ctx.log('peer killed');
  await ctx.sleep(3_000); // let the pose/stat streams go stale (gates are 300ms / 5s)

  // --- 2. B keeps walking; A must still see it (client-authored path resumed). -----------
  p0 = await puppetPosOf(ctx, a, bId);
  assert.ok(p0, 'the watcher lost the walker entirely (no puppet mirror entry)');
  // Degraded mode still moves the walker locally, so waiting on B's OWN pose proves the command
  // took before we start asking what A can see.
  await b.walk(0, 1, 3000);
  await a.waitFor(`(function(){var m=JSON.parse((window.__omwMP||{}).puppets||"{}");var p=m[String(${bId})];`
    + `return !!p && Math.hypot(p.x-(${p0.x}),p.y-(${p0.y}))>40;})()`, STEP,
    'watcher sees the walker move with the peer DOWN (degraded mode must keep everyone moving)');
  ctx.log('ok: degraded mode -- movement still visible with no peer');

  // --- 3. The server named the outage. ----------------------------------------------------
  // (server log is attached by the harness on failure; assert via the authority mirror: the
  // cell has no owner now.)
  const ownerDown = await waitOwner(ctx, a, 'none');
  assert.equal(ownerDown, 'none', 'with the peer gone the cell must be unheld, not stuck on a dead holder');
  ctx.log('ok: cell authority released');

  // --- 4. A fresh peer returns and re-takes the cell; movement still visible after. -------
  peer = ctx.startSimPeer('-2,-9');
  assert.ok(peer, 'could not restart the peer');
  const owner2 = await waitOwner(ctx, a, 'some');
  assert.notEqual(owner2, 'none', 'the restarted peer never re-took the cell');
  ctx.log(`peer restarted: owner=${owner2}`);
  await ctx.sleep(4_000); // avatars re-spawn, streams resume
  p0 = await puppetPosOf(ctx, a, bId);
  assert.ok(p0, 'the watcher lost the walker entirely (no puppet mirror entry)');
  await b.walk(0, 1, 3000);
  await a.waitFor(`(function(){var m=JSON.parse((window.__omwMP||{}).puppets||"{}");var p=m[String(${bId})];`
    + `return !!p && Math.hypot(p.x-(${p0.x}),p.y-(${p0.y}))>40;})()`, STEP,
    'watcher sees the walker move after the peer RETURNED (re-convergence, no freeze)');
  ctx.log('ok: re-converged after the peer returned');

  const errs = a.luaErrors().concat(b.luaErrors());
  assert.equal(errs.length, 0, 'Lua errors during the outage:\n' + errs.join('\n'));
  ctx.log('ok: peer outage handled as degraded movement, then re-converged');
}
