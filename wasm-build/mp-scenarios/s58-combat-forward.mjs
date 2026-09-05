// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s58 (M5): AN ATTACK ON A CELL NPC REACHES THE CELL'S OWNER.
//
// WHY THIS EXISTS. Reported from a live server as "hits are not registering, or even showing
// misses". The cause was a contract mismatch: `combat.lua` refused to forward an attack unless
// it already knew the target cell's authority epoch, while `server/src/core/combat.ts` had long
// since stopped requiring one — it validates the epoch only `if (target.epoch !== undefined)`
// and proves presence by proximity instead, precisely because "the attacker is usually a
// NON-holder". The attacker normally IS a non-holder, so this fired in ordinary play.
//
// And it does not lose a message, it loses the SWING: `puppet.lua`'s onHit interceptor has
// already returned false and cancelled the entire local damage chain before the forward is
// even considered. No damage, no miss, no sound. The player swings and the game says nothing.
//
// WHAT THIS DOES AND DOES NOT COVER — checked, not assumed. It covers the JOURNEY: a real
// engine swinging a real weapon-event at a real puppet, through a real server, to the cell's
// real owner. It does NOT isolate the epoch branch, and it was written believing it did:
// reverting the client fix and re-running it still PASSES, because `actors.lua` learns the
// epoch in the same `MP_ActorAuthorityInfo` handler that attaches the puppets, so by the time
// anything is hittable the epoch is already known. The epoch-absent branch needs a puppet whose
// cell the client has no epoch for — an actor that has wandered across a boundary — which no
// deterministic scenario here reproduces. The unit tests in wasm-build/lua-tests cover the
// decision itself and DO fail when the fix is reverted.
//
// Keep the negative control in mind before trusting this scenario to police that fix: it will
// not. It polices the route.
//
// It needs an authority HOLDER, and since `canSimulate` became `p.system === true` only a sim
// peer can be one. No browser scenario could stand one up, which is why s40/s41/s42/s51 all
// fail with `exactly one holder: 0 !== 1` — they were written for client-held authority and
// were quietly retired by that change. This one stands up a peer of its own
// (`server/dist/testpeer.mjs`) rather than asserting a client holds anything.
//
// The peer HOLDS but does not SIMULATE: it answers the protocol, it does not run OpenMW. That
// is exactly enough to assert routing and nothing more, which is all this scenario claims.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const bootTimeoutMs = 420_000;

// [content] enforce = "off" is REQUIRED to put a protocol peer alongside a retail browser
// client. ContentGate adopts the FIRST client's manifest as the session's canonical one
// (core/manifest.ts); the browser joins first carrying the full retail list, so the peer —
// which runs no game data at all — is refused BAD_CONTENT and its socket closes mid-handshake.
// Observed exactly that before this line existed: "your game is missing builtin.omwscripts,
// tribunal.esm, bloodmoon.esm". Content policy is not what this scenario measures.
export const serverRules = `
[content]
enforce = "off"
`;

const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const PUPPET_TIMEOUT = 90_000;

// The client mirror has no cellKey of its own, but actorCensus tags every active actor with
// one ("player@-2,-9"), and the local player is always in its own cell. (Same trick as s42.)
async function cellKeyOf(c) {
  const census = JSON.parse(await c.eval('window.omw.state.actorCensus||"[]"'));
  const me = census.find((e) => e.startsWith('player@'));
  if (!me) throw new Error(`actorCensus has no player entry: ${JSON.stringify(census)}`);
  return me.slice('player@'.length);
}

export default async function run(ctx) {
  // RETAIL DATA REQUIRED: the Example Suite ships no NPCs at all, so there is nothing to hit.
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required for cell NPCs)');
    return;
  }
  const { holdCell } = await import(
    pathToFileURL(join(ROOT, 'server', 'dist', 'testpeer.mjs')).href);

  const c = await ctx.launchClient('swinger', '', BOOT);
  const cellKey = await cellKeyOf(c);
  ctx.log(`client is in ${cellKey}`);

  // Give the cell an owner. The client is already standing in it, so the server tells it
  // (ActorAuthorityInfo) and it puppets the cell's NPCs off the back of that.
  const { peer, epoch } = await holdCell(ctx.serverPort, ctx.serverPassword, cellKey);
  ctx.log(`peer holds ${cellKey} at epoch ${epoch}`);

  await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0',
    PUPPET_TIMEOUT, 'the client to puppet the cell NPCs (needs a holder)');

  const probe = JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
  const record = Object.keys(probe).find((r) => r !== 'player');
  assert.ok(record, `no NPC to hit in ${cellKey}: ${JSON.stringify(Object.keys(probe))}`);
  ctx.log(`swinging at ${record}`);

  // Swing. `hitn:` posts the STOCK Hit event, so it travels the identical path a real weapon
  // swing takes: the puppet's interceptor forwards it and cancels the local damage.
  // SWING REPEATEDLY, not once. A single swing plus a fixed wait is load-sensitive: this passed
  // alone in 74.6s and failed at 75.1s inside a full suite run, purely because the box was busy
  // driving other scenarios. The assertion is "a swing reaches the owner", not "the first one
  // arrives within N seconds", so keep swinging until it lands or the window closes.
  peer.inbox.events.length = 0;
  const swingUntil = Date.now() + 60_000;
  // An explicit stop flag, NOT the inbox contents. The second phase below clears the inbox to
  // watch for its own hit, which would make an inbox-driven condition true again and leave this
  // loop firing ARMED swings underneath it -- the unarmed assertion then reads a health payload
  // and fails for a reason that has nothing to do with the product.
  let stopArmed = false;
  void (async () => {
    while (Date.now() < swingUntil && !stopArmed
           && peer.inbox.events.filter((e) => e.name === 'CombatHit').length === 0) {
      await c.eval(`window.omw.send('hitn:${record}:7')`);
      await ctx.sleep(1500);
    }
  })();

  // THE ASSERTION. Before the fix this never arrived, because the client would not send
  // without an epoch it had no way to have yet.
  const got = await peer.waitEvent('CombatHit');
  const body = got.value;
  ctx.log(`peer received CombatHit: ${JSON.stringify(body).slice(0, 200)}`);
  assert.ok(body?.target, 'CombatHit carried no target');
  assert.equal(body.target.cellKey, cellKey, 'the hit was addressed to the wrong cell');
  assert.equal(body.damage?.health, 7, 'the raw pre-mitigation damage did not survive the trip');

  // ---------------------------------------------------------------- UNARMED, which is FATIGUE
  //
  // Morrowind's hand-to-hand damages FATIGUE, and the engine fills EITHER health OR fatigue and
  // never both (mwlua/luamanagerimp.cpp onHit). The server used to demand damage.health, so it
  // dropped every unarmed swing in the game -- a level-1 character with no weapon could not land
  // a single blow, and because puppet.lua has already cancelled the local damage chain by then
  // the attack produced nothing at all: no damage, no miss, no sound.
  //
  // This suite could not have caught it. The hitn: hook hardcoded a health payload, so no
  // scenario was ABLE to express the failing shape, and 46 of them passed while combat was
  // broken for anyone without a weapon. hitnfat: exists so the gap cannot reopen.
  // Stop the armed loop and let its in-flight swing settle before clearing the inbox, or a
  // straggler health hit lands in the window the unarmed assertion is watching.
  stopArmed = true;
  // DRAIN UNTIL QUIET, rather than sleeping a guessed interval and clearing once. The armed
  // loop swings every 1.5 s and a swing already in flight lands after the stop flag is set, so
  // a fixed 2 s settle plus a single clear left a health hit sitting in the inbox -- and the
  // unarmed assertion below then read THAT, reporting `damage.health = 7` where it wanted
  // `damage.fatigue = 5` and failing as though fatigue forwarding were broken. It was not; the
  // test was.
  //
  // Deliberately NOT fixed by selecting the first event that happens to carry a fatigue
  // channel. That would pass just as happily on a build that quietly converted fatigue to
  // health, which is the exact bug this scenario exists to catch. Draining to silence keeps
  // the assertion strict: anything that arrives after this can only be an unarmed swing.
  {
    const quietFor = 3000;
    const drainUntil = Date.now() + 30_000;
    let lastSeen = Date.now();
    peer.inbox.events.length = 0;
    while (Date.now() < drainUntil) {
      await ctx.sleep(250);
      if (peer.inbox.events.some((e) => e.name === 'CombatHit')) {
        peer.inbox.events.length = 0;
        lastSeen = Date.now();
        continue;
      }
      if (Date.now() - lastSeen >= quietFor) break;
    }
  }
  ctx.log('swinging UNARMED (fatigue damage) at ' + record);
  peer.inbox.events.length = 0;
  const fatUntil = Date.now() + 60_000;
  void (async () => {
    while (Date.now() < fatUntil
           && peer.inbox.events.filter((e) => e.name === 'CombatHit').length === 0) {
      await c.eval(`window.omw.send('hitnfat:${record}:5')`);
      await ctx.sleep(1500);
    }
  })();

  const fat = await peer.waitEvent('CombatHit');
  const fatBody = fat.value;
  ctx.log(`peer received unarmed CombatHit: ${JSON.stringify(fatBody).slice(0, 200)}`);
  assert.equal(fatBody.damage?.fatigue, 5, 'the fatigue damage did not survive the trip');
  assert.equal(fatBody.damage?.health, undefined,
    'an unarmed hit must NOT carry a health channel — the engine sends one or the other');
  ctx.log('ok: an unarmed (fatigue-only) hit reaches the cell owner');

  peer.close();
}
