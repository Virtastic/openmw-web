// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s173: THE NPC POSE STREAM REACHES A LONE PLAYER'S SCRIPTS.
//
// 2026-09-23, dev box: the server relayed ~41 ActorMoveBatch frames/s to a solo player and the
// browser received every one, yet actors.lua counted none -- NPCs ran their own AI on that
// screen, walked slowly at the player, never swung, and hits landed on a copy the server had
// never heard of. No scenario asserted the stream arrives; this one does, for ONE client
// standing where that player stood (Seyda Neen outskirts, -2,-8).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPOT = '-12000,-62000,300'; // inside -2,-8

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-8');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) { ctx.log('SKIP: retail data absent'); return; }

  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.cmd('snapto:' + SPOT);
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'A puppets cell actors');

  const read = async () => JSON.parse(await a.eval(`JSON.stringify((() => { const s = window.omw.state; return {
    abi: s.actorBatchesIn, holder: s.authorityHolder, isHolder: s.isHolder, puppeted: s.puppetedActors,
    puppetRx: s.puppetRx, puppetMark: s.puppetMark, cell: s.cell, actors: s.actorCount, simReady: s.simReady }; })())`));
  const before = await read();
  await new Promise((r) => setTimeout(r, 5000));
  const after = await read();
  ctx.log(`before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  const got = Number(after.abi || 0) - Number(before.abi || 0);
  assert.ok(got > 20, `ActorMoveBatch reached the scripts ${got} times in 5 s (expected ~100+)`);
  ctx.log(`ok: ${got} actor batches in 5 s`);
}
