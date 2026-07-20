// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s03: chat round-trip. MOTD (server chat line on join, plugins/builtin/motd.ts) reaches both,
// then A -> B and B -> A messages arrive within the 2s budget.
//
// Mirror semantics (scripts/mp/global.lua + player.lua): __omwMP.lastChat = JSON of the last
// SERVER ChatMessage only (join/leave lines skip it), __omwMP.lastChatLine = last formatted
// line shown in the chat UI (includes join/leave). So: assert the MOTD via lastChat BEFORE
// any chat is sent, then use both mirrors for the round-trip.
import assert from 'node:assert/strict';

const CHAT_BUDGET_MS = 2000;

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('bot-a'),
    ctx.launchClient('bot-b'),
  ]);

  // MOTD: harness stamps a per-run motd into the server config; it must be the last server
  // chat line each client saw at this point (nothing else has been sent yet).
  const motdExpr = `((window.__omwMP||{}).lastChat||"").includes(${JSON.stringify(ctx.motd)})`;
  await a.waitFor(motdExpr, 5000, `MOTD on ${a.name}`);
  await b.waitFor(motdExpr, 5000, `MOTD on ${b.name}`);
  ctx.log('ok: MOTD reached both clients');

  // A -> B. sendChat feeds Module.__omwMPCmd, drained by player.lua onFrame -> ChatSend event
  // -> server broadcast (sender included).
  const nonceA = 'n' + Math.random().toString(36).slice(2, 10);
  await a.eval(`window.__omwMP.sendChat(${JSON.stringify('hello from A ' + nonceA)})`);
  let t0 = Date.now();
  await b.waitFor(`((window.__omwMP||{}).lastChat||"").includes(${JSON.stringify(nonceA)})`,
    CHAT_BUDGET_MS, `A's message on ${b.name}`);
  const dtAB = Date.now() - t0;
  // lastChatLine (player-script UI mirror) must carry it too, attributed to A.
  const lineB = await b.eval('(window.__omwMP||{}).lastChatLine||""');
  assert.ok(lineB.includes(nonceA), `lastChatLine on B missing nonce (got "${lineB}")`);
  assert.ok(lineB.includes(a.name), `lastChatLine on B not attributed to ${a.name} (got "${lineB}")`);

  // B replies -> A.
  const nonceB = 'n' + Math.random().toString(36).slice(2, 10);
  await b.eval(`window.__omwMP.sendChat(${JSON.stringify('hello back from B ' + nonceB)})`);
  t0 = Date.now();
  await a.waitFor(`((window.__omwMP||{}).lastChat||"").includes(${JSON.stringify(nonceB)})`,
    CHAT_BUDGET_MS, `B's reply on ${a.name}`);
  const dtBA = Date.now() - t0;
  const lineA = await a.eval('(window.__omwMP||{}).lastChatLine||""');
  assert.ok(lineA.includes(nonceB), `lastChatLine on A missing nonce (got "${lineA}")`);

  ctx.log(`ok: chat round-trip A->B ${dtAB}ms, B->A ${dtBA}ms`);
}
