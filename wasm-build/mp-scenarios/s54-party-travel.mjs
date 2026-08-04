// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s54 (party travel): two players form a party, and the leader moves the group. PUBLIC is
// the only destination — the dedicated `party-<key>` world was removed, because a party is
// together either in the leader's OWN world flipped to Party (leader keeps their world and
// stays quest authority) or in the shared world. So: target=party must be REFUSED, a
// non-leader must not be able to move anyone, and the leader moving to public must fan the
// destination out to both members. End to end through real browsers.
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
    // The gateway's worlds MUST share the launch world's dir: accounts, friends and
    // PARTIES live there, and a party world that cannot see the party refuses the members
    // it exists for (world access control, plan 3.8). This is a real deployment
    // requirement, not a test detail.
    '--shared', ctx.serverDataDir,
    '--base-port', String(GW_PORT + 200), '--max-worlds', '4',
    // Worlds this gateway spawns must boot WITHOUT real game data, a peer binary or a server
    // password — a harness has none. server.mjs refuses on all three, so every spawned world
    // died and the scenario saw only an empty world list.
    '--server-entry', join(ROOT, 'server', 'dist', 'testhost.mjs'),
  ], {
    // PIPED, not discarded: a gateway whose spawned worlds all crash comes up "healthy" and
    // is indistinguishable from a working one. ctx.watchChild prints this on any failure.
    stdio: ['ignore', 'pipe', 'pipe'],
    // Worlds this gateway spawns inherit it: the harness clients log in with the fixed
    // ?mpauto=1 password, which real servers refuse by default.
    env: { ...process.env, OMW_ALLOW_HARNESS_AUTH: '1' },
  });
  ctx.watchChild('gateway', gw);
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

    // A NON-leader may not move the group.
    await b.eval("Module.__omwMPCmd='partytravel:public'");
    await ctx.sleep(2500);
    const refused = await b.eval(
      "JSON.stringify((window.__omwMP||{}).lastSocialResult||'')");
    ctx.log('  non-leader result: ' + refused);
    assert.equal(await b.eval("(window.__omwMP||{}).partyTravelTo||''"), '',
      'a non-leader must not be able to move the party');
    ctx.log('  ok: non-leader travel refused');

    // The dedicated party world is gone: asking for it must be refused, and must not create
    // a world at the gateway.
    await a.eval("Module.__omwMPCmd='partytravel:party'");
    await ctx.sleep(3000);
    const after = await (await fetch(`http://127.0.0.1:${GW_PORT}/worlds`)).json();
    assert.equal(after.worlds.filter((w) => w.mode === 'party').length, 0,
      'target=party must no longer spawn a party world');
    ctx.log('  ok: dedicated party world is refused, none created');

    // The leader moves the group to the SHARED world: both members get the destination.
    await a.eval("Module.__omwMPCmd='partytravel:public'");
    for (const [who, c] of [['A', a], ['B', b]]) {
      await c.waitFor("((window.__omwMP||{}).partyTravelTo||'') !== ''", STEP,
        `${who} received the party's destination`);
      const tt = await c.eval("(window.__omwMP||{}).partyTravelTo||''");
      ctx.log(`  ${who}: travelTo=${tt}`);
    }
    ctx.log('  ok: leader moved the whole party to the shared world');

  } finally {
    stopGw();
  }
}
