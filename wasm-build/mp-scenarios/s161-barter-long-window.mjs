// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s161: A TRADE IS SHARED FOR AS LONG AS THE WINDOW IS OPEN, AND THE CONVERSATION IS ONE.
//   160: the merchant's live container watch shared the chest's 15 s expiry, so a sale made
//        after that went unreported (the item stayed in the seller's pack for everyone else,
//        the purse delta never travelled). A opens a barter window, waits 16 s, sells; B then
//        opens the same merchant and sees the item in the stock and the purse moved (a buy:
//        nobody outdoors at Seyda Neen has a purse a sale could lower).
//   162: the dialogue lock was released on the Dialogue -> Barter edge, so a second player
//        could open the merchant mid-trade. While A is in the trade, B's dlg: is refused.
// Trades go through the barter:sell: hook (player.lua -> global.lua mpTestBarter): one item
// into the merchant's inventory, the purse down by its value, exactly what the trade window
// does on a client that can click it.
//
// RETAIL DATA REQUIRED: the clean Example Suite ships no NPCs to trade with.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const ITEM = 'iron_cuirass';
const LONGER_THAN_A_CHEST_WATCH = 16_000; // CONTAINER_WATCH_SECONDS is 15

const goldOf = async (c) => {
  const raw = await c.eval('window.omw.state.barterGold||""');
  return raw === '' || raw === 'no-npc' ? null : Number(raw);
};
const lockOf = async (c) => {
  const raw = await c.eval('window.omw.state.dialogueLock');
  return raw ? JSON.parse(raw) : null;
};
const npcsOf = async (c) => JSON.parse(await c.eval('window.omw.state.cellNpcs||"[]"'));
// The merchant's refKey is per client (a content NPC is 'o:<local id>'), so look for the
// stock entry that carries the item rather than for a key.
const stockWith = (item) =>
  `Object.values(JSON.parse(window.omw.state.containerItems||"{}")).some(function(s){ return (s[${JSON.stringify(item)}]||0) > 0; })`;

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for a merchant)');
    return;
  }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);

  await a.waitFor('JSON.parse(window.omw.state.cellNpcs||"[]").length > 0', STEP, 'A sees cell NPCs');
  await b.waitFor('JSON.parse(window.omw.state.cellNpcs||"[]").length > 0', STEP, 'B sees cell NPCs');
  const [na, nb] = await Promise.all([npcsOf(a), npcsOf(b)]);
  const shared = na.filter((r) => nb.includes(r));
  assert.ok(shared.length > 0, 'no NPC record is present in both clients\' cells');
  const npc = shared[0];
  ctx.log(`trading with "${npc}"`);

  await a.cmd(`give:${ITEM}`);
  await ctx.sleep(500);

  // A talks, then opens the trade window from the conversation.
  await a.cmd(`dlg:${npc}`);
  await a.waitFor('JSON.parse(window.omw.state.dialogueLock||"{}").granted === true', STEP, 'A holds the dialogue lock');
  await a.cmd(`barter:open:${npc}`);
  await a.waitFor('(window.omw.state.barterGold||"") !== ""', STEP, 'A opened a barter window');
  const goldBefore = await goldOf(a);
  assert.notEqual(goldBefore, null, `barter:open found no living "${npc}" nearby`);
  ctx.log(`A opened the trade: purse ${goldBefore}`);

  // 162: the trade window is the same conversation. B is still refused.
  await b.cmd(`dlg:${npc}`);
  await b.waitFor('(window.omw.state.dialogueLock||"") !== ""', STEP, 'B got a lock result');
  const denied = await lockOf(b);
  ctx.log(`B while A trades: ${JSON.stringify(denied)}`);
  assert.equal(denied.granted, false, 'opening the trade window released A\'s dialogue lock: B walked into the conversation');

  // 160: longer than a chest watch lives, then the sale. THE PURSE: the only NPCs outside at
  // Seyda Neen are guards and villagers with a barter gold of 0 (Arrille is indoors), so a
  // sale cannot LOWER the purse (#105: 'purse 0', 30 s waiting for it to drop). The stock
  // watch proves the sale; the purse delta is proven the other way round -- A BUYS one item
  // of the merchant's own stock, and the purse rises by its value.
  ctx.log(`waiting ${LONGER_THAN_A_CHEST_WATCH / 1000} s with the window open`);
  await ctx.sleep(LONGER_THAN_A_CHEST_WATCH);
  await a.cmd(`barter:sell:${ITEM}`);
  await a.waitFor(stockWith(ITEM), STEP, `A's stock mirror never listed the ${ITEM} A sold (the live watch died with the 15 s chest expiry)`);
  const stock = Object.values(JSON.parse(await a.eval('window.omw.state.containerItems||"{}"'))).find((s) => (s[ITEM] || 0) > 0);
  const wares = Object.keys(stock).filter((id) => id !== ITEM && !id.startsWith('gold_'));
  assert.ok(wares.length > 0, `"${npc}" carries nothing but the ${ITEM} to buy back (${JSON.stringify(stock)})`);
  await a.cmd(`barter:buy:${wares[0]}`);
  await a.waitFor(`Number(window.omw.state.barterGold||"0") > ${goldBefore}`, STEP, 'the purchase raised the purse on A');
  const goldAfter = await goldOf(a);
  ctx.log(`A sold the ${ITEM} and bought ${wares[0]}: purse ${goldBefore} -> ${goldAfter}`);
  assert.ok(goldAfter > goldBefore, 'the buy hook did not move the purse');

  // Close the trade (Barter -> Dialogue keeps the lock), then leave the conversation.
  await a.cmd('barter:close');
  await ctx.sleep(1000);
  await a.cmd('dlg:release');

  // B opens the same merchant: the stock carries A's cuirass and the purse is what A left.
  await b.cmd(`dlg:${npc}`);
  await b.waitFor('JSON.parse(window.omw.state.dialogueLock||"{}").granted === true', STEP, 'B acquires the lock after A leaves');
  await b.cmd(`barter:open:${npc}`);
  await b.waitFor('(window.omw.state.barterGold||"") !== ""', STEP, 'B opened a barter window');
  await b.waitFor(stockWith(ITEM), STEP,
    `B's stock mirror never listed the ${ITEM} A sold (the sale after 15 s went unreported)`);
  await b.waitFor(`Number(window.omw.state.barterGold||"-1") === ${goldAfter}`, STEP,
    `B's purse never matched A's post-trade ${goldAfter} (the gold delta of a long trade was never sent)`);
  ctx.log(`B sees the ${ITEM} in stock and the purse at ${goldAfter}`);

  await b.cmd('barter:close');
  await b.cmd('dlg:release');
  ctx.log('PASS: a trade longer than 15 s still syncs, and the trade window keeps the conversation lock');
}
