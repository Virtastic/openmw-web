// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s194: A FRIEND'S SWING IS SEEN, NOT JUST FELT. The launch video (2026-10-20) shows a friend's
// sword held straight up for a whole fight on the other screen: the wind-up played, the blow never
// did. Every fight scenario stayed green because none could see the picture -- s172 says it
// outright: "the clients cannot report their animation". puppet.lua now prints, a fixed time after
// each half of a swing it plays, what the puppet's right arm is running and where in it
// ('[mp] swing probe ...'). Here A swings with a drawn longsword, held and clicked, while B watches;
// on B's screen each blow must move past the point the wind-up stops at, and be over 1.5 s later.
// RETAIL DATA REQUIRED (the weapon and its animation groups are Morrowind's).
import assert from 'node:assert/strict';

export const timeoutMs = 20 * 60_000;
export const managedPeer = true;
const LOWGFX = '&tier=low&noshadow=1';
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPOT = { x: -12288, y: -69632, z: 87 }; // Seyda Neen on land (s172)
const SWORD = 'iron longsword';
const PROBE = /\[mp\] swing probe (\S+) group=(\S+) active=(\S+) time=(\S+) windupStop=(\S+)/;

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('swinger', LOWGFX, BOOT), ctx.launchClient('watcher', LOWGFX, BOOT)]);
  for (const c of [a, b]) await c.waitFor('String(window.omw.state.baselineReady||"") === "1"', 180_000, `${c.name} settled`);
  for (const c of [a, b]) { try { await c.click('#omw-tour-x'); } catch { /* none */ } }
  const idA = String(await a.eval('window.omw.state.playerId'));
  await a.cmd(`snapto:${SPOT.x},${SPOT.y},${SPOT.z}`);
  await b.cmd(`snapto:${SPOT.x + 250},${SPOT.y + 250},${SPOT.z + 30}`);
  await b.waitFor(`(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(idA)}]||{}).x !== undefined`, 120_000, 'B draws A');
  await a.cmd(`equip:${SWORD}:16`);
  await ctx.sleep(1500);
  await a.cmd('stance:weapon');
  await ctx.sleep(2500); // the draw animation, on both screens
  await b.cmd(`face:${SPOT.x},${SPOT.y},${SPOT.z + 60}`);

  // Held swings (the press and the release land in different frames: the wind-up, then the blow)
  // and clicks (both in one frame: the whole swing at once).
  for (const ms of [400, 400, 400, 30, 30]) {
    await a.cmd(`attack:${ms}`);
    await ctx.sleep(2500);
  }

  const lines = b.logMatches(PROBE).map((l) => { const m = PROBE.exec(l); return { label: m[1], group: m[2], active: m[3], time: +m[4], stop: +m[5] }; });
  for (const l of lines) ctx.log(`B sees: ${l.label} group=${l.group} active=${l.active} t=${l.time} windupStop=${l.stop}`);
  const swing = lines.filter((l) => l.group === 'weapononehand');
  const blows = swing.filter((l) => l.label === 'blow+0.25'), ends = swing.filter((l) => l.label === 'blow+1.5');
  assert.ok(blows.length >= 3, `B played ${blows.length} blows of A's swings (want the 5 A made, at least 3)`);
  // The video's picture: still on the swing group, sitting at the wind-up's stop.
  const held = (l) => l.active === l.group && Number.isFinite(l.stop) && Math.abs(l.time - l.stop) < 0.02;
  assert.equal(blows.filter(held).length, 0, 'a blow never left the wind-up: the sword stays raised (launch video, 2026-10-20)');
  assert.equal(ends.filter((l) => l.active === l.group).length, 0, 'a swing was still on screen 1.5 s after its blow: never finished');
  ctx.log(`ok: ${blows.length} blows seen on B, each past the wind-up and over within 1.5 s`);
}
