// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Shared social steps for scenarios with two players in the ONE v2 world. The v1 "join a
// friend" door (worldmode / joinfriend) is gone (OT3-31, OT3-58); the v2 way to be beside a
// friend is an invite: the friend sends it, you accept, and you are teleported to where they
// stand (social.ts acceptInvite -> InviteAccepted -> global.lua MP_InviteAccepted).
//
// NOTE: starts with an underscore so the harness scan skips it -- a library, not a scenario.
import assert from 'node:assert/strict';

/** `from` sends `to` a friend request by handle and `to` accepts; both lists show one friend. */
export async function befriend(from, to, fromHandle, toHandle, step = 30_000) {
  await from.cmd(`social:FriendRequest:${toHandle}`);
  await to.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, step, 'the request arrives');
  await to.cmd(`social:FriendAccept:${fromHandle}`);
  await from.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, step, 'they are friends');
}

/** `host` invites the friend `guest`; `guest` accepts. Returns once the accept was SENT
 *  (the teleport itself is the caller's to observe: cell, pose). */
export async function inviteAndAccept(host, guest, hostHandle, step = 30_000) {
  const acct = JSON.parse(await host.eval("window.omw.state.friends||'[]'"))[0].acct;
  await host.eval("window.omw.state.socialResult = ''; 'cleared'");
  await host.cmd(`social:InviteSend:${acct}`);
  await host.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'InviteSend'`, step, 'the invite is answered');
  const sent = JSON.parse(await host.eval("window.omw.state.socialResult||'{}'"));
  assert.equal(sent.ok, true, `the invite was refused: ${JSON.stringify(sent)}`);
  await guest.waitFor(`JSON.parse(window.omw.state.invites||'[]').length > 0`, step, 'the invite reaches the guest');
  const invites = JSON.parse(await guest.eval("window.omw.state.invites||'[]'"));
  assert.equal(invites[0].name, hostHandle, `the card must name the inviter by handle: ${JSON.stringify(invites)}`);
  await guest.cmd(`social:InviteAccept:${invites[0].acct}`);
  return invites[0];
}
