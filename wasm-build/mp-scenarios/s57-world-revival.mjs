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
import { gatewayRules, grantLockerSession, startGatewayAndClient } from './_gateway.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STEP = 30_000;
const GW_PORT = 58900 + (process.pid % 120);
// The world this scenario reaps and dials back into. priv-* because that is the only prefix
// the gateway will revive on dial, and revival is the whole subject here.
const OWN_ID = 'priv-revivetest';
// 45s, not 4s. A world is idle until someone is JOINED, and a client takes several seconds to
// boot -- longer under SwiftShader, which is what CI has. At 4s the world was reaped one second
// BEFORE the player finished arriving in it: the client logged HelloSent and then
// 'server disconnect: SHUTDOWN', and everything after that was a reconnect to a world that no
// longer existed. The scenario was racing its own fixture, not testing a reap.
//
// Still far below the two-minute default, so the reap is still driven rather than waited out.
const REAP_MS = 45000;

// serverToken is the credential a WORLD PROCESS presents to the gateway so it may create
// a world for a player. The gateway takes the account from the caller's identity and never
// from the body, and a world has no locker session to present -- so without this every
// in-game create is refused with 401, which is exactly what was happening. This one file is
// both the world's config and the gateway's --shared config, mirroring production.
export const serverRules = gatewayRules(GW_PORT);


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




export default async function run(ctx) {
  // The whole gateway dance lives in _gateway.mjs now: wait for the PUBLIC world before
  // dialling anything, reach a world THROUGH the gateway, arrive in your OWN world, and
  // declare #mphome so a reload does not make the client treat wherever it landed as home.
  // s57 had hand-rolled three of those four and was missing the first, which is why the
  // public world was dialled while it might still be booting.
  //
  // ownId is the world this scenario later reaps and dials back into. It HAS to be the
  // player own world: `where:solo` returns them there, so a separate one would send them
  // somewhere that was never reaped and the revival round trip would never be exercised.
  const gw = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, idleReapMs: REAP_MS, ownId: OWN_ID,
  });
  const a = gw.client;
  const stopGw = gw.stop;
  const acct = a.name.toLowerCase();
  try {
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
    // PRESSED MORE THAN ONCE, ON PURPOSE. `where:public` asks the server for a world list and
    // switches when the answer names an up public world -- publicStage goes `asked` ->
    // `list:<n>` -> `resolved:<url>`. Under load the run has been seen to stop at `asked`: the
    // request goes out and the answer does not come back, so nothing switches and the player
    // just stays put. A real player presses the button again, and so does this.
    //
    // Worth being clear that this is a PRODUCT observation, not only a test one: a Public
    // press that is silently lost looks to the player exactly like a button that does nothing.
    let inPublic = false;
    let lastStage = '(never set)';
    for (let attempt = 1; attempt <= 3 && !inPublic; attempt++) {
      await a.eval("Module.__omwMPCmd='socialtab:worlds'");
      await a.eval("Module.__omwMPCmd='where:public'");
      const by = Date.now() + 90_000;
      while (Date.now() < by) {
        if (await playersIn('vvardenfell') > 0) { inPublic = true; break; }
        const v = String(await a.eval("(window.__omwMP||{}).publicStage||''").catch(() => ''));
        if (v) lastStage = v;
        await ctx.sleep(1000);
      }
      if (!inPublic) ctx.log(`  Public press ${attempt} did not land (publicStage="${lastStage}")`);
    }
    ctx.log(`  reached public: ${inPublic} (publicStage="${lastStage}")`);
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
