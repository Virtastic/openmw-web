// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s113: A CAST COSTS MAGICKA. The avatar on the peer never casts (the owner's client casts
// and forwards the hit), so the only thing that ever lowers magicka is the owner's own
// engine -- and the peer's bar report, which rules a driving player, says "full" four times
// a second. Unless the client's spend reaches the avatar, every spell is free and the bar
// flickers. Unit tier: avatarstats.test.ts ("MAGICKA GOES DOWN TOO"). Live: spend on the
// client, and the PEER-reported magicka must come down and stay down; then a restore
// (potion) must bring it back up the same way.
import assert from 'node:assert/strict';

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.waitFor('/^\d+\/\d+$/.test(String(window.omw.state.selfMagicka||""))', 300_000, 'the peer reports A\'s magicka (driving the input tier)');
  const full = parseBars(await a.eval('window.omw.state.selfMagicka'));
  ctx.log(`peer-reported magicka: ${full.c}/${full.b}`);
  assert.ok(full.b >= 2, 'need a magicka pool to spend from');

  const settle = async (pred, what) => {
    const deadline = Date.now() + 20_000;
    let v = null;
    while (Date.now() < deadline) {
      v = parseBars(await a.eval('window.omw.state.selfMagicka'));
      if (v && pred(v)) break;
      await ctx.sleep(400);
    }
    return v;
  };

  // The cast: local magicka drops to a quarter. The avatar's report says full until the
  // spend reaches it.
  const spent = Math.floor(full.b / 4);
  await a.cmd(`setmp:${spent}`);
  let v = await settle((b) => b.c <= spent + 1, 'spend');
  ctx.log(`after the cast: peer-reported ${v ? v.c + '/' + v.b : 'none'}`);
  assert.ok(v && v.c <= spent + 1, 'the spend never reached the avatar: the peer still reports the bar full, so the cast was free');
  await ctx.sleep(3_000);
  v = parseBars(await a.eval('window.omw.state.selfMagicka'));
  assert.ok(v.c <= spent + 1, `the spend was undone by a later report: ${v.c}/${v.b}`);

  // The potion: back to full on the client; the avatar must follow.
  await a.cmd(`setmp:${full.b}`);
  v = await settle((b) => b.c >= b.b, 'restore');
  ctx.log(`after the potion: peer-reported ${v ? v.c + '/' + v.b : 'none'}`);
  assert.ok(v && v.c >= v.b, 'the restore never reached the avatar');
  ctx.log('ok: a cast costs magicka and a potion restores it, on the bars the peer reports');
}
