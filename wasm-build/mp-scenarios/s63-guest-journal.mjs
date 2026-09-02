// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s63: instance-owned journals, end to end through two real engines.
//
// A guest in another player's world sees THAT player's journal — with real entry text, not
// just quest indices — and their own campaign comes back untouched when they leave. The
// mechanism is a whole-journal stash in the engine (MWDialogue::Journal::stash/unstash),
// driven by the `borrowed` flag on JournalSync so a missed transition self-corrects.
//
// worldOwner is set with worldMode=public so the guest is admitted without party plumbing
// (mayJoinWorld short-circuits on public) while ownerCharId is still set — which is what
// makes the journal borrowed. Synthetic on purpose: it isolates the journal mechanism.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Real Morrowind journal quests: the demo content has no DIAL records of type Journal, so
// this needs retail data exactly as s60 does.
const OWNER_QUEST = 'a1_2_antabolisinformant';
const OWNER_STAGE = 10;
const GUEST_QUEST = 'a1_1_findspymaster';
const GUEST_STAGE = 5;
const STEP = 20_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

export const serverEnv = (runId) => ({
  OMW_WORLD_OWNER: `bot-owner-${runId}`,
  OMW_WORLD_MODE: 'public',
});

const stageOf = (q) =>
  `(JSON.parse((window.__omwMP||{}).journal||"{}")[${JSON.stringify(q)}] || 0)`;

export default async function run(ctx) {
  // ponytail: SKIPPED until rewritten on the friend path. This scenario admitted its guest
  // through worldMode=public, and the public mode is deleted (Solo/Party model): a stranger
  // can no longer stand in an owned world at all. The borrowed-journal mechanism itself is
  // alive (quests.ts journalTarget) and covered server-side by questcredit.test.ts; the
  // browser-level rewrite needs the real flow -- owner befriends guest (social: commands),
  // flips to party (worldmode:party), guest joinfriend: -- all of which the cmd channel
  // already offers.
  ctx.log('SKIP: admission path (public mode) deleted by the Solo/Party model; '
    + 'rewrite on the friend path. Server-side coverage: questcredit.test.ts');
  return;

  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for journal quests)');
    return;
  }
  // The OWNER first: this world is their campaign.
  const owner = await ctx.launchClient('bot-owner', '', BOOT);
  await owner.eval(`Module.__omwMPCmd='quest:${OWNER_QUEST}:${OWNER_STAGE}'`);
  await owner.waitFor(`${stageOf(OWNER_QUEST)} === ${OWNER_STAGE}`, STEP,
    'the owner advanced their own campaign');
  ctx.log(`ok: owner at ${OWNER_QUEST}=${OWNER_STAGE}`);

  // A GUEST joins. Their own journal must be set aside for the visit.
  const guest = await ctx.launchClient('bot-guest', '', BOOT);
  await guest.waitFor(`${stageOf(OWNER_QUEST)} === ${OWNER_STAGE}`, STEP,
    "the guest adopted the owner's campaign");
  ctx.log('ok: guest sees the owner\'s quest state');

  // The guest's own journal must be SET ASIDE, and the owner's must not be.
  await guest.waitFor(`(window.__omwMP||{}).journalStashed === "true"`, STEP,
    'the guest stashed their own campaign for the visit');
  assert.equal(await owner.eval(`(window.__omwMP||{}).journalStashed`), 'false',
    'the owner must never stash — this is their own world');
  ctx.log('ok: guest stashed, owner did not');

  // A quest the guest advances here belongs to the OWNER's campaign, not theirs.
  await guest.eval(`Module.__omwMPCmd='quest:${GUEST_QUEST}:${GUEST_STAGE}'`);
  await owner.waitFor(`${stageOf(GUEST_QUEST)} === ${GUEST_STAGE}`, STEP,
    "the guest's deed advanced the owner's campaign");
  ctx.log('ok: guest deeds land in the owner\'s log');

  const luaErrs = [...guest.luaErrors(), ...owner.luaErrors()];
  assert.equal(luaErrs.length, 0,
    'Lua errors — a throwing handler disables its whole subsystem:\n' + luaErrs.join('\n'));
  ctx.log('ok: no Lua errors from the stash/unstash path');
}
