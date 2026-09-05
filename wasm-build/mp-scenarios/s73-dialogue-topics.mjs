// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s73: a dialogue topic one player learns becomes askable for the other.
//
// Why this is shared at all: the JOURNAL already is. A guest's quest state routes through the
// host's journal, so without topic sharing a guest can be looking at a quest in their log and
// have no way to ask anyone about it, because the topic that quest turns on was learned by
// someone else. Sharing the journal and not the topics is the inconsistent position.
//
// TES3MP synced these and is remembered for "server freezes caused by infinite topic packet
// spam". That failure is a LOOP rather than volume -- B applies a topic, B's own diff then
// reads it as something B did not have and sends it back -- so this scenario asserts the loop
// is absent as carefully as it asserts the feature works. A test that only proved delivery
// would pass just as happily on the version that melts the server.
//
// RETAIL, and the reason is worth writing down because the first version of this file asserted
// the opposite. "A topic is just a record id" is wrong: it is a RECORD. addTopic looks the id
// up in the ESM store and throws "topic record not found" if it is not there, and the Example
// Suite ships no Morrowind dialogue at all -- so on demo content the player never learns the
// topic and nothing downstream can possibly work. That is what this scenario found on its first
// run, by checking the LOCAL fact before blaming the network.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOT = { retail: true, joinTimeoutMs: 420_000 };



export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (a topic is a RECORD, and the example suite has none)');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('topic-a', '', BOOT),
    ctx.launchClient('topic-b', '', BOOT),
  ]);

  // What B has APPLIED from other players. This is the only outward signal the receiving half
  // of topic sync has: addTopic leaves nothing a script can read back, which is why this
  // feature went unproven for so long and why s73 skipped behind a wrong explanation.
  const appliedOn = async (c) =>
    JSON.parse(await c.eval("window.omw.state.topicsApplied||'[]'"));

  const beforeB = await appliedOn(b);
  ctx.log(`  B has applied ${beforeB.length} remote topics so far`);

  // A REAL topic record from Morrowind.esm (the file holds 1698; these were verified by parsing
  // it directly rather than guessed). The id has to be real because the RECEIVER calls addTopic,
  // which throws on an unknown record -- so a made-up id would test nothing on B's side.
  const TOPIC = 'little advice';

  // 'learntopic:', not 'topic:'. The latter calls addTopic, which is invisible to the collection
  // quests.lua diffs, so nothing would ever be broadcast. This marks it locally learned for the
  // diff and lets the real path run: diff -> TopicsLearned -> server relay -> B applies.
  await a.eval(`window.omw.send('learntopic:${TOPIC}')`);
  ctx.log(`  A learned ${TOPIC}`);

  let got = false;
  const by = Date.now() + 60_000;
  while (Date.now() < by) {
    const applied = await appliedOn(b);
    if (applied.includes(TOPIC)) { got = true; break; }
    await ctx.sleep(1000);
  }
  assert.ok(got, `B never applied ${TOPIC} from A -- the sync did not carry it`);
  ctx.log(`  ok: B applied ${TOPIC}`);

  // THE LOOP GUARD, and the whole reason this is safe to ship. B has just applied a topic it did
  // not have; if B's own diff read that back as a local discovery it would send it to A, A would
  // apply and re-send, and the two would trade it forever. That is the shape of the TES3MP
  // "infinite topic packet spam" failure -- a LOOP, not volume.
  //
  // Asserted on A: A must never receive its own topic back. Checked after a settle long enough
  // for a round trip to have happened if one were going to.
  await ctx.sleep(6000);
  const appliedOnA = await appliedOn(a);
  assert.ok(!appliedOnA.includes(TOPIC),
    `A applied its OWN topic back — the echo guard is not holding: ${JSON.stringify(appliedOnA)}`);

  // ...and B must have applied it exactly once, not once per round trip.
  const afterB = await appliedOn(b);
  const times = afterB.filter((t) => t === TOPIC).length;
  assert.equal(times, 1, `B applied ${TOPIC} ${times} times — it is bouncing`);
  ctx.log('  ok: exactly one crossing, and nothing bounced back');
}
