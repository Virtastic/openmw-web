// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s143: THE LEADER'S LEVEL SCALES THE WORLD. Levelled creature lists on the sim peer rolled
// against the NEAREST avatar, so a level-1 friend helping a level-20 host met level-1
// creatures wherever they stood -- the host's game got easier around the helper. The world
// is the host's: it rolls at the host's level everywhere. Proven on the peer's own spawn log
// ("levelled spawn ... rolled at level N (party leader)") for a creature that rolls beside the
// low-level guest, far from the host.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

export const managedPeer = true;
const STEP = 30_000;
const GW_PORT = 19110; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const HOST_LEVEL = 13; // reached one level at a time: the server refuses a jump of 2+ (#369)
const SPOT = '-12500,-53100,512'; // inside -2,-7, where levelled lists roll scribs and foragers (s109)
const rowOf = (handle) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(handle)}; }) || {})`;

export default async function run(ctx) {
  const BOOT = { retail: true, joinTimeoutMs: 420_000 };
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'lvl-host', ownId: 'priv-lvl-host', boot: BOOT });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'lvl-guest', ownId: 'priv-lvl-guest', boot: BOOT });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const H = `lhost${tag}`, G = `lguest${tag}`;
    await host.client.cmd(`profile:lvl-host@example.com:${H}`);
    await guest.client.cmd(`profile:lvl-guest@example.com:${G}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    // The host is a veteran; the helper is fresh off the boat. Morrowind levels ONE at a time
    // and the server refuses any larger jump outright (#369, LEVEL_JUMP_LIMIT 2); the 10 s
    // step window is the one thing the harness seam relaxes. So 1->13 is twelve +1 steps,
    // each given a progression diff (1 s) to travel before the next.
    for (let lvl = 2; lvl <= HOST_LEVEL; lvl++) {
      await host.client.cmd(`setlevel:${lvl}`);
      await ctx.sleep(1_500);
    }
    await host.client.waitFor('Number(JSON.parse(window.omw.state.gameTime||"{}").abs||1) >= 0', 2_000, 'settle').catch(() => {});
    await host.client.cmd(`social:FriendRequest:${G}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await guest.client.cmd(`social:FriendAccept:${H}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    const acct = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"))[0].acct;
    await guest.client.cmd(`joinfriend:${acct}`);
    await host.client.waitFor(`${rowOf(G)}.id !== undefined`, 300_000, 'the guest is inside the host world');
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(guest.client, GW_PORT, guest.account);

    // The helper walks off alone to the wilds; the host stays in town.
    await guest.client.cmd('snapto:' + SPOT);
    await guest.client.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 300_000, 'the peer rolled a levelled creature beside the guest');
    // Under managedPeer the peers belong to the gateway's worlds, and their "[mp]" lines
    // travel as simpeer.output records through the gateway's stdout.
    const peer = ctx.childLogTail ? ctx.childLogTail('gateway') : '';
    const unwrap = (l) => l.replace(/^.*\[mp\] /, '').replace(/"\}?\s*$/, '');
    const rolls = peer.split(String.fromCharCode(10)).filter((l) => /levelled spawn .* rolled at level/.test(l)).map(unwrap);
    const party = peer.split(String.fromCharCode(10)).filter((l) => /party level ->/.test(l)).map(unwrap);
    ctx.log(`peer: ${party.slice(-2).join(' || ')}`);
    ctx.log(`peer rolls: ${rolls.slice(-4).join(' || ')}`);
    // THE FIX, at the point it is decidable: the leader's level reached the engine's spawn
    // scaler (mp.setPartyLevel), so mwmechanics/actors.cpp nearestAvatarLevel returns 13 for
    // every levelled roll in this world instead of the level-1 helper's. The peer's own body
    // is a level-1 idle dummy and the helper is level 1, so a party level of 13 can only have
    // come from the host's doc -- there is no other source of a 13 in this world.
    assert.ok(party.some((l) => new RegExp(`party level -> ${HOST_LEVEL} `).test(l)),
      `the peer never learned the leader's level (saw: ${party.join(' || ') || 'nothing'})`);
    assert.ok(!party.some((l) => /party level -> 1 /.test(l) && party.indexOf(l) === party.length - 1),
      'the party level fell back to 1 -- the leader stopped being tracked');
    // A levelled roll observed after the level was set must use it, never a lower tier. The
    // guest waited for a named creature beside them, so at least one roll happened in this
    // world after the level was set; the roll assert used to sit inside an `if` and pass on
    // an empty list (backlog 240).
    const leaderRolls = rolls.filter((l) => /party leader/.test(l));
    assert.ok(leaderRolls.length > 0, `no levelled roll at the party leader's level was logged (rolls: ${rolls.join(' || ') || 'none'})`);
    ctx.log(`observed ${leaderRolls.length} roll(s) at the leader's level`);
    assert.ok(leaderRolls.every((l) => new RegExp(`rolled at level ${HOST_LEVEL} `).test(l)),
      `a roll used a level other than the host's ${HOST_LEVEL}: ${leaderRolls.join(' || ')}`);
    ctx.log(`PASS: the world scales to the host's level ${HOST_LEVEL} (the peer applied it), not the level-1 helper's`);
  } finally {
    host.stop();
  }
}
