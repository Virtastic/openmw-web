// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M7 world state: the server-owned clock (broadcast, rest-for-everyone, restart), the
// per-region weather authority (claim/handoff/dormancy, mirroring the M4 cell
// invariants), server-issued custom records (ack ordering, peer + late-joiner sync,
// restart), operator cell resets (schedule fires and survives a restart), map sharing
// under the [sharing] toggle, and server-pushed GUI routing including a disconnect
// mid-dialog that must not leak a pending promise.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../src/server';
import type { DeepPartial, Config } from '../src/config';
import { TestClient, tmpDataDir } from './helpers';

interface TimeBody { gameHour: number; day: number; month: number; year: number; timeScale: number }

// timeScale 0 freezes the free-running clock: every test that asserts on a calendar
// value wants the ONLY mover to be an explicit advance.
async function boot(t: { after(fn: () => unknown): void }, override?: DeepPartial<Config>, dataDir = tmpDataDir()) {
  const configOverride: DeepPartial<Config> = {
    ...override,
    time: { scale: 0, ...override?.time },
    // Every test client dials from 127.0.0.1; a starved limiter fails later subtests
    // for reasons that have nothing to do with what they assert.
    limits: { maxConnsPerIp: 16, loginPerMinPerIp: 60, ...override?.limits },
  };
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', configOverride });
  t.after(() => server.close());
  return { server, dataDir };
}

async function join(server: RunningServer, name: string) {
  const c = await TestClient.connect(server.port);
  const { playerId } = await c.joinAsNew(name);
  await c.waitEvent('PlayerList');
  return { c, playerId };
}

// A round trip that proves everything sent before it has been processed and delivered.
async function fence(from: TestClient, ...watchers: TestClient[]) {
  const text = `fence-${Math.random().toString(36).slice(2)}`;
  from.sendEvent('ChatSend', { text });
  for (const w of watchers) await w.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === text);
}

// Poll a settled value: teardown is async, so reading a count once races the close.
async function settles<T>(read: () => T, want: T, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (read() === want) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(read(), want, `${what} never settled`);
}

test('server-owned clock', async (t) => {
  const dataDir = tmpDataDir();
  const { server } = await boot(t, undefined, dataDir);

  await t.test('joining clients receive the current WorldTime', async () => {
    const { c } = await join(server, 'Tick');
    const time = (await c.waitEvent('WorldTime')).value as TimeBody;
    assert.equal(time.timeScale, 0);
    assert.ok(time.year >= 427 && time.month >= 1 && time.day >= 1);
    c.close();
    await c.closed;
  });

  await t.test('one player resting advances time for EVERYONE', async () => {
    const { c: a } = await join(server, 'Rester');
    const before = (await a.waitEvent('WorldTime')).value as TimeBody;
    const { c: b } = await join(server, 'Sleeper');
    await b.waitEvent('WorldTime');

    a.sendEvent('WorldTimeRequest', { advanceHours: 8, reason: 'rest' });
    const aTime = (await a.waitEvent('WorldTime')).value as TimeBody;
    const bTime = (await b.waitEvent('WorldTime')).value as TimeBody;
    assert.deepEqual(aTime, bTime, 'the clock is one shared value, not per player');
    const advanced = (aTime.day - before.day) * 24 + (aTime.gameHour - before.gameHour);
    assert.ok(Math.abs(advanced - 8) < 0.01, `expected +8h, got ${advanced}`);
    a.close(); b.close();
    await a.closed; await b.closed;
  });

  await t.test('the calendar rolls over days and months', async () => {
    const { c } = await join(server, 'Calendar');
    await c.waitEvent('WorldTime');
    const start = server.api.world.time();
    server.api.world.advanceTime(24 * 40); // past the end of any month
    const rolled = (await c.waitEvent('WorldTime')).value as TimeBody;
    assert.ok(rolled.month !== start.month || rolled.year !== start.year, 'month must roll');
    assert.ok(rolled.day >= 1 && rolled.day <= 31);
    assert.ok(rolled.gameHour >= 0 && rolled.gameHour < 24);
    c.close();
    await c.closed;
  });

  await t.test('malformed and out-of-range requests are dropped, not applied', async () => {
    const { c } = await join(server, 'Cheater');
    await c.waitEvent('WorldTime');
    const before = server.api.world.time();
    for (const body of [
      { advanceHours: 1e9, reason: 'rest' },       // beyond the per-request cap
      { advanceHours: -5, reason: 'rest' },        // backwards
      { advanceHours: 0, reason: 'rest' },         // no-op
      { advanceHours: 'lots', reason: 'rest' },    // wrong type
      { advanceHours: 3 },                          // no reason
      { advanceHours: 3, reason: 'timetravel' },   // unknown reason
    ]) {
      c.sendEvent('WorldTimeRequest', body);
    }
    await fence(c, c);
    assert.deepEqual(server.api.world.time(), before);
    assert.equal(c.inbox.events.filter((e) => e.name === 'WorldTime').length, 0);
    c.close();
    await c.closed;
  });

  await t.test('the clock survives a restart', async () => {
    const before = server.api.world.time();
    server.api.world.advanceTime(30);
    await server.flush();
    await server.close();

    const restarted = await startServer({ requireGameData: false,
      dataDir, port: 0, host: '127.0.0.1',
      configOverride: { time: { scale: 0 }, limits: { maxConnsPerIp: 16, loginPerMinPerIp: 60 } },
    });
    t.after(() => restarted.close());
    const after = restarted.api.world.time();
    assert.ok(after.day !== before.day || after.month !== before.month, 'the calendar must not reset');
    const { c } = await join(restarted, 'AfterReboot');
    const seen = (await c.waitEvent('WorldTime')).value as TimeBody;
    assert.deepEqual(seen, {
      gameHour: Math.round(after.gameHour * 1e4) / 1e4,
      day: after.day, month: after.month, year: after.year, timeScale: 0,
    });
    c.close();
    await c.closed;
  });
});

test('per-region weather authority', async (t) => {
  const { server } = await boot(t);
  const { c: a, playerId: aId } = await join(server, 'WeatherA');
  const { c: b, playerId: bId } = await join(server, 'WeatherB');

  await t.test('the first player in a region becomes its authority', async () => {
    a.sendEvent('WorldRegionChange', { region: 'Ascadian Isles' });
    assert.deepEqual((await a.waitEvent('WorldWeatherAuthority')).value, {
      region: 'Ascadian Isles', holderId: aId,
    });
  });

  await t.test('a second player in the region is told who holds it', async () => {
    b.sendEvent('WorldRegionChange', { region: 'Ascadian Isles' });
    assert.deepEqual((await b.waitEvent('WorldWeatherAuthority')).value, {
      region: 'Ascadian Isles', holderId: aId,
    });
    b.sendEvent('WorldRegionChange', { region: 'Ascadian Isles' }); // idempotent re-declare
    await fence(b, a);
  });

  await t.test('the holder\'s weather reaches peers; a non-holder is dropped', async () => {
    a.sendEvent('WorldWeather', { region: 'Ascadian Isles', current: 4, next: 6, transition: 0.25 });
    assert.deepEqual((await b.waitEvent('WorldWeather')).value, {
      region: 'Ascadian Isles', current: 4, next: 6, transition: 0.25,
    });
    b.sendEvent('WorldWeather', { region: 'Ascadian Isles', current: 9 }); // not the holder
    b.sendEvent('WorldWeather', { region: 'Ascadian Isles', current: -1 }); // malformed
    b.sendEvent('WorldWeather', { region: 'Ascadian Isles', current: 2, transition: 5 }); // out of range
    b.sendEvent('WorldWeather', { current: 2 }); // no region
    b.sendEvent('WorldRegionChange', {}); // malformed region change
    await fence(b, a);
    assert.equal(a.inbox.events.filter((e) => e.name === 'WorldWeather').length, 0);
  });

  await t.test('a second region has its own independent authority', async () => {
    const { c: far } = await join(server, 'WeatherFar');
    far.sendEvent('WorldRegionChange', { region: 'Sheogorad' });
    const grant = (await far.waitEvent('WorldWeatherAuthority')).value as { region: string; holderId: number };
    assert.equal(grant.region, 'Sheogorad');
    far.sendEvent('WorldWeather', { region: 'Sheogorad', current: 2 });
    const seen = (await a.waitEvent('WorldWeather')).value as { region: string };
    assert.equal(seen.region, 'Sheogorad', 'the broadcast is global; clients filter by region');
    far.close();
    await far.closed;
  });

  await t.test('the longest-present occupant inherits on handoff', async () => {
    // A walks out of the region; B (the only remaining occupant) inherits it and is
    // handed the region's last weather so the sim continues rather than rerolls.
    a.sendEvent('WorldRegionChange', { region: 'Bitter Coast' });
    const handoff = (await b.waitEvent('WorldWeatherAuthority')).value as { region: string; holderId: number };
    assert.deepEqual(handoff, { region: 'Ascadian Isles', holderId: bId });
    const carried = (await b.waitEvent('WorldWeather', (v) =>
      (v as { region: string }).region === 'Ascadian Isles')).value as
      { current: number; restore?: boolean };
    assert.equal(carried.current, 4, 'the new holder resumes the stored weather');
    // MARKED `restore`. The client drops any WorldWeather for a region it holds, so a handback
    // that is not distinguishable from an echo is discarded by the very client it is for — and
    // the region then keeps whatever weather that client rolled at boot, which solo means a
    // fresh roll every session ("weather is randomised on each load").
    assert.equal(carried.restore, true,
      'the continuity handback must be marked, or the new holder cannot tell it from its own echo');
    // A is told it no longer speaks for the region it left.
    const revoked = (await a.waitEvent('WorldWeatherAuthority', (v) =>
      (v as { region: string }).region === 'Ascadian Isles')).value as { holderId: number };
    assert.equal(revoked.holderId, 0);
    // And B may now speak for it, while A holds its new region.
    b.sendEvent('WorldWeather', { region: 'Ascadian Isles', current: 7 });
    assert.equal(((await a.waitEvent('WorldWeather')).value as { current: number }).current, 7);
    assert.deepEqual((await a.waitEvent('WorldWeatherAuthority', (v) =>
      (v as { region: string }).region === 'Bitter Coast')).value, { region: 'Bitter Coast', holderId: aId });
  });

  await t.test('an emptied region goes dormant and resumes for the next claimant', async () => {
    b.close();
    await b.closed;
    a.close();
    await a.closed;
    const { c, playerId } = await join(server, 'WeatherLate');
    c.sendEvent('WorldRegionChange', { region: 'Ascadian Isles' });
    const claim = (await c.waitEvent('WorldWeatherAuthority')).value as { holderId: number };
    assert.equal(claim.holderId, playerId, 'a dormant region is claimable again');
    const resumed = (await c.waitEvent('WorldWeather', (v) =>
      (v as { region: string }).region === 'Ascadian Isles')).value as { current: number };
    assert.equal(resumed.current, 7, 'the folded state comes back');
    c.close();
    await c.closed;
  });

  await t.test('a joining client is given every known region\'s weather', async () => {
    const { c } = await join(server, 'WeatherJoiner');
    const seen = new Map<string, number>();
    for (let i = 0; i < 2; i++) {
      const w = (await c.waitEvent('WorldWeather')).value as { region: string; current: number };
      seen.set(w.region, w.current);
    }
    assert.equal(seen.get('Ascadian Isles'), 7);
    assert.equal(seen.get('Sheogorad'), 2);
    c.close();
    await c.closed;
  });
});

test('server-issued custom records', async (t) => {
  const dataDir = tmpDataDir();
  const { server } = await boot(t, undefined, dataDir);
  const ids: string[] = [];
  const { c: a } = await join(server, 'Enchanter');
  await a.waitEvent('RecordsSync');
  const { c: b } = await join(server, 'Peer');
  await b.waitEvent('RecordsSync');

  await t.test('acks come back in send order with distinct server ids', async () => {
    for (let i = 1; i <= 3; i++) {
      a.sendEvent('RecordCreate', { tempId: i, kind: 'enchantment', data: { name: `ench${i}`, cost: i * 10 } });
    }
    for (let i = 1; i <= 3; i++) {
      const ack = (await a.waitEvent('RecordCreateAck')).value as { tempId: number; recordNetId: string };
      assert.equal(ack.tempId, i, 'acks must arrive in the order the client asked');
      assert.ok(typeof ack.recordNetId === 'string' && ack.recordNetId.length > 0);
      assert.ok(!ids.includes(ack.recordNetId), 'ids must be unique');
      ids.push(ack.recordNetId);
    }
  });

  await t.test('peers already in world learn each new record immediately', async () => {
    const pushed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sync = (await b.waitEvent('RecordsSync')).value as
        { records: { recordNetId: string; kind: string }[] };
      assert.equal(sync.records.length, 1, 'a creation pushes just the new record');
      assert.equal(sync.records[0]!.kind, 'enchantment');
      pushed.push(sync.records[0]!.recordNetId);
    }
    assert.deepEqual(pushed, ids, 'the same ids the author was acked, in the same order');
  });

  await t.test('malformed creates are dropped and mint nothing', async () => {
    a.sendEvent('RecordCreate', { tempId: 9, kind: 'sandwich', data: { name: 'x' } }); // bad kind
    a.sendEvent('RecordCreate', { tempId: 10, kind: 'spell' });                        // no data
    a.sendEvent('RecordCreate', { kind: 'spell', data: { name: 'x' } });               // no tempId
    a.sendEvent('RecordCreate', { tempId: 'x', kind: 'spell', data: { name: 'x' } });  // wrong type
    await fence(a, b);
    assert.equal(a.inbox.events.filter((e) => e.name === 'RecordCreateAck').length, 0);
    assert.equal(b.inbox.events.filter((e) => e.name === 'RecordsSync').length, 0);
  });

  await t.test('a late joiner gets the COMPLETE record set with data intact', async () => {
    const { c } = await join(server, 'LateJoiner');
    const sync = (await c.waitEvent('RecordsSync')).value as
      { records: { recordNetId: string; kind: string; data: { name: string; cost: number } }[] };
    assert.deepEqual(sync.records.map((r) => r.recordNetId), ids);
    assert.deepEqual(sync.records.map((r) => r.data.name), ['ench1', 'ench2', 'ench3']);
    assert.deepEqual(sync.records.map((r) => r.data.cost), [10, 20, 30]);
    c.close();
    await c.closed;
  });

  await t.test('records and their ids survive a restart', async () => {
    a.close(); b.close();
    await a.closed; await b.closed;
    await server.flush();
    await server.close();
    const restarted = await startServer({ requireGameData: false,
      dataDir, port: 0, host: '127.0.0.1',
      configOverride: { time: { scale: 0 }, limits: { maxConnsPerIp: 16, loginPerMinPerIp: 60 } },
    });
    t.after(() => restarted.close());
    const { c } = await join(restarted, 'AfterReboot');
    const sync = (await c.waitEvent('RecordsSync')).value as { records: { recordNetId: string }[] };
    assert.deepEqual(sync.records.map((r) => r.recordNetId), ids);
    // A new record must not reuse an id handed out before the reboot.
    c.sendEvent('RecordCreate', { tempId: 42, kind: 'potion', data: { name: 'restart brew' } });
    const ack = (await c.waitEvent('RecordCreateAck')).value as { recordNetId: string };
    assert.ok(!ids.includes(ack.recordNetId), 'ids must not restart at 1');
    c.close();
    await c.closed;
  });
});

test('operator cell resets', async (t) => {
  const dataDir = tmpDataDir();
  const { server } = await boot(t, { cellReset: { cells: ['9,9'], intervalSec: 2 } }, dataDir);
  let later: RunningServer | undefined; // the restarted instance, shared by the last two subtests

  await t.test('the schedule fires and clears the right cell doc', async () => {
    const { c } = await join(server, 'Resetter');
    c.sendCellChange('9,9', 0, 0, 0);
    await c.waitEvent('WorldCellState');
    c.sendEvent('ObjectSpawnRequest', {
      tempId: 1, recordId: 'gold_001', cellKey: '9,9', x: 1, y: 2, z: 3, rotZ: 0, count: 5,
    });
    await c.waitEvent('ObjectSpawnAck');
    // A neighbouring cell is touched too and must be left alone.
    c.sendEvent('ObjectSpawnRequest', {
      tempId: 2, recordId: 'gold_001', cellKey: '8,8', x: 1, y: 2, z: 3, rotZ: 0, count: 5,
    });
    await c.waitEvent('ObjectSpawnAck');

    const reset = (await c.waitEvent('WorldCellReset', () => true, 15_000)).value as { cellKey: string };
    assert.equal(reset.cellKey, '9,9');

    c.sendEvent('ResyncRequest', { cellKey: '9,9' });
    const wiped = (await c.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '9,9')).value as
      { placed: unknown[] };
    assert.deepEqual(wiped.placed, [], 'the reset cell is empty');

    c.sendEvent('ResyncRequest', { cellKey: '8,8' });
    const kept = (await c.waitEvent('WorldCellState', (v) => (v as { cellKey: string }).cellKey === '8,8')).value as
      { placed: unknown[] };
    assert.equal(kept.placed.length, 1, 'an unscheduled cell is untouched');
    c.close();
    await c.closed;
  });

  await t.test('the schedule itself survives a restart (without the plugin)', async () => {
    await server.flush();
    await server.close();
    // No cell-reset plugin and no [cellReset] config: anything still scheduled came off
    // disk, not from a re-registration.
    const restarted = await startServer({ requireGameData: false,
      dataDir, port: 0, host: '127.0.0.1',
      configOverride: {
        plugins: ['motd'], time: { scale: 0 },
        limits: { maxConnsPerIp: 16, loginPerMinPerIp: 60 },
      },
    });
    t.after(() => restarted.close());
    assert.deepEqual(restarted.api.world.scheduledResets(), ['9,9']);
    later = restarted;
  });

  await t.test('an on-demand reset broadcasts to everyone', async () => {
    const server2 = later!;
    const { c: a } = await join(server2, 'ResetWatchA');
    const { c: b } = await join(server2, 'ResetWatchB');
    await server2.api.world.resetCell('12,12');
    assert.equal(((await a.waitEvent('WorldCellReset')).value as { cellKey: string }).cellKey, '12,12');
    assert.equal(((await b.waitEvent('WorldCellReset')).value as { cellKey: string }).cellKey, '12,12');
    a.close(); b.close();
    await a.closed; await b.closed;
  });
});

test('map sharing follows the [sharing] toggle', async (t) => {
  await t.test('shared: explored cells relay to peers with the sender id', async () => {
    const { server } = await boot(t, { sharing: { map: true } });
    const { c: a, playerId: aId } = await join(server, 'MapA');
    const { c: b } = await join(server, 'MapB');
    a.sendEvent('WorldMapExplored', { cellKeys: ['1,1', '1,2'] });
    assert.deepEqual((await b.waitEvent('WorldMapExplored')).value, { cellKeys: ['1,1', '1,2'], byId: aId });
    await fence(a, a);
    assert.equal(a.inbox.events.filter((e) => e.name === 'WorldMapExplored').length, 0, 'never echoed');

    a.sendEvent('WorldMapExplored', { cellKeys: [] });        // empty
    a.sendEvent('WorldMapExplored', { cellKeys: [1, 2] });    // not strings
    a.sendEvent('WorldMapExplored', {});                      // no list
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'WorldMapExplored').length, 0);
    a.close(); b.close();
    await a.closed; await b.closed;
  });

  await t.test('individual: nothing is relayed', async () => {
    const { server } = await boot(t, { sharing: { map: false } });
    const { c: a } = await join(server, 'MapOffA');
    const { c: b } = await join(server, 'MapOffB');
    a.sendEvent('WorldMapExplored', { cellKeys: ['3,3'] });
    await fence(a, b);
    assert.equal(b.inbox.events.filter((e) => e.name === 'WorldMapExplored').length, 0);
    a.close(); b.close();
    await a.closed; await b.closed;
  });
});

test('server-pushed GUI', async (t) => {
  const { server } = await boot(t, { gui: { timeoutSec: 1 } });

  await t.test('a message box resolves with the player\'s reply', async () => {
    const { c, playerId } = await join(server, 'GuiA');
    const pending = server.api.gui.messageBox(playerId, 'Pay the toll?', ['Yes', 'No']);
    const push = (await c.waitEvent('GuiMessageBox')).value as
      { guiId: number; text: string; buttons: string[] };
    assert.equal(push.text, 'Pay the toll?');
    assert.deepEqual(push.buttons, ['Yes', 'No']);
    c.sendEvent('GuiReply', { guiId: push.guiId, data: { button: 1 } });
    const result = await pending;
    assert.equal(result.answered, true);
    assert.deepEqual(result.data, { button: 1 });
    c.close();
    await c.closed;
  });

  await t.test('input and list dialogs round-trip their payloads', async () => {
    const { c, playerId } = await join(server, 'GuiB');
    const input = server.api.gui.inputDialog(playerId, 'Name your ship');
    const inputPush = (await c.waitEvent('GuiInputDialog')).value as { guiId: number; label: string };
    assert.equal(inputPush.label, 'Name your ship');
    c.sendEvent('GuiReply', { guiId: inputPush.guiId, data: { text: 'Nerevar' } });
    assert.deepEqual((await input).data, { text: 'Nerevar' });

    const list = server.api.gui.listBox(playerId, 'Pick one', ['a', 'b', 'c']);
    const listPush = (await c.waitEvent('GuiListBox')).value as { guiId: number; items: string[] };
    assert.deepEqual(listPush.items, ['a', 'b', 'c']);
    c.sendEvent('GuiReply', { guiId: listPush.guiId, data: { index: 2 } });
    assert.deepEqual((await list).data, { index: 2 });
    c.close();
    await c.closed;
  });

  await t.test('another player cannot answer your dialog, and a reply lands once', async () => {
    const { c: a, playerId: aId } = await join(server, 'GuiOwner');
    const { c: b } = await join(server, 'GuiThief');
    const pending = server.api.gui.messageBox(aId, 'Secret', ['ok']);
    const push = (await a.waitEvent('GuiMessageBox')).value as { guiId: number };
    b.sendEvent('GuiReply', { guiId: push.guiId, data: { button: 0 } }); // not yours
    b.sendEvent('GuiReply', { guiId: 999999 });                          // unknown id
    b.sendEvent('GuiReply', {});                                         // malformed
    await fence(b, a);
    assert.equal(server.api.world.pendingGuiCount(), 1, 'the dialog is still open');
    a.sendEvent('GuiReply', { guiId: push.guiId, data: { button: 0 } });
    assert.equal((await pending).answered, true);
    a.sendEvent('GuiReply', { guiId: push.guiId, data: { button: 1 } }); // late double reply
    await fence(a, b);
    await settles(() => server.api.world.pendingGuiCount(), 0, 'pending dialogs');
    a.close(); b.close();
    await a.closed; await b.closed;
  });

  await t.test('an unanswered dialog times out instead of hanging', async () => {
    const { c, playerId } = await join(server, 'GuiSilent');
    const pending = server.api.gui.messageBox(playerId, 'ignored', ['ok']);
    await c.waitEvent('GuiMessageBox');
    const result = await pending;
    assert.equal(result.answered, false);
    assert.equal(result.reason, 'timeout');
    await settles(() => server.api.world.pendingGuiCount(), 0, 'pending dialogs');
    c.close();
    await c.closed;
  });

  await t.test('disconnecting mid-dialog settles the promise and leaks nothing', async () => {
    const { c, playerId } = await join(server, 'GuiQuitter');
    const pending = server.api.gui.messageBox(playerId, 'still there?', ['yes']);
    await c.waitEvent('GuiMessageBox');
    assert.equal(server.api.world.pendingGuiCount(), 1);
    c.close();
    await c.closed;
    const result = await pending;
    assert.equal(result.answered, false);
    assert.equal(result.reason, 'disconnect');
    await settles(() => server.api.world.pendingGuiCount(), 0, 'pending dialogs');
  });

  await t.test('pushing to someone who is gone resolves immediately', async () => {
    const result = await server.api.gui.messageBox(65000, 'nobody home');
    assert.equal(result.answered, false);
    assert.equal(result.reason, 'offline');
    assert.equal(server.api.world.pendingGuiCount(), 0);
  });
});
