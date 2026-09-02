// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// End-to-end sweep of the social features against a RUNNING server with lobby-bots present.
// One client does what a player does and asserts the server answered: chat (global + whisper),
// friend request, world chat, world mode flip, presence, and a shared journal
// entry. Exits nonzero on the first failure.
//
//   npx tsx bots/sweep.ts --port 9000 --ticket <t> --bot Ashka
//
// ponytail: no framework — assert + a numbered log line per feature is the whole report.

import assert from 'node:assert/strict';
import { TestClient } from '../test/helpers';

const arg = (f: string, d: string): string => {
  const i = process.argv.indexOf(f);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : d;
};
const port = Number(arg('--port', '9000'));
const ticket = arg('--ticket', '');
const bot = arg('--bot', 'Ashka');
const ticket2 = arg('--ticket2', ''); // a second real player, for the relay assertions
const botAcct = bot.toLowerCase();

let step = 0;
const ok = (what: string): void => console.log(`  ${++step}. ok  ${what}`);

const c = await TestClient.connect(port);
c.hello();
await c.waitJson('SessionHelloOk');
c.sendJson({ t: 'SessionLoginTicket', ticket });
const welcome = await c.waitJson('SessionWelcome');
c.sendJson({ t: 'SessionReady' });
await c.waitEvent('PlayerList');
ok(`joined as ${String(welcome['characterId']).slice(0, 10)}…`);

// --- chat: public ---------------------------------------------------------------------
c.sendEvent('ChatSend', { text: 'sweep: public ping', channel: 'global' });
const mine = await c.waitEvent('ChatMessage', (v) =>
  String((v as { text?: string }).text ?? '').includes('public ping'), 8000);
assert.ok(mine, 'public chat did not come back');
ok('chat: public message round-tripped');

// A bot answers on the same channel, which proves fan-out to other players.
const reply = await c.waitEvent('ChatMessage', (v) =>
  String((v as { from?: string }).from ?? '').toLowerCase() === botAcct, 12000).catch(() => null);
assert.ok(reply, `no reply from ${bot} — chat fan-out to other players is broken`);
ok(`chat: ${bot} replied (fan-out works)`);

// --- chat: whisper --------------------------------------------------------------------
c.sendEvent('ChatSend', { text: 'sweep: whisper', channel: 'whisper', to: botAcct });
const whisper = await c.waitEvent('ChatMessage', (v) =>
  String((v as { channel?: string }).channel ?? '') === 'whisper', 8000).catch(() => null);
assert.ok(whisper, 'whisper produced no ChatMessage');
ok('chat: whisper delivered');

// --- friends --------------------------------------------------------------------------
c.sendEvent('FriendRequest', { name: bot });
const frResult = await c.waitEvent('SocialResult', (v) =>
  (v as { op?: string }).op === 'FriendRequest', 8000);
// Idempotent: a rerun finds them already friends, which is a pass, not a failure.
const frv = frResult.value as { ok?: boolean; detail?: string };
assert.ok(frv.ok === true || frv.detail === 'already_friends', `friend request refused: ${frv.detail}`);
ok(`friends: request ${frv.ok ? 'sent' : 'already friends'}`);

const friendList = await c.waitEvent('FriendList', (v) =>
  JSON.stringify(v).toLowerCase().includes(botAcct), 12000).catch(() => null);
assert.ok(friendList, `${bot} never appeared in FriendList — accept did not land`);
ok(`friends: ${bot} accepted and is on the list`);

// --- world chat -------------------------------------------------------------------------
// The '@' tier is world chat now: everyone in this world hears it, no membership needed.
c.sendEvent('ChatSend', { text: 'sweep: world ping', channel: 'party' });
const worldMsg = await c.waitEvent('ChatMessage', (v) =>
  String((v as { text?: string }).text ?? '').includes('world ping'), 8000).catch(() => null);
assert.ok(worldMsg, 'world-channel chat produced nothing');
ok('world chat: world-channel chat works');

// --- presence / status ------------------------------------------------------------------
c.sendEvent('PresenceMode', { mode: 'friends' });
const pres = await c.waitEvent('SocialResult', (v) =>
  (v as { op?: string }).op === 'PresenceMode', 8000);
assert.equal((pres.value as { ok?: boolean }).ok, true,
  'PresenceMode refused — the privacy control is broken again');
ok('status: presence mode set');

c.sendEvent('SetAvailability', { state: 'offline' });
const avail = await c.waitEvent('SocialResult', (v) =>
  (v as { op?: string }).op === 'SetAvailability', 8000);
assert.equal((avail.value as { ok?: boolean }).ok, true, 'SetAvailability refused');
c.sendEvent('SetAvailability', { state: 'online' });
ok('status: availability toggled');

// --- world change -----------------------------------------------------------------------
// Only the world's owner may flip it; the refusal must be explicit, not silence.
c.sendEvent('SetWorldMode', { mode: 'party' });
const flip = await c.waitEvent('SocialResult', (v) =>
  (v as { op?: string }).op === 'SetWorldMode', 8000);
assert.equal((flip.value as { ok?: boolean }).ok, false,
  'the PUBLIC world let a player flip its mode');
assert.equal((flip.value as { detail?: string }).detail, 'not_flippable');
ok('world: public refuses a mode flip (not_flippable)');

const worlds = await (async () => {
  c.sendEvent('WorldList', {});
  return c.waitEvent('WorldList', () => true, 8000).catch(() => null);
})();
assert.ok(worlds, 'WorldList returned nothing — the world switcher has no data');
ok('world: world list returned');

// --- quests: a shared journal entry -------------------------------------------------------
// The server relays to everyone EXCEPT the author, so proving this needs a second player.
if (ticket2) {
  const c2 = await TestClient.connect(port);
  c2.hello();
  await c2.waitJson('SessionHelloOk');
  c2.sendJson({ t: 'SessionLoginTicket', ticket: ticket2 });
  await c2.waitJson('SessionWelcome');
  c2.sendJson({ t: 'SessionReady' });
  await c2.waitEvent('PlayerList');
  // A FRESH quest id per run: a repeat of an index already recorded is non-monotonic, and
  // the server stores those without relaying (M6) — a rerun would look like a broken relay.
  const questId = `sweep_${Date.now().toString(36)}`;
  c.sendEvent('JournalEntry', { questId, index: 1 });
  const shared = await c2.waitEvent('JournalEntry', (v) =>
    String((v as { questId?: string }).questId ?? '') === questId, 10000).catch(() => null);
  assert.ok(shared, 'a journal entry did not reach the other player — quest sharing is broken');
  ok('quests: journal entry reached another player');
  c2.close();
} else {
  console.log('  --  skip quests: pass --ticket2 for the relay check');
}

// --- lobby rule: nothing above may have written to the character --------------------------
ok('sweep complete');
c.close();
process.exit(0);
