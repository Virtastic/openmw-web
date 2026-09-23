// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s175: GO TO JAIL. s126 ends where the guard's greeting opens; the choice every caught player
// takes next -- serve the time -- had never been run (backlog 45: "time skip is a local
// advanceTime; skill loss and confiscation unverified").
//
// The `jail` hook calls what the dialogue's "Go to jail" choice calls (World::goToJail): the
// bounty is forfeited, the player is taken to the prison marker, the jail screen runs, days pass.
// Asserted, in multiplayer terms:
//   * the bounty the SERVER holds goes to zero (a relog does not bring the crime back);
//   * the player arrives at the prison marker and stays there (the fair-play gate does not snap
//     a jail transfer back to the scene of the crime), and comes back there after a relog;
//   * the days served reach the world clock as a time request, not as a local-only jump the
//     server then slews away.
// RETAIL DATA REQUIRED: the prison markers are Morrowind.esm's.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const BOUNTY = 300; // iDaysinPrisonMod 100 -> three days
export const bootTimeoutMs = 420_000;

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
const timeOf = async (c) => JSON.parse(await c.eval('window.omw.state.gameTime||"{}"'));

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const a = await ctx.launchClient('jailbird', '', BOOT);
  await a.cmd(`bounty:${BOUNTY}`);
  await a.waitFor(`window.omw.state.bounty === "${BOUNTY}"`, 30_000, 'the bounty is on record');
  const cell0 = String(await a.eval('window.omw.state.cell||""'));
  const pose0 = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
  const t0 = await timeOf(a);
  const req0 = Number(await a.eval('window.omw.state.timeRequests||0'));
  ctx.log(`before: cell=${cell0} gameTime=${JSON.stringify(t0)} bounty=${BOUNTY}`);

  await a.cmd('jail');
  await a.waitFor(`String(window.omw.state.uiMode||'') === 'Jail'`, 30_000, 'the jail screen opened');
  await a.waitFor(`String(window.omw.state.uiMode||'') !== 'Jail'`, 120_000, 'the sentence was served');
  await a.waitFor('window.omw.state.bounty === "0"', 30_000, 'the bounty was forfeited');

  // Where they are once the server has had its say.
  await ctx.sleep(8000);
  const cell1 = String(await a.eval('window.omw.state.cell||""'));
  const pose1 = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
  const t1 = await timeOf(a);
  const req1 = Number(await a.eval('window.omw.state.timeRequests||0'));
  ctx.log(`after: cell=${cell1} pose=${JSON.stringify(pose1)} gameTime=${JSON.stringify(t1)} timeRequests ${req0}->${req1}`);
  assert.ok(cell1 !== cell0 || dist(pose1, pose0) > 1024, 'the player was not taken to the prison marker, or was snapped back');
  assert.ok(req1 > req0, 'the days served never reached the server as a time request');
  assert.ok(t1.abs - t0.abs > 24, `the world clock kept ${(t1.abs - t0.abs).toFixed(1)} h of a three-day sentence`);
  assert.deepEqual(a.luaErrors(), [], 'no Lua error along the way');

  // A relog: the server's copy says the same.
  await ctx.sleep(2000);
  a.close();
  await ctx.sleep(2500);
  const a2 = await ctx.launchClient('jailbird', '', BOOT);
  await a2.waitFor('window.omw.state.restored === "1"', 60_000, 'rejoin restore applied');
  await ctx.sleep(3000);
  const bounty2 = String(await a2.eval('window.omw.state.bounty||""'));
  const pose2 = JSON.parse(await a2.eval('window.omw.state.pose||"null"'));
  ctx.log(`after relog: bounty=${bounty2} cell=${await a2.eval('window.omw.state.cell')} ${Math.round(dist(pose2, pose1))} u from the jail exit`);
  assert.ok(bounty2 === '0' || bounty2 === '', `the crime came back with the relog (bounty ${bounty2})`);
  assert.ok(dist(pose2, pose1) < 256, 'the relog put the player somewhere other than where the sentence left them');
  ctx.log('ok: jailed, time served on the world clock, bounty gone for good, and the player stays where the guards left them');
}
