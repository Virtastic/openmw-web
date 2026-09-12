// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s112: A HEAL STICKS. The peer's bars rule a driving player (s110 proved the creature's
// damage lands), so anything the player does to their OWN bars -- a potion, resting, a
// self-cast Restore Health -- is a client claim the server must forward to the avatar as a
// restore. If it does not, the avatar's next report knocks the bar straight back down and
// every potion in the game does nothing (measured once, 2026-09: "overwritten by the
// un-restored avatar three seconds later"). Unit-tier: avatarstats.test.ts. This is it live:
// get bitten, heal to full on the client, and the PEER-reported bars must follow up.
import assert from 'node:assert/strict';

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const SPOT = '-12500,-53100,512';

const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const netObjs = async (c) => JSON.parse(await c.eval('window.omw.state.netObjects||"{}"'));
const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };
const bars = async (c) => parseBars(await c.eval('window.omw.state.selfStats'));

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-7');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const a = await ctx.launchClient('bot-a', '', BOOT);
  await a.cmd('snapto:' + SPOT);
  await a.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'A built a named creature');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 30_000, 'A puppeted the cell actors');
  const names = Object.values(await netObjs(a));
  const probe = await probeOf(a);
  const victim = names.find((r) => probe[r] && !probe[r].dead);
  assert.ok(victim, 'no living named creature');
  const p = probe[victim];
  await a.cmd(`snapto:${Math.round(p.x + 60)},${Math.round(p.y)},${Math.round(p.z + 8)}`);
  await ctx.sleep(3_000);

  // Get hurt (s110's chain), then walk away so the bite stops.
  let hurt = null, pokes = 0;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !(hurt && hurt.c < hurt.b)) {
    if (pokes < 3) { await a.cmd(`hitn:${victim}:1`); pokes++; }
    await ctx.sleep(2_000);
    hurt = await bars(a);
  }
  assert.ok(hurt && hurt.c < hurt.b, `never got hurt (selfStats=${JSON.stringify(hurt)}); s110 covers this`);
  await a.cmd(`snapto:${Math.round(p.x + 2500)},${Math.round(p.y)},${Math.round(p.z + 8)}`);
  await ctx.sleep(4_000);
  const before = await bars(a);
  ctx.log(`hurt: selfStats=${before.c}/${before.b} (out of the creature's reach now)`);
  assert.ok(before.c < before.b, 'should still be hurt after stepping away');

  // The potion: a client-side heal to full. Nothing on the peer did this.
  await a.cmd(`sethp:${before.b}`);
  const healDeadline = Date.now() + 20_000;
  let after = null;
  while (Date.now() < healDeadline) {
    after = await bars(a);
    if (after && after.c >= after.b) break;
    await ctx.sleep(500);
  }
  ctx.log(`after the heal: selfStats=${after ? after.c + '/' + after.b : 'none'}`);
  assert.ok(after && after.c >= after.b,
    'the client heal never reached the avatar: the peer-reported bars stayed down, so the '
    + 'next report will undo the potion (the "every potion does nothing" failure)');
  // And it STAYS: two more reports later the avatar still agrees.
  await ctx.sleep(3_000);
  const later = await bars(a);
  assert.ok(later && later.c >= later.b, `the heal was undone: selfStats=${later.c}/${later.b}`);
  ctx.log(`ok: a client heal became the avatar's truth and stayed (${later.c}/${later.b})`);
}
