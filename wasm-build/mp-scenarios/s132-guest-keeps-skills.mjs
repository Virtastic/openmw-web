// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s132: WHAT YOU LEARN ON THE VISIT COMES HOME. Morrowind progression is use-based; a guest
// who swung a sword all evening in a friend's world must find Long Blade higher on THEIR
// character at home (MP-COVERAGE-MAP: skills, attributes, level and inventory write to the
// GUEST's charId; only the quest half is the host's). Without this, helping is charity.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const STEP = 30_000;
const GW_PORT = 19020; // ten apart from its neighbours (see s102)
export const bootTimeoutMs = 420_000;
const SKILL = 'longblade';
async function skillOf(c) {
  await c.eval("if (window.omw.state) window.omw.state.skillOf = null; 'cleared';");
  await c.cmd(`skillof:${SKILL}`);
  await c.waitFor("typeof window.omw.state.skillOf === 'string'", 10_000, 'skill reported');
  return Number(await c.eval('window.omw.state.skillOf'));
}

// The shared players.db, read directly: this is the row every world process writes, and the
// failure this scenario caught was exactly a stale write-back to it (a world that never let
// go of the guest's doc when they left flushed its pre-visit copy over the host world's).
function docSkill(ctx) {
  try {
    const db = new DatabaseSync(join(ctx.serverDataDir, 'players.db'), { readOnly: true });
    const rows = db.prepare('SELECT key, doc FROM players').all();
    db.close();
    return rows.map((r) => { const d = JSON.parse(r.doc); return `${r.key.slice(0, 6)}: class=${d.appearance?.class} lb=${d.stats?.skills?.longblade} level=${d.stats?.level}`; }).join(' ; ');
  } catch (e) { return 'db: ' + e.message; }
}

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'skill-host', ownId: 'priv-skill-host' });
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'skill-guest', ownId: 'priv-skill-guest' });
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const hostHandle = `khost${tag}`, guestHandle = `kguest${tag}`;
    await host.client.cmd(`profile:skill-host@example.com:${hostHandle}`);
    await guest.client.cmd(`profile:skill-guest@example.com:${guestHandle}`);
    for (const [who, cli] of [['host', host.client], ['guest', guest.client]]) {
      await cli.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await cli.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    // No "home before" read: in a private ?nomw world the bot's character is an unclassed
    // template until the party world's chargen gate classes it on arrival (measured: 5 at
    // home, 35 on arrival). The claim under test is the DELTA the visit adds, so the baseline
    // is what the guest arrives with.
    await host.client.cmd(`social:FriendRequest:${guestHandle}`);
    await guest.client.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await guest.client.cmd(`social:FriendAccept:${hostHandle}`);
    await host.client.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    await host.client.cmd('worldmode:party');
    await host.client.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    const guestFriends = JSON.parse(await guest.client.eval("window.omw.state.friends||'[]'"));
    await guest.client.cmd(`joinfriend:${guestFriends[0].acct}`);
    const guestRow = `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(guestHandle)}; }) || {})`;
    await host.client.waitFor(`${guestRow}.id !== undefined`, 120_000, "the guest is inside the host world");
    await guest.client.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(guest.client, GW_PORT, guest.account);
    await guest.client.waitFor('String(window.omw.state.baselineReady||"") === "1"', 60_000, 'the guest character is settled in the host world');
    let visiting = 5;
    for (const by = Date.now() + 60_000; Date.now() < by && visiting <= 5;) { visiting = await skillOf(guest.client); if (visiting <= 5) await ctx.sleep(1_000); }
    assert.ok(visiting > 5, `the guest character never got a class in the host world (${SKILL} stayed at the template 5)`);
    ctx.log(`guest ${SKILL} on arrival: ${visiting} | docs: ${docSkill(ctx)}`);

    // The evening's training: the skill rises by 5 in the host world -- one window's budget
    // (#369: +5 per 10 s per key), so this passes under the production rule, not just the
    // harness seam.
    const want = visiting + 5;
    await guest.client.cmd(`setskill:${SKILL}:${want}`);
    await ctx.sleep(4_000); // the 1 s progression diff writes it to the GUEST character
    assert.equal(await skillOf(guest.client), want, 'the skill rose in the host world');
    ctx.log(`ok: ${SKILL} ${visiting} -> ${want} while visiting | docs: ${docSkill(ctx)}`);

    // Home again, and it stuck.
    await host.client.cmd('worldmode:private');
    await guest.client.waitFor(`(window.omw.state.worldClosed||'') !== '' || String(window.omw.state.state||'') !== 'Joined'`, STEP, 'the guest is sent home');
    await guest.client.waitFor('window.omw.state.state === "Joined" && String(window.omw.state.worldClosed||"") === ""', 300_000, 'the guest is back in their own world');
    await guest.client.waitFor('String(window.omw.state.baselineReady||"") === "1"', 60_000, 'the guest character is restored at home');
    await ctx.sleep(2_000);
    ctx.log(`docs at home: ${docSkill(ctx)}`);
    const home = await skillOf(guest.client);
    ctx.log(`guest ${SKILL} at home after the visit: ${home}`);
    assert.equal(home, want, 'the skill learned on the visit did not come home: progression was written to the wrong character, or the restore dropped it');
    ctx.log('PASS: what a guest learns in a friend world is theirs at home');
  } finally {
    host.stop();
  }
}
