// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s119: THE PEER DIES AND COMES BACK, AND THE WORLD PICKS UP. s69 proves degraded movement
// while a hand-spawned peer is gone; nothing proved the SERVER noticing its own peer die,
// restarting it (simpeer.ts backoff), re-anchoring the occupied cells and handing the NPCs
// back to a body that can simulate them. A peer crash is the one outage a live world will
// certainly see; if the restart does not put the NPCs back under authority, the fight a
// player was in freezes forever and every swing after it says nothing.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

export const managedPeer = true;
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const holderOf = async (c) => String(await c.eval('window.omw.state.authorityHolder||"none"'));
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));

async function waitHolder(ctx, c, pred, ms, what) {
  const by = Date.now() + ms;
  let h = 'none';
  while (Date.now() < by) {
    h = await holderOf(c);
    if (pred(h)) return h;
    await ctx.sleep(500);
  }
  throw new Error(`${what}: holder=${h}`);
}

async function killAndProve(ctx, a, b, victim) {
  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  const deadline = Date.now() + 90_000;
  let died = false;
  while (Date.now() < deadline && !died) {
    await a.cmd(`hitn:${victim}:40`);
    await b.cmd(`hitn:${victim}:40`);
    await ctx.sleep(600);
    died = (await a.eval(deadExpr)) === true || (await b.eval(deadExpr)) === true;
  }
  return died;
}

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  const first = await waitHolder(ctx, a, (h) => h !== 'none', 300_000, 'the server never brought its peer up');
  await b.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', STEP, 'B sees the holder too');
  ctx.log(`the server's peer holds the cell (holder=${first})`);

  // Kill it. The engine ignores TERM (mp-harness startSimPeer.stop), so KILL, like a crash.
  // By exact process name: `pkill -f <path>` matches the shell running it and reports failure.
  let killed = '';
  try { killed = execSync('pgrep -x openmw | xargs -r kill -9; pgrep -x openmw | wc -l', { encoding: 'utf8' }).trim(); } catch (e) { killed = 'kill failed: ' + e.message; }
  ctx.log(`peer killed (openmw processes left: ${killed})`);
  const gone = await waitHolder(ctx, a, (h) => h === 'none', 120_000, 'the server never noticed its peer die (authority still held)');
  ctx.log(`authority dropped (holder=${gone})`);

  // ...and back. The server restarts it after its backoff and re-anchors the occupied cell.
  const second = await waitHolder(ctx, a, (h) => h !== 'none', 300_000, 'the server never restarted its peer (or it never re-took the cell)');
  ctx.log(`a peer holds the cell again (holder=${second})`);
  await b.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', STEP, 'B sees the new holder');
  for (const c of [a, b]) await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 60_000, `${c.name} puppets the cell actors under the new peer`);

  // The world is simulated again: a fight resolves.
  const [pa, pb] = await Promise.all([probeOf(a), probeOf(b)]);
  const victim = Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard && !/mudcrab|scrib|rat|slaughterfish|kwama/.test(r));
  assert.ok(victim, 'need a living NPC both see after the restart');
  const died = await killAndProve(ctx, a, b, victim);
  assert.ok(died, `"${victim}" never died after the peer restart: the new peer is not simulating the cell the players stand in`);
  ctx.log(`ok: the peer died, the server brought it back, and "${victim}" died to the players' blows`);
}
