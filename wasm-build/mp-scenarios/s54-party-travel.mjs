// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s54 (party travel): two players form a party in the public world; the leader triggers
// PartyTravel target=party. The gateway must spin up the party world, BOTH clients must
// redial it (dialTarget moves; the world's /status sees two players), and a non-leader's
// attempt must be refused. This is the plan's "party shifts between realms together",
// end to end through real browsers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP = 30_000;
const GW_PORT = 58830 + (process.pid % 120);

export const serverRules = `[gateway]\nurl = "http://127.0.0.1:${GW_PORT}"`;

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const playersIn = async (port) => {
  try {
    const st = await (await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) })).json();
    return st.playerCount ?? 0;
  } catch {
    return -1;
  }
};

export default async function run(ctx) {
  const worldsDir = mkdtempSync(join(tmpdir(), 'omw-s54-worlds-'));
  const gw = spawn(process.execPath, [
    join(ROOT, 'server', 'dist', 'gateway.mjs'),
    '--worlds', worldsDir, '--port', String(GW_PORT),
    '--base-port', String(GW_PORT + 200), '--public-host', '127.0.0.1', '--max-worlds', '4',
  ], {
    stdio: 'ignore',
    // Worlds this gateway spawns inherit it: the harness clients log in with the fixed
    // ?mpauto=1 password, which real servers refuse by default.
    env: { ...process.env, OMW_ALLOW_HARNESS_AUTH: '1' },
  });
  const stopGw = () => { try { gw.kill('SIGTERM'); } catch { /* gone */ } };

  try {
    assert.ok(await waitHttp(`http://127.0.0.1:${GW_PORT}/healthz`, 30_000), 'gateway must come up');
    const [a, b] = await Promise.all([
      ctx.launchClient('trav-a'),
      ctx.launchClient('trav-b'),
    ]);

    // Form the party: A invites, B accepts (same uplink the Party tab uses).
    await a.eval(`Module.__omwMPCmd='social:PartyInvite:${b.name.toLowerCase()}'`);
    await b.waitFor("JSON.parse((window.__omwMP||{}).invites||'[]').some(i=>i.kind==='party')",
      STEP, 'B sees the party invite');
    await b.eval(`Module.__omwMPCmd='social:PartyAccept:${a.name.toLowerCase()}'`);
    await a.waitFor("(JSON.parse((window.__omwMP||{}).party||'{}').members||[]).length === 2",
      STEP, 'party of two forms');
    ctx.log('  ok: party formed');

    // A NON-leader may not move the group: B tries, and nothing must start.
    await b.eval("Module.__omwMPCmd='partytravel:party'");
    await ctx.sleep(2500);
    const early = await (await fetch(`http://127.0.0.1:${GW_PORT}/worlds`)).json();
    assert.equal(early.worlds.filter((w) => w.mode === 'party').length, 0,
      'a non-leader must not be able to spawn the party world');
    ctx.log('  ok: non-leader travel refused');

    // The leader moves the group to the party world.
    await a.eval("Module.__omwMPCmd='partytravel:party'");

    // Diagnostics: did the PartyTravel event reach each client, and where would they dial?
    await ctx.sleep(4000);
    for (const [who, c] of [['A', a], ['B', b]]) {
      const tt = await c.eval("(window.__omwMP||{}).partyTravelTo||''");
      const dial = await c.eval("(window.__omwMP||{}).dialTarget||''");
      const st = await c.eval("(window.__omwMP||{}).state||''");
      ctx.log(`  ${who}: travelTo=${tt} dial=${dial} state=${st}`);
    }

    // The party world must appear at the gateway and BOTH clients must arrive in it.
    let partyPort = 0;
    const upBy = Date.now() + 90_000;
    while (Date.now() < upBy) {
      const l = await (await fetch(`http://127.0.0.1:${GW_PORT}/worlds?account=${encodeURIComponent(a.name.toLowerCase())}`)).json();
      const w = l.worlds.find((x) => x.mode === 'party');
      if (w?.up) { partyPort = w.port; break; }
      await ctx.sleep(1000);
    }
    assert.ok(partyPort > 0, 'the party world must come up at the gateway');
    ctx.log(`  party world up on ${partyPort}`);

    const bothBy = Date.now() + 90_000;
    let count = 0;
    while (Date.now() < bothBy) {
      count = await playersIn(partyPort);
      if (count >= 2) break;
      await ctx.sleep(1000);
    }
    assert.equal(count, 2, `both party members must arrive in the party world, got ${count}`);
    ctx.log('  ok: both members travelled together');

    // Reconnect safety: each client's dial target must now be the party world.
    for (const [who, c] of [['A', a], ['B', b]]) {
      const dial = String(await c.eval("(window.__omwMP||{}).dialTarget||''"));
      assert.ok(dial.includes(`:${partyPort}/`),
        `${who}'s reconnect target must be the party world, got ${dial}`);
    }
    ctx.log('  ok: reconnects would return both members to the party world');
  } finally {
    stopGw();
  }
}
