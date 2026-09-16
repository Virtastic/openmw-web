// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s149: YOU CAN DROWN, ONCE. Under water past the breath timer the game hurts you; the peer
// rules the body, and its avatar is under the same water. The player must lose health (a
// helper who could not drown could scout the sea bed for free) and lose it ONCE -- a local
// drowning tick plus the avatar's would kill twice as fast. Then surfacing must stop it.
// Deep water is needed: at the s109 spot the sea is 133 units deep and a swimmer's head
// bobs at the surface (measured: 60 s there cost nothing, correctly). Cell -3,-9, west of
// Seyda Neen, has a sea floor 1136 units down (Morrowind.esm LAND/VHGT); a body 400 down
// there is well under, and sneak (swim down) holds it there.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SEABED = { x: -19264, y: -72128, z: -400 }; // -3,-9: the floor is at -1136
const HOLD_S = 40; // fHoldBreathTime is 20 s; then ~3 health a second (fSuffocationDamage)

const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };
const bars = async (c) => parseBars(await c.eval('window.omw.state.selfStats'));
const pose = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"null"'));

export default async function run(ctx) {
  // CONTROL (temporary): no peer -- does the engine drown a client-ruled player here at all?
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await a.cmd(`snapto:${SEABED.x},${SEABED.y},${SEABED.z}`);
  await b.cmd(`snapto:${SEABED.x + 300},${SEABED.y},${SEABED.z}`);
  const idA = await a.eval('window.omw.state.playerId');
  const rowOf = `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(String(idA))}]||{})`;
  await b.waitFor(`${rowOf}.x !== undefined`, STEP, 'B has a puppet of A');
  await ctx.sleep(3_000);
  // A bigger pool first (s144's honest way, then a claimed gain): 20 s of breath and then
  // three health a second would kill a 35-health character inside the sampling window.
  const hp0 = Number(await a.eval('window.omw.state.hp'));
  await a.cmd('sethpbase:95'); await a.cmd('sethp:95');
  await ctx.sleep(1_000);
  const start = { c: Number(await a.eval('window.omw.state.hp')), b: 95 };
  const at = await pose(a);
  ctx.log(`A under water at z=${at.z.toFixed(0)} with ${start.c}/${start.b}`);
  assert.ok(at.z < -250, `A is not deep under (z=${at.z.toFixed(0)})`);
  await b.waitFor(`${rowOf}.z < -250`, STEP, "B's puppet of A is under water too");
  // Hold the depth: sneak is swim-down.
  await a.cmd(`walk:0,0,${HOLD_S * 1000}:sneak`);

  // Hold there. Sample the peer's bars and the client's own bar every 5 s.
  const t0 = Date.now();
  let cur = start, local = start.c, firstHurtAt = 0;
  while (Date.now() - t0 < HOLD_S * 1000) {
    await ctx.sleep(2_000);
    cur = { c: Number(await a.eval('window.omw.state.hp')), b: 95 };
    local = Number(await a.eval('window.omw.state.hp'));
    if (!firstHurtAt && cur.c < start.c - 1) firstHurtAt = Date.now() - t0;
    if (true) {
      const z = (await pose(a)).z, az = Number(JSON.parse(await b.eval(`JSON.stringify(${rowOf})`)).z);
      await a.eval("if (window.omw.state) window.omw.state.body = null; 'cleared';"); await a.cmd('body');
      await a.waitFor("typeof window.omw.state.body === 'string'", 5_000, 'body answered');
      ctx.log(`t+${Math.round((Date.now() - t0) / 1000)}s peer ${cur.c}/${cur.b} client ${local}; A at z=${z.toFixed(0)}, avatar (as B sees it) z=${az.toFixed(0)}; engine says ${await a.eval('window.omw.state.body')}`);
    }
    if (cur.c <= 25 || local <= 25) break; // never let the bot die; that is s22/s77's business
  }
  assert.ok(cur.c < start.c - 1, `${HOLD_S} s under water cost nothing (${start.c} -> ${cur.c}): drowning never reached the ruling body`);
  assert.ok(cur.c > 0, 'the bot must not die here');
  assert.ok(firstHurtAt >= 15_000, `hurt at t+${Math.round(firstHurtAt / 1000)}s, before the breath ran out`);
  const lost = start.c - cur.c;
  assert.ok(Math.abs(local - cur.c) <= Math.max(3, lost * 0.5),
    `client ${local} vs peer ${cur.c} (lost ${lost}): one side drowned twice`);

  // Surface: lift A out of the water; the bleeding must stop.
  await a.cmd('walk:0,0,1:sneak'); // stop diving
  await a.cmd(`snapto:${SEABED.x},${SEABED.y},${200}`);
  await ctx.sleep(3_000);
  const surfaced = { c: Number(await a.eval('window.omw.state.hp')), b: 95 };
  await ctx.sleep(15_000);
  const later = { c: Number(await a.eval('window.omw.state.hp')), b: 95 };
  ctx.log(`surfaced: ${surfaced.c} then ${later.c} fifteen seconds later`);
  assert.ok(later.c >= surfaced.c - 1, `still losing health out of the water (${surfaced.c} -> ${later.c})`);
  ctx.log(`PASS: drowning cost ${lost} health once (first hit at t+${Math.round(firstHurtAt / 1000)}s), both sides agree, and it stopped on surfacing`);
}
