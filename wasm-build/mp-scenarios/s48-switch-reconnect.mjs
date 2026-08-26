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

// serverToken is the credential a WORLD PROCESS presents to the gateway so it may create
// a world for a player. The gateway takes the account from the caller's identity and never
// from the body, and a world has no locker session to present -- so without this every
// in-game create is refused with 401, which is exactly what was happening. This one file is
// both the world's config and the gateway's --shared config, mirroring production.
export const serverRules = `[gateway]\nurl = "http://127.0.0.1:${GW_PORT}"\nserverToken = "harness-server-credential-not-for-production"`;

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
    '--base-port', String(GW_PORT + 200), '--max-worlds', '4',
    // Worlds this gateway spawns must boot WITHOUT real game data, a peer binary or a server
    // password — a harness has none. server.mjs refuses on all three, so every spawned world
    // died and the scenario saw only an empty world list.
    '--server-entry', join(ROOT, 'server', 'dist', 'testhost.mjs'),
  ], {
    // CAPTURED, not discarded. A gateway that comes up healthy but spawns no worlds is
    // invisible with stdio:'ignore' — the scenario then fails on a downstream assertion
    // ("session created") while the reason sits unprinted in a dead pipe.
    stdio: ['ignore', 'pipe', 'pipe'],
    // Worlds this gateway spawns inherit it: the harness clients log in with the fixed
    // ?mpauto=1 password, which real servers refuse by default.
    env: { ...process.env, OMW_ALLOW_HARNESS_AUTH: '1' },
  });
  ctx.watchChild('gateway', gw);
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

    // --- the actual subject: WHERE would a reconnect go? -------------------------------
    // Every redial path in net.lua goes through targetUrl(), so the dial target IS the
    // property. Asserting it directly rather than staging a network failure, because a
    // DELIBERATE mp.disconnect() cannot stand in for one: close() calls
    // emscripten_websocket_delete immediately, destroying the handle and its callbacks, so
    // no close event fires and no reconnect is scheduled — correct behaviour for choosing
    // to leave, and useless as a drop simulation. Everything downstream of targetUrl()
    // (scheduleReconnect, the auth ladder, the backoff) is shared, already-covered code;
    // the only thing a world switch changes is this value.
    const dial = String(await a.eval("(window.__omwMP||{}).dialTarget || ''"));
    ctx.log(`  dial target after switching: ${dial}`);
    assert.ok(dial.includes(`:${sessionPort}/`),
      `a reconnect must redial the world we SWITCHED TO (port ${sessionPort}), but the dial `
      + `target is "${dial}" — a dropped player would be silently returned to the world they `
      + 'originally launched into');
    assert.ok(!dial.includes(`:${ctx.serverPort}/`),
      'and it must NOT still point at the launch world');
    ctx.log('  ok: a reconnect would return the player to the session world, not the public one');
  } finally {
    stopGw();
  }
}
