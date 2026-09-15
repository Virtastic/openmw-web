// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s52 (M5): the PvP gate, with a REAL swing. Under Phase 4C every melee is the peer's
// avatar swinging natively (combat.lua: a real client hit on a puppet is cancel-only), so
// the gate that matters is the one on the PEER: with the server default ([rules] pvp =
// false) A's avatar standing beside B's, drawn and swinging, must not hurt B's avatar. The
// old draft sent the hitp: relay hook, which the client itself refuses when pvp is off --
// it proved the test hook's gate, not the game's (backlog 238). B's peer-reported bars must
// be untouched over ten seconds of swinging, and no relay hit may go out under A's name.
import assert from 'node:assert/strict';

export const managedPeer = true; // the avatar swings on the server's own peer
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const WEAPON = 'iron longsword';
const SWING_MS = 12_000; // "nothing happens" needs a window, not a moment

const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };

export default async function run(ctx) {
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  const idB = String(await b.eval('window.omw.state.playerId'));
  const puppetOfB = `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(idB)}]||{})`;
  await a.waitFor(`${puppetOfB}.x !== undefined`, STEP, 'puppet of B on A');
  await b.waitFor('window.omw.state.pvp === "false"', STEP, 'B sees pvp disabled');
  await b.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', 300_000, "the peer reports B's bars (the peer rules B's body)");
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, 'the cell is peer-held');

  // Kit and stance: the avatar mirrors both (s138). Skill up so a miss is not the reason.
  await a.cmd(`equip:${WEAPON}:16`); // grants and equips (slot 16 = carried right)
  await a.waitFor(`(window.omw.state.equippedIds||"").indexOf(${JSON.stringify(WEAPON)}) >= 0`, 15_000, 'the sword is in hand');
  await a.cmd('setskill:longblade:100');
  await ctx.sleep(3_000); // equipment + skills diff out to the avatar
  await a.cmd('stance:weapon');
  await a.waitFor('window.omw.state.stance === "weapon"', 10_000, 'the sword is drawn');

  // Beside B, facing B. The avatar follows the snap (s110's idiom).
  const p = JSON.parse(await a.eval(`JSON.stringify(${puppetOfB})`));
  await a.cmd(`snapto:${Math.round(p.x + 60)},${Math.round(p.y)},${Math.round(p.z + 8)}`);
  await ctx.sleep(3_000);
  await a.eval("if (window.omw.state) window.omw.state.hitFwd = undefined; 'cleared';");
  const before = parseBars(await b.eval('window.omw.state.selfStats'));
  const hpBefore = Number(await b.eval('window.omw.state.hp||"0"'));
  ctx.log(`pvp off: A swings at B's puppet from 60 units; B at ${before.c}/${before.b} (own bar ${hpBefore})`);

  const until = Date.now() + SWING_MS;
  let swings = 0, lowest = before.c;
  while (Date.now() < until) {
    const q = JSON.parse(await a.eval(`JSON.stringify(${puppetOfB})`));
    await a.cmd(`face:${Math.round(q.x)},${Math.round(q.y)},${Math.round(q.z + 40)}`);
    await a.cmd('attack:1200'); swings++;
    await ctx.sleep(1_500);
    const cur = parseBars(await b.eval('window.omw.state.selfStats')) || before;
    lowest = Math.min(lowest, cur.c);
  }
  await ctx.sleep(3_000); // the peer's last report
  const after = parseBars(await b.eval('window.omw.state.selfStats')) || before;
  const hpAfter = Number(await b.eval('window.omw.state.hp||"0"'));
  const fwd = String(await a.eval('window.omw.state.hitFwd'));
  ctx.log(`${swings} swing(s): B ${before.c}/${before.b} -> ${after.c}/${after.b} (lowest ${lowest}, own bar ${hpBefore} -> ${hpAfter}); A hitFwd=${fwd} selfFlags=${await a.eval('window.omw.state.selfFlags')}`);
  assert.ok(lowest >= before.c, `PvP disabled: B's peer-reported bars dropped to ${lowest} from ${before.c} -- the avatar's swing landed`);
  assert.ok(hpAfter >= hpBefore, `PvP disabled: B's own bar dropped ${hpBefore} -> ${hpAfter}`);
  assert.equal(fwd, 'undefined', `a hit went out under A's name (hitFwd=${fwd}) with pvp off`);
  assert.equal(await b.eval('window.omw.state.lastHitTaken'), undefined, 'no CombatHit should have been delivered to B');
  ctx.log('ok: PvP gate held against a real swing end to end');
}
