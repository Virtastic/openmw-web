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

const worldsOf = async (acct) => {
  try {
    const r = await fetch(`http://127.0.0.1:${GW_PORT}/worlds?account=${encodeURIComponent(acct)}`,
      { signal: AbortSignal.timeout(1500) });
    return (await r.json()).worlds ?? [];
  } catch {
    return [];
  }
};

// Asked of the GATEWAY, by world id. The directory strips a world's internal host and port
// from everything it serves -- there is a test asserting it must not leak them -- so this used
// to poll http://127.0.0.1:undefined/status and read the silence as 'nobody is there'.
// playerCount survives the sanitiser.
const playersIn = async (id) => {
  try {
    const w = await (await fetch(`http://127.0.0.1:${GW_PORT}/worlds/${id}`,
      { signal: AbortSignal.timeout(1500) })).json();
    return w.playerCount ?? 0;
  } catch {
    return -1;
  }
};


// The gateway mints these only when harness auth is on; a null here means the affordance is
// absent, and the scenario says so rather than failing later at 'no locker session'.
async function harnessSession(gwPort, account) {
  const r = await fetch(`http://127.0.0.1:${gwPort}/harness/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password: 'harness-pass-1' }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`the gateway would not mint a harness locker session (${r.status})`);
  return (await r.json()).token;
}

// Injected AFTER boot, never through the URL. #mplocker in the address flips index.html into
// locker/launcher mode -- a different asset path that never comes up in the harness and killed
// the client outright. These two globals are the whole of what rebootIntoWorld reads, and the
// base has to point at the GATEWAY: /auth/ticket lives there, while lockerHttpBase would
// otherwise derive it from the WORLD's socket URL and get a server that does not serve it.
async function grantLockerSession(client, gwPort, account) {
  const token = await harnessSession(gwPort, account);
  // Ends in a STRING on purpose. The last expression is what Runtime.evaluate serialises, and
  // an assignment whose value is a function comes back as an unserialisable remote object --
  // which rejects, and an unhandled rejection here takes the whole run down with no output at
  // all rather than failing this scenario.
  await client.eval(`window.__omwLockerToken = ${JSON.stringify(token)};`
    + `window.__lockerHttpBase = function(){ return 'http://127.0.0.1:${gwPort}'; };`
    + `'granted';`);
}

export default async function run(ctx) {
  const worldsDir = mkdtempSync(join(tmpdir(), 'omw-s57-worlds-'));
  const gw = spawn(process.execPath, [
    join(ROOT, 'server', 'dist', 'gateway.mjs'),
    '--worlds', worldsDir, '--port', String(GW_PORT),
    '--base-port', String(GW_PORT + 200), '--max-worlds', '4',
    '--idle-reap-ms', String(REAP_MS),
    // SHARE THE WORLD'S DATA DIR, as s47 and s54 already do. Two reasons, both real
    // deployment requirements rather than test details: accounts, friends and parties live
    // there, and a world that cannot see them refuses the very players it was created for --
    // and the shared config.toml is where [gateway] serverToken lives, which is how a world
    // process proves to the gateway that it may create a world for a player. Without it this
    // gateway read a config with no credential and refused every create with 401.
    '--shared', ctx.serverDataDir,
    '--server-entry', join(ROOT, 'server', 'dist', 'testhost.mjs'),
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OMW_ALLOW_HARNESS_AUTH: '1' },
  });
  ctx.watchChild('gateway', gw);
  const stopGw = () => { try { gw.kill('SIGTERM'); } catch { /* gone */ } };

  try {
    assert.ok(await waitHttp(`http://127.0.0.1:${GW_PORT}/healthz`, 30_000), 'gateway must come up');
    // A LOCKER SESSION, which ?mpauto=1 does not grant. The page needs one to change world at
    // all: rebootIntoWorld mints a fresh single-use ticket with it, and without one every
    // switch died at 'no locker session' before touching the network -- so this scenario was
    // asserting against a path it could not reach. The gateway only serves this when harness
    // auth is already enabled, which is exactly where this runs.
    // THE PRODUCTION FLOW, and every part of it is load-bearing (see s47 for the evidence).
    // The client dials THROUGH the gateway, because worldUrlOf derives a switch destination
    // from the current connection's authority plus /w/<id> -- a client wired straight to a
    // world derives a path no world serves. And it arrives in its OWN world, because a
    // brand-new account is refused by public with "finish creating your character in your
    // private world first". The launcher creates that world through the gateway with the
    // player's locker session; this does the same.
    const acctName = `bot-a-${ctx.runId}`;
    const soloToken = await harnessSession(GW_PORT, acctName);
    // THE SAME WORLD the scenario later reaps and dials back into. It has to be: `where:solo`
    // returns a player to their OWN world, so a separate one here would send them somewhere
    // that was never reaped and the revival round trip would never be exercised. POST /worlds
    // is create-or-join, so the in-game create below simply resolves to this one.
    const soloId = 'priv-revivetest';
    const mk = await fetch(`http://127.0.0.1:${GW_PORT}/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${soloToken}` },
      body: JSON.stringify({ id: soloId, mode: 'private' }),
    });
    assert.equal(mk.status, 200, `the player's own world must be creatable (${mk.status})`);
    const soloBy = Date.now() + 60_000;
    let soloUp = false;
    while (Date.now() < soloBy) {
      try {
        const w = await (await fetch(`http://127.0.0.1:${GW_PORT}/worlds/${soloId}`)).json();
        if (w.up) { soloUp = true; break; }
      } catch { /* still booting */ }
      await ctx.sleep(1000);
    }
    assert.ok(soloUp, "the player's own world must come up");
    const ownUrl = `ws://127.0.0.1:${GW_PORT}/w/${soloId}`;
    const a = await ctx.launchClient('bot-a', '', { mpUrl: ownUrl, homeUrl: ownUrl });
    await grantLockerSession(a, GW_PORT, `bot-a-${ctx.runId}`);
    const acct = a.name.toLowerCase();

    // --- own world, entered -------------------------------------------------------------
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await a.waitFor("(window.__omwMP||{}).worldCount !== undefined", STEP, 'world list arrives');
    // NAMED priv-*, because that is the only kind of world the gateway will REVIVE ON DIAL --
    // and revival is the whole subject of this scenario. A reaped world outside that prefix
    // stays down, so the old id could never have exercised the round trip it asserts. Real
    // private worlds are named this way (priv-<username>-<8hex>); the owner is read from disk
    // rather than parsed out of the id.
    await a.eval("Module.__omwMPCmd='worldcreate:priv-revivetest:private'");
    await a.waitFor("Number((window.__omwMP||{}).worldCount||0) > 1", STEP, 'session created');

    // `up`, not a port: the gateway publishes no world ports, so the old `ownPort = w.port`
    // captured undefined and then failed its own `> 0` check the instant the world came up.
    let ownUp = false;
    const upBy = Date.now() + 60_000;
    while (Date.now() < upBy) {
      const w = (await worldsOf(acct)).find((x) => x.id === 'priv-revivetest');
      if (w?.up) { ownUp = true; break; }
      await ctx.sleep(1000);
    }
    assert.ok(ownUp, 'the private world must come up');

    await a.eval("Module.__omwMPCmd='socialtab:players'");
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await ctx.sleep(1500);
    // RE-GRANT BEFORE EVERY SWITCH. A switch RELOADS the page, and the locker session is
    // injected into window rather than carried in the URL, so it does not survive. s47 and s48
    // switch once and never noticed; this scenario switches three times and the second one
    // silently had no session at all.
    await grantLockerSession(a, GW_PORT, `bot-a-${ctx.runId}`);
    await a.eval("Module.__omwMPCmd='worldjoin:priv-revivetest'");

    let joined = false;
    const joinBy = Date.now() + 60_000;
    while (Date.now() < joinBy) {
      if (await playersIn('priv-revivetest') > 0) { joined = true; break; }
      await ctx.sleep(1000);
    }
    assert.ok(joined, 'the player must first arrive in their own world');
    ctx.log('  in their own world');

    // --- leave for the public world, and let the empty one be reaped --------------------
    // RE-GRANT BEFORE EVERY SWITCH. A switch RELOADS the page, and the locker session is
    // injected into window rather than carried in the URL, so it does not survive. s47 and s48
    // switch once and never noticed; this scenario switches three times and the second one
    // silently had no session at all.
    await grantLockerSession(a, GW_PORT, `bot-a-${ctx.runId}`);
    // RELEARN THE WORLD LIST FIRST. The join above reloaded the page, and worldUrls -- which
    // is where the client keeps the public world's address -- died with the Lua state. Without
    // this, Public has no address to dial and does nothing at all. A player necessarily does
    // the same thing, because the Public button lives in the hub that fetches the list.
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await a.waitFor("(window.__omwMP||{}).worldCount !== undefined", STEP,
      'the world list is back after the reload');
    await a.eval("Module.__omwMPCmd='where:public'");
    // WHAT PUBLIC DECIDED. mpWhere either dials, says "you are already in the public world",
    // or says "the public world is not available right now" when it has no address -- three
    // outcomes that otherwise look identical from out here.
    await ctx.sleep(2500);
    ctx.log(`  where:public -> publicStage="${await a.eval("(window.__omwMP||{}).publicStage||''")}"`
      + ` chat="${await a.eval("(window.__omwMP||{}).lastChatLine||''")}"`
      + ` worldCount=${await a.eval("(window.__omwMP||{}).worldCount||'?'")}`);
    // WAIT FOR THE DESTINATION TO SEE THEM, not for the client to say 'Joined'. The client is
    // ALREADY Joined -- to the world it is leaving -- so that condition is true the moment it
    // is asked and the scenario walked straight on to expect a reap of a world the player had
    // not left yet.
    // 180s, not 60. A world switch RELOADS the page, so the whole engine boots again -- which
    // took 7s here on a warm cache and is several times that under SwiftShader on a busy box.
    // The first join in this scenario is given 600s for exactly this reason; expecting the
    // second to land in 60 was measuring the boot, not the switch.
    let inPublic = false;
    const pubBy = Date.now() + 180_000;
    while (Date.now() < pubBy) {
      if (await playersIn('vvardenfell') > 0) { inPublic = true; break; }
      await ctx.sleep(1000);
    }
    assert.ok(inPublic, 'the player must actually reach the public world before anything is idle');
    ctx.log('  switched to the public world');

    let reaped = false;
    const reapBy = Date.now() + REAP_MS + 30_000;
    while (Date.now() < reapBy) {
      const w = (await worldsOf(acct)).find((x) => x.id === 'priv-revivetest');
      if (!w || !w.up) { reaped = true; break; }
      await ctx.sleep(500);
    }
    assert.ok(reaped, `the idle private world must be reaped within ${REAP_MS}ms + slack`);
    ctx.log('  their own world was reaped while they were away');

    // --- and now the subject: go home ---------------------------------------------------
    // The resume token died with that process, and for an SSO user every remaining rung of the
    // ladder is the password path the server refuses. Getting back in at all proves the world
    // was revived under its owner AND that the ladder rescued itself with a fresh ticket.
    // RE-GRANT BEFORE EVERY SWITCH. A switch RELOADS the page, and the locker session is
    // injected into window rather than carried in the URL, so it does not survive. s47 and s48
    // switch once and never noticed; this scenario switches three times and the second one
    // silently had no session at all.
    await grantLockerSession(a, GW_PORT, `bot-a-${ctx.runId}`);
    await a.eval("Module.__omwMPCmd='where:solo'");

    let home = false;
    const homeBy = Date.now() + 90_000;
    while (Date.now() < homeBy) {
      const w = (await worldsOf(acct)).find((x) => x.id === 'priv-revivetest');
      if (w?.up) {
        if (await playersIn('priv-revivetest') > 0) { home = true; break; }
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
    ctx.log('  ok: their world was revived and they walked back in');
  } finally {
    stopGw();
  }
}
