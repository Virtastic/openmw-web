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
// Runs on demo content: unlike companions or merchants, a topic is a record id and needs no
// retail dialogue to exercise.
import assert from 'node:assert/strict';

const STEP = 20_000;
const TOPIC = 'nerevarine';

// CLEARED BEFORE ASKING. The mirror is write-once from the page's point of view: after the
// first publish it is never null again, so a second call would wait on a condition that is
// already true and hand back the PREVIOUS answer. That would have made the loop below spin on
// a stale list and the whole test meaningless.
const topicsOf = async (c) => {
  await c.eval("if (window.__omwMP) window.__omwMP.topics = null; 'cleared';");
  await c.eval("Module.__omwMPCmd='topics'");
  await c.waitFor('((window.__omwMP||{}).topics||null) !== null', STEP, 'the client listed its topics');
  return String(await c.eval("(window.__omwMP||{}).topics||''")).split(',').filter(Boolean);
};

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('topic-a'),
    ctx.launchClient('topic-b'),
  ]);

  // Baseline first. The demo content may hand out topics of its own, and asserting on an
  // absolute list would break the moment it changed; what matters is the DELTA.
  const beforeB = await topicsOf(b);
  assert.ok(!beforeB.includes(TOPIC), `B already knew ${TOPIC}; the test proves nothing`);
  ctx.log(`  B starts with ${beforeB.length} topics`);

  // A learns it, the way a conversation would.
  await a.eval(`Module.__omwMPCmd='topic:${TOPIC}'`);

  // The diff runs on the same slow beat as globals, factions and bounty, so this is not
  // instant -- and it should not be. Waiting on the fact rather than sleeping a guessed
  // interval means a slower beat makes this take longer rather than fail.
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
