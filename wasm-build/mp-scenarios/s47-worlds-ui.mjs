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
export const serverRules = `[gateway]\nurl = "http://127.0.0.1:${GW_PORT}"`;

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

    // The scenario's world must point at this gateway, or its Worlds tab correctly reports
    // "standalone" and there is nothing to test.
    const a = await ctx.launchClient('bot-a', '');

    // --- 1. The tab fetches the directory the first time it is opened ------------------
    await a.eval("Module.__omwMPCmd='socialtab:worlds'");
    await a.waitFor("(window.__omwMP||{}).worldCount !== undefined", STEP,
      'the client received a world list from the gateway');
    const count = Number(await a.eval("(window.__omwMP||{}).worldCount"));
    const err = String(await a.eval("(window.__omwMP||{}).worldsError"));
    assert.equal(err, '', `the directory must be reachable, got error "${err}"`);
    assert.ok(count >= 1, `the public world must be listed, saw ${count}`);
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
    const sessionPort = listed.worlds.find((w) => w.id === 'my-session').port;

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
    // The definitive check is on the DESTINATION world: it must report a player that was
    // not there before. Asserting only on client state would pass if the client merely
    // believed it had moved.
    const joinedBy = Date.now() + 60_000;
    let arrived = false;
    while (Date.now() < joinedBy) {
      try {
        const st = await (await fetch(`http://127.0.0.1:${sessionPort}/status`)).json();
        if ((st.playerCount ?? 0) > 0) { arrived = true; break; }
      } catch { /* still switching */ }
      await ctx.sleep(1000);
    }
    assert.ok(arrived, 'the player must actually arrive in the world they joined');
    ctx.log('  join: player moved to my-session and the destination world sees them');
    ctx.log(`  after join: ${await a.screenshot(join(SHOTS, '3-joined-session.png'))}`);

    ctx.log(`UI screenshots written to ${SHOTS} — review the Worlds tab for layout and legibility`);
  } finally {
    stopGw();
  }
}
