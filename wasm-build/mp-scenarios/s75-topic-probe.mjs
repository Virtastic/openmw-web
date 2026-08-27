// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s75: does addTopic produce anything the topic SYNC can see?
//
// This exists because s73 has been skipping since it was written, reporting "none of these is a
// topic in this content" -- a guess that is now known to be wrong. All five of its candidates
// are real DIAL topic records in Morrowind.esm (verified by parsing the retail file: it holds
// 1698 of them), and the engine never logged an addTopic failure, so addTopic was not refusing.
//
// The suspicion is therefore the READER, and it matters far beyond the test. `quests.lua`
// topicSet() -- the source of truth the whole topic-sync feature diffs against -- enumerates
// `types.Player.journal(player).topics`. The Lua API describes that as journal TEXT data
// "accumulated by the player": topics the player has heard lines for. addTopic marks a topic
// KNOWN, which is not the same thing and may produce no entry at all.
//
// If that is right then s73 could never observe its own input, and the feature has never been
// demonstrated to work by anything. One client and two reads settle it, with no server and no
// second player involved -- deliberately, so nothing about the network can be blamed.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
// Real DIAL topic records, confirmed present in Morrowind.esm by parsing it directly.
const KNOWN_REAL = ['background', 'little advice', 'my trade', 'Balmora', 'Vivec'];

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (a topic is a RECORD; the example suite has none)');
    return;
  }
  const c = await ctx.launchClient('topicprobe', '', BOOT);

  const read = async () => {
    await c.eval("if (window.__omwMP) window.__omwMP.topics = null; 'cleared';");
    await c.eval("Module.__omwMPCmd='topics'");
    await c.waitFor("typeof (window.__omwMP||{}).topics === 'string'", 20_000, 'client listed its topics');
    return String(await c.eval("(window.__omwMP||{}).topics||''")).split(',').filter(Boolean);
  };

  const before = await read();
  ctx.log(`  before: ${before.length} topics visible to the sync`);

  for (const t of KNOWN_REAL) {
    await c.eval(`Module.__omwMPCmd='topic:${t}'`);
    await ctx.sleep(400);
  }
  await ctx.sleep(2000);

  const after = await read();
  ctx.log(`  after addTopic x${KNOWN_REAL.length}: ${after.length} topics visible`);
  const gained = after.filter((t) => !before.includes(t));
  ctx.log(`  gained: ${JSON.stringify(gained)}`);

  // The engine's own words, if it objected to any of them.
  const NL = new RegExp(String.fromCharCode(92) + 'r?' + String.fromCharCode(92) + 'n');
  const errs = [...new Set((c.logTail?.(4000) ?? '').split(NL)
    .filter((l) => /addTopic/i.test(l)).map((l) => l.trim()))];
  ctx.log(`  addTopic complaints (${errs.length}):`);
  for (const l of errs.slice(0, 6)) ctx.log(`    ${l.slice(0, 200)}`);

  // CHARACTERISATION, not a bug report. The measurement came back unambiguous: five real topic
  // records added, zero engine complaints, and nothing at all visible to topicSet(). So this
  // asserts the behaviour AS IT IS, and will start failing the day OpenMW changes it -- which is
  // the only way anyone will find out.
  //
  // What this does and does NOT prove, because the difference decides whether the feature works:
  //
  //   * PROVES: a topic added programmatically never enters `journal(player).topics`. That is
  //     the collection quests.lua diffs, so a programmatic topic is never BROADCAST -- and s73,
  //     which learns via this exact command and then polls this exact collection, could never
  //     observe its own input. Its long-standing "not a topic in this content" was a wrong
  //     guess about a real symptom.
  //   * DOES NOT PROVE the feature is broken. In real play a topic is learned by TALKING, which
  //     records dialogue entries against it, and entries are precisely what this collection
  //     holds. The organic path is therefore untouched by this result.
  //   * ALSO EXPLAINS why the echo guard has never been stressed: a topic applied on the
  //     receiving side (also via addTopic) is likewise invisible to that side's own diff, so it
  //     cannot be re-broadcast even if the baseline write were removed.
  //
  // The honest status of topic sharing is UNPROVEN rather than working or broken. Proving it
  // needs a client that learns a topic through dialogue, which is not something a headless
  // client can currently drive.
  assert.equal(gained.length, 0,
    'addTopic became visible to topicSet() -- the engine behaviour this scenario characterises '
    + 'has CHANGED. That is good news: s73 can now be written to learn topics this way. Update '
    + 'both, and delete this assertion.');
  assert.equal(errs.length, 0, 'addTopic started reporting failures where it previously accepted silently');
  ctx.log('  characterised: addTopic is silently invisible to the sync (unchanged)');
}
