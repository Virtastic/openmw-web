// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s103: A PLAYER REPORTS SOMEBODY AND AN OPERATOR CAN READ IT.
//
// Moderation is the one social feature with no feedback loop for the person using it: you
// report a griefer, the panel says thank you, and whether anything reached a human is
// unknowable from inside the game. The two halves are written in different places — the panel
// command in the client, the queue behind an admin route — and nothing joined them up, so
// either could have rotted without the other noticing.
//
// The report path is also deliberately forgiving in a way worth pinning: an OFFLINE name is
// accepted and recorded as typed, because the griefer who logs off the moment they are done is
// the ordinary case. A future tightening that "validates" the name would quietly delete that.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

const OWNER = { name: 'mods@example.com', password: 'a-long-enough-passphrase' };
const STEP = 30_000;
const GW_PORT = 18871;

export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'rep-host', ownId: 'priv-rep-host',
  });
  const base = `http://127.0.0.1:${GW_PORT}/admin/api`;
  try {
    const other = await addClient(ctx, GW_PORT, { name: 'rep-other', ownId: 'priv-rep-other' });

    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const reporter = `rep${tag}`;
    const target = `bad${tag}`;
    await host.client.cmd(`profile:rep-host@example.com:${reporter}`);
    await other.client.cmd(`profile:rep-other@example.com:${target}`);
    for (const [who, cli] of [['reporter', host.client], ['target', other.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }

    // The report itself, exactly as the panel sends it: a NAME and a reason. The target is in
    // a different world, which is the ordinary case and the one a roster-only lookup breaks.
    await host.client.cmd(`social:ReportPlayer:${target}:shouting slurs in world chat`);
    await host.client.waitFor(
      `JSON.parse(window.omw.state.socialResult||'{}').op === 'ReportPlayer'`, STEP,
      'the server answered the report');
    const res = JSON.parse(await host.client.eval("window.omw.state.socialResult||'{}'"));
    assert.equal(res.ok, true, `the report was refused: ${JSON.stringify(res)}`);
    ctx.log(`ok: ${reporter} reported ${target}, who is in another world`);

    // The operator side.
    const owner = await fetch(`${base}/setup/owner`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER),
    });
    assert.equal(owner.status, 200, `owner creation (${owner.status})`);
    const token = (await owner.json()).token;
    const auth = { authorization: `Bearer ${token}` };
    await fetch(`${base}/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ deploymentMode: 'multiplayer', completed: true }),
    });

    // IT REACHED A HUMAN. Polled: the report is written by a world process and read by the
    // platform, so the two are not the same tick.
    let found;
    for (let i = 0; i < 20 && !found; i++) {
      const r = await fetch(`${base}/reports`, { headers: auth });
      assert.equal(r.status, 200, `the report queue must be readable (${r.status})`);
      const body = await r.json();
      const rows = body.reports ?? body;
      found = (Array.isArray(rows) ? rows : []).find((x) =>
        JSON.stringify(x).includes(target));
      if (!found) await ctx.sleep(1000);
    }
    assert.ok(found, 'the report never reached the operator\'s queue');
    // The fields the console actually renders (server.ts: ts, reporter, target, reason).
    assert.ok(JSON.stringify(found).includes('slurs'),
      `the reason must survive to the queue: ${JSON.stringify(found)}`);
    ctx.log(`ok: the operator can read it — ${JSON.stringify(found).slice(0, 160)}`);
    ctx.log('PASS: a report crosses from the panel to the operator queue');
  } finally {
    host.stop();
  }
}
