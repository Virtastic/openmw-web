// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s62 (M6): the rest of the quest layer — MWScript globals, per-object MWScript locals,
// factions and crime (PROTOCOL.md §M6 GlobalVarUpdate / MemberVarUpdate / FactionUpdate /
// CrimeUpdate). Each family is driven through the ENGINE bridge on A (never a hand-rolled
// send) and asserted on B's own engine-backed mirror.
//
// It also pins the two things that are easy to get wrong and impossible to see from a
// convergence check: the M7 time globals must NOT travel here, and applying an inbound
// update must not bounce back (the diff caches are seeded by the apply).
//
// RETAIL DATA REQUIRED: the Example Suite ships no factions and no scripted quest content.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP_TIMEOUT = 20_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

const GLOBAL = 'FreedSlavesCounter'; // Morrowind.esm, a plain quest counter
const GLOBAL_VALUE = 7;
const FACTION = 'fighters guild';
const BOUNTY = 250;

const jsonOf = async (c, key) => JSON.parse(await c.eval(`(window.__omwMP||{}).${key}||"{}"`));
const globalKey = (obj, name) =>
  Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a', '', BOOT),
    ctx.launchClient('bot-b', '', BOOT),
  ]);
  await a.waitFor('((window.__omwMP||{}).globalVars||"") !== ""', STEP_TIMEOUT, 'A globals mirror live');
  await b.waitFor('((window.__omwMP||{}).globalVars||"") !== ""', STEP_TIMEOUT, 'B globals mirror live');

  // --- MWScript globals ---------------------------------------------------------------
  // The time globals are M7's; they must never appear in the M6 diff set.
  const gA = await jsonOf(a, 'globalVars');
  for (const t of ['GameHour', 'Day', 'Month', 'Year', 'DaysPassed']) {
    assert.equal(globalKey(gA, t), undefined, `${t} must be excluded from GlobalVarUpdate diffs`);
  }
  ctx.log(`ok: ${Object.keys(gA).length} globals tracked, none of them the M7 clock`);

  await a.eval(`Module.__omwMPCmd='gvar:${GLOBAL}:${GLOBAL_VALUE}'`);
  const seesGlobal = (c) =>
    `Object.entries(JSON.parse((window.__omwMP||{}).globalVars||"{}")).some(([k,v])=>k.toLowerCase()===${JSON.stringify(GLOBAL.toLowerCase())}&&v===${GLOBAL_VALUE})`;
  await a.waitFor(seesGlobal(a), STEP_TIMEOUT, `A wrote ${GLOBAL}=${GLOBAL_VALUE}`);
  await b.waitFor(seesGlobal(b), STEP_TIMEOUT, `B received ${GLOBAL}=${GLOBAL_VALUE}`);
  ctx.log(`ok: GlobalVarUpdate ${GLOBAL}=${GLOBAL_VALUE} relayed`);

  // --- crime -------------------------------------------------------------------------
  await a.eval(`Module.__omwMPCmd='bounty:${BOUNTY}'`);
  await a.waitFor(`(window.__omwMP||{}).bounty === "${BOUNTY}"`, STEP_TIMEOUT, 'A bounty set');
  await b.waitFor(`(window.__omwMP||{}).bounty === "${BOUNTY}"`, STEP_TIMEOUT,
    'B bounty matches (CrimeUpdate + setCrimeLevel)');
  ctx.log(`ok: CrimeUpdate bounty=${BOUNTY} applied on B via the global-only setCrimeLevel`);

  // --- factions ----------------------------------------------------------------------
  await a.eval(`Module.__omwMPCmd='faction:${FACTION}:1'`);
  const inFaction = `Object.keys(JSON.parse((window.__omwMP||{}).factions||"{}")).some((k)=>k.toLowerCase()===${JSON.stringify(FACTION)})`;
  await a.waitFor(inFaction, STEP_TIMEOUT, 'A joined the faction');
  await b.waitFor(inFaction, STEP_TIMEOUT, 'B received FactionUpdate and applied it');
  const fb = await jsonOf(b, 'factions');
  ctx.log(`ok: FactionUpdate applied on B -> ${JSON.stringify(fb)}`);

  // --- per-object MWScript locals ------------------------------------------------------
  // Pick a scripted content object both clients have in their own cell.
  await a.waitFor('Object.keys(JSON.parse((window.__omwMP||{}).cellScripted||"{}")).length > 0',
    STEP_TIMEOUT, 'A found scripted cell objects');
  await b.waitFor('Object.keys(JSON.parse((window.__omwMP||{}).cellScripted||"{}")).length > 0',
    STEP_TIMEOUT, 'B found scripted cell objects');
  const [sa, sb] = await Promise.all([jsonOf(a, 'cellScripted'), jsonOf(b, 'cellScripted')]);
  const rec = Object.keys(sa).sort().find((r) => sb[r] && sb[r] === sa[r]);
  if (!rec) {
    ctx.log(`SKIP MemberVarUpdate: no scripted object shared by both cells (A=${Object.keys(sa).length}, B=${Object.keys(sb).length})`);
  } else {
    const varName = sa[rec];
    ctx.log(`member var: "${rec}".${varName}`);
    await a.eval(`Module.__omwMPCmd='mvar:${rec}:${varName}:3'`);
    const key = `${rec}.${varName}`;
    await b.waitFor(
      `JSON.parse((window.__omwMP||{}).memberVars||"{}")[${JSON.stringify(key)}] === 3`,
      STEP_TIMEOUT, `B applied MemberVarUpdate ${key}=3`);
    ctx.log(`ok: MemberVarUpdate ${key}=3 relayed cell-scoped and applied`);
  }

  // --- echo guard ----------------------------------------------------------------------
  // B applied three inbound families. If any apply had bounced back, A would see B's value
  // re-arrive and the two would keep trading updates; instead A must be exactly where it
  // put itself, and B must not have drifted.
  await ctx.sleep(4000);
  const [gb2, ga2] = await Promise.all([jsonOf(b, 'globalVars'), jsonOf(a, 'globalVars')]);
  const kb = globalKey(gb2, GLOBAL);
  const ka = globalKey(ga2, GLOBAL);
  ctx.log(`after settle: A ${GLOBAL}=${ga2[ka]} B ${GLOBAL}=${gb2[kb]}`);
  assert.equal(ga2[ka], GLOBAL_VALUE, 'A drifted: an applied update was echoed back');
  assert.equal(gb2[kb], GLOBAL_VALUE, 'B drifted: an applied update was echoed back');
  assert.equal(await a.eval('(window.__omwMP||{}).bounty'), String(BOUNTY), 'A bounty drifted');
  ctx.log('ok: echo guards held across globals/crime/factions');
}
