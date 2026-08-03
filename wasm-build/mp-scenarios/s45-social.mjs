// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s45 (Phase C): friends, presence and invites end-to-end through two real clients.
//
// The unit tests cover the policy exhaustively; what only a live run can prove is that the
// wire actually connects — that a player script's uplink reaches the server family, that
// the reply comes back through the global relay to the right player script, and that an
// accepted invite really moves the character. Those are three separate places a rename or
// a missing registration silently breaks the whole feature while every unit test stays
// green.
import assert from 'node:assert/strict';

const STEP = 20_000;

// Presence is the reason this needs its own server config: the default grace window is
// long enough that a scenario would sit waiting for an offline announcement.
export const serverRules = '';

const evalJson = async (c, expr, dflt = '[]') => JSON.parse(await c.eval(`(window.__omwMP||{}).${expr}||'${dflt}'`));

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('soc-a'),
    ctx.launchClient('soc-b'),
  ]);
  const nameA = a.name;
  const nameB = b.name;

  // A friend list arrives at join even when empty — the client renders from it, so a
  // missing one means an empty window forever rather than a visible error.
  await a.waitFor("(window.__omwMP||{}).friends !== undefined", STEP, 'A received an initial FriendList');
  assert.deepEqual(await evalJson(a, 'friends'), [], 'a fresh account starts with no friends');

  // 1. A requests B. The request must surface on B.
  await a.eval(`Module.__omwMPCmd='social:FriendRequest:${nameB}'`);
  // The server replies to every social op, so a refusal is never silent. Surface it before
  // waiting on B: "B never saw the request" and "the server refused it" look identical from
  // a timeout, and they need different fixes.
  await ctx.sleep(2000);
  ctx.log(`  A socialResult: ${await a.eval("(window.__omwMP||{}).socialResult||'none'")}`);
  await b.waitFor(`JSON.parse((window.__omwMP||{}).friendRequests||'[]').length > 0`,
    STEP, `B received A's friend request`);
  const reqs = await evalJson(b, 'friendRequests');
  assert.equal(reqs[0].name, nameA, `request should name the sender, got ${JSON.stringify(reqs)}`);
  ctx.log(`ok: friend request ${nameA} -> ${nameB}`);

  // 2. B accepts. BOTH sides must end up with a friend — a one-sided list is the classic
  //    failure of a two-row friendship model and would show up right here.
  await b.eval(`Module.__omwMPCmd='social:FriendAccept:${reqs[0].acct}'`);
  await a.waitFor(`JSON.parse((window.__omwMP||{}).friends||'[]').length === 1`, STEP, 'A sees the friendship');
  await b.waitFor(`JSON.parse((window.__omwMP||{}).friends||'[]').length === 1`, STEP, 'B sees the friendship');
  const friendOfA = (await evalJson(a, 'friends'))[0];
  assert.equal(friendOfA.name, nameB);
  assert.equal(friendOfA.online, true, 'a friend who is connected must read as online');
  // cellKey is friends-only, and now that they ARE friends it should be present.
  assert.ok(friendOfA.cellKey, `an online friend should carry a cellKey, got ${JSON.stringify(friendOfA)}`);
  ctx.log(`ok: mutual friendship, B online at ${friendOfA.cellKey}`);

  // 3. Invite and travel. Asserted by POSITION, not by the absence of an error: the
  //    teleport happens in the global script, and a silent pcall failure there would
  //    otherwise look identical to success.
  // B walks away FIRST. Both clients spawn on the same point, so inviting from where they
  // already stand makes the teleport a no-op — the check would pass identically whether the
  // teleport worked or silently threw inside the global script's pcall.
  await b.eval("Module.__omwMPCmd='walk:0,1,6000'");
  await ctx.sleep(6500);
  const posBefore = JSON.parse(await a.eval("(window.__omwMP||{}).pose||'null'"));
  const hostPos = JSON.parse(await b.eval("(window.__omwMP||{}).pose||'null'"));
  const apart = Math.hypot(posBefore.x - hostPos.x, posBefore.y - hostPos.y, posBefore.z - hostPos.z);
  ctx.log(`B walked ${apart.toFixed(1)} units away before inviting`);
  assert.ok(apart > 200, `B must be somewhere else for the invite to prove anything (${apart.toFixed(1)} units)`);

  // Read the account key from B's own friend list so it comes from the server rather than
  // being guessed from the display name.
  const friendOfB = (await evalJson(b, 'friends'))[0];
  await b.eval(`Module.__omwMPCmd='social:InviteSend:${friendOfB.acct}'`);
  await a.waitFor(`JSON.parse((window.__omwMP||{}).invites||'[]').length > 0`, STEP, 'A received the invite');
  await a.eval(`Module.__omwMPCmd='social:InviteAccept:${friendOfA.acct}'`);
  await a.waitFor("(window.__omwMP||{}).invitedTo !== undefined", STEP, 'A acted on the invite');
  await ctx.sleep(1500); // the teleport lands a frame or two after the event
  const posAfter = JSON.parse(await a.eval("(window.__omwMP||{}).pose||'null'"));
  const moved = Math.hypot(posAfter.x - posBefore.x, posAfter.y - posBefore.y, posAfter.z - posBefore.z);
  const gap = Math.hypot(posAfter.x - hostPos.x, posAfter.y - hostPos.y, posAfter.z - hostPos.z);
  ctx.log(`invite: A moved ${moved.toFixed(1)} units, now ${gap.toFixed(1)} from the host`);
  // Both halves matter: that A moved at all, and that it moved TOWARD the host rather than
  // anywhere else.
  assert.ok(moved > 100, `accepting an invite did not move the character (${moved.toFixed(1)} units)`);
  assert.ok(gap < apart, `A should end up nearer the host than it started (${gap.toFixed(1)} vs ${apart.toFixed(1)})`);

  // 4. Unfriend clears BOTH sides. An unfriend that only updates the initiator leaves the
  //    other player believing they still have a friend they can no longer interact with.
  await a.eval(`Module.__omwMPCmd='social:FriendRemove:${friendOfA.acct}'`);
  await a.waitFor(`JSON.parse((window.__omwMP||{}).friends||'[]').length === 0`, STEP, 'A list cleared');
  await b.waitFor(`JSON.parse((window.__omwMP||{}).friends||'[]').length === 0`, STEP, 'B list cleared too');
  ctx.log('ok: unfriend cleared both sides');
}
