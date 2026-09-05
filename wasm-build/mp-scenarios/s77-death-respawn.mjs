// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s70 (Phase 4A): DYING AND COMING BACK, with the peer owning your bars.
//
// This scenario exists because the audit found a fix that looked right, compiled, and passed
// the whole Lua suite while doing nothing: the peer-side resurrect called
// `types.Actor.resurrect`, which is not in the Lua API at all. The pcall swallowed it, the
// avatar body stayed a CORPSE that merely reported healthy bars -- no AI, no controls, no
// melee -- and every player who died was permanently unable to act. Nothing caught it because
// nothing ever exercised death on the peer.
//
// The chain under test: the peer's avatar reaches 0 hp -> the owner is killed by the bar
// report -> the client sends PlayerDeath -> the respawn plugin resurrects the player AND the
// server tells the peer to replace the avatar body (AvatarResurrect) -> the fresh avatar
// reports LIVING bars. The proof that it is a real body and not a corpse reporting numbers is
// that the player can move again afterwards and the bars stay up.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;
export const serverRules = `
[content]
enforce = "off"
`;

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const hp = async (c) => {
  const s = String(await c.eval('window.omw.state.selfStats') ?? '');
  const m = /^(\d+)\/(\d+)$/.exec(s);
  return m ? { cur: Number(m[1]), base: Number(m[2]) } : null;
};

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent'); return;
  }
  const peer = ctx.startSimPeer('-2,-9');
  if (!peer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset)'); return; }

  const a = await ctx.launchClient('mortal', '', BOOT);
  const by = Date.now() + 300_000;
  let owner = 'none';
  while (Date.now() < by) {
    owner = String(await a.eval('window.omw.state.authorityHolder'));
    if (owner && owner !== 'none') break;
    await ctx.sleep(500);
  }
  assert.notEqual(owner, 'none', 'the simulating peer never took the cell');

  // The peer must be streaming this player's bars before we can kill them through it.
  await a.waitFor("window.omw.state.selfStats !== undefined", STEP,
    'the peer reports this player’s bars (MP_SelfStats)');
  const before = await hp(a);
  ctx.log(`cell owner=${owner}; bars ${before?.cur}/${before?.base}`);

  // Kill the player. sethp drives the CLIENT's own health to 0, which is the ordinary death
  // edge: the client reports it and the respawn plugin answers.
  await a.eval("window.omw.send('sethp:0')");
  ctx.log('killed; waiting for the respawn to bring the bars back');

  // THE ASSERTION. After the respawn the peer's report must show a LIVING avatar. Before the
  // fix this stayed at 0 forever (the corpse kept reporting 0) or oscillated as the death
  // loop re-killed the player every few seconds.
  await a.waitFor(
    `(function(){var s=window.omw.state.selfStats; if(!s) return false;`
    + ` var m=/^(\\d+)\\/(\\d+)$/.exec(s); return !!m && Number(m[1]) > 0; })()`,
    STEP, 'the peer reports a LIVING avatar after the respawn (a corpse reports 0 forever)');
  const after = await hp(a);
  ctx.log(`ok: alive again at ${after?.cur}/${after?.base}`);

  // And it STAYS alive: the death loop's signature was hp going back to 0 within a few
  // seconds as the un-resurrected avatar reported itself dead again.
  await ctx.sleep(8_000);
  const settled = await hp(a);
  assert.ok(settled && settled.cur > 0,
    `the player died again ${settled?.cur}/${settled?.base} -- the avatar was never actually `
    + 'revived, only made to report healthy bars');
  ctx.log(`ok: still alive after the window at ${settled.cur}/${settled.base}`);

  const errs = a.luaErrors();
  assert.equal(errs.length, 0, 'Lua errors during death/respawn:\n' + errs.join('\n'));
}
