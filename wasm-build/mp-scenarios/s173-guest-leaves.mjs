// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s173: A GUEST PRESSES LEAVE. The Social panel tells a guest whose world they are in and offers
// one button: Leave. Kick (s141), Solo (s102) and the host vanishing (s129) all send a guest
// home; the guest's OWN way out had no test of any kind -- not the button, not `where:home`.
//
// Driven the way a player does it: O opens the panel (a real key), the button is clicked with a
// real mouse. Asserted: the guest lands in their own world, the host's roster loses them, the
// host is not disturbed, and they are still friends (leaving is not a falling-out).
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19160; // ten apart from its neighbours (s154 = 19150)
const O = { key: 'o', code: 'KeyO', keyCode: 79 };
export const bootTimeoutMs = 420_000;
const rowOf = (handle) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(handle)}; }) || {})`;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'leave-host', ownId: 'priv-leave-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'leave-guest', ownId: 'priv-leave-guest' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const H = `lhost${tag}`, G = `lguest${tag}`;
    await host.client.cmd(`profile:leave-host@example.com:${H}`);
    await guest.client.cmd(`profile:leave-guest@example.com:${G}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    await host.client.cmd(`social:FriendRequest:${G}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request reaches the guest');
    await guest.client.cmd(`social:FriendAccept:${H}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');

    const acct = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"))[0].acct;
    await guest.client.cmd(`joinfriend:${acct}`);
    await host.client.waitFor(`${rowOf(G)}.id !== undefined`, 300_000, 'the host sees the guest arrive');
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(guest.client, GW_PORT, guest.account);
    await guest.client.waitFor(`String(window.omw.state.amHost||"") === "false" && String(window.omw.state.worldHost||"") === ${JSON.stringify(H)}`, STEP, 'the guest knows whose world it is in');
    const hostDial = String(await host.client.eval('window.omw.state.dialTarget||""'));
    ctx.log(`ok: ${G} is visiting ${H}'s world`);

    // O opens the Social panel; the guest row offers Leave.
    await ctx.sleep(900);
    for (let i = 0; i < 3; i++) {
      await guest.client.waitFor(`String(window.omw.state.uiMode||'none') === 'none'`, 5000, 'no engine window owns the keys').catch(() => {});
      await guest.client.eval(`document.getElementById('canvas').focus()`);
      await guest.client.key(O);
      if (await guest.client.waitFor(`getComputedStyle(document.getElementById('omw-social')).display !== 'none'`, 5000, 'panel').then(() => true).catch(() => false)) break;
    }
    await guest.client.waitFor(`!!document.querySelector('#omw-social .whererow .btn')`, STEP, 'the guest row offers Leave');
    const label = await guest.client.eval(`document.querySelector('#omw-social .whererow').innerText`);
    ctx.log(`panel says: ${JSON.stringify(label)}`);
    assert.match(label, new RegExp(`Visiting\\s+${H}`, 'i'), 'the panel names the host'); // the row is CSS-uppercased
    assert.equal(await guest.client.eval(`document.querySelector('#omw-social .whererow .btn').textContent`), 'Leave');
    const hit = await guest.client.click('#omw-social .whererow .btn');
    ctx.log(`clicked Leave (hit ${hit})`);

    // Home: the guest's own world, as its host.
    await host.client.waitFor(`${rowOf(G)}.id === undefined`, 120_000, 'the host world loses the guest');
    await guest.client.waitFor(`window.omw && window.omw.state && window.omw.state.state === "Joined" && String(window.omw.state.dialTarget||"").indexOf("priv-leave-guest") >= 0`, 300_000, 'the guest lands in their own world');
    await guest.client.waitFor('String(window.omw.state.amHost||"") === "true"', STEP, 'at home the guest is the host again');
    assert.equal(await guest.client.eval("window.omw.state.worldClosed||''"), '', 'leaving is not being sent home: no closed-world notice');

    // The host was not disturbed and the friendship stands.
    assert.equal(await host.client.eval('window.omw.state.state'), 'Joined', 'the host is still playing');
    assert.equal(String(await host.client.eval('window.omw.state.dialTarget||""')), hostDial, 'the host did not move');
    await grantLockerSession(guest.client, GW_PORT, guest.account);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'leaving must not touch the friendship');
    ctx.log('PASS: the guest pressed Leave, went home, and the host carried on');
  } finally {
    host.stop();
  }
}
