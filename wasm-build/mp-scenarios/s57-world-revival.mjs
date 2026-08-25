// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s57: a private world that was REAPED while you were elsewhere must come back when you return.
//
// This is the single most common multiplayer journey and it was the reason multiplayer was
// gated off production: "returning from the public world to your own dead-ends at AUTH_FAILED".
// Three things have to line up and all three are easy to get wrong in ways that look identical
// from the outside — nothing happens and the player is stuck on a loading screen:
//
//   1. The world must be REVIVED on dial. It is only a directory on disk by then; the gateway
//      has no process for it. It must also be revived WITH ITS OWNER, or server.ts reads an
//      empty OMW_WORLD_OWNER as "public, admit anyone" and any signed-in account could walk
//      into somebody's solo game.
//   2. The resume token must NOT be what gets the player back in. It lived in the memory of the
//      process that was just reaped, so it is guaranteed refused.
//   3. The auth ladder must then RESCUE itself rather than dead-ending. For an SSO user every
//      remaining rung is the password ladder the server refuses on principle, so the only
//      credential that can work is a fresh ticket — which only the page can mint.
//
// Reaping is driven by --idle-reap-ms rather than by waiting out the two-minute default.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP = 30_000;
const GW_PORT = 58900 + (process.pid % 120);
const REAP_MS = 4000;

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

const worldsOf = async (acct) => {
  try {
    const r = await fetch(`http://127.0.0.1:${GW_PORT}/worlds?account=${encodeURIComponent(acct)}`,
      { signal: AbortSignal.timeout(1500) });
    return (await r.json()).worlds ?? [];
  } catch {
    return [];
  }
};

const playersIn = async (port) => {
  try {
    const st = await (await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) })).json();
    return st.playerCount ?? 0;
  } catch {
    return -1;
  }
};

export default async function run(ctx) {
  const worldsDir = mkdtempSync(join(tmpdir(), 'omw-s57-worlds-'));
  const gw = spawn(process.execPath, [
    join(ROOT, 'server', 'dist', 'gateway.mjs'),
    '--worlds', worldsDir, '--port', String(GW_PORT),
    '--base-port', String(GW_PORT + 200), '--max-worlds', '4',
    '--idle-reap-ms', String(REAP_MS),
    '--server-entry', join(ROOT, 'server', 'dist', 'testhost.mjs'),
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OMW_ALLOW_HARNESS_AUTH: '1' },
  });
  ctx.watchChild('gateway', gw);
  const stopGw = () => { try { gw.kill('SIGTERM'); } catch { /* gone */ } };

  try {
    assert.ok(await waitHttp(`http://127.0.0.1:${GW_PORT}/healthz`, 30_000), 'gateway must come up');
    const a = await ctx.launchClient('bot-a', '');
    const acct = a.name.toLowerCase();

    // --- own world, entered -------------------------------------------------------------
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await a.waitFor("(window.__omwMP||{}).worldCount !== undefined", STEP, 'world list arrives');
    await a.eval("Module.__omwMPCmd='worldcreate:revivetest:private'");
    await a.waitFor("Number((window.__omwMP||{}).worldCount||0) > 1", STEP, 'session created');

    let ownPort = 0;
    const upBy = Date.now() + 60_000;
    while (Date.now() < upBy) {
      const w = (await worldsOf(acct)).find((x) => x.id === 'revivetest');
      if (w?.up) { ownPort = w.port; break; }
      await ctx.sleep(1000);
    }
    assert.ok(ownPort > 0, 'the private world must come up');

    await a.eval("Module.__omwMPCmd='socialtab:players'");
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await ctx.sleep(1500);
    await a.eval("Module.__omwMPCmd='worldjoin:revivetest'");

    let joined = false;
    const joinBy = Date.now() + 60_000;
    while (Date.now() < joinBy) {
      if (await playersIn(ownPort) > 0) { joined = true; break; }
      await ctx.sleep(1000);
    }
    assert.ok(joined, 'the player must first arrive in their own world');
    ctx.log(`  in their own world on ${ownPort}`);

    // --- leave for the public world, and let the empty one be reaped --------------------
    await a.eval("Module.__omwMPCmd='where:public'");
    await a.waitFor(`(window.__omwMP||{}).state === 'Joined'`, STEP, 'arrives in the public world');
    ctx.log('  switched to the public world');

    let reaped = false;
    const reapBy = Date.now() + REAP_MS + 30_000;
    while (Date.now() < reapBy) {
      const w = (await worldsOf(acct)).find((x) => x.id === 'revivetest');
      if (!w || !w.up) { reaped = true; break; }
      await ctx.sleep(500);
    }
    assert.ok(reaped, `the idle private world must be reaped within ${REAP_MS}ms + slack`);
    ctx.log('  their own world was reaped while they were away');

    // --- and now the subject: go home ---------------------------------------------------
    // The resume token died with that process, and for an SSO user every remaining rung of the
    // ladder is the password path the server refuses. Getting back in at all proves the world
    // was revived under its owner AND that the ladder rescued itself with a fresh ticket.
    await a.eval("Module.__omwMPCmd='where:solo'");

    let home = false, homePort = 0;
    const homeBy = Date.now() + 90_000;
    while (Date.now() < homeBy) {
      const w = (await worldsOf(acct)).find((x) => x.id === 'revivetest');
      if (w?.up) {
        homePort = w.port;
        if (await playersIn(homePort) > 0) { home = true; break; }
      }
      await ctx.sleep(1000);
    }

    const lastErr = String(await a.eval("(window.__omwMP||{}).lastError || ''"));
    assert.ok(home,
      'the player never got back into their own world after it was reaped. '
      + `lastError=${JSON.stringify(lastErr)} — an AUTH_FAILED here is the dead-end that gated `
      + 'multiplayer off production: the resume token died with the reaped process and the '
      + 'ladder must rescue itself with a fresh ticket rather than falling to the password path');
    assert.ok(!/AUTH_FAILED/.test(lastErr),
      `got home, but only after surfacing ${lastErr} to the player`);
    ctx.log(`  ok: their world was revived on ${homePort} and they walked back in`);
  } finally {
    stopGw();
  }
}
