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
  // MEASURE THE BOX, THEN BUDGET AGAINST IT. Every wait in this scenario is really "how long
  // does an engine take to boot here", because a world switch reloads the page and boots it
  // again -- and this is the only scenario that does that THREE times. Fixed numbers were
  // wrong in both directions: 240s passed on a quiet box and failed at 291s on a busy one,
  // then 420s failed at 475s. There is no constant that is both generous enough for the
  // slowest machine and honest on the fastest.
  //
  // The first boot is the measurement: launchClient does not return until the client is
  // Joined, so the wall time of this call IS a boot-and-join on this machine right now.
  const bootStart = Date.now();
  const gw = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, idleReapMs: REAP_MS, ownId: OWN_ID,
  });
  const a = gw.client;
  // A generous multiple, not a tight one: a reboot competes with whatever made the first boot
  // slow, and the floor keeps a suspiciously fast first boot from setting an unusable budget.
  const bootMs = Date.now() - bootStart;
  const ARRIVE_MS = Math.max(180_000, bootMs * 8);
  ctx.log(`  first boot took ${(bootMs / 1000).toFixed(1)}s; allowing `
    + `${(ARRIVE_MS / 1000).toFixed(0)}s per arrival after a switch`);
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
    // priv-revivetest is the world the client is ALREADY IN -- startGatewayAndClient created
    // it as bot-a's own world and booted straight into it (ownId === OWN_ID). It has to be,
    // because a scenario about REVIVING this exact world cannot reap one the player is not the
    // owner of. So the create below is idempotent (the gateway returns ok for the world that
    // exists), and the list correctly holds ONE world, not two -- asserting >1 could never
    // pass. What matters is that the world is THERE and named as expected.
    await a.eval("Module.__omwMPCmd='worldcreate:priv-revivetest:private'");
    await a.waitFor('((window.__omwMP||{}).worldCreate||"") !== ""', STEP,
      'the server answered the create request at all');
    const createdAns = JSON.parse(await a.eval('(window.__omwMP||{}).worldCreate'));
    ctx.log(`  create answered: ok=${createdAns.ok} error="${createdAns.error ?? ''}"`);
    assert.equal(createdAns.ok, true,
      `creating the session was refused: ${createdAns.error || 'no reason given'}`);
    await a.waitFor(
      `JSON.parse((window.__omwMP||{}).worlds||"[]").some(w => w.id === 'priv-revivetest')`,
      STEP, 'the private world is listed');

    // `up`, not a port: the gateway publishes no world ports, so the old `ownPort = w.port`
    // captured undefined and then failed its own `> 0` check the instant the world came up.
    let ownUp = false;
    const upBy = Date.now() + ARRIVE_MS;
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
    const joinBy = Date.now() + ARRIVE_MS;
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
    // PRESS AGAIN ONLY WHILE NOTHING IS IN FLIGHT. `where:public` asks the server for a world
    // list and switches when the answer names an up public world:
    //     asked -> list:<n> -> resolved:<url> -> switchTo:<url>
    // Under load the first press has been seen to stop at `asked` -- the request goes out and
    // the answer does not come back -- so a second press is worth making, exactly as a player
    // would. But once publicStage shows `switchTo:` the switch IS happening, and pressing
    // again RELOADS THE PAGE and restarts the engine boot that was already running. A blind
    // retry loop therefore prevented the very arrival it was waiting for: three presses, three
    // reloads, never landing. Re-press only from `asked`; after that, wait it out.
    let inPublic = false;
    let lastStage = '(never set)';
    // BUDGETED LIKE A JOIN, because that is what it is. Arriving after a switch means the page
    // reloads and the WHOLE ENGINE boots again -- the harness gives a first join 600s for
    // exactly that reason, and this scenario does it three times. 240s passed in isolation and
    // failed in a full run at 291s, which was measuring the box rather than the product.
    const publicBy = Date.now() + ARRIVE_MS;
    let pressed = 0;
    let lastPress = 0;
    while (Date.now() < publicBy && !inPublic) {
      const inFlight = lastStage.startsWith('switchTo:') || lastStage.startsWith('resolved:');
      if (!inFlight && Date.now() - lastPress > 30_000 && pressed < 3) {
        pressed++;
        lastPress = Date.now();
        ctx.log(`  pressing Public (attempt ${pressed}, publicStage="${lastStage}")`);
        // RE-GRANTED IMMEDIATELY BEFORE THE PRESS, not once before the loop. The token is
        // injected into `window` rather than carried in the URL, so it dies with any reload --
        // and granting it before the loop meant that by the time a press actually happened the
        // page underneath could already be a new one. Proven, not guessed: at failure the page
        // reported switchTo cleared (so rebootIntoWorld DID run) and hasLockerToken=false (so
        // it threw on the very first thing it checks).
        await grantLockerSession(a, GW_PORT, gw.account);
        await a.eval("Module.__omwMPCmd='socialtab:worlds'");
        await a.eval("Module.__omwMPCmd='where:public'");
      }
      if (await playersIn('vvardenfell') > 0) { inPublic = true; break; }
      const v = String(await a.eval("(window.__omwMP||{}).publicStage||''").catch(() => ''));
      if (v) lastStage = v;
      await ctx.sleep(1000);
    }
    ctx.log(`  reached public: ${inPublic} (publicStage="${lastStage}")`);
    if (!inPublic) {
      // THE CLIENT'S OWN ACCOUNT, restored after a refactor dropped it. Everything visible
      // from out here says the same unhelpful thing -- the switch was issued and nobody
      // arrived -- so the page's own state is the only place left to look. An empty log with
      // empty mirrors means it navigated somewhere blank; a full log means it booted and could
      // not connect. Those are different bugs.
      // THE TWO THINGS THAT DECIDE THIS. `switchTo` still set means the page never consumed
      // the destination Lua published; cleared means it TRIED and rebootIntoWorld threw. And a
      // missing locker token is the most likely reason it would throw, because a switch
      // reloads the page and the token is injected into window rather than carried in the URL.
      const sw = await a.eval("String((window.__omwMP||{}).switchTo||'(cleared)')").catch(() => '?');
      const tok = await a.eval("String(!!window.__omwLockerToken)").catch(() => '?');
      const base = await a.eval("String(typeof window.__lockerHttpBase)").catch(() => '?');
      ctx.log(`  switchTo="${sw}" hasLockerToken=${tok} lockerHttpBase=${base}`);
      ctx.log(`  jsErrors: ${JSON.stringify(a.jsErrors?.() ?? [])}`);
      ctx.log(`  luaErrors: ${JSON.stringify(a.luaErrors?.() ?? [])}`);
      const where = await a.eval('String(location.href)').catch((e) => `eval failed: ${e}`);
      const frag = await a.eval('String(window.__omwBootFrag||"(none)")').catch(() => '?');
      ctx.log(`  page url: ${where}`);
      ctx.log(`  boot fragment: ${frag}`);
      ctx.log(`  client log tail:
${a.logTail?.(40) ?? '(none)'}`);
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
