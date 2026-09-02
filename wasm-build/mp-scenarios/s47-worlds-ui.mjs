// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s47 (F3): the WORLDS tab in the Social hub, driven against a REAL gateway.
//
// This is the scenario that decides whether a player can actually reach multi-world, as
// opposed to the platform merely working. It asserts the mechanism (the client received a
// world list, and creating a session produced a joinable world) AND screenshots the tab,
// because a Lua UI that throws still leaves every state mirror correct — this project has
// already shipped two windows that never rendered while their state assertions passed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STEP = 30_000;

// Fixed at module scope because `serverRules` is a static export evaluated before run(): the
// world's [gateway] url has to be written into its config before the server boots, so the
// port cannot be discovered later. Derived from the pid so two concurrent runs do not collide.
const GW_PORT = 58400 + (process.pid % 120);

// Point this scenario's world at the gateway below. Without it the Worlds tab correctly
// reports "standalone" and there is nothing to exercise.
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
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}


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
  const SHOTS = mkdtempSync(join(tmpdir(), 'omw-s47-'));
  const worldsDir = mkdtempSync(join(tmpdir(), 'omw-s47-worlds-'));
  const gwPort = GW_PORT;
  const basePort = gwPort + 200;

  // A real gateway supervising real world processes. The scenario's own server (ctx) is a
  // separate world; this one is what the browser client will BROWSE.
  const gw = spawn(process.execPath, [
    join(ROOT, 'server', 'dist', 'gateway.mjs'),
    '--worlds', worldsDir,
    '--port', String(gwPort),
    // Worlds this gateway spawns MUST share the launch world's data dir: accounts, friends
    // and parties live there, and a world that cannot see them refuses the very players it
    // was created for (world access control). A real deployment requirement, not a test
    // detail — the gateway's own default sharedDir is a sibling of the worlds dir.
    '--shared', ctx.serverDataDir,
    '--base-port', String(basePort),
    '--max-worlds', '4',
    // No public world: the flag died with the mode (Solo/Party model). Every world here is
    // created through the directory by an authed account, exactly like production.
    // Worlds this gateway spawns must boot WITHOUT real game data, a peer binary or a
    // server password — a harness has none of those. server.mjs refuses on all three, so
    // every spawned world died and the scenario saw only an empty world list.
    '--server-entry', join(ROOT, 'server', 'dist', 'testhost.mjs'),
  ], {
    // PIPED, not discarded: a gateway whose spawned worlds all crash comes up "healthy" and
    // is indistinguishable from a working one. ctx.watchChild prints this on any failure.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OMW_ALLOW_HARNESS_AUTH: '1' },
  });
  ctx.watchChild('gateway', gw);
  const stopGw = () => { try { gw.kill('SIGTERM'); } catch { /* already gone */ } };

  try {
    assert.ok(await waitHttp(`http://127.0.0.1:${gwPort}/healthz`, 30_000), 'the gateway must come up');
    ctx.log(`gateway up on ${gwPort}`);

    // THE SPLICE (/w/<id>) is tested below against the world this scenario CREATES --
    // there is no world at boot any more, which is itself the correct post-Phase-W state.

    // The scenario's world must point at this gateway, or its Worlds tab correctly reports
    // "standalone" and there is nothing to test.
    // A LOCKER SESSION, which ?mpauto=1 does not grant. The page needs one to change world at
    // all: rebootIntoWorld mints a fresh single-use ticket with it, and without one every
    // switch died at 'no locker session' before touching the network -- so this scenario was
    // asserting against a path it could not reach. The gateway only serves this when harness
    // auth is already enabled, which is exactly where this runs.
    // THROUGH THE GATEWAY, which is what a real player does and the only way this scenario can
    // test a switch at all. worldUrlOf builds a switch destination from the CURRENT
    // connection's authority plus the world's /w/<id> path, so a client dialled straight at a
    // world derives ws://<that world>/w/<other world> -- a path no world serves, because the
    // GATEWAY is what splices it through (Caddy fronts it the same way in production).
    //
    // This must come AFTER the public world is up. An earlier attempt dialled the gateway
    // while that world was still booting, got the 502 a down world is supposed to answer with,
    // and never recovered -- which read as "the gateway upgrade path is broken" and was really
    // just a race. The splice assertion above proves the path itself works.
    // ...into the player's OWN world, not the public one. A brand-new account is refused by
    // public with "finish creating your character in your private world first" -- a real
    // product rule, not a harness quirk -- so booting straight into public could never work.
    // This is the production flow: the launcher creates your solo world through the gateway
    // with your locker session, and you arrive there.
    const acctName = `bot-a-${ctx.runId}`;
    const soloToken = await harnessSession(gwPort, acctName);
    const soloId = 'solo-bot-a';
    const mk = await fetch(`http://127.0.0.1:${gwPort}/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${soloToken}` },
      body: JSON.stringify({ id: soloId, mode: 'private' }),
    });
    assert.equal(mk.status, 200, `the player's own world must be creatable (${mk.status})`);
    const soloUpBy = Date.now() + 60_000;
    let soloUp = false;
    while (Date.now() < soloUpBy) {
      try {
        const w = await (await fetch(`http://127.0.0.1:${gwPort}/worlds/${soloId}`)).json();
        if (w.up) { soloUp = true; break; }
      } catch { /* still booting */ }
      await ctx.sleep(1000);
    }
    assert.ok(soloUp, "the player's own world must come up");
    ctx.log(`  own world ${soloId} is up`);

    // THE SPLICE ITSELF, tested without a browser. /w/<id> on the gateway is how a real
    // client reaches a world -- Caddy fronts it in production -- and it is what every world
    // SWITCH resolves to, so if it does not work nothing downstream can.
    const spliced = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/w/${soloId}`);
      const done = (v) => { try { ws.close(); } catch { /* already gone */ } resolve(v); };
      ws.addEventListener('open', () => done('open'), { once: true });
      ws.addEventListener('error', () => done('error'), { once: true });
      ws.addEventListener('close', (e) => done(`closed ${e.code}`), { once: true });
      setTimeout(() => done('timeout'), 10_000);
    });
    ctx.log(`  gateway splice /w/${soloId}: ${spliced}`);
    assert.equal(spliced, 'open',
      `the gateway must splice /w/<id> through to a world, got "${spliced}"`);

    const a = await ctx.launchClient('bot-a', '', {
      mpUrl: `ws://127.0.0.1:${gwPort}/w/${soloId}`,
    });
    await grantLockerSession(a, GW_PORT, `bot-a-${ctx.runId}`);

    // --- 1. The tab fetches the directory the first time it is opened ------------------
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await a.waitFor("(window.__omwMP||{}).worldCount !== undefined", STEP,
      'the client received a world list from the gateway');
    const count = Number(await a.eval("(window.__omwMP||{}).worldCount"));
    const err = String(await a.eval("(window.__omwMP||{}).worldsError"));
    assert.equal(err, '', `the directory must be reachable, got error "${err}"`);
    assert.ok(count >= 1, `the player's own world must be listed, saw ${count}`);
    ctx.log(`  worlds listed: ${count}`);
    ctx.log(`  worlds tab: ${await a.screenshot(join(SHOTS, '1-worlds-list.png'))}`);

    // --- 2. Creating a session from the UI produces a real, joinable world -------------
    const before = count;
    // The harness cannot type into the name field, so the create is driven by a test hook
    // that goes through the same uplink a button press would.
    await a.eval("Module.__omwMPCmd='worldcreate:my-session:private'");
    // Read the SERVER'S ANSWER before waiting on the list. social.lua mirrors it to
    // `worldCreate`, and waiting only on worldCount turned every refusal -- platform_full,
    // too_many_sessions, unreachable -- into the same blind 30s timeout that says nothing
    // about which one happened.
    await a.waitFor('((window.__omwMP||{}).worldCreate||"") !== ""', STEP,
      'the server answered the create request at all');
    const created = JSON.parse(await a.eval('(window.__omwMP||{}).worldCreate'));
    ctx.log(`  create answered: ok=${created.ok} error="${created.error ?? ''}"`);
    assert.equal(created.ok, true, `creating a session was refused: ${created.error || 'no reason given'}`);
    await a.waitFor(`Number((window.__omwMP||{}).worldCount||0) > ${before}`, STEP,
      'the new session appears in the list');
    ctx.log(`  after create: ${await a.eval("(window.__omwMP||{}).worldCount")} worlds`);
    ctx.log(`  worlds tab (session created): ${await a.screenshot(join(SHOTS, '2-worlds-created.png'))}`);

    // The gateway must agree — the UI must not be showing a world that does not exist.
    // The account is the CLIENT's generated name (the harness suffixes it to keep runs
    // isolated), lowercased the way the server keys accounts.
    const acct = a.name.toLowerCase();
    const listed = await (await fetch(`http://127.0.0.1:${gwPort}/worlds?account=${encodeURIComponent(acct)}`)).json();
    assert.ok(listed.worlds.some((w) => w.id === 'my-session'),
      'the session the player created must exist on the gateway, not just in the UI');

    // --- 3. JOIN actually moves the player to the other world -------------------------
    // The part a player would notice most if it were broken. Pressing join goes through
    // joinWorld() -> MP_JoinWorld -> net.switchTo(): a disconnect and a redial of a
    // DIFFERENT world, with no page reload, so the engine and loaded assets stay put.
    // NO PORT. The directory strips a world's internal host and port from everything it
    // serves -- there is a test asserting it must not leak them, because an address there was
    // once a configured guess defaulting to 127.0.0.1, i.e. a remote player's own machine.
    // This used to read `.port` (undefined), poll http://127.0.0.1:undefined/status, and
    // report the resulting silence as 'the player never arrived'. playerCount survives the
    // sanitiser, so the gateway's own view is both correct and the only thing available.

    // A freshly spawned world takes time to answer /status; the UI only offers a join once
    // it is up, so the test must wait for the same condition rather than racing it.
    const upBy = Date.now() + 60_000;
    let up = false;
    while (Date.now() < upBy) {
      const l = await (await fetch(`http://127.0.0.1:${gwPort}/worlds?account=${encodeURIComponent(acct)}`)).json();
      if (l.worlds.find((w) => w.id === 'my-session')?.up) { up = true; break; }
      await ctx.sleep(1000);
    }
    assert.ok(up, 'the created session must come up, or there is nothing to join');
    // Refresh the client's list so it sees the world as joinable.
    await a.eval("Module.__omwMPCmd='socialtab:players'");
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await ctx.sleep(1500);

    await a.eval("Module.__omwMPCmd='worldjoin:my-session'");
    // WHAT THE CLIENT DECIDED. The join is a chain -- MP_SocialJoinById -> joinWorld ->
    // mpJoinWorld -> net.switchTo -> the page's rebootIntoWorld -- and every link can fail
    // quietly. These four mirrors say which link stopped: joinError means the world was never
    // in the client's list, publicStage means switchTo was reached and with what address,
    // switchTo empty AFTER that means the page took it and gave up, and dialTarget says where
    // a reconnect would now go.
    await ctx.sleep(2000);
    for (const k of ['joinError', 'publicStage', 'switchTo', 'dialTarget']) {
      ctx.log(`  ${k}: "${String(await a.eval(`(window.__omwMP||{}).${k}||''`))}"`);
    }
    // The definitive check is on the DESTINATION world: it must report a player that was
    // not there before. Asserting only on client state would pass if the client merely
    // believed it had moved.
    const joinedBy = Date.now() + 60_000;
    let arrived = false;
    let lastSeen = 'the gateway was never reached';
    while (Date.now() < joinedBy) {
      try {
        const w = await (await fetch(`http://127.0.0.1:${gwPort}/worlds/my-session`)).json();
        lastSeen = `playerCount=${w.playerCount ?? 0} up=${w.up}`;
        if ((w.playerCount ?? 0) > 0) { arrived = true; break; }
      } catch (err) { lastSeen = `gateway error: ${err}`; }
      await ctx.sleep(1000);
    }
    ctx.log(`  destination world: ${lastSeen}`);
    assert.ok(arrived, `the player must actually arrive in the world they joined — ${lastSeen}`);
    ctx.log('  join: player moved to my-session and the destination world sees them');
    ctx.log(`  after join: ${await a.screenshot(join(SHOTS, '3-joined-session.png'))}`);

    ctx.log(`UI screenshots written to ${SHOTS} — review the Worlds tab for layout and legibility`);
  } finally {
    stopGw();
  }
}
