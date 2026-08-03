// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s71 (M7): custom records resolve across clients (PROTOCOL.md §M7 RecordCreate /
// RecordCreateAck / RecordsSync). This is the fix for a REAL M3 defect: a player-made
// item's record id is minted per-client ("Generated:0x<n>"), so a peer resolving the raw
// id landed on an unrelated local record — once on a puppet's NPC record.
//
// The trap this scenario is built to avoid: a placeholder stand-in still produces an
// object with a netId, so "B sees an object" proves nothing. Every assertion here is on
// the CONTENT of the record the peer resolved — name, kind, cost, effect, enchantment
// charge — which only the shared record data can supply.
import assert from 'node:assert/strict';

const STEP_TIMEOUT = 20_000;
const ITEM_NAME = 'MP Shared Cuirass';
const ENCH_NAME = 'MP Enchanted Helm';
const SPELL_NAME = 'MP Shared Spell';

const netRecords = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).netRecords||"{}"'));
const recordInfo = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).netRecordInfo||"{}"'));
const objNames = async (c) => JSON.parse(await c.eval('(window.__omwMP||{}).netObjectNames||"{}"'));
const entryByName = (info, name) => Object.entries(info).find(([, v]) => v.name === name);
const hasName = (name) =>
  `Object.values(JSON.parse((window.__omwMP||{}).netRecordInfo||"{}")).some((r)=>r.name===${JSON.stringify(name)})`;

export default async function run(ctx) {
  const a = await ctx.launchClient('bot-a');
  const b = await ctx.launchClient('bot-b');

  // Offset B's dynamic-id counter with a record that is NEVER shared. Both clients rebuild
  // every shared record, so their `Generated:0x<n>` counters otherwise advance in lockstep
  // and the same number means the same record by accident — measured: both minted
  // `Generated:0x2` for it. A broken registry (raw ids on the wire) would then resolve
  // "correctly" by pure coincidence and this scenario would pass on a real bug. With the
  // local-only decoy the numbering diverges, so only the netId mapping can line the records
  // up, and every content assertion below is real evidence.
  await b.eval(`Module.__omwMPCmd='mklocal:B Local Decoy'`);
  await ctx.sleep(1500);
  // (an empty Lua table encodes as `[]`, so count the keys rather than string-comparing)
  assert.equal(Object.keys(await netRecords(b)).length, 0,
    'the local-only decoy must NOT have been registered with the server');

  // --- a plain custom item -------------------------------------------------------------
  await a.eval(`Module.__omwMPCmd='mkrec:${ITEM_NAME}'`);
  await a.waitFor(hasName(ITEM_NAME), STEP_TIMEOUT, 'A got a RecordCreateAck (server record id)');
  const itemEntryA = entryByName(await recordInfo(a), ITEM_NAME);
  const itemNetId = itemEntryA[0];
  const itemLocalA = (await netRecords(a))[itemNetId];
  ctx.log(`A: local record ${itemLocalA} -> server id ${itemNetId}`);
  assert.ok(itemNetId.length > 0 && itemNetId !== itemLocalA,
    'the server id must be its own string, not the local dynamic id');

  // The single-record RecordsSync push (§M7: peers must resolve the id BEFORE anything
  // referencing it arrives, not only at their next join).
  await b.waitFor(`JSON.parse((window.__omwMP||{}).netRecords||"{}")[${JSON.stringify(itemNetId)}] !== undefined`,
    STEP_TIMEOUT, 'B received the record via RecordsSync');
  const itemLocalB = (await netRecords(b))[itemNetId];
  ctx.log(`B built local record ${itemLocalB} for ${itemNetId} (A's local id was ${itemLocalA})`);
  assert.notEqual(itemLocalB, itemLocalA,
    `both clients minted "${itemLocalB}" for this record — the id spaces did not diverge, so this run would not prove resolution`);
  const itemB = (await recordInfo(b))[itemNetId];
  assert.equal(itemB && itemB.name, ITEM_NAME, `B resolved the wrong record (${JSON.stringify(itemB)})`);

  // A drops it: the wire carries the SERVER id, so B rebuilds the real item.
  await a.eval(`Module.__omwMPCmd='drop:${itemLocalA}'`);
  await a.waitFor('Object.keys(JSON.parse((window.__omwMP||{}).netObjects||"{}")).length === 1',
    STEP_TIMEOUT, 'A tracks its drop');
  await b.waitFor('Object.keys(JSON.parse((window.__omwMP||{}).netObjects||"{}")).length === 1',
    STEP_TIMEOUT, 'B placed the dropped object');
  const [na, nb] = await Promise.all([objNames(a), objNames(b)]);
  ctx.log(`dropped object name on A="${Object.values(na)[0]}" on B="${Object.values(nb)[0]}"`);
  assert.equal(Object.values(na)[0], ITEM_NAME, 'A lost its own record name');
  assert.equal(Object.values(nb)[0], ITEM_NAME,
    `B resolved the wrong record ("${Object.values(nb)[0]}") — the M3 placeholder/collision bug`);

  // --- a custom SPELL ------------------------------------------------------------------
  // Spells live in core.magic, not openmw.types, which is why a types-only search makes
  // them look absent; world.createRecord takes ESM::Spell directly.
  await a.eval(`Module.__omwMPCmd='mkspell:${SPELL_NAME}'`);
  await a.waitFor(hasName(SPELL_NAME), STEP_TIMEOUT, 'A registered the custom spell');
  const spellEntryA = entryByName(await recordInfo(a), SPELL_NAME);
  const spellNetId = spellEntryA[0];
  await b.waitFor(`(JSON.parse((window.__omwMP||{}).netRecordInfo||"{}")[${JSON.stringify(spellNetId)}]||{}).name === ${JSON.stringify(SPELL_NAME)}`,
    STEP_TIMEOUT, 'B rebuilt the custom spell');
  const spellB = (await recordInfo(b))[spellNetId];
  ctx.log(`spell on A=${JSON.stringify(spellEntryA[1])} on B=${JSON.stringify(spellB)}`);
  assert.equal(spellB.kind, 'spell', 'B built the wrong record kind for a spell');
  assert.equal(spellB.cost, spellEntryA[1].cost, 'spell cost did not survive the round trip');
  assert.equal(spellB.effect, spellEntryA[1].effect, 'spell effect did not survive the round trip');
  assert.equal(spellB.magnitude, spellEntryA[1].magnitude, 'spell magnitude did not survive');

  // --- an ENCHANTED item traded A -> B ---------------------------------------------------
  // Two chained custom records: the item references an enchantment whose id is ALSO
  // per-client. Both must travel as server ids or B resolves someone else's record.
  await a.eval(`Module.__omwMPCmd='mkench:${ENCH_NAME}'`);
  await a.waitFor(hasName(ENCH_NAME), STEP_TIMEOUT, 'A registered the enchanted item');
  const enchEntryA = entryByName(await recordInfo(a), ENCH_NAME);
  const enchNetId = enchEntryA[0];
  assert.ok(enchEntryA[1].enchant, 'the enchanted item must carry an enchantment id on A');

  await b.waitFor(`(JSON.parse((window.__omwMP||{}).netRecordInfo||"{}")[${JSON.stringify(enchNetId)}]||{}).name === ${JSON.stringify(ENCH_NAME)}`,
    STEP_TIMEOUT, 'B rebuilt the enchanted item');
  const enchB = (await recordInfo(b))[enchNetId];
  ctx.log(`enchanted item on A=${JSON.stringify(enchEntryA[1])} on B=${JSON.stringify(enchB)}`);
  assert.ok(enchB.enchant, 'B rebuilt the item WITHOUT its enchantment');
  assert.notEqual(enchB.enchant, enchEntryA[1].enchant,
    "the enchantment must resolve to B's OWN local record through the registry");
  assert.equal(enchB.enchantEffect, enchEntryA[1].enchantEffect,
    'the enchantment effect did not survive the round trip');
  assert.equal(enchB.enchantCharge, enchEntryA[1].enchantCharge,
    'the enchantment charge did not survive the round trip');

  // Trade it through the world: A drops the helm, B must place the REAL one.
  const enchLocalA = (await netRecords(a))[enchNetId];
  await a.eval(`Module.__omwMPCmd='drop:${enchLocalA}'`);
  await b.waitFor(`Object.values(JSON.parse((window.__omwMP||{}).netObjectNames||"{}")).indexOf(${JSON.stringify(ENCH_NAME)}) >= 0`,
    STEP_TIMEOUT, 'B placed the dropped enchanted item as the real record');
  ctx.log('ok: enchanted item traded A -> B with its enchantment intact');

  // --- a late joiner ---------------------------------------------------------------------
  const c = await ctx.launchClient('bot-c');
  await c.waitFor('Object.keys(JSON.parse((window.__omwMP||{}).netRecords||"{}")).length >= 4',
    STEP_TIMEOUT, 'C received the full RecordsSync at join (item, spell, enchantment, helm)');
  await c.waitFor(`Object.values(JSON.parse((window.__omwMP||{}).netObjectNames||"{}")).indexOf(${JSON.stringify(ITEM_NAME)}) >= 0`,
    STEP_TIMEOUT, 'C rebuilt the dropped custom item from the replayed records');
  const infoC = await recordInfo(c);
  assert.ok(entryByName(infoC, SPELL_NAME), 'C did not receive the custom spell');
  assert.ok(entryByName(infoC, ENCH_NAME), 'C did not receive the enchanted item');
  ctx.log('ok: custom records resolve for a live peer AND a late joiner');
}
