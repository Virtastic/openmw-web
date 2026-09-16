// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s159: DAMAGED STRENGTH IS STILL DAMAGED AFTER A RELOG. A Damage Attribute effect (a
// witch's curse, a Greater Bonewalker's touch) leaves `.damage` on the attribute long after
// the spell ends, and only Restore Attribute or a shrine clears it -- that is the whole point
// of the effect. The character declaration carried `.base` alone, so a relog (and the avatar
// on the peer) came back at full strength: the curse was a reload away from cured. The map
// now carries "<attribute>_damage" beside the base.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const STEP = 30_000;
// WHICH HALF LOST IT (#105: 0 after the relog, no client console in an assertion failure). The
// server half is unit-proven (a PlayerAttributes map with strength_damage comes back in the
// Welcome record); the doc says whether the first session ever declared the damage, and the
// relogged client's console says what the restore did with it.
function docAttributes(ctx) {
  try {
    const db = new DatabaseSync(join(ctx.serverDataDir, 'players.db'), { readOnly: true });
    const rows = db.prepare('SELECT key, doc FROM players').all();
    db.close();
    return rows.map((r) => `${r.key.slice(0, 6)}: ${JSON.stringify(JSON.parse(r.doc).stats?.attributes ?? null)}`).join(' ; ');
  } catch (e) { return 'db: ' + e.message; }
}
async function attr(c, id) {
  await c.eval("if (window.omw.state) window.omw.state.attrOf = null; 'cleared';");
  await c.cmd(`attrof:${id}`);
  await c.waitFor("typeof window.omw.state.attrOf === 'string'", 10_000, `${id} answered`);
  const [base, damage, modifier] = String(await c.eval('window.omw.state.attrOf')).split('/').map(Number);
  return { base, damage, modifier };
}

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-a');
  await a.waitFor('String(window.omw.state.baselineReady||"") === "1"', STEP, 'settled');
  const before = await attr(a, 'strength');
  ctx.log(`strength before: base ${before.base}, damage ${before.damage}`);
  assert.equal(before.damage, 0, 'a fresh character carries no damage');

  await a.cmd('damageattr:strength:15'); // what the effect leaves behind
  const hurt = await attr(a, 'strength');
  assert.equal(hurt.damage, 15, 'the damage took locally');
  await ctx.sleep(6_000); // the progression diff (2 s cadence) reaches the server
  a.close();

  await ctx.sleep(2_000);
  const a2 = await ctx.launchClient('bot-a');
  await a2.waitFor('window.omw.state.restored === "1"', 120_000, 'rejoin restore applied');
  await a2.waitFor('String(window.omw.state.baselineReady||"") === "1"', STEP, 'settled again');
  const after = await attr(a2, 'strength');
  ctx.log(`strength after the relog: base ${after.base}, damage ${after.damage}`);
  if (after.damage !== 15) {
    ctx.log(`docs: ${docAttributes(ctx)}`);
    ctx.log(`relogged client, last lines:
${a2.logTail(40)}`);
  }
  assert.equal(after.base, before.base, 'the base must come back unchanged');
  assert.equal(after.damage, 15, `the attribute damage did not survive the relog (${after.damage}): the declaration carried .base alone`);
  ctx.log('PASS: damaged strength is still damaged after a relog');
}
