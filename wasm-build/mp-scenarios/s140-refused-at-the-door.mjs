// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s140: THE HOST GOES SOLO WHILE YOU ARE ON YOUR WAY OVER. Joining a friend is a page reboot
// (~20 s of loading); if the host flips private inside that window, the new page dials a
// world that now refuses it ("this world is private"). That refusal used to fall through the
// credential ladder -- a fresh ticket, then the terminal "sign in again" modal -- and strand
// the player on a loading screen with a lie. Not a credential problem: go home, and say why.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19080; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'door-host', ownId: 'priv-rdoor-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'door-guest', ownId: 'priv-rdoor-guest' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const H = `rhost${tag}`, G = `rguest${tag}`;
    await host.client.cmd(`profile:door-host@example.com:${H}`);
    await guest.client.cmd(`profile:door-guest@example.com:${G}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    await host.client.cmd(`social:FriendRequest:${G}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await guest.client.cmd(`social:FriendAccept:${H}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    const ownUrl = String(await guest.client.eval('window.omw.state.dialTarget||""'));
    assert.ok(ownUrl.includes('priv-rdoor-guest'), `the guest's own world is the dial target at home (${ownUrl})`);

    // The guest sets off -- and the host goes solo while the page is still rebooting.
    const acct = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"))[0].acct;
    await guest.client.cmd(`joinfriend:${acct}`);
    await guest.client.waitFor('String(window.omw.state.switchTo||"") !== "" || String(window.omw.state.state||"") !== "Joined"', STEP, 'the guest is on their way (the switch began)');
    // Clear the party-mode result first: the wait below matched the STALE SetWorldMode from
    // the party flip and never proved the private flip was answered (backlog 240).
    await host.client.eval("if (window.omw.state) window.omw.state.socialResult = ''; 'cleared';");
    await host.client.cmd('worldmode:private');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'solo');
    ctx.log('the host went solo while the guest was rebooting into their world');

    // The refused dial must land the guest back home, joined, told why -- never Failed.
    // HARNESS ONLY: a real player's boot fragment carries mplocker and rebootIntoWorld keeps
    // it, so the go-home reboot can mint its ticket. The harness cannot put mplocker in the
    // URL, and a token present on window at BOOT flips index.html into locker mode (the boot
    // never finishes) -- so the session must be granted on the rebooted page after its boot
    // decision and before the refusal: the moment the engine reports any state past 'boot'.
    await guest.client.waitFor('!!window.omw && !!window.omw.state && String(window.omw.state.state||"boot") !== "boot"', 240_000, 'the rebooted page has an engine up');
    await grantLockerSession(guest.client, GW_PORT, guest.account);
    ctx.log(`locker session granted on the rebooted page at state=${await guest.client.eval('window.omw.state.state')}`);
    const by = Date.now() + 240_000;
    let home = false, lastSaid = 0;
    const peek = async (expr) => { try { return String(await guest.client.eval(expr)); } catch (e) { return `(eval failed: ${String(e.message).slice(0, 40)})`; } };
    while (Date.now() < by && !home) {
      try {
        home = (await guest.client.eval('window.omw.state.state === "Joined" && String(window.omw.state.dialTarget||"").indexOf("priv-rdoor-guest") >= 0')) === true;
      } catch { /* mid-reload */ }
      if (!home && Date.now() - lastSaid > 20_000) {
        lastSaid = Date.now();
        ctx.log(`waiting: state=${await peek('window.omw.state.state')} target=${await peek('window.omw.state.dialTarget')} lastError=${await peek('window.omw.state.lastError')} closed=${await peek('window.omw.state.worldClosed')}`);
        // The page that lands home is yet another fresh document: it needs the session too,
        // after ITS boot decision. Any state past boot is safe.
        try { if ((await peek('window.omw.state.state')) !== 'boot') await grantLockerSession(guest.client, GW_PORT, guest.account); } catch { /* mid-reload */ }
      }
      if (!home) await ctx.sleep(1_000);
    }
    if (!home) {
      const t = (guest.client.logTail ? guest.client.logTail(2000) : '').split(String.fromCharCode(10)).filter((l) => /\[mp\]|world|ticket|locker/i.test(l) && !/RigGeometry|Local map/.test(l)).slice(-15);
      ctx.log('guest tail: ' + t.join(' || '));
    }
    assert.ok(home, 'the guest never landed back in their own world');
    const why = await guest.client.eval("window.omw.state.worldClosed||''");
    const err = await guest.client.eval("window.omw.state.lastError||''");
    ctx.log(`home again: worldClosed="${why}" lastError="${err}" state=${await guest.client.eval('window.omw.state.state')}`);
    assert.notEqual(await guest.client.eval('window.omw.state.state'), 'Failed', `the guest dead-ended at Failed (${err})`);
    const tail = (guest.client.logTail ? guest.client.logTail(3000) : '').split(String.fromCharCode(10)).filter((l) => /refused at the door|going home|world is private/.test(l)).slice(-3);
    ctx.log('guest log: ' + tail.join(' || '));
    assert.ok(tail.some((l) => /going home/.test(l)), 'the guest never took the go-home path on the refusal (it may have been admitted before the flip -- rerun)');
    assert.equal(await host.client.eval('window.omw.state.state'), 'Joined', 'the host is untouched');
    ctx.log("PASS: refused at the door of a friend's world mid-journey, the guest went home with a reason instead of a sign-in modal");
  } finally {
    host.stop();
  }
}
