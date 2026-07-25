// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s80 (M8): session resume (PROTOCOL.md §M8 / §Session tier). A reloaded tab must rejoin
// IN PLACE — same cell, same position — without going through auth again.
//
// The reload is a real one (location.reload() in the same target, so localStorage survives
// and the ticket the client parked is still there). Asserted on the MECHANISM: the
// authPath mirror says `resume`, i.e. the client sent SessionResume in HELLO_OK and the
// server accepted it, not that it quietly re-registered and happened to look the same.
//
// It also pins the §M8 claim that a resumed session needs no resume-specific apply path:
// the post-Ready stream is a superset of a fresh join, so the M2/M6/M7 mirrors must all be
// repopulated afterwards without any extra client logic.
import assert from 'node:assert/strict';

const STEP_TIMEOUT = 25_000;
const BOOT_TIMEOUT = 180_000;

const poseOf = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).pose||"{}"'));
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-a');
  const b = await ctx.launchClient('bot-b'); // a witness: the resumed player must come back for peers too

  assert.equal(await a.eval('(window.__omwMP||{}).authPath'), 'register',
    'first boot should take the normal auth ladder');
  const idBefore = await a.eval('(window.__omwMP||{}).playerId');

  // Walk a little so "in place" means something other than the spawn point.
  await a.eval(`Module.__omwMPCmd='walk:0,1,1500'`);
  await ctx.sleep(3000);
  const poseBefore = await poseOf(a);
  ctx.log(`before reload: id=${idBefore} pose=${JSON.stringify(poseBefore)}`);
  assert.ok(Number.isFinite(poseBefore.x), 'pose mirror is live before the reload');

  // B must see A's puppet before the drop, so we can tell "came back" from "never left".
  await b.waitFor(`!!JSON.parse((window.__omwMP||{}).puppets||"{}")[${JSON.stringify(idBefore)}]`,
    STEP_TIMEOUT, "B sees A's puppet before the reload");

  // The reload: same tab, same profile -> the parked ticket in localStorage survives.
  // Defer the navigation so the eval itself returns before the execution context dies.
  await a.eval('setTimeout(function(){ location.reload(); }, 50); 1');
  await ctx.sleep(2000);
  await a.waitFor('(window.__omwMP||{}).state === "Joined"', BOOT_TIMEOUT, 'A rejoined after the reload');

  const authPath = await a.eval('(window.__omwMP||{}).authPath');
  ctx.log(`authPath after reload: ${authPath}`);
  assert.equal(authPath, 'resume', 'A did not resume — it re-authed (ticket lost or not sent)');

  // Rejoined IN PLACE: the server restored the cell and pose from the ticket, and the
  // client applied the normal playerRecord path (no resume-specific code).
  await a.waitFor('((window.__omwMP||{}).pose||"") !== ""', STEP_TIMEOUT, 'A pose mirror live again');
  const poseAfter = await poseOf(a);
  const drift = dist(poseBefore, poseAfter);
  ctx.log(`pose ${JSON.stringify(poseBefore)} -> ${JSON.stringify(poseAfter)} (drift ${drift.toFixed(1)} units)`);
  // Tight on purpose. At 400 this passed while the server was resuming players off the
  // PlayerDoc's last-flushed position instead of the ticket's live pose — a 302.9-unit
  // backwards rubber-band on every reconnect, and a teleport to the respawn point for anyone
  // who had died. A loose threshold hid a real bug; "landed where I left off" means metres.
  assert.ok(drift < 40, `resumed player did not land where it left off (${drift.toFixed(1)} units)`);

  // Superset claim (§M8): everything a fresh join delivers is delivered again.
  await a.waitFor('(window.__omwMP||{}).journalSynced === "true"', STEP_TIMEOUT, 'JournalSync re-sent (M6)');
  await a.waitFor('Number((window.__omwMP||{}).timeApplied||"0") > 0', STEP_TIMEOUT, 'WorldTime re-sent (M7)');
  await a.waitFor('JSON.parse((window.__omwMP||{}).players||"[]").length >= 1', STEP_TIMEOUT, 'PlayerList re-sent (M0)');
  ctx.log('ok: post-resume stream is a superset of a fresh join (no resume-specific apply path)');

  // And the peers get the player back.
  const idAfter = await a.eval('(window.__omwMP||{}).playerId');
  await b.waitFor(`!!JSON.parse((window.__omwMP||{}).puppets||"{}")[${JSON.stringify(idAfter)}]`,
    STEP_TIMEOUT, "B re-placed A's puppet after the resume");
  ctx.log(`ok: resumed as playerId ${idAfter} (was ${idBefore}); B re-placed the puppet`);
}
