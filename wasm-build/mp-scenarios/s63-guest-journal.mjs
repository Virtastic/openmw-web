// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s63: THE QUEST LOG IS THE HOST'S. You join a friend's world and they lead: their campaign
// is the one on the table. The guest sees the host's journal (real entries, not indices),
// their own campaign is set aside for the visit (MWDialogue::Journal::stash/unstash, driven by
// the `borrowed` flag on JournalSync), a quest step the guest takes lands in the HOST's log --
// and when the host closes up and the guest lands back home, their own journal is exactly as
// they left it, with none of the host's quests in it.
//
// Rewritten on the friend path (befriend, Party, joinfriend, retail data through the gateway)
// after the public mode this used to admit its guest through was deleted.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 18970; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const OWNER_QUEST = 'a1_2_antabolisinformant';
const OWNER_STAGE = 10;
const GUEST_QUEST = 'a1_1_findspymaster';
const GUEST_STAGE = 5;
const stageOf = (q) => `(JSON.parse(window.omw.state.journal||"{}")[${JSON.stringify(q)}] || 0)`;

export default async function run(ctx) {
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'jour-host', ownId: 'priv-jour-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'jour-guest', ownId: 'priv-jour-guest', boot: BOOT });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `jhost${tag}`, guestHandle = `jguest${tag}`;
    await host.client.cmd(`profile:jour-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:jour-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }

    // The HOST's campaign is at stage 10; the GUEST's own campaign has its own, different mark.
    await host.client.cmd(`quest:${OWNER_QUEST}:${OWNER_STAGE}`);
    await host.client.waitFor(`${stageOf(OWNER_QUEST)} === ${OWNER_STAGE}`, STEP, 'the host advanced their own campaign');
    const GUEST_OWN_QUEST = 'a1_1_findspymaster';
    await guest.client.cmd(`quest:${GUEST_OWN_QUEST}:2`);
    await guest.client.waitFor(`${stageOf(GUEST_OWN_QUEST)} === 2`, STEP, "the guest advanced their OWN campaign at home");
    await ctx.sleep(3_000); // persisted (journal advances flush at the write)
    ctx.log(`host at ${OWNER_QUEST}=${OWNER_STAGE}; guest at home with ${GUEST_OWN_QUEST}=2`);

    await host.client.cmd(`social:FriendRequest:${guestHandle}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await guest.client.cmd(`social:FriendAccept:${hostHandle}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    const guestFriends = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"));
    await guest.client.cmd(`joinfriend:${guestFriends[0].acct}`);
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 300_000, "the guest is inside the host's world");
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(guest.client, GW_PORT, guest.account); // the switch reloaded the page

    // 1. The guest sees the HOST's campaign, and their own is set aside.
    await guest.client.waitFor(`${stageOf(OWNER_QUEST)} === ${OWNER_STAGE}`, STEP, "the guest adopted the host's campaign");
    await guest.client.waitFor('window.omw.state.journalStashed === "true"', STEP, 'the guest stashed their own campaign for the visit');
    assert.equal(await host.client.eval('window.omw.state.journalStashed'), 'false', 'the host must never stash: this is their own world');
    assert.equal(Number(await guest.client.eval(stageOf(GUEST_OWN_QUEST))), 0, "the guest's own mark must not be visible in the host's world");
    ctx.log("ok: the guest sees the host's log, stashed their own");

    // 2. A quest step the guest takes here lands in the HOST's log.
    await guest.client.cmd(`quest:${GUEST_QUEST}:${GUEST_STAGE}`);
    await host.client.waitFor(`${stageOf(GUEST_QUEST)} === ${GUEST_STAGE}`, STEP, "the guest's deed advanced the host's campaign");
    ctx.log("ok: the guest's deed is in the host's log");

    // 3. Home again: the guest's own journal is exactly as they left it.
    await host.client.cmd('worldmode:private');
    await guest.client.waitFor(`(window.omw.state.worldClosed||'') !== '' || String(window.omw.state.state||'') !== 'Joined'`, STEP, 'the guest is sent home');
    await guest.client.waitFor('window.omw.state.state === "Joined" && String(window.omw.state.worldClosed||"") === ""', 300_000, 'the guest is back in their own world');
    await guest.client.waitFor(`${stageOf(GUEST_OWN_QUEST)} === 2`, 60_000, "the guest's own campaign came back");
    await ctx.sleep(3_000);
    assert.equal(Number(await guest.client.eval(stageOf(OWNER_QUEST))), 0, "the host's quest must not follow the guest home");
    assert.equal(await guest.client.eval('window.omw.state.journalStashed'), 'false', 'nothing is stashed at home');
    // The deed the guest did in the host's world was the HOST's: at home it is the guest's own stage 2, not 5.
    assert.equal(Number(await guest.client.eval(stageOf(GUEST_QUEST))), 2, "the deed done as a guest belongs to the host's log, not the guest's");
    const luaErrs = [...guest.client.luaErrors(), ...host.client.luaErrors()];
    assert.equal(luaErrs.length, 0, 'Lua errors on the stash/unstash path:\n' + luaErrs.join('\n'));
    ctx.log('PASS: the quest log is the host\'s while you visit, and your own is untouched when you leave');
  } finally {
    host.stop();
  }
}
