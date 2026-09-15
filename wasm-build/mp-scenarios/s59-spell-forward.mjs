// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s59 (M5): SPELL DAMAGE REACHES THE CELL'S OWNER, the same as a weapon hit does.
//
// WHY THIS EXISTS. Spell damage never travelled in multiplayer. Casting at an NPC or a player
// did nothing: the caster's own client damaged its local puppet copy, the owner was never told,
// and the next stats push reverted it. Three of the four M5 combat messages were implemented on
// the server and sent by nobody; `CombatSpellHit` was one of them.
//
// The cause was an asymmetry between melee and magic, not a missing message:
//
//   MELEE  — the engine hands damage application to Lua (the `Hit` local event), so
//            scripts/mp/puppet.lua intercepts it, returns false to cancel, and forwards.
//   MAGIC  — mwmechanics/spelleffects.cpp applies harmful effects itself in C++, and its only
//            Lua notification (`Class::onHit`) returns void and is queued. Nothing could veto
//            it, so the damage was always applied locally and never forwarded.
//
// The fix is a synchronous seam: puppet.lua marks every puppet through `mp.setPuppet`, the
// damage site asks `MWMP::isPuppet` before applying, and parks the effect instead. puppet.lua
// drains it the next frame and forwards it over the route melee already used. See
// openmw/apps/openmw/mwmp/puppets.hpp.
//
// This asserts the JOURNEY: a real engine casting a real damaging spell at a real NPC, through
// the server, to the peer that owns it — and the NPC dying of it, seen by both players.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCast, castAt, FIRE_BITE } from './_spell.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;

// A protocol/simulating peer runs no game data, so it cannot satisfy a manifest adopted from a
// retail browser. See s58 for the full reasoning.
export const serverRules = `
[content]
enforce = "off"
`;

const STEP_TIMEOUT = 25_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for cell NPCs)');
    return;
  }
  // Started first: it boots a whole retail game (~2.5 min on a GPU-less box) before it can take
  // a cell, so it needs to overlap the browser boots rather than follow them.
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) {
    ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset). '
      + 'Run under wasm-build/Dockerfile.harness-peer.');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('caster', '', BOOT),
    ctx.launchClient('watcher', '', BOOT),
  ]);
  for (const c of [a, b]) {
    await c.waitFor('Number(window.omw.state.actorCount||0) > 0', STEP_TIMEOUT, `${c.name} sees actors`);
  }

  let owner = 'none';
  const deadline = Date.now() + Number(process.env.S59_PEER_TIMEOUT ?? 300_000);
  while (Date.now() < deadline) {
    owner = await a.eval('window.omw.state.authorityHolder');
    if (owner && owner !== 'none') break;
    await ctx.sleep(500);
  }
  assert.notEqual(owner, 'none', 'the simulating peer never took the cell');
  ctx.log(`cell owner=${owner}; the caster does not own the target`);

  for (const c of [a, b]) {
    await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', STEP_TIMEOUT,
      `${c.name} puppeted the cell actors`);
  }

  const [pa, pb] = await Promise.all([probeOf(a), probeOf(b)]);
  // ONE living, unguarded NPC both clients see; the caster stands beside it. With the peer
  // holding the cell every actor here is a puppet on the caster, so a touch cast lands on
  // the seam under test.
  const victims = Object.keys(pa).filter((r) => r !== 'player' && pb[r] && !pa[r].guard
    && pa[r].dead !== true && pb[r].dead !== true);
  assert.ok(victims.length > 0, 'need at least one living NPC visible to both clients');
  const victim = victims[0];
  const target = async () => (await probeOf(a))[victim] || pa[victim];
  const p0 = await target();
  await a.cmd(`snapto:${Math.round(p0.x + 60)},${Math.round(p0.y)},${Math.round(p0.z + 8)}`);
  await ctx.sleep(3_000);
  // A REAL CAST (backlog 242): Fire Bite on touch, the spell stance and the use key on the
  // caster's own engine. The castat: hook parked the effect on the puppet directly and
  // stayed green with spelleffects.cpp's own path dead.
  await prepareCast(a, ctx, FIRE_BITE, 'destruction');
  ctx.log(`casting ${FIRE_BITE} at "${victim}" from beside it (of ${victims.length} shared NPCs)`);

  // CAST, repeatedly, re-aimed at where the mark stands now. Every cast goes through
  // spelleffects.cpp on the caster's client, where the target is a puppet — so nothing is
  // applied locally and the effect is forwarded to the peer that owns it. If that chain is
  // broken the NPC simply never dies, which is exactly what "casting does nothing" looked like.
  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  const castDeadline = Date.now() + 150_000;
  let died = false, casts = 0;
  while (Date.now() < castDeadline && !died) {
    const p = await target();
    const me = JSON.parse(await a.eval('window.omw.state.pose||"{}"'));
    if (Math.hypot(p.x - me.x, p.y - me.y) > 120) { // it walked off: step back beside it
      await a.cmd(`snapto:${Math.round(p.x + 60)},${Math.round(p.y)},${Math.round(p.z + 8)}`);
      await ctx.sleep(2_000);
    }
    await castAt(a, ctx, p); casts++;
    died = (await a.eval(deadExpr)) === true || (await b.eval(deadExpr)) === true;
  }
  if (!died) {
    // Where did the chain stop? Each stage mirrors its own outcome, so one run says which.
    for (const c of [a, b]) {
      const [mark, fwd, sf, st] = await Promise.all([
        c.eval('window.omw.state.puppetMark'),
        c.eval('window.omw.state.magicFwd'),
        c.eval('window.omw.state.spellFwd'),
        c.eval('window.omw.state.stance'),
      ]);
      ctx.log(`  ${c.name}: puppetMark=${mark} magicFwd=${fwd} spellFwd=${sf} stance=${st} probe=${JSON.stringify((await probeOf(c))[victim])}`);
    }
  }
  assert.ok(died,
    `"${victim}" never died from ${casts} real cast(s): the cast fizzled, missed, or is not reaching the cell owner -- the `
    + '"my spells do nothing" failure this scenario exists for');
  ctx.log(`ok: "${victim}" died from spell damage routed through the cell owner`);

  // Authored by the peer, so it must reach BOTH players — not just the caster.
  await a.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on the caster');
  await b.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on the watcher');
  ctx.log('ok: both players saw the spell kill');
}
