// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Shared setup for scenarios that need a REAL gateway supervising real worlds.
//
// It exists because getting this right took four separate corrections, every one of which
// looked like a product defect first (see MP-BACKLOG, "What made the world switch testable"):
// dial the splice only after the world is UP, reach a world THROUGH the gateway, arrive in
// your OWN world rather than public, and set #mphome or a reload makes the client treat
// wherever it landed as home. Anything that switches worlds needs all four, and a fifth
// scenario re-deriving them by hand is how one of them gets missed.
//
// s47, s48 and s57 predate this helper and still inline the same steps. They are left alone
// because they pass, and rewriting a passing scenario to share code is a bad trade.
//
// NOTE: this file starts with an underscore so the harness's scenario scan skips it -- it is
// a library, not a scenario, and a bare .mjs here would be run as one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Config a scenario must export so its own world knows where the gateway is. */
export function gatewayRules(gwPort) {
  return `[gateway]\nurl = "http://127.0.0.1:${gwPort}"\n`
    + 'serverToken = "harness-server-credential-not-for-production"';
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return true; }
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** A locker SESSION, which ?mpauto=1 does not grant. rebootIntoWorld mints a fresh
 *  single-use ticket with it, so without one every switch dies at "no locker session"
 *  before touching the network. */
export async function harnessSession(gwPort, account) {
  const r = await fetch(`http://127.0.0.1:${gwPort}/harness/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password: 'harness-pass-1' }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`the gateway would not mint a harness locker session (${r.status})`);
  return (await r.json()).token;
}

/** Injected AFTER boot, never through the URL: #mplocker flips index.html into
 *  locker/launcher mode, a different asset path that never comes up here and kills the client
 *  outright. The base must point at the GATEWAY, because /auth/ticket lives there and
 *  lockerHttpBase would otherwise derive it from the WORLD socket. Ends in a string because
 *  Runtime.evaluate serialises its last expression and a function comes back unserialisable --
 *  which rejects, and an unhandled rejection takes the whole run down with no output at all.
 *  Re-grant before EVERY switch: a switch reloads the page and these live on window. */
export async function grantLockerSession(client, gwPort, account) {
  const token = await harnessSession(gwPort, account);
  await client.eval(`window.__omwLockerToken = ${JSON.stringify(token)};`
    + `window.__lockerHttpBase = function(){ return 'http://127.0.0.1:${gwPort}'; };`
    + `'granted';`);
}

/**
 * Start a gateway and put a client in its OWN world through it (worlds are created on demand).
 * Returns { client, gwPort, ownId, account, stop }.
 */
export async function startGatewayAndClient(ctx, opts = {}) {
  const { gwPort, name = 'bot-a', maxWorlds = 4, idleReapMs, ownId = 'priv-own-world' } = opts;
  const worldsDir = mkdtempSync(join(tmpdir(), 'omw-gw-worlds-'));
  const gw = spawn(process.execPath, [
    join(ROOT, 'server', 'dist', 'gateway.mjs'),
    '--worlds', worldsDir,
    '--port', String(gwPort),
    // Worlds this gateway spawns MUST share the launch world's data dir: accounts, friends
    // and parties live there, and a world that cannot see them refuses the very players it
    // was created for. A deployment requirement, not a test detail.
    '--shared', ctx.serverDataDir,
    '--base-port', String(gwPort + 200),
    '--max-worlds', String(maxWorlds),
    // No public world: the flag AND the mode died with the Solo/Party model. Worlds exist
    // only when an authed account creates one, which is what this helper does below --
    // deployment asks. This helper never asked, then asserted 60s later that one came up, so
    // exactly the production flow.
    ...(idleReapMs ? ['--idle-reap-ms', String(idleReapMs)] : []),
    // Spawned worlds must boot WITHOUT real game data, a peer binary or a server password --
    // a harness has none of those, and server.mjs refuses on all three.
    '--server-entry', join(ROOT, 'server', 'dist', 'testhost.mjs'),
  ], {
    // PIPED, not discarded: a gateway whose spawned worlds all crash comes up "healthy" and is
    // indistinguishable from a working one.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OMW_ALLOW_HARNESS_AUTH: '1' },
  });
  ctx.watchChild('gateway', gw);
  const stop = () => { try { gw.kill('SIGTERM'); } catch { /* already gone */ } };

  try {
    assert.ok(await waitHttp(`http://127.0.0.1:${gwPort}/healthz`, 30_000), 'the gateway must come up');

    // The player's OWN world -- the only kind there is now. Dialling a world still booting
    // gets the 502 a down world is supposed to give, so the helper waits for `up` below
    // before handing anyone a client. Named priv-* because that is the only prefix the
    // gateway will revive on dial.
    const account = `${name}-${ctx.runId}`;
    const token = await harnessSession(gwPort, account);
    const mk = await fetch(`http://127.0.0.1:${gwPort}/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: ownId, mode: 'private' }),
    });
    assert.equal(mk.status, 200, `the player's own world must be creatable (${mk.status})`);
    const ownBy = Date.now() + 60_000;
    let ownUp = false;
    while (Date.now() < ownBy) {
      try {
        if ((await (await fetch(`http://127.0.0.1:${gwPort}/worlds/${ownId}`)).json()).up) { ownUp = true; break; }
      } catch { /* still booting */ }
      await ctx.sleep(1000);
    }
    assert.ok(ownUp, 'the player own world must come up');

    // THROUGH the gateway, and declaring its home. worldUrlOf builds a switch destination from
    // the current connection's authority plus /w/<id>, so a client wired straight to a world
    // derives a path no world serves; and a switch reloads the page, so without #mphome the
    // client relearns "my own world" as wherever it just landed.
    const ownUrl = `ws://127.0.0.1:${gwPort}/w/${ownId}`;
    const client = await ctx.launchClient(name, '', { mpUrl: ownUrl, homeUrl: ownUrl });
    await grantLockerSession(client, gwPort, account);
    return { client, gwPort, ownId, account, stop };
  } catch (err) {
    stop();
    throw err;
  }
}
