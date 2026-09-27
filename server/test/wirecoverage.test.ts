// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE SIX CLIENT->SERVER MESSAGES NO TEST SENT (MP-READINESS-AUDIT, item 3). Each handler was
// reachable only through a browser: the talked-to write lands on the character doc, the two
// social un-actions (unblock, unmute) are safety controls, and PresenceMode/SetAvailability were
// once silently broken at exactly this layer -- the client's generic router puts the argument in
// `acct`, and a handler reading only `mode` refused every privacy change. Each is sent here over
// the real WebSocket and its effect asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir, readPlayerDoc } from './helpers';

const CFG = { limits: { maxConnsPerIp: 16 } };
async function boot(t: { after(fn: () => unknown): void }) {
  const dataDir = tmpDataDir();
  const server = await startServer({ requireGameData: false, dataDir, port: 0, host: '127.0.0.1', configOverride: CFG as never });
  t.after(() => server.close());
  return { server, dataDir };
}
async function player(t: { after(fn: () => unknown): void }, port: number, name: string) {
  const c = await TestClient.connect(port);
  t.after(() => c.close());
  const { welcome } = await c.joinAsNew(name, 'hunter22');
  await c.waitEvent('PlayerList');
  return { c, charId: String(welcome['characterId']) };
}
const result = async (c: TestClient, op: string) =>
  (await c.waitEvent('SocialResult', (v) => (v as { op?: string }).op === op)).value as { ok: boolean; detail: string };

test('PlayerTalkedTo lands the NPCs spoken to on the character doc, deduplicated; a non-content ref is refused', async (t) => {
  const { server, dataDir } = await boot(t);
  const { c, charId } = await player(t, server.port, 'Talker');
  const npc = (i: number) => ({ ref: { __refnum: { index: i, contentFile: 0 } } }); // as identity.lua sends: { ref = obj }
  c.sendEvent('PlayerTalkedTo', { list: [npc(11), npc(12)] });
  c.sendEvent('PlayerTalkedTo', { list: [npc(12), npc(13)] });
  c.sendEvent('PlayerTalkedTo', { list: [{ name: 'not a content ref' }] }); // anything but a content refnum is refused
  await c.waitEvent('StateRefused', (v) => (v as { kind?: string }).kind === 'PlayerTalkedTo');
  await server.flush();
  const doc = readPlayerDoc(dataDir, charId) as { talkedTo?: string[] } | undefined;
  assert.deepEqual([...(doc?.talkedTo ?? [])].sort(), ['c:11:0', 'c:12:0', 'c:13:0'], 'the talked-to set did not land once each');
});

test('BlockRemove lifts a block: a friend request refused as blocked goes through after it', async (t) => {
  const { server } = await boot(t);
  const { c: a } = await player(t, server.port, 'Alice');
  const { c: b } = await player(t, server.port, 'Bob');
  a.sendEvent('BlockAdd', { name: 'Bob' });
  assert.equal((await result(a, 'BlockAdd')).ok, true);
  b.sendEvent('FriendRequest', { name: 'Alice' });
  assert.equal((await result(b, 'FriendRequest')).detail, 'blocked', 'a blocked player could still send a request');
  a.sendEvent('BlockRemove', { acct: 'bob' });
  assert.equal((await result(a, 'BlockRemove')).ok, true);
  b.sendEvent('FriendRequest', { name: 'Alice' });
  const after = await result(b, 'FriendRequest');
  assert.equal(after.ok, true, 'the request was still refused after the block was lifted: ' + after.detail);
});

test('MuteRemove lifts a mute: the speaker is heard again', async (t) => {
  const { server } = await boot(t);
  const { c: quiet } = await player(t, server.port, 'Quiet');
  const { c: loud } = await player(t, server.port, 'Loud');
  quiet.sendEvent('MuteAdd', { name: 'Loud' });
  await result(quiet, 'MuteAdd');
  loud.sendEvent('ChatSend', { channel: 'global', text: 'muted line' });
  await loud.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'muted line');
  const heardMuted = await quiet.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'muted line', 600).then(() => true, () => false);
  assert.equal(heardMuted, false, 'a muted speaker was heard');
  quiet.sendEvent('MuteRemove', { acct: 'loud' });
  assert.equal((await result(quiet, 'MuteRemove')).ok, true);
  loud.sendEvent('ChatSend', { channel: 'global', text: 'heard again' });
  await quiet.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'heard again');
});

test('WorldCreate on a server with no gateway answers, instead of leaving the client waiting', async (t) => {
  const { server } = await boot(t);
  const { c } = await player(t, server.port, 'Builder');
  c.sendEvent('WorldCreate', { id: 'mine', mode: 'party' });
  const got = (await c.waitEvent('WorldCreate')).value as { ok: boolean; error: string };
  assert.deepEqual(got, { ok: false, error: 'no_gateway' });
});

test('PresenceMode takes the mode in either field (the client router sends it as acct), and refuses nonsense', async (t) => {
  const { server } = await boot(t);
  const { c } = await player(t, server.port, 'Hermit');
  c.sendEvent('PresenceMode', { acct: 'private' });
  assert.deepEqual(await result(c, 'PresenceMode'), { op: 'PresenceMode', ok: true, detail: 'private' });
  c.sendEvent('PresenceMode', { mode: 'friends' });
  assert.deepEqual(await result(c, 'PresenceMode'), { op: 'PresenceMode', ok: true, detail: 'friends' });
  c.sendEvent('PresenceMode', { mode: 'everyone-ever' });
  assert.equal((await result(c, 'PresenceMode')).ok, false);
});

test('SetAvailability takes the state in either field, and refuses nonsense', async (t) => {
  const { server } = await boot(t);
  const { c } = await player(t, server.port, 'Napper');
  c.sendEvent('SetAvailability', { acct: 'offline' });
  assert.deepEqual(await result(c, 'SetAvailability'), { op: 'SetAvailability', ok: true, detail: 'offline' });
  c.sendEvent('SetAvailability', { state: 'online' });
  assert.deepEqual(await result(c, 'SetAvailability'), { op: 'SetAvailability', ok: true, detail: 'online' });
  c.sendEvent('SetAvailability', { state: 'maybe' });
  assert.equal((await result(c, 'SetAvailability')).ok, false);
});
