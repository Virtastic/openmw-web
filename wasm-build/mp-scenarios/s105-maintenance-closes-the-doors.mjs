// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s105: MAINTENANCE CLOSES THE DOORS — all of them, and opens them again.
//
// This is the switch an operator reaches for when something is wrong and they need the box to
// stop taking new work while they look at it. It only helps if it is BOTH halves: new arrivals
// turned away AND the people already inside told, in one action, across two programs. Half of
// it is worse than neither — an operator who believes the doors are shut while players keep
// arriving is worse off than one who knows they are open.
//
// The switch lives on the platform and has to reach every running game, which is a relay from
// the gateway into each world over loopback with the platform's own credential. It also has to
// SURVIVE: a game reaped while maintenance was on keeps its own marker, and if that is never
// cleared it comes back on its owner's next dial with doors that never reopen.
//
// The last step is the one that makes the rest mean anything: turning it off has to actually
// let people back in. A test that only proves things are refused is satisfied by a server that
// is simply broken.
import assert from 'node:assert/strict';
import { startGatewayAndClient, harnessSession } from './_gateway.mjs';

const OWNER = { name: 'maint@example.com', password: 'a-long-enough-passphrase' };
const STEP = 30_000;
// Spaced from its neighbours: the gateway puts each world on GW_PORT + 200 upward, one per
// client, so adjacent scenarios otherwise hand each other a port still draining.
const GW_PORT = 18950;

export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'maint-player', ownId: 'priv-maint-world',
  });
  const root = `http://127.0.0.1:${GW_PORT}`;
  const base = `${root}/admin/api`;
  try {
    await host.client.waitFor('window.omw.state.state === "Joined"', STEP,
      'a player is in a game before the doors close');

    const owner = await fetch(`${base}/setup/owner`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
    });
    assert.equal(owner.status, 200, `owner creation (${owner.status})`);
    const token = (await owner.json()).token;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await fetch(`${base}/setup`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ deploymentMode: 'multiplayer', completed: true }),
    });

    // A control BEFORE the switch: creating a world must work, or "refused afterwards" says
    // nothing about maintenance.
    const player = await harnessSession(GW_PORT, `${host.account}-second`);
    const before = await fetch(`${root}/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${player}` },
      body: JSON.stringify({ id: 'priv-maint-probe', mode: 'private' }),
    });
    assert.equal(before.status, 200,
      `a world must be creatable before maintenance (${before.status}) — without this the`
      + ' refusal below proves nothing');
    ctx.log('ok: the doors are open to begin with');

    // THE SWITCH.
    const on = await fetch(`${base}/maintenance`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ on: true, message: 'back in ten minutes' }),
    });
    assert.equal(on.status, 200, `maintenance must be settable (${on.status}): ${await on.text()}`);
    ctx.log('ok: the operator closed the doors');

    // 1. NEW ARRIVALS ARE TURNED AWAY — and told why, so a launcher shows the operator's
    // message rather than an error the player cannot act on.
    const during = await fetch(`${root}/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${player}` },
      body: JSON.stringify({ id: 'priv-maint-probe-2', mode: 'private' }),
    });
    assert.equal(during.status, 503, `a new game must be refused during maintenance (${during.status})`);
    const why = await during.json();
    assert.match(String(why.message ?? ''), /back in ten minutes/,
      `the operator's own message must reach the player: ${JSON.stringify(why)}`);
    ctx.log(`ok: new arrivals are refused, and told: "${why.message}"`);

    // 2. AND THE PEOPLE ALREADY INSIDE ARE TOLD. This is the relay from the platform into each
    // running game — a different program, over loopback, with the platform's own credential.
    await host.client.waitFor('window.omw.state.state !== "Joined"', 90_000,
      'a player already in a game must be let go, not left playing on a server that believes'
      + ' its doors are shut');
    ctx.log('ok: the player already inside was disconnected');

    // 3. AND THE DOORS OPEN AGAIN. The control: without it, everything above is satisfied by a
    // server that has simply stopped working.
    const off = await fetch(`${base}/maintenance`, {
      method: 'POST', headers: auth, body: JSON.stringify({ on: false, message: '' }),
    });
    assert.equal(off.status, 200, `maintenance must be clearable (${off.status})`);
    const after = await fetch(`${root}/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${player}` },
      body: JSON.stringify({ id: 'priv-maint-probe-3', mode: 'private' }),
    });
    assert.equal(after.status, 200,
      `the doors must open again (${after.status}) — a maintenance switch with no way back is`
      + ' one an operator is right to be afraid of');
    ctx.log('ok: the doors opened again');
    ctx.log('PASS: maintenance turns arrivals away, lets the people inside go, and lifts');
  } finally {
    host.stop();
  }
}
