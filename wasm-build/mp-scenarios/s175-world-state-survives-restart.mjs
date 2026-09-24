// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s175: THE WORLD PROCESS RESTARTS AND THE WORLD IS STILL THE WORLD.
//
// A host and a guest (friends, Party) change the host's world: a door opened and then locked,
// a chest filled, an item dropped and picked up by the other player, eight hours rested away,
// and the weather changed by whichever of them holds the region. Both clients must agree on
// every one of those -- WEATHER included, which nothing in the suite had ever compared across
// two clients (world.lua MP_WorldWeather / core/weather.ts).
//
// Then the WORLD PROCESS restarts: not a reconnect, a new process on the same data dir. The
// gateway's rolling restart (SIGHUP, the idiom an operator and the updater use; worlds.ts
// rollingRestart) stops the world and starts a replacement. Both clients must come back on
// their own -- the guest too, into a world whose Party mode lived only in the old process's
// memory unless the gateway handed it over (OMW_WORLD_LAST_MODE) -- and still agree on every
// item, with the values from before the restart.
//
// Hooks, not keys, for the world edits (door:/chest:/drop:/takenet:/rest:/weather:): none of
// these is what this scenario is about, each has its own scenario (s30-s32, s70), and no
// player input sets the weather at all. The restart and the return are real.
import assert from 'node:assert/strict';
import { startGatewayAndClient, addClient, grantLockerSession } from './_gateway.mjs';

export const bootTimeoutMs = 420_000;
const GW_PORT = 19210; // ten apart from its neighbours (see s102)
// A hang guard, not a timing: two retail clients on the loaded box ran seconds a frame (an
// eval unanswered for 7 s), and a chest put is a frame, a round trip and a mirror tick.
const STEP = 120_000;
// RETAIL: the Example Suite village has no region, so it has no weather at all (measured:
// region "" and no holder); Seyda Neen is the Bitter Coast, and its nearest door is locked.
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const REST_HOURS = 8;

const J = (expr) => `JSON.parse(window.omw.state.${expr}||'{}')`;
// Everything one client believes, in ONE eval (every eval costs a frame).
const snapshotExpr = (chestNet, dropNet, netItem) => `JSON.stringify({
  state: window.omw.state.state,
  doorOpen: window.omw.state.doorOpen, doorLocked: window.omw.state.doorLocked,
  chest: !!${J('netObjects')}[${JSON.stringify(chestNet)}],
  chestHolds: ((${J('containerItems')})['n:${chestNet}']||{})[${JSON.stringify(netItem)}] || 0,
  drop: !!${J('netObjects')}[${JSON.stringify(dropNet)}],
  clock: (${J('gameTime')}).abs,
  region: window.omw.state.region, holder: window.omw.state.isWeatherHolder,
  weather: (JSON.parse(window.omw.state.weatherApplied||'null')||{}).target ?? (JSON.parse(window.omw.state.weatherApplied||'null')||{}).current })`;

// A RETAIL character arrives dressed, so the items moved around are its own clothes: content
// records, whose wire name is their record id (a minted test item goes through netRecords and,
// in retail, tripped the engine: "Object Generated:0x13 of type NPC can not be placed into a
// container" -- the test hook, not what this scenario is about).
async function ownItem(c, not = []) {
  await c.waitFor('String(window.omw.state.equippedIds||"").split(",").some((x) => x && !/^Generated:/.test(x))', 60_000, `${c.name} wears something of its own`);
  return String(await c.eval('window.omw.state.equippedIds')).split(',').find((x) => x && !/^Generated:/.test(x) && !not.includes(x));
}

export default async function run(ctx) {
  const host = await startGatewayAndClient(ctx, { gwPort: GW_PORT, name: 'ws-host', ownId: 'priv-ws-host', boot: BOOT });
  const H = host.client;
  try {
    const guest = await addClient(ctx, GW_PORT, { name: 'ws-guest', ownId: 'priv-ws-guest', boot: BOOT });
    const G = guest.client;
    const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
    const HH = `wshost${tag}`, GH = `wsguest${tag}`;
    await H.cmd(`profile:ws-host@example.com:${HH}`);
    await G.cmd(`profile:ws-guest@example.com:${GH}`);
    for (const [who, c] of [['host', H], ['guest', G]]) {
      await c.waitFor('window.omw.state.profileOk !== undefined', STEP, `${who} profile answered`);
      assert.equal(await c.eval('window.omw.state.profileOk'), 'true', `${who} needs a handle`);
    }
    await H.cmd(`social:FriendRequest:${GH}`);
    await G.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives');
    await G.cmd(`social:FriendAccept:${HH}`);
    await H.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
    await H.cmd('worldmode:party');
    await H.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode'`, STEP, 'party');
    await G.cmd(`joinfriend:${JSON.parse(await G.eval("window.omw.state.friends||'[]'"))[0].acct}`);
    const rowOf = (h) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(h)}; }) || {})`;
    await H.waitFor(`${rowOf(GH)}.id !== undefined`, 300_000, "the guest reached the host's world");
    await G.waitFor('window.omw.state.state === "Joined"', 60_000, 'the guest is joined after the redial');
    await grantLockerSession(G, GW_PORT, guest.account);
    ctx.log("ok: host and guest share the host's world");

    // ---- 1. a door opened, then locked (the host's hand, the guest's eyes).
    for (const c of [H, G]) await c.waitFor('window.omw.state.doorOpen !== undefined', STEP, `${c.name}: door mirror live`);
    if (await H.eval('window.omw.state.doorLocked') === 'true') {
      await H.cmd('door:unlock');
      await G.waitFor('window.omw.state.doorLocked === "false"', STEP, 'the guest sees the door unlocked');
    }
    if (await H.eval('window.omw.state.doorOpen') !== 'true') await H.cmd('door:toggle');
    await G.waitFor('window.omw.state.doorOpen === "true"', STEP, 'the guest sees the door open');
    await H.cmd('door:lock:50');
    await G.waitFor('window.omw.state.doorLocked === "true"', STEP, 'the guest sees the door locked');

    // ---- 2. a chest filled (s31's path: the item's WIRE name is what the chest holds).
    const itemH = await ownItem(H);
    const netItem = itemH; // a content record travels under its own id
    const netsBefore = JSON.parse(await H.eval(`JSON.stringify(Object.keys(${J('netObjects')}))`));
    await H.cmd('chest:spawn');
    await H.waitFor(`Object.keys(${J('netObjects')}).length > ${netsBefore.length}`, STEP, 'the chest is netted');
    const chestNet = JSON.parse(await H.eval(`JSON.stringify(Object.keys(${J('netObjects')}))`)).find((k) => !netsBefore.includes(k));
    await H.cmd('chest:open');
    await H.waitFor(`'n:${chestNet}' in ${J('containerItems')}`, STEP, 'the chest is registered on open');
    await H.cmd(`chest:put:${itemH}`);
    const holds = (n) => `(((${J('containerItems')})['n:${chestNet}']||{})[${JSON.stringify(netItem)}]||0) === ${n}`;
    await H.waitFor(holds(1), STEP, 'the chest holds the item on the host').catch(async (e) => {
      const seen = await H.eval(`JSON.stringify({ item: ${JSON.stringify(itemH)}, chest: ${JSON.stringify(chestNet)}, containerItems: window.omw.state.containerItems, chestOp: window.omw.state.chestOp, equipped: window.omw.state.equippedIds })`).catch(() => '(unreadable)');
      throw new Error(`${e.message.split('\n')[0]}\n  state: ${seen}`);
    });
    await G.waitFor(`!!${J('netObjects')}[${JSON.stringify(chestNet)}]`, STEP, 'the chest stands on the guest');
    await G.cmd(`chest:open:${chestNet}`);
    await G.waitFor(holds(1), STEP, 'the guest sees the chest holding it');

    // ---- 3. an item dropped by the guest and picked up by the host.
    const itemG = await ownItem(G, [itemH]);
    const netsG = JSON.parse(await G.eval(`JSON.stringify(Object.keys(${J('netObjects')}))`));
    await G.cmd(`drop:${itemG}`);
    await G.waitFor(`Object.keys(${J('netObjects')}).length > ${netsG.length}`, STEP, 'the guest drop is netted');
    const dropNet = JSON.parse(await G.eval(`JSON.stringify(Object.keys(${J('netObjects')}))`)).find((k) => !netsG.includes(k));
    await H.waitFor(`!!${J('netObjects')}[${JSON.stringify(dropNet)}]`, STEP, 'the host sees the drop');
    await H.cmd(`takenet:${dropNet}`);
    for (const c of [H, G]) await c.waitFor(`!${J('netObjects')}[${JSON.stringify(dropNet)}]`, STEP, `${c.name}: the picked-up item is gone`);

    // ---- 4. time: the host rests eight hours; both clocks move.
    const clock0 = JSON.parse(await G.eval(`JSON.stringify(${J('gameTime')})`)).abs;
    await H.cmd(`rest:${REST_HOURS}`);
    // The guest SLEWS to the new time (s70), a step per frame, on a client at a frame a second or two.
    await G.waitFor(`(${J("gameTime")}).abs >= ${clock0 + REST_HOURS - 0.5}`, 180_000, "the guest's clock took the rest");

    // ---- 5. weather: whoever holds the region changes it; the other applies it.
    let hold = null;
    for (const by = Date.now() + 120_000; Date.now() < by && !hold;) {
      const [h, g] = await Promise.all([H.eval('window.omw.state.isWeatherHolder'), G.eval('window.omw.state.isWeatherHolder')]);
      hold = h === 'true' ? [H, G] : g === 'true' ? [G, H] : null;
      if (!hold) await ctx.sleep(1000);
    }
    const region = await H.eval('window.omw.state.region');
    assert.ok(hold, `nobody holds the weather for region "${region}" -- there is no weather to agree on`);
    const [holder, other] = hold;
    // A SETTLED SKY FIRST. changeWeather lets a running transition finish before the next one
    // starts, and both screens follow the holder through it -- #151: the guest received
    // "current 0, next 1" for the whole 90 s, because the holder was itself still clearing to
    // cloudy on a client at a frame or two a second. Ordered from a settled sky, the change is
    // the only transition in flight.
    await other.waitFor(`(() => { const w = JSON.parse(window.omw.state.weatherApplied||'null'); return !!w && (w.next === undefined || w.next === null || w.next === w.current); })()`,
      240_000, `${other.name} sees a settled sky before the change`).catch((e) => ctx.log('  (sky still in transition: ' + e.message.split('\n')[0] + ')'));
    const was = JSON.parse(await other.eval("window.omw.state.weatherApplied||'null'"))?.target;
    const WEATHER = was === 5 ? 4 : 5; // thunder, or rain if it already thunders
    await holder.cmd(`weather:${WEATHER}`);
    await other.waitFor(`(JSON.parse(window.omw.state.weatherApplied||'null')||{}).target === ${WEATHER}`, 90_000,
      `${other.name} applies the holder's weather ${WEATHER} in ${region}`);
    ctx.log(`ok: ${holder.name} holds ${region}; weather ${was} -> ${WEATHER} reached ${other.name}`);

    const snap = async (c) => JSON.parse(await c.eval(snapshotExpr(chestNet, dropNet, netItem)));
    const [b1, b2] = await Promise.all([snap(H), snap(G)]);
    ctx.log(`before the restart: host=${JSON.stringify(b1)} guest=${JSON.stringify(b2)}`);
    for (const k of ['doorOpen', 'doorLocked', 'chest', 'chestHolds', 'drop']) assert.equal(b1[k], b2[k], `before the restart they already disagree on ${k}`);
    assert.ok(Math.abs(b1.clock - b2.clock) < 0.75, `clocks disagree before the restart: ${b1.clock} vs ${b2.clock}`);

    // ---- THE RESTART. SIGHUP: the gateway rolls every world -- stop, wait for the exit, start
    // a new process on the same data dir, wait for it to answer.
    const gwLog = () => ctx.childLogTail('gateway');
    const rolls0 = (gwLog().match(/rolling_restart_done/g) ?? []).length;
    const drops = new Map([[H, 0], [G, 0]]);
    process.kill(host.proc.pid, 'SIGHUP');
    const t0 = Date.now();
    for (const by = Date.now() + 240_000; Date.now() < by && (gwLog().match(/rolling_restart_done/g) ?? []).length === rolls0;) {
      for (const c of [H, G]) if (await c.eval('window.omw.state.state').catch(() => 'x') !== 'Joined') drops.set(c, drops.get(c) + 1);
      await ctx.sleep(500);
    }
    const doneLine = gwLog().split('\n').reverse().find((l) => /rolling_restart_done/.test(l)) ?? '';
    ctx.log(`gateway: ${doneLine.slice(0, 240)} (${Date.now() - t0} ms)`);
    assert.ok(/rolling_restart_done/.test(doneLine), 'the gateway never finished its rolling restart');
    assert.match(doneLine, /"?failed"?\s*[:=]\s*0/, `a world failed to come back: ${doneLine}`);

    // Both come back on their own: seen off the world, then Joined again.
    for (const c of [H, G]) {
      for (const by = Date.now() + 60_000; drops.get(c) === 0 && Date.now() < by;) {
        if (await c.eval('window.omw.state.state').catch(() => 'x') !== 'Joined') drops.set(c, 1);
        else await ctx.sleep(300);
      }
    }
    ctx.log(`off-world samples during the restart: host ${drops.get(H)}, guest ${drops.get(G)}`);
    assert.ok(drops.get(H) > 0, "the host's connection never dropped: the world process did not actually restart");
    for (const c of [H, G]) {
      await c.waitFor('window.omw.state.state === "Joined"', 240_000, `${c.name} is back in the world after the restart`);
    }
    const url = await G.eval('String(window.omw.state.dialTarget || "")');
    ctx.log(`back ${Math.round((Date.now() - t0) / 1000)} s after SIGHUP; guest dialled ${url}`);
    assert.ok(url.includes(host.ownId), `the guest came back somewhere else (${url}), not the host's world`);

    // The chest is re-opened, as a player would to look inside; mirrors reset on a new session.
    await H.cmd(`chest:open:${chestNet}`);
    await G.cmd(`chest:open:${chestNet}`);
    // Converge, then judge: every item on both clients, against the values from before.
    let a1, a2, bad = ['(never sampled)'];
    for (const by = Date.now() + 120_000; Date.now() < by;) {
      [a1, a2] = await Promise.all([snap(H), snap(G)]);
      bad = [];
      for (const [who, s] of [['host', a1], ['guest', a2]]) {
        for (const k of ['doorOpen', 'doorLocked', 'chest', 'chestHolds', 'drop']) if (s[k] !== b1[k]) bad.push(`${who}.${k}=${s[k]} (was ${b1[k]})`);
        if (!(s.clock >= b1.clock - 0.25)) bad.push(`${who}.clock=${s.clock} went back from ${b1.clock}`);
      }
      if (Math.abs(a1.clock - a2.clock) >= 0.75) bad.push(`clocks ${a1.clock} vs ${a2.clock}`);
      const wOther = (a1.holder === 'true' ? a2 : a1).weather;
      if (wOther !== WEATHER) bad.push(`non-holder weather=${wOther} (was ${WEATHER})`);
      if (bad.length === 0) break;
      await ctx.sleep(2000);
    }
    ctx.log(`after the restart: host=${JSON.stringify(a1)} guest=${JSON.stringify(a2)}`);
    assert.deepEqual(bad, [], `after the world restarted the clients do not hold the world they left: ${bad.join('; ')}`);
    ctx.log(`PASS: door, chest, pickup, clock (+${REST_HOURS} h) and weather ${WEATHER} survived a world-process restart on both clients`);
  } finally {
    host.stop();
  }
}
