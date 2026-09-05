// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s60 (M6): the shared journal (PROTOCOL.md §M6 JournalEntry/JournalSync).
//   1. Both clients consume JournalSync at join (nothing may broadcast before that).
//   2. A advances a quest stage through the REAL engine path (setJournalIndex ->
//      onQuestUpdate -> JournalEntry) -> B's ENGINE journal (types.Player.quests) matches.
//   3. The ECHO GUARD holds: B applied an inbound entry and must not have originated a
//      single JournalEntry of its own (journalSent stays 0). Asserting only "B's journal
//      matches" would pass just as well with a guard that ping-pongs forever.
//   4. A regression is refused by the server's monotonic-max arbitration: A drops the
//      stage back and B's engine journal keeps the higher index.
//
// RETAIL DATA REQUIRED: the Example Suite ships 28 DIAL records and NOT ONE of type
// Journal, so `types.Player.quests[id]` cannot resolve anything on the demo content.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP_TIMEOUT = 20_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

const QUEST = 'a1_2_antabolisinformant'; // Morrowind.esm, DIAL type Journal
const STAGE = 10;

const engineJournal = async (c) => JSON.parse(await c.eval('window.omw.state.journalEngine||"{}"'));
const stageOf = (j, id) => {
  for (const [k, v] of Object.entries(j)) if (k.toLowerCase() === id) return v;
  return undefined;
};

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for journal quests)');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a', '', BOOT),
    ctx.launchClient('bot-b', '', BOOT),
  ]);

  // JournalSync must land before anything is allowed to broadcast (§M6 seeding rule).
  await a.waitFor('window.omw.state.journalSynced === "true"', STEP_TIMEOUT, 'A consumed JournalSync');
  await b.waitFor('window.omw.state.journalSynced === "true"', STEP_TIMEOUT, 'B consumed JournalSync');
  assert.equal(await b.eval('window.omw.state.journalSent'), '0', 'B broadcast before/at sync');
  ctx.log('ok: both clients seeded from JournalSync, no pre-sync broadcasts');

  // A advances the quest through the engine's own journal path.
  await a.eval(`window.omw.send('quest:${QUEST}:${STAGE}')`);
  await a.waitFor(
    `Object.entries(JSON.parse(window.omw.state.journalEngine||"{}")).some(([k,v])=>k.toLowerCase()===${JSON.stringify(QUEST)}&&v===${STAGE})`,
    STEP_TIMEOUT, `A's engine journal reached stage ${STAGE}`);
  assert.equal(await a.eval('window.omw.state.journalSent'), '1',
    'A must have originated exactly one JournalEntry');

  await b.waitFor(
    `Object.entries(JSON.parse(window.omw.state.journalEngine||"{}")).some(([k,v])=>k.toLowerCase()===${JSON.stringify(QUEST)}&&v===${STAGE})`,
    STEP_TIMEOUT, `B's engine journal reached stage ${STAGE}`);
  ctx.log(`ok: ${QUEST} = ${STAGE} on both clients (engine journal, not just the cache)`);

  // Echo guard: B applied someone else's entry and originated nothing.
  const sentB = await b.eval('window.omw.state.journalSent');
  ctx.log(`B journalSent = ${sentB} (must stay 0)`);
  assert.equal(sentB, '0', 'echo guard broken: applying an inbound entry re-broadcast it');

  // Monotonic-max: a regression from A must not rewind B.
  await a.eval(`window.omw.send('quest:${QUEST}:1')`);
  await a.waitFor(
    `Object.entries(JSON.parse(window.omw.state.journalEngine||"{}")).some(([k,v])=>k.toLowerCase()===${JSON.stringify(QUEST)}&&v===1)`,
    STEP_TIMEOUT, 'A regressed its own journal locally');
  await ctx.sleep(4000);
  const stageB = stageOf(await engineJournal(b), QUEST);
  ctx.log(`after A regressed to 1, B is at ${stageB}`);
  assert.equal(stageB, STAGE, 'server must refuse to relay a journal regression');
  assert.equal(await b.eval('window.omw.state.journalSent'), '0', 'B still originated nothing');
  ctx.log('ok: monotonic-max arbitration held');
}
