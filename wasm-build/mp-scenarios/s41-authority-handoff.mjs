// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s41: ONLY A SIM PEER MAY HOLD CELL AUTHORITY. A client never does, however it asks.
//
// WHAT THIS FILE USED TO BE, and why it could not stay. It tested client-to-client authority
// HANDOFF: two browsers share a cell, the holder is SIGKILLed, the survivor must be granted the
// cell and resume the NPCs' AI. That model is gone. `worldstate.ts` `canSimulate` is now
// `return p.system === true`, with the reasoning stated there:
//
//   ONLY the sim peer may hold a cell. Not a knob: it was tied to `auth.requireSso`, which has
//   nothing to do with who simulates NPCs — so a non-SSO server silently fell back to letting a
//   PLAYER'S BROWSER author NPC state for everyone.
//
// So there is no second holder to hand off TO, and the old scenario could only ever fail
// (`exactly one holder before handoff: 0 !== 1`). It had been failing unnoticed since that
// change, because the wasm engine did not build and the browser suite was not being run.
//
// Deleting it would have left the REPLACEMENT property untested, which is the more important
// one: the whole point of that change is that a player's machine can never author NPC state.
// Nothing anywhere drove that through a real browser. This does.
//
// The sharpest form of the assertion is the second one: `simulatesActors` is CLIENT-DECLARED
// (connection.ts:913), and a client that declares it must still be refused. That is the exact
// hole `canSimulate` was rewritten to close, so it is worth an explicit test rather than
// trusting the flag is ignored.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;

// A protocol peer runs no game data, so it cannot satisfy a manifest adopted from a retail
// browser. See s52 for the full reasoning.
export const serverRules = `
[content]
enforce = "off"
`;

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
// Long enough that a Grant which was going to arrive, has. The server grants on cell entry,
// so this is generous rather than a guess at scheduling.
const NO_GRANT_SETTLE_MS = 8_000;

const mirror = (c, key) => c.eval(`(window.__omwMP||{}).${key}`);

async function cellKeyOf(c) {
  const census = JSON.parse(await c.eval('(window.__omwMP||{}).actorCensus||"[]"'));
  const me = census.find((e) => e.startsWith('player@'));
  if (!me) throw new Error(`actorCensus has no player entry: ${JSON.stringify(census)}`);
  return me.slice('player@'.length);
}

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for cell NPCs)');
    return;
  }
  const { holdCell, TestClient } = await import(
    pathToFileURL(join(ROOT, 'server', 'dist', 'testpeer.mjs')).href);

  const a = await ctx.launchClient('watcher', '', BOOT);
  const cellKey = await cellKeyOf(a);
  ctx.log(`client is in ${cellKey}`);

  // 1. A LONE BROWSER DOES NOT TAKE THE CELL. Before the sim peer existed this client would
  //    have been granted it on arrival and would be simulating every NPC for everyone.
  await ctx.sleep(NO_GRANT_SETTLE_MS);
  assert.equal(await mirror(a, 'isHolder'), 'false',
    'a browser client took cell authority — canSimulate is no longer system-only');
  assert.equal(await mirror(a, 'authorityHolder'), 'none',
    `no peer is running, so ${cellKey} must have no holder at all`);
  ctx.log('lone browser holds nothing, and the cell has no holder');

  // 2. DECLARING simulatesActors CHANGES NOTHING. This is the hole canSimulate was rewritten
  //    to close: the flag is client-authored, so believing it hands NPC authorship to whoever
  //    asks. TestClient sets it true by default, which is exactly the claim under test.
  const liar = await TestClient.connect(ctx.serverPort);
  await liar.joinAsNew('EagerSimulator');
  await liar.waitEvent('PlayerList');
  liar.sendCellChange(cellKey, 0, 0, 0);
  await liar.waitEvent('PlayerCellChange');
  await ctx.sleep(NO_GRANT_SETTLE_MS);
  const grants = liar.inbox.events.filter((e) => e.name === 'ActorAuthorityGrant');
  assert.equal(grants.length, 0,
    `a client declaring simulatesActors was granted authority: ${JSON.stringify(grants)}`);
  assert.equal(await mirror(a, 'authorityHolder'), 'none',
    'the declaring client became the holder as far as the browser is concerned');
  ctx.log('a client declaring simulatesActors was refused');

  // 3. A SYSTEM PEER DOES GET IT, and the browser is told who holds the cell — which is what
  //    lets it puppet the NPCs rather than simulate them.
  const { peer, epoch } = await holdCell(ctx.serverPort, ctx.serverPassword, cellKey);
  ctx.log(`peer holds ${cellKey} at epoch ${epoch}`);
  await a.waitFor(`(window.__omwMP||{}).authorityHolder !== 'none'`, 30_000,
    'the browser to learn the cell has a holder');
  const holder = await mirror(a, 'authorityHolder');
  assert.notEqual(holder, 'none', 'the browser never learned about the peer');
  assert.equal(await mirror(a, 'isHolder'), 'false',
    'the browser thinks IT holds the cell the peer was granted');
  assert.equal(String(holder), String(peer.playerId),
    `the holder should be the peer (${peer.playerId}), got ${holder}`);
  ctx.log(`browser sees holder=${holder} (the peer), and still holds nothing itself`);

  liar.close();
  peer.close();
}
