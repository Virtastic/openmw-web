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

const NL = new RegExp(String.fromCharCode(92) + 'r?' + String.fromCharCode(92) + 'n');
const STEP = 20_000;
// CANDIDATES, not one guess. addTopic needs a real dialogue RECORD, and which ids exist
// depends entirely on the content loaded -- 'nerevarine' looked obvious and is not one. The
// scenario tries these in order and uses the first that actually takes, so it does not hinge
// on any single id being present in whatever Morrowind build the harness has staged.
const TOPIC_CANDIDATES = ['background', 'little advice', 'latest rumors', 'my trade', 'services'];

// CLEARED BEFORE ASKING. The mirror is write-once from the page's point of view: after the
// first publish it is never null again, so a second call would wait on a condition that is
// already true and hand back the PREVIOUS answer. That would have made the loop below spin on
// a stale list and the whole test meaningless.
const topicsOf = async (c) => {
  await c.eval("if (window.__omwMP) window.__omwMP.topics = null; 'cleared';");
  await c.eval("Module.__omwMPCmd='topics'");
  // typeof, not truthiness. A player who knows NO topics publishes an EMPTY STRING, and `'' ||
  // null` is null -- so "answered with nothing" and "has not answered yet" were the same value
  // and this waited out its whole timeout on a fresh character. The mirror starts undefined and
  // is cleared to null above, neither of which is a string, so this separates them cleanly.
  await c.waitFor("typeof (window.__omwMP||{}).topics === 'string'", STEP,
    'the client listed its topics');
  return String(await c.eval("(window.__omwMP||{}).topics||''")).split(',').filter(Boolean);
};

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (a dialogue topic is a RECORD, and the '
      + 'example suite has none)');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('topic-a', '', BOOT),
    ctx.launchClient('topic-b', '', BOOT),
  ]);

  // Baseline first. The demo content may hand out topics of its own, and asserting on an
  // absolute list would break the moment it changed; what matters is the DELTA.
  const beforeB = await topicsOf(b);
  ctx.log(`  B starts with ${beforeB.length} topics`);

  // A learns one, the way a conversation would -- whichever of the candidates this content has.
  let TOPIC = null;
  for (const cand of TOPIC_CANDIDATES) {
    if (beforeB.includes(cand)) continue; // must be new to B or it proves nothing
    await a.eval(`Module.__omwMPCmd='topic:${cand}'`);
    await ctx.sleep(1500);
    if ((await topicsOf(a)).includes(cand)) { TOPIC = cand; break; }
  }
  if (!TOPIC) {
    // SAY WHY, using the engine's own words. player.lua prints '[mp] addTopic <id> failed: <err>'
    // for every rejection, and that line has never once been read: a SKIP does not dump client
    // logs, so the scenario has been reporting "not a topic in this content" as a conclusion
    // when it was only ever a guess about the cause.
    //
    // It matters here because the guess is now known to be WRONG. All five candidates ARE real
    // DIAL topic records in Morrowind.esm -- verified by parsing the retail file directly, which
    // holds 1698 of them. So the reason addTopic refuses is something else, and the engine has
    // been saying so the whole time into a log nobody printed.
    const why = [...new Set((a.logTail?.(4000) ?? '').split(NL)
      .filter((l) => /addTopic|topic record|journal/i.test(l))
      .map((l) => l.trim()))];
    ctx.log(`  engine's own words on the refusals (${why.length} distinct):`);
    for (const l of why.slice(0, 8)) ctx.log(`    ${l.slice(0, 200)}`);
    if (!why.length) ctx.log('    none — addTopic did not even report a failure, so the command may not be reaching the client');
    // THE REASON, established by s75 rather than guessed at here. addTopic is silently invisible
    // to `journal(player).topics` -- the collection this scenario polls AND the one quests.lua
    // diffs -- so driving a topic in through the harness command and then looking for it here
    // can never work. It is not the content: all five candidates are real DIAL records in
    // Morrowind.esm, and the engine raises no complaint.
    //
    // Left as a SKIP rather than deleted, because the FEATURE is unproven rather than broken: a
    // topic learned the way a player learns one (by talking, which records entries) would appear
    // here normally. What is missing is a way to drive dialogue from a headless client. Whoever
    // adds that can delete this branch and the scenario works as written.
    ctx.log('SKIP: addTopic is invisible to journal().topics, so this cannot observe its own '
      + 'input -- see s75-topic-probe, which characterises exactly that. NOT a content problem.');
    return;
  }
  ctx.log(`  A learned ${TOPIC}`);

  // Re-asked each round rather than smuggling a side effect into a waitFor expression: the
  // mirror only refreshes when the client is told to publish it, so the poll has to drive that.
  let learned = false;
  const by = Date.now() + 60_000;
  while (Date.now() < by) {
    if ((await topicsOf(b)).includes(TOPIC)) { learned = true; break; }
    await ctx.sleep(1000);
  }
  assert.ok(learned, `B never learned ${TOPIC} from A`);
  ctx.log(`  ok: B can now ask about ${TOPIC}`);

  // THE LOOP GUARD, which is the whole reason this is safe to ship. B has just applied a topic
  // it did not have; if B's own diff reads that as a local discovery it sends it straight back
  // to A, and the two of them trade it forever. B's topic count must move by exactly the one
  // topic, and A must not end up hearing about its own.
  const afterB = await topicsOf(b);
  const gained = afterB.filter((t) => !beforeB.includes(t));
  assert.deepEqual(gained, [TOPIC],
    `B should have gained exactly one topic, gained: ${JSON.stringify(gained)}`);
  ctx.log('  ok: exactly one topic crossed, and nothing bounced back');
}
