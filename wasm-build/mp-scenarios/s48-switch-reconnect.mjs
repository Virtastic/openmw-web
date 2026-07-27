// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s48 (F3): after switching worlds, a RECONNECT must redial the world you switched TO.
//
// net.switchTo() records the current world in `currentUrl` and every dial path reads it via
// targetUrl(). If that were wrong — if any path still read mp.getUrl() — a player who joined
// a friend's private session and then had a brief network hiccup would be silently returned
// to the public world they launched into, mid-session, with no error. That is a confusing
// failure a player would report as "it randomly teleported me", so it is worth an explicit
// test rather than trusting the code reads right.
//
// The mechanism is asserted, not the symptom: the client is forced to drop and MUST come
// back on the SESSION world, proven by that world's own /status seeing the player return.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP = 30_000;
const GW_PORT = 58700 + (process.pid % 120);

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
    return -1; // not answering
  }
};

export default async function run(ctx) {
  const worldsDir = mkdtempSync(join(tmpdir(), 'omw-s48-worlds-'));
  const gw = spawn(process.execPath, [
    join(ROOT, 'server', 'dist', 'gateway.mjs'),
    '--worlds', worldsDir, '--port', String(GW_PORT),
    '--base-port', String(GW_PORT + 200), '--public-host', '127.0.0.1', '--max-worlds', '4',
  ], { stdio: 'ignore' });
  const stopGw = () => { try { gw.kill('SIGTERM'); } catch { /* gone */ } };

  try {
    assert.ok(await waitHttp(`http://127.0.0.1:${GW_PORT}/healthz`, 30_000), 'gateway must come up');
    const a = await ctx.launchClient('bot-a', '');
    const acct = a.name.toLowerCase();

    // Create and enter a private session.
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await a.waitFor("(window.__omwMP||{}).worldCount !== undefined", STEP, 'world list arrives');
    await a.eval("Module.__omwMPCmd='worldcreate:switchtest:private'");
    await a.waitFor("Number((window.__omwMP||{}).worldCount||0) > 1", STEP, 'session created');

    const listUrl = `http://127.0.0.1:${GW_PORT}/worlds?account=${encodeURIComponent(acct)}`;
    let sessionPort = 0;
    const upBy = Date.now() + 60_000;
    while (Date.now() < upBy) {
      const l = await (await fetch(listUrl)).json();
      const w = l.worlds.find((x) => x.id === 'switchtest');
      if (w?.up) { sessionPort = w.port; break; }
      await ctx.sleep(1000);
    }
    assert.ok(sessionPort > 0, 'the session world must come up');

    // Refresh so the UI offers a join, then switch.
    await a.eval("Module.__omwMPCmd='socialtab:players'");
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await ctx.sleep(1500);
    await a.eval("Module.__omwMPCmd='worldjoin:switchtest'");

    const joinBy = Date.now() + 60_000;
    let joined = false;
    while (Date.now() < joinBy) {
      if (await playersIn(sessionPort) > 0) { joined = true; break; }
      await ctx.sleep(1000);
    }
    assert.ok(joined, 'the player must first arrive in the session world');
    ctx.log(`  switched into the session world on ${sessionPort}`);

    // --- the actual subject: drop the connection and see WHERE it comes back ----------
    // mp.disconnect() from the client is the same shape as a transport drop: net.lua sees
    // the close and schedules a redial through targetUrl().
    await a.eval("Module.__omwMPCmd='netdrop'");
    await a.waitFor("(window.__omwMP||{}).state !== 'Joined'", STEP, 'the client notices the drop');
    ctx.log('  connection dropped; waiting for the automatic redial');

    await a.waitFor("(window.__omwMP||{}).state === 'Joined'", 90_000, 'the client reconnects somewhere');

    // Where did it land? The SESSION world must see it again. Checking the client's own
    // belief would pass even if it had gone back to the public world.
    const backBy = Date.now() + 60_000;
    let back = false;
    while (Date.now() < backBy) {
      if (await playersIn(sessionPort) > 0) { back = true; break; }
      await ctx.sleep(1000);
    }
    assert.ok(back,
      'after a reconnect the player must be back in the world they SWITCHED TO, '
      + 'not the one they originally launched into');
    ctx.log('  ok: the reconnect returned the player to the session world, not the public one');
  } finally {
    stopGw();
  }
}
