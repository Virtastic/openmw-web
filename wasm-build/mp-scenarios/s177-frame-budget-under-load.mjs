// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s177: THE FRAME BUDGET IN A CROWDED CELL. Two real retail clients and twenty protocol bots
// in one cell the sim peer holds (s42's crowd). s42 asks whether the clients still AGREE; this
// asks whether they can still PLAY: the frame rate a player sees and the longest hitch, sampled
// with requestAnimationFrame exactly the way play/index.html's omwTelemetry samples it (the
// engine's main loop rides rAF, so a rAF gap IS a frame the player waited for).
//
// Asserted: median fps >= 55 per client and no frame over 100 ms in the steady window (after the
// crowd has arrived and its puppets are built -- building twenty new bodies is loading, and is
// reported separately), and the server's own relay accounting (worldstate.ts noteRelay,
// actor.relay_stats) shows no NPC frame SHED for a backed-up socket while the crowd is in.
// The same window is measured BEFORE the bots arrive, so a failure says whether the crowd cost
// the frames or the machine never had them: the harness renders through SwiftShader on a
// GPU-less box, where the uncrowded number is itself a property of the box.
// S177_MIN_FPS / S177_MAX_GAP_MS move the bar for a machine that cannot meet it by design.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BOTS = Number(process.env.S177_BOTS ?? 20);
const MIN_FPS = Number(process.env.S177_MIN_FPS ?? 55);
const MAX_GAP_MS = Number(process.env.S177_MAX_GAP_MS ?? 100);
const WINDOW_MS = 60_000;
const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
export const timeoutMs = 30 * 60_000;
export const serverRules =
  `\n[server]\nmaxPlayers = ${(2 + BOTS) * 2 + 16}\n`
  + `\n[content]\nenforce = "off"\n` // s42: the first client's manifest is canonical and bots would be refused
  + `\n[limits]\nmaxConnsPerIp = ${(2 + BOTS) * 4 + 16}\nloginPerMinPerIp = 100000\n`;

// A rAF sampler in the page: every frame's timestamp, plus whether the loading overlay showed.
const INSTALL = `(function(){ if (window.__s177) return 'already';
  var s = window.__s177 = { t: [], load: 0 };
  function tick(ts){ var el = document.getElementById('loading');
    if (el && !el.classList.contains('hide') && el.style.display !== 'none') s.load++; else s.t.push(ts);
    requestAnimationFrame(tick); }
  requestAnimationFrame(tick); return 'installed'; })()`;
const RESET = `(function(){ window.__s177.t = []; window.__s177.load = 0; return true; })()`;
const TAKE = `JSON.stringify({ t: window.__s177.t, load: window.__s177.load, vis: document.visibilityState })`;

function stats(t) {
  const gaps = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  const perSec = [];
  if (t.length) for (let s = t[0]; s + 1000 <= t[t.length - 1]; s += 1000) perSec.push(t.filter((x) => x >= s && x < s + 1000).length);
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const sorted = [...gaps].sort((a, b) => a - b);
  return { frames: t.length, fpsMedian: med(perSec), fpsMin: perSec.length ? Math.min(...perSec) : 0,
    worstGapMs: Math.round(gaps.length ? Math.max(...gaps) : 0),
    p99GapMs: Math.round(sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0),
    over100: gaps.filter((g) => g > MAX_GAP_MS).length };
}

async function measure(ctx, clients, label) {
  await Promise.all(clients.map((c) => c.eval(RESET)));
  await ctx.sleep(WINDOW_MS);
  const out = await Promise.all(clients.map(async (c) => {
    const r = JSON.parse(await c.eval(TAKE));
    return { name: c.name, loadFrames: r.load, vis: r.vis, ...stats(r.t) };
  }));
  for (const o of out) ctx.log(`${label} ${o.name}: fps median ${o.fpsMedian} (min ${o.fpsMin}), worst frame ${o.worstGapMs} ms, p99 ${o.p99GapMs} ms, ${o.over100} frames > ${MAX_GAP_MS} ms, ${o.frames} frames, ${o.loadFrames} under the loading screen, ${o.vis}`);
  return out;
}

const relayStats = (ctx, sinceIso) => ctx.serverLogTail(20_000).split('\n')
  .filter((l) => l.includes('"actor.relay_stats"'))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && e.ts >= sinceIso);

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) { ctx.log('SKIP: play/mwdata/Morrowind.esm absent'); return; }

  const clients = [await ctx.launchClient('fb-a', '', BOOT), await ctx.launchClient('fb-b', '', BOOT)];
  for (const c of clients) {
    await c.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 300_000, `${c.name}: the peer holds the cell`);
    await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 120_000, `${c.name} puppets the cell's NPCs`);
    assert.equal(await c.eval(INSTALL), 'installed');
  }
  const census = JSON.parse(await clients[0].eval('window.omw.state.actorCensus||"[]"'));
  const cellKey = (census.find((e) => e.startsWith('player@')) ?? '').slice('player@'.length);
  assert.ok(cellKey, `no cell key in actorCensus: ${JSON.stringify(census)}`);

  // The uncrowded frame rate of THIS box, first.
  const base = await measure(ctx, clients, 'uncrowded');

  // The crowd.
  const soak = spawn('npx', ['tsx', 'bots/soak.ts', '--attach', String(ctx.serverPort), '--onecell', '--cellkey', cellKey,
    '--bots', String(BOTS), '--minutes', '4'], { cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.watchChild('soak', soak);
  const arrive0 = Date.now();
  await Promise.all(clients.map((c) => c.eval(RESET)));
  let players = 0;
  for (const by = Date.now() + 120_000; Date.now() < by && players < 2 + BOTS;) {
    players = (await ctx.serverStatus()).players.length;
    if (players < 2 + BOTS) await ctx.sleep(1000);
  }
  assert.ok(players >= 2 + BOTS, `the crowd never fully joined: ${players}/${2 + BOTS}\n${ctx.childLogTail('soak', 30)}`);
  // Twenty new puppets on each client: wait until each roster shows them, then 10 s to build.
  for (const c of clients) await c.waitFor(`JSON.parse(window.omw.state.players||'[]').length >= ${1 + BOTS}`, 120_000, `${c.name} sees the crowd`);
  await ctx.sleep(10_000);
  const arrival = await Promise.all(clients.map(async (c) => stats(JSON.parse(await c.eval(TAKE)).t)));
  ctx.log(`crowd arrival (${Math.round((Date.now() - arrive0) / 1000)} s, reported, not judged): `
    + arrival.map((a, i) => `${clients[i].name} fps ${a.fpsMedian} worst ${a.worstGapMs} ms`).join('; '));

  const since = new Date().toISOString();
  const crowded = await measure(ctx, clients, 'crowded');
  // relay_stats is flushed on the next relay after 30 s: give it one more tick to land.
  await ctx.sleep(35_000);
  const rs = relayStats(ctx, since);
  const shed = rs.flatMap((e) => Object.entries(e.shed ?? {}));
  const sent = rs.reduce((n, e) => n + Object.values(e.sent ?? {}).reduce((a, b) => a + b, 0), 0);
  ctx.log(`server relay_stats in the window: ${rs.length} report(s), ${sent} NPC frames sent, shed ${JSON.stringify(Object.fromEntries(shed))}`);
  try { soak.kill('SIGTERM'); } catch { /* gone */ }

  assert.ok(rs.length > 0 && sent > 0, 'no actor.relay_stats with traffic in the window: the peer streamed nothing, so "no shedding" would mean nothing');
  const fails = [];
  for (const [i, c] of crowded.entries()) {
    const b = base[i];
    if (c.fpsMedian < MIN_FPS) fails.push(`${c.name}: median ${c.fpsMedian} fps < ${MIN_FPS} (uncrowded ${b.fpsMedian})`);
    if (c.worstGapMs > MAX_GAP_MS) fails.push(`${c.name}: worst frame ${c.worstGapMs} ms > ${MAX_GAP_MS} (${c.over100} such; uncrowded worst ${b.worstGapMs} ms)`);
  }
  if (shed.length) fails.push(`the server shed NPC frames: ${JSON.stringify(Object.fromEntries(shed))}`);
  assert.deepEqual(fails, [], `frame budget under a crowd of ${BOTS}:\n  ${fails.join('\n  ')}`);
  ctx.log(`PASS: ${crowded.map((c) => `${c.name} ${c.fpsMedian} fps, worst ${c.worstGapMs} ms`).join('; ')} with ${BOTS} bots; nothing shed`);
}
