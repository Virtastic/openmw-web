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
const probeOf = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).actorProbe||"{}"'));

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
    await c.waitFor('Number((window.__omwMP||{}).actorCount||0) > 0', STEP_TIMEOUT, `${c.name} sees actors`);
  }

  let owner = 'none';
  const deadline = Date.now() + Number(process.env.S59_PEER_TIMEOUT ?? 300_000);
  while (Date.now() < deadline) {
    owner = await a.eval('(window.__omwMP||{}).authorityHolder');
    if (owner && owner !== 'none') break;
    await ctx.sleep(500);
  }
  assert.notEqual(owner, 'none', 'the simulating peer never took the cell');
  ctx.log(`cell owner=${owner}; the caster does not own the target`);

  for (const c of [a, b]) {
    await c.waitFor('Number((window.__omwMP||{}).puppetedActors||0) > 0', STEP_TIMEOUT,
      `${c.name} puppeted the cell actors`);
  }

  const [pa, pb] = await Promise.all([probeOf(a), probeOf(b)]);
  // CAST AT EVERY shared NPC, not one picked in advance. Only actors the caster is PUPPETING
  // exercise the path under test — the engine skips its local application for those and parks
  // the effect — and which of a cell's actors are puppeted is not something the probe reports.
  // Betting on a single record picked an unpuppeted mudcrab once and proved nothing.
  const victims = Object.keys(pa).filter((r) => r !== 'player' && pb[r]
    && pa[r].dead !== true && pb[r].dead !== true);
  assert.ok(victims.length > 0, 'need at least one living NPC visible to both clients');
  ctx.log(`casting at ${victims.length} shared NPCs: ${victims.slice(0, 4).join(', ')}...`);

  // CAST, repeatedly. Every one of these goes through spelleffects.cpp on the caster's client,
  // where the target is a puppet — so nothing is applied locally and the effect is forwarded to
  // the peer that owns it. If that chain is broken the NPC simply never dies, which is exactly
  // what "casting does nothing" looked like in play.
  const anyDead = async (c) => {
    const p = JSON.parse(await c.eval('(window.__omwMP||{}).actorProbe||"{}"'));
    return victims.find((r) => p[r] && p[r].dead === true) ?? null;
  };
  const castDeadline = Date.now() + 120_000;
  let died = null;
  while (Date.now() < castDeadline && !died) {
    for (const v of victims) {
      await a.eval(`Module.__omwMPCmd=${JSON.stringify('castat:' + v + ':40')}`);
      await ctx.sleep(350);
    }
    died = (await anyDead(a)) ?? (await anyDead(b));
  }
  const victim = died;
  if (!died) {
    // Where did the chain stop? Each stage mirrors its own outcome, so one run says which.
    for (const c of [a, b]) {
      const [castAt, mark, fwd, sf] = await Promise.all([
        c.eval('(window.__omwMP||{}).castAt'),
        c.eval('(window.__omwMP||{}).puppetMark'),
        c.eval('(window.__omwMP||{}).magicFwd'),
        c.eval('(window.__omwMP||{}).spellFwd'),
      ]);
      ctx.log(`  ${c.name}: castAt=${castAt} puppetMark=${mark} magicFwd=${fwd} spellFwd=${sf}`);
    }
  }
  assert.ok(died,
    'the NPC never died from spell damage: casting is not reaching the cell owner, which is the '
    + '"my spells do nothing" failure this scenario exists for');
  ctx.log(`ok: "${victim}" died from spell damage routed through the cell owner`);

  // Authored by the peer, so it must reach BOTH players — not just the caster.
  const deadExpr = `((JSON.parse((window.__omwMP||{}).actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  await a.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on the caster');
  await b.waitFor(deadExpr, STEP_TIMEOUT, 'NPC dead on the watcher');
  ctx.log('ok: both players saw the spell kill');
}
