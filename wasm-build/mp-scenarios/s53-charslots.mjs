// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s53 (character slots): a fresh account gets exactly one default character; creating a
// second slot works from in-world; switching to it is a reconnect that lands ON the new
// character (Welcome.characterId flips), and the two slots have separate state (the new
// one is fresh — no playerRecord).
import assert from 'node:assert/strict';
import { gatewayRules, grantLockerSession, startGatewayAndClient } from './_gateway.mjs';

const STEP = 30_000;
// Derived from the pid so two concurrent runs do not collide, and fixed at module scope
// because serverRules is evaluated before run().
const GW_PORT = 58800 + (process.pid % 120);

// A CHARACTER SWITCH IS A WORLD SWITCH. It reloads the page and re-dials, which needs a
// locker session to mint a fresh ticket -- and this scenario used to spawn no gateway at all,
// so there was no front door to get one from and the switch died at 'no locker session'
// before touching the network. It asserted against a path it could not reach.
export const serverRules = gatewayRules(GW_PORT);

export default async function run(ctx) {
  const gw = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'slots-a' });
  const a = gw.client;
  try {

    // A fresh account: exactly one slot, active, with a NEUTRAL placeholder name.
    await a.waitFor("(window.omw.state.characterId||'') !== ''", STEP, 'Welcome carried a characterId');
    const firstId = String(await a.eval("window.omw.state.characterId"));
    assert.match(firstId, /^c[0-9a-f]{24}$/, `default character id looks wrong: ${firstId}`);
    assert.equal(String(await a.eval("window.omw.state.characterCount")), '1');
    const chars = JSON.parse(String(await a.eval("window.omw.state.characters||'[]'")));
    // NOT the account name. An SSO account name is the person's real name, and a character
    // name is public — it labels the tile and rides every PlayerAppearance to other players.
    // The auto-created slot gets a placeholder and takes its real name from chargen.
    assert.notEqual(chars[0].name.toLowerCase(), a.name.toLowerCase(),
      'the default slot must NOT be named after the account (that leaks the real name)');
    assert.equal(chars[0].name, 'Adventurer', `unexpected placeholder name: ${chars[0].name}`);
    ctx.log(`  ok: one default character ${firstId}`);

    // Create a second slot from in-world (the Characters tab's create path).
    await a.eval("window.omw.send('charcreate:Drelas Arano')");
    await a.waitFor("window.omw.state.characterCount === '2'", STEP, 'second slot appears');
    const after = JSON.parse(String(await a.eval("window.omw.state.characters")));
    const alt = after.find((c) => c.name === 'Drelas Arano');
    assert.ok(alt, `created slot missing from list: ${JSON.stringify(after)}`);
    assert.notEqual(alt.id, firstId);
    ctx.log(`  ok: created second slot ${alt.id}`);

    // Switch: a reconnect that must come back AS the new character.
    // A switch RELOADS the page, and the locker session is injected into window rather
    // than carried in the URL, so it does not survive one. Re-grant before each.
    await grantLockerSession(a, GW_PORT, gw.account);
    await a.eval(`window.omw.send('charswitch:${alt.id}')`);
    // REPORT THE HANDOFF, because a bare wait on characterId cannot tell 'the command never
    // reached Lua' from 'Lua published a destination and the page ignored it' from 'the reload
    // happened and came back as the wrong character'. Each is a different bug and they were all
    // presenting as the same 30-second timeout. publicStage is set by net.switchTo BEFORE its
    // own empty-url check, so it distinguishes 'not called' from 'called with nothing'.
    await ctx.sleep(1500);
    const stage = String(await a.eval("window.omw.state.publicStage||''"));
    const swTo = String(await a.eval("window.omw.state.switchTo||''"));
    const swChar = String(await a.eval("window.omw.state.switchChar||''"));
    ctx.log(`  after charswitch: publicStage="${stage}" switchTo="${swTo}" switchChar="${swChar}"`);
    await a.waitFor(`(window.omw.state.characterId||'') === '${alt.id}'`, STEP,
      `reconnect lands on the selected character (publicStage="${stage}" switchChar="${swChar}")`);
    await a.waitFor("window.omw.state.state === 'Joined'", STEP, 'and reaches Joined');
    ctx.log('  ok: switched — the session now plays the new slot');

    // And back: the original slot must still be selectable (nothing was lost).
    // A switch RELOADS the page, and the locker session is injected into window rather
    // than carried in the URL, so it does not survive one. Re-grant before each.
    await grantLockerSession(a, GW_PORT, gw.account);
    await a.eval(`window.omw.send('charswitch:${firstId}')`);
    await a.waitFor(`(window.omw.state.characterId||'') === '${firstId}'`, STEP,
      'switching back to the first character works');
    ctx.log('  ok: round trip between slots');
  } finally {
    gw.stop();
  }
}
