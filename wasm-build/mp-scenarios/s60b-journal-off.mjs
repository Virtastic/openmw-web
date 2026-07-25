// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s60b (M6): the operator's sharing switch. With `[sharing] journal = false` the server
// STORES a JournalEntry against the sender's own player doc and relays nothing — B's
// journal must be untouched. Sharing is a per-server config table, so this cannot live in
// s60: the harness gives each scenario file exactly one server.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP_TIMEOUT = 20_000;
const SETTLE_MS = 5000; // generous: we are proving that NOTHING arrives
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

const QUEST = 'a1_2_antabolisinformant';
const STAGE = 10;

// Merged over config.default.toml by the harness (see startGameServer).
export const serverRules = '[sharing]\njournal = false';

const hasStage = (id, stage) =>
  `Object.entries(JSON.parse((window.__omwMP||{}).journalEngine||"{}")).some(([k,v])=>k.toLowerCase()===${JSON.stringify(id)}&&v===${stage})`;

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for journal quests)');
    return;
  }
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a', '', BOOT),
    ctx.launchClient('bot-b', '', BOOT),
  ]);
  await a.waitFor('(window.__omwMP||{}).journalSynced === "true"', STEP_TIMEOUT, 'A consumed JournalSync');
  await b.waitFor('(window.__omwMP||{}).journalSynced === "true"', STEP_TIMEOUT, 'B consumed JournalSync');

  await a.eval(`Module.__omwMPCmd='quest:${QUEST}:${STAGE}'`);
  await a.waitFor(hasStage(QUEST, STAGE), STEP_TIMEOUT, `A's engine journal reached stage ${STAGE}`);
  // The client still SENDS: sharing is a server-side policy, not a client mute.
  assert.equal(await a.eval('(window.__omwMP||{}).journalSent'), '1',
    'A must still originate the JournalEntry (sharing is arbitrated server-side)');

  await ctx.sleep(SETTLE_MS);
  const jb = JSON.parse(await b.eval('(window.__omwMP||{}).journalEngine||"{}"'));
  const got = Object.entries(jb).find(([k]) => k.toLowerCase() === QUEST);
  ctx.log(`sharing off: B's entry for ${QUEST} = ${got ? got[1] : '(absent)'}`);
  assert.equal(got, undefined, 'journal sharing disabled: B must not receive the entry');
  ctx.log('ok: [sharing] journal = false blocked the relay');
}
