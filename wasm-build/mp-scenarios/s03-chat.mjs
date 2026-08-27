// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s03: chat round-trip. MOTD (server chat line on join, plugins/builtin/motd.ts) reaches both,
// then A -> B and B -> A messages arrive within the latency budget (see CHAT_BUDGET_MS).
//
// Mirror semantics (scripts/mp/global.lua + player.lua): __omwMP.lastChat = JSON of the last
// SERVER ChatMessage only (join/leave lines skip it), __omwMP.lastChatLine = last formatted
// line shown in the chat UI (includes join/leave). So: assert the MOTD via lastChat BEFORE
// any chat is sent, then use both mirrors for the round-trip.
import assert from 'node:assert/strict';

// A LATENCY BOUND, not a rendering benchmark. 2000 ms was chosen against a machine with a GPU;
// on a GPU-less box the client renders through SwiftShader and a round trip that is genuinely
// fast on the wire can still miss it, which is this repo's documented anti-pattern -- a test
// that measures the machine is not a test. Observed failing at exactly this bound in two
// different images while the message itself arrived fine.
//
// 10 s is still a real assertion: chat is a relay with no simulation behind it, so anything
// approaching this number means a genuine stall rather than a slow renderer. Overridable so a
// fast machine can hold itself to a tighter bar.
const CHAT_BUDGET_MS = Number(process.env.OMW_CHAT_BUDGET_MS || 10000);

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
  // lastChatLine (player-script UI mirror) lags lastChat by one engine frame (global script
  // mirrors on receipt, then sendEvent-hops to the player script) — up to ~1s on a throttled
  // headless tab. So WAIT for it; a bare eval here is a race (bit us in full-suite runs).
  await b.waitFor(
    `(((window.__omwMP||{}).lastChatLine||"").includes(${JSON.stringify(nonceA)})
      && ((window.__omwMP||{}).lastChatLine||"").includes(${JSON.stringify(a.name)}))`,
    CHAT_BUDGET_MS, `lastChatLine on ${b.name} carries A's nonce + attribution`);

  // B replies -> A.
  const nonceB = 'n' + Math.random().toString(36).slice(2, 10);
  await b.eval(`window.__omwMP.sendChat(${JSON.stringify('hello back from B ' + nonceB)})`);
  t0 = Date.now();
  await a.waitFor(`((window.__omwMP||{}).lastChat||"").includes(${JSON.stringify(nonceB)})`,
    CHAT_BUDGET_MS, `B's reply on ${a.name}`);
  const dtBA = Date.now() - t0;
  await a.waitFor(
    `((window.__omwMP||{}).lastChatLine||"").includes(${JSON.stringify(nonceB)})`,
    CHAT_BUDGET_MS, `lastChatLine on ${a.name} carries B's nonce`);

  ctx.log(`ok: chat round-trip A->B ${dtAB}ms, B->A ${dtBA}ms`);
}
