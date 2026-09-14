// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s136: A PARTY OF THREE. Every guest scenario so far is one friend joining one host. A real
// evening is the host and TWO friends: both join through the real door, everyone sees
// everyone (three names on every screen), a guest's chat reaches the host AND the other
// guest, the two guests can trade with each other inside the host's world (drop + pickup,
// the sanctioned exchange, s108), and when the host closes up BOTH guests land home. The
// guest-to-guest edges are the ones nothing else exercises.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19060; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const netCount = 'Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length';
const rowOf = (handle) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(handle)}; }) || {})`;

async function countOf(c, id) {
  await c.eval("if (window.omw.state) window.omw.state.count = null; 'cleared';");
  await c.cmd(`count:${id}`);
  await c.waitFor("typeof window.omw.state.count === 'string'", 10_000, `${c.name} reported its count`);
  return Number(await c.eval('window.omw.state.count'));
}

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'trio-host', ownId: 'priv-trio-host' });
  try {
    const ga = await addClient(ctx, GW_PORT, { name: 'trio-a', ownId: 'priv-trio-a' });
    const gb = await addClient(ctx, GW_PORT, { name: 'trio-b', ownId: 'priv-trio-b' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const H = `thost${tag}`, A = `ta${tag}`, B = `tb${tag}`;
    await host.client.cmd(`profile:trio-host@example.com:${H}`);
    await ga.client.cmd(`profile:trio-a@example.com:${A}`);
    await gb.client.cmd(`profile:trio-b@example.com:${B}`);
    for (const [who, cli] of [['host', host.client], ['A', ga.client], ['B', gb.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    // The host befriends both.
    for (const [handle, g] of [[A, ga], [B, gb]]) {
      await host.client.cmd(`social:FriendRequest:${handle}`);
      await g.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, `the request reaches ${handle}`);
      await g.client.cmd(`social:FriendAccept:${H}`);
    }
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 2`, STEP, 'the host has two friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    // Both friends come over.
    for (const [handle, g] of [[A, ga], [B, gb]]) {
      const acct = JSON.parse(await g.client.eval("window.omw.state.friends||'[]'"))[0].acct;
      await g.client.cmd(`joinfriend:${acct}`);
      await host.client.waitFor(`${rowOf(handle)}.id !== undefined`, 300_000, `the host sees ${handle} arrive`);
      await g.client.waitFor('window.omw.state.state === "Joined"', 60_000, `${handle} is joined after the redial`);
      await grantLockerSession(g.client, GW_PORT, g.account);
    }
    // Everyone sees everyone: three names on every screen.
    for (const [who, cli, others] of [['host', host.client, [A, B]], ['A', ga.client, [H, B]], ['B', gb.client, [H, A]]]) {
      for (const o of others) await cli.waitFor(`${rowOf(o)}.id !== undefined`, STEP, `${who} sees ${o}`);
    }
    ctx.log('ok: host, A and B are together and each sees the other two');

    // A guest's chat reaches the host and the other guest.
    const nonce = 'n' + Math.random().toString(36).slice(2, 10);
    await ga.client.eval(`window.omw.send('chatx:say::' + ${JSON.stringify('evening all ' + nonce)})`);
    for (const [who, cli] of [['host', host.client], ['B', gb.client]]) {
      await cli.waitFor(`(window.omw.state.lastChat||"").includes(${JSON.stringify(nonce)})`, 15_000, `A's chat reached ${who}`);
    }
    ctx.log("ok: a guest's chat reached the host and the other guest");

    // Guest-to-guest trade inside the host's world: A drops, B takes, exactly one holder after.
    await ga.client.cmd('equiptest');
    await ga.client.waitFor('(window.omw.state.equippedIds||"") !== ""', 12_000, 'A holds the test item');
    const itemId = (await ga.client.eval('window.omw.state.equippedIds')).split(',')[0];
    const bHad = await countOf(gb.client, itemId);
    await ga.client.cmd(`drop:${itemId}`);
    await gb.client.waitFor(`${netCount} === 1`, STEP, "B sees A's drop");
    await host.client.waitFor(`${netCount} === 1`, STEP, 'the host sees the drop too');
    const netId = await gb.client.eval('Object.keys(JSON.parse(window.omw.state.netObjects))[0]');
    await gb.client.cmd(`takenet:${netId}`);
    for (const [who, cli] of [['A', ga.client], ['B', gb.client], ['host', host.client]]) {
      await cli.waitFor(`${netCount} === 0`, STEP, `the item left the ground on ${who}`);
    }
    await ctx.sleep(1_500);
    const aNow = await countOf(ga.client, itemId), bNow = await countOf(gb.client, itemId);
    ctx.log(`trade: A holds ${aNow}, B holds ${bNow} (had ${bHad})`);
    assert.equal(aNow, 0, 'A still holds what it gave B');
    assert.equal(bNow, bHad + 1, "B did not receive A's item");
    ctx.log("ok: two guests traded inside the host's world");

    // The host closes up: BOTH guests are sent home and land joined in their own worlds.
    await host.client.cmd('worldmode:private');
    for (const [who, g] of [['A', ga], ['B', gb]]) {
      await g.client.waitFor(`(window.omw.state.worldClosed||'') !== '' || String(window.omw.state.state||'') !== 'Joined'`, STEP, `${who} is sent home`);
    }
    for (const [who, g] of [['A', ga], ['B', gb]]) {
      await g.client.waitFor('window.omw.state.state === "Joined" && String(window.omw.state.worldClosed||"") === ""', 180_000, `${who} is back in their own world`);
    }
    await host.client.waitFor(`${rowOf(A)}.id === undefined && ${rowOf(B)}.id === undefined`, STEP, 'the host is alone again');
    const errs = ga.client.luaErrors().concat(gb.client.luaErrors(), host.client.luaErrors());
    assert.equal(errs.length, 0, 'Lua errors during the evening:\n' + errs.join('\n'));
    ctx.log('PASS: a party of three -- everyone seen by everyone, chat to all, guests trading, both home when the host closes');
  } finally {
    host.stop();
  }
}
