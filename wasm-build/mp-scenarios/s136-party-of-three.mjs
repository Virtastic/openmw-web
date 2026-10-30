// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s136: THREE PLAYERS IN ONE WORLD. Every earlier two-player scenario has exactly one pair. A
// real evening is three: everyone sees everyone (three names on every screen), one player's
// chat reaches BOTH others, two of them trade inside the world (drop + pickup, the sanctioned
// exchange, s108), and when one leaves the other two see them go. The edges between players
// who are not the first client are the ones nothing else exercises. (v1 framed it as a host
// and two guests who are sent home when the host closes up; that is gone, OT3-31/58.)
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient } from './_gateway.mjs';

const STEP = 30_000;
const GW_PORT = 19060; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const netCount = 'Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length';
const rowOf = (handle) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(handle)}; }) || {})`;

// BY NAME, not by id (#127): the test helmet is a record MINTED at runtime, and M7 maps
// server record ids per world -- the id A's engine knows it by is not the id B's engine
// creates it under, so counting B's pack by A's id answered 0 for an item B was holding.
async function countOf(c, name) {
  await c.eval("if (window.omw.state) window.omw.state.countName = null; 'cleared';");
  await c.cmd(`countname:${name}`);
  await c.waitFor("typeof window.omw.state.countName === 'string'", 10_000, `${c.name} reported its count`);
  return Number(await c.eval('window.omw.state.countName'));
}

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'trio-host' });
  try {
    const ga = await addClient(ctx, GW_PORT, { name: 'trio-a' });
    const gb = await addClient(ctx, GW_PORT, { name: 'trio-b' });
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
      // Stored first (a refusal shows as itself), then carried to the other world by its 10 s
      // social heartbeat: 60 s covers several beats on a loaded box (#175 s136).
      await host.client.eval("window.omw.state.socialResult = ''; 'cleared'");
      await host.client.cmd(`social:FriendRequest:${handle}`);
      await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'FriendRequest'`, STEP, `the server answered the request to ${handle}`);
      const res = JSON.parse(await host.client.eval('window.omw.state.socialResult'));
      assert.ok(res.ok, `the request to ${handle} was refused: ${res.detail}`);
      await g.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, 60_000, `the request reaches ${handle}`);
      await g.client.cmd(`social:FriendAccept:${H}`);
    }
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 2`, 60_000, 'the host has two friends');
    // Everyone is in the one world already (v1 had to join the host's party world).
    for (const [handle, g] of [[A, ga], [B, gb]]) {
      await host.client.waitFor(`${rowOf(handle)}.id !== undefined`, 300_000, `the host sees ${handle}`);
      await g.client.waitFor('window.omw.state.state === "Joined"', 60_000, `${handle} is joined`);
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
    const ITEM_NAME = 'MP Test Helmet'; // global.lua mpTestItem's record name
    const bHad = await countOf(gb.client, ITEM_NAME);
    await ga.client.cmd(`drop:${itemId}`);
    await gb.client.waitFor(`${netCount} === 1`, STEP, "B sees A's drop");
    await host.client.waitFor(`${netCount} === 1`, STEP, 'the host sees the drop too');
    const netId = await gb.client.eval('Object.keys(JSON.parse(window.omw.state.netObjects))[0]');
    await gb.client.cmd(`takenet:${netId}`);
    for (const [who, cli] of [['A', ga.client], ['B', gb.client], ['host', host.client]]) {
      await cli.waitFor(`${netCount} === 0`, STEP, `the item left the ground on ${who}`);
    }
    // The take lands in B's pack a frame or more after it leaves the ground; at B's frame
    // rate a fixed pause counted 0 (#117). Count until it is there.
    let aNow = 0, bNow = bHad;
    for (let i = 0; i < 20 && bNow !== bHad + 1; i++) { await ctx.sleep(1_000); [aNow, bNow] = [await countOf(ga.client, ITEM_NAME), await countOf(gb.client, ITEM_NAME)]; }
    ctx.log(`trade: A holds ${aNow}, B holds ${bNow} (had ${bHad})`);
    assert.equal(aNow, 0, 'A still holds what it gave B');
    assert.equal(bNow, bHad + 1, "B did not receive A's item");
    ctx.log("ok: two guests traded inside the host's world");

    // One of them leaves: the other two see them go and stay put.
    ga.client.close();
    await host.client.waitFor(`${rowOf(A)}.id === undefined`, 120_000, 'the host sees A leave');
    await gb.client.waitFor(`${rowOf(A)}.id === undefined`, 120_000, 'B sees A leave');
    assert.equal(await gb.client.eval('window.omw.state.state'), 'Joined', 'B stays joined');
    const errs = gb.client.luaErrors().concat(host.client.luaErrors());
    assert.equal(errs.length, 0, 'Lua errors during the evening:\n' + errs.join('\n'));
    ctx.log('PASS: three players -- everyone seen by everyone, chat to all, trading, a leaver is seen to go');
  } finally {
    host.stop();
  }
}
