// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The movement envelope, made to ACT in the shared lobby.
//
// The client authors its own position, so this cannot prove honesty — it bounds how far a
// modified client gets before the server stops believing it. Everywhere but the lobby that
// stays a counted signal: a private world is the player's own game, and a false positive there
// would rubber-band someone whose connection merely stalled. In the lobby the frame is refused.
//
// Asserted through a PEER's move batches rather than server internals: what matters is what
// other players see, which is also the only thing a cheat is trying to change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

// A MONOTONIC warp, which is what a teleport hack actually looks like, with interest culling
// switched off (interestRadius = 0) so distance cannot stop the relay by itself and let this
// pass for the wrong reason.
//
// Monotonic matters. Oscillating between two points defeats the run counter on purpose: the
// speed anchor is deliberately NOT advanced on a refused frame, so a player who returns to
// somewhere reachable measures as plausible again and is forgiven. That is the right behaviour
// and the wrong test — it would report enforcement as broken when it is working as designed.
//
// SIZED TO STAY IN BOUNDS. MAX_ABS_COORD is 512000 and handleMove rejects anything past it
// outright, so at 400k a hop everything after the first was refused by the BOUNDS check — in
// both worlds. The lobby assertion passed anyway, for entirely the wrong reason, and only the
// private-world control noticed. 8 hops of 60000 tops out at 480000, inside the bound, and
// 60000 units per 260 ms is ~230000 units/s — nowhere near plausible.
const WARP = 60_000;

/** A character created in its own world, so the lobby's chargen gate admits it later. */
async function makeCharacter(dataDir: string, name: string): Promise<void> {
  const solo = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'private',
  });
  const a = await TestClient.connect(solo.port);
  await a.joinAsNew(name);
  await a.waitEvent('PlayerList');
  a.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'h', hair: 'x', isMale: true, class: 'nightblade', name,
  });
  a.sendEvent('ChargenComplete', {});
  a.close();
  await a.closed;
  await solo.flush();
  await solo.close();
}

/**
 * Warp back and forth `n` times and report how many of those warps a WATCHING peer was actually
 * told about. `lobby` selects the gateway shared world (OMW_WORLD_ID + public) or an ordinary one.
 */
async function warpsSeenByPeer(
  t: { after: (fn: () => unknown) => void }, lobby: boolean, n: number,
): Promise<number> {
  const dataDir = tmpDataDir();
  await makeCharacter(dataDir, 'Warper');
  await makeCharacter(dataDir, 'Watcher');

  const had = process.env.OMW_WORLD_ID;
  if (lobby) process.env.OMW_WORLD_ID = 'vvardenfell';
  else delete process.env.OMW_WORLD_ID;
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    worldMode: lobby ? 'public' : 'private',
    // ISOLATE THE ONE MECHANISM. A warp far enough to be implausible is also far enough to be
    // culled (interestRadius) AND to be dropped to the far LOD tier, either of which would stop
    // the relay by itself and let this pass — or fail — for entirely the wrong reason. Culling
    // off, and the tier radii pushed past any distance used here so every pose is "near" and
    // sent every tick. What is left is the speed envelope.
    configOverride: {
      limits: {
        interestRadius: 0,
        lodNearRadius: 1_000_000_000,
        lodMidRadius: 1_000_000_000,
      },
    },
  });
  t.after(() => {
    if (had === undefined) delete process.env.OMW_WORLD_ID;
    else process.env.OMW_WORLD_ID = had;
    return server.close();
  });

  const login = async (name: string) => {
    const c = await TestClient.connect(server.port);
    c.hello();
    await c.waitJson('SessionHelloOk');
    c.login(name, 'hunter22');
    await c.waitJson('SessionWelcome');
    c.sendJson({ t: 'SessionReady' });
    await c.waitEvent('PlayerList');
    c.sendCellChange('0,0', 0, 0, 0);
    return c;
  };

  const watcher = await login('Watcher');
  const warper = await login('Warper');

  warper.sendMove({ x: 0, y: 0, z: 0 });
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 1; i <= n; i++) {
    warper.sendMove({ x: WARP * i, y: 0, z: 0 });
    // Spaced past MOVE_WINDOW_MS so each hop is actually judged. Anything faster is accepted
    // without a verdict by design — see the burst test below for why that matters.
    await new Promise((r) => setTimeout(r, 260));
  }
  await new Promise((r) => setTimeout(r, 250));
  // The furthest the watcher was EVER told the warper had got, expressed in hops.
  const mine = watcher.playerId;
  let furthest = 0;
  for (const b of watcher.inbox.batches) {
    for (const e of b.entries) if (e.id !== mine && e.pose.x > furthest) furthest = e.pose.x;
  }
  warper.close();
  watcher.close();
  return Math.round(furthest / WARP);
}

test('lobby: a sustained warp stops being relayed to other players', async (t) => {
  const hops = await warpsSeenByPeer(t, true, 8);
  // The first two hops are still taken — the run has to establish itself before enforcement
  // starts — and every one after is refused, so the warper never gets further than that.
  assert.ok(hops > 0, 'the watcher was receiving poses at all');
  assert.ok(hops <= 3, `the warp kept being relayed: peers followed it to hop ${hops} of 8`);
});

// NEGATIVE CONTROL. The IDENTICAL sequence outside the lobby is relayed in full, so the test
// above is enforcement rather than the frames being lost to a rate limit, the bounds check or a
// stale seq. Removing the ctx.lobbyWorld gate makes this one fail.
test('a private world still only COUNTS an implausible move', async (t) => {
  const hops = await warpsSeenByPeer(t, false, 8);
  assert.equal(hops, 8,
    `outside the lobby this is a signal, not a gate (peers followed only to hop ${hops})`);
});


// THE FALSE POSITIVE THIS MUST NOT HAVE, and the reason speed is measured over a window rather
// than between frames.
//
// Frame spacing is ARRIVAL spacing. A player whose connection stalls and then delivers a burst
// sends several ordinary little movements a few milliseconds apart — per-frame that is an
// enormous apparent speed for someone who did nothing but have bad wifi. While the envelope
// only COUNTED, that was noise in a log. Now that the lobby refuses on it, judging per-frame
// would rubber-band the wrong person, on the connection least able to recover from it.
test('lobby: a burst delivered after a stall is not mistaken for a warp', async (t) => {
  const dataDir = tmpDataDir();
  await makeCharacter(dataDir, 'Stally');
  await makeCharacter(dataDir, 'Watcher2');
  const had = process.env.OMW_WORLD_ID;
  process.env.OMW_WORLD_ID = 'vvardenfell';
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public',
  });
  t.after(() => {
    if (had === undefined) delete process.env.OMW_WORLD_ID;
    else process.env.OMW_WORLD_ID = had;
    return server.close();
  });

  const login = async (name: string) => {
    const c = await TestClient.connect(server.port);
    c.hello();
    await c.waitJson('SessionHelloOk');
    c.login(name, 'hunter22');
    await c.waitJson('SessionWelcome');
    c.sendJson({ t: 'SessionReady' });
    await c.waitEvent('PlayerList');
    c.sendCellChange('0,0', 0, 0, 0);
    return c;
  };

  const watcher = await login('Watcher2');
  const stally = await login('Stally');
  stally.sendMove({ x: 0, y: 0, z: 0 });
  await new Promise((r) => setTimeout(r, 300));

  // The stall, then the catch-up: 12 frames back to back, each a plausible single-tick step for
  // a levitating character (~130 units), all arriving within milliseconds of each other.
  const STEP = 130, FRAMES = 12;
  for (let i = 1; i <= FRAMES; i++) stally.sendMove({ x: i * STEP, y: 0, z: 0 });
  await new Promise((r) => setTimeout(r, 500));

  const mine = watcher.playerId;
  let furthest = 0;
  for (const b of watcher.inbox.batches) {
    for (const e of b.entries) if (e.id !== mine && e.pose.x > furthest) furthest = e.pose.x;
  }
  // Judged per-frame this is ~130 units over ~0 ms — astronomically fast, three windows over,
  // and the player would be frozen near the origin. Judged over a window it is 1560 units in
  // ~0.5 s, comfortably inside the envelope, which is the truth.
  assert.ok(Math.abs(furthest - FRAMES * STEP) < 1,
    `a stalled player was rubber-banded: peers last saw x=${furthest}, not ${FRAMES * STEP}`);
  stally.close();
  watcher.close();
});

// TRAVEL IS NOT CHEATING. A cell change is a legitimate teleport — a door, a silt strider,
// Recall, Divine Intervention — and the envelope must not measure across one.
//
// The old per-frame check got this for free: it compared against player.pose, which the cell
// change handler refreshes. The windowed check keeps its own baseline, so it has to be told —
// and without that, arriving anywhere by door reads as two cells covered instantly. Three
// doors in a row and the lobby would freeze a player for travelling normally.
test('lobby: travelling between cells is never mistaken for a warp', async (t) => {
  const dataDir = tmpDataDir();
  await makeCharacter(dataDir, 'Traveller');
  await makeCharacter(dataDir, 'Watcher3');
  const had = process.env.OMW_WORLD_ID;
  process.env.OMW_WORLD_ID = 'vvardenfell';
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: 'public',
    configOverride: {
      limits: { interestRadius: 0, lodNearRadius: 1_000_000_000, lodMidRadius: 1_000_000_000 },
    },
  });
  t.after(() => {
    if (had === undefined) delete process.env.OMW_WORLD_ID;
    else process.env.OMW_WORLD_ID = had;
    return server.close();
  });

  const login = async (name: string) => {
    const c = await TestClient.connect(server.port);
    c.hello();
    await c.waitJson('SessionHelloOk');
    c.login(name, 'hunter22');
    await c.waitJson('SessionWelcome');
    c.sendJson({ t: 'SessionReady' });
    await c.waitEvent('PlayerList');
    return c;
  };
  const watcher = await login('Watcher3');
  watcher.sendCellChange('0,0', 0, 0, 0);
  const traveller = await login('Traveller');

  // THE SUBJECT IS THE STEP AFTER ARRIVING, not the arrival. A cell change relays its own
  // position regardless, so counting arrivals would pass whether or not the envelope had
  // frozen the player — measuring nothing. What the baseline reset actually protects is the
  // ordinary WALKING that follows a teleport.
  //
  // Three door-and-walk cycles. Without the reset each walk is measured from the anchor left
  // behind in the previous cell, so all three read as implausible, the run reaches three, and
  // the THIRD walk is refused. Both cells stay adjacent to the watcher's: cellsVisible() spans
  // only ±1 of the grid, and a traveller who simply walked out of view would look identical to
  // one who had been frozen.
  const HOP = 60_000;
  const STEP = 111; // distinct from the arrival coordinate, so the walk is identifiable
  let lastWalk = 0;
  for (let i = 0; i < 3; i++) {
    const far = i % 2 === 0;
    const at = far ? HOP : 0;
    traveller.sendCellChange(far ? '1,0' : '-1,0', at, 0, 0);
    await new Promise((r) => setTimeout(r, 260));
    lastWalk = at + STEP;
    traveller.sendMove({ x: lastWalk, y: 0, z: 0 }); // an ordinary step after arriving
    await new Promise((r) => setTimeout(r, 260));
  }
  await new Promise((r) => setTimeout(r, 300));

  const mine = watcher.playerId;
  let sawLastWalk = false;
  for (const b of watcher.inbox.batches) {
    for (const e of b.entries) {
      if (e.id !== mine && Math.round(e.pose.x) === lastWalk) sawLastWalk = true;
    }
  }
  assert.ok(sawLastWalk,
    `a player who walked after arriving by door was frozen: peers never saw x=${lastWalk}`);
  traveller.close();
  watcher.close();
});
