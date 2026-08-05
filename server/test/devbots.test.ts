// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// DEV/TEST BOTS: a friend request and a party invite must be ACCEPTED, through the same
// social path a human uses — and the feature must stay off unless asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { AccountStore } from '../src/core/accounts';
import { PlayerStore } from '../src/persist/playerstore';

// Real Morrowind record ids, taken from characters that actually exist on the dev server —
// not invented, because a wrong content id produces a broken puppet.
const LOOK = {
  botRace: 'dark elf', botHead: 'b_n_dark elf_m_head_01',
  botHair: 'b_n_dark elf_m_hair_01', botClass: 'acrobat',
};
const BOTS = {
  dev: { bots: 2, botPrefix: 'Bot', botNames: ['Bot1', 'Bot2'], ...LOOK },
  rules: { respawnCellKey: '-2,-9', respawnX: -10350, respawnY: -71235, respawnZ: 167 },
  login: { allowHarnessAuth: true },
};

async function boot(t: { after(fn: () => unknown): void }, override: unknown) {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: override as never,
  });
  t.after(() => server.close());
  return server;
}

test('a bot accepts a friend request, then a party invite', async (t) => {
  const server = await boot(t, BOTS);

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Human', 'hunter22');

  // The bots are in the roster like anyone else — that is what makes them useful for a video.
  const names = server.api.players().map((p) => p.name);
  assert.ok(names.includes('Bot1'), `expected Bot1 in the roster, got ${names.join(', ')}`);

  // FRIEND. The client sends a NAME (what a player types/clicks); the bot answers FriendAccept.
  a.sendEvent('FriendRequest', { name: 'Bot1' });
  const friends = await a.waitEvent('FriendList',
    (v) => ((v as { friends?: { acct: string }[] }).friends ?? []).some((f) => f.acct === 'bot1'));
  assert.ok(friends, 'the bot never became a friend');

  // PARTY. Same shape: invite by name, the bot answers PartyAccept and appears as a member.
  a.sendEvent('PartyInvite', { name: 'Bot1' });
  const party = await a.waitEvent('PartyUpdate',
    (v) => ((v as { members?: { acct: string }[] }).members ?? []).some((m) => m.acct === 'bot1'));
  assert.ok(party, 'the bot never joined the party');
});

test('bots are OFF unless asked for', async (t) => {
  const server = await boot(t, { login: { allowHarnessAuth: true } });
  const names = server.api.players().map((p) => p.name);
  assert.deepEqual(names.filter((n) => n.startsWith('Bot')), [],
    'dev bots must never appear on a server that did not enable them');
});

// AN ACCOUNT IS A PRECONDITION, NOT A SIDE EFFECT. Account creation used to be fire-and-forget
// while the bot joined the roster immediately, so for the first moments after boot a bot was
// visible but unreachable: a friend request resolves a typed NAME through the account index.
// That race would only ever surface as "the bot ignored me". And register() answers 'exists'
// on the second boot, which skipped the username — leaving a bot whose first attempt failed
// permanently without a handle.
test('every bot has a real account and public handle, and a restart reuses it', async (t) => {
  const dataDir = tmpDataDir();
  const opts = {
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: BOTS as never,
  };

  const first = await startServer(opts);
  // Closed BEFORE reading: the account store is write-behind, so a fresh reader would see
  // whatever had reached disk rather than what the bots actually have.
  await first.close();

  const seen = new AccountStore(dataDir);
  for (const name of ['Bot1', 'Bot2']) {
    const acct = await seen.get(name);
    assert.ok(acct, `${name} joined the roster with no account — unreachable by name`);
    assert.equal(acct.username, name, `${name} has no public handle`);
  }
  const createdAt = (await seen.get('Bot1'))!.createdAt;

  // Second boot: the same account, not a duplicate or a fresh one.
  const second = await startServer(opts);
  t.after(() => second.close());
  const after = new AccountStore(dataDir);
  assert.equal((await after.get('Bot1'))?.createdAt, createdAt, 'the bot account was recreated');
  assert.equal((await after.get('Bot1'))?.username, 'Bot1');
});

// A BOT IS A CHARACTER, NOT JUST AN ACCOUNT — and it stands where players begin. An account
// with no character has no slot, no doc and no position, so nothing that reads a character
// (the Players panel, a party row, the world) has anything to show.
test('each bot has a completed character standing in the starter village', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: BOTS as never,
  });
  await server.close(); // write-behind stores: read what they actually hold

  const accounts = new AccountStore(dataDir);
  const acct = await accounts.get('Bot1');
  assert.ok(acct, 'Bot1 has no account');
  const slot = (acct.characters ?? [])[0];
  assert.ok(slot, 'Bot1 has an account but no character');
  assert.equal(slot.name, 'Bot1');
  assert.equal(slot.completed, true, 'an incomplete slot reads as creation-in-progress');

  const players = new PlayerStore(dataDir, 'default');
  const doc = await players.get(slot.id);
  assert.equal(doc?.position?.cellKey, '-2,-9', 'the bot is not in the starter village');
  // Appearance is what spawns a puppet for other clients; handleAppearance refuses a partial
  // one, so all four required fields must be present or none.
  assert.equal(doc?.appearance?.name, 'Bot1');
  assert.equal(doc?.appearance?.race, 'dark elf');
});

// Content ids are deployment-specific, so an unconfigured server must NOT invent them: a
// broken puppet is worse than no puppet.
test('without configured content ids a bot is social-only, never half-dressed', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: { dev: { bots: 1, botPrefix: 'Bot', botNames: ['Bot1'] }, login: { allowHarnessAuth: true } } as never,
  });
  await server.close();

  const accounts = new AccountStore(dataDir);
  const slot = ((await accounts.get('Bot1'))?.characters ?? [])[0];
  assert.ok(slot, 'the bot should still have a character');
  const doc = await new PlayerStore(dataDir, 'default').get(slot.id);
  assert.equal(doc?.appearance, undefined, 'a partial appearance would withhold the record');
  assert.ok(doc?.position, 'it still stands somewhere');
});

// PRESSURE: A WORLD FULL OF BOTS IS AN EMPTY WORLD. Bots are not system peers, so every
// human-facing count included them — which means /status connectedCount never reaches zero,
// the gateway's idle reaper never fires, and the sim peer never goes idle. A dev server with
// bots on would hold a world (and a headless engine) open forever, and every bot would eat a
// maxPlayers slot that a real player could not then use. They must be visible WITHOUT being
// occupants for the purposes of capacity and lifecycle.
test('bots do not hold a world open or consume player slots', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { ...BOTS, server: { maxPlayers: 4 } } as never,
  });
  t.after(() => server.close());

  // The visible roster shows them — that is the whole point of the feature.
  const names = server.api.players().map((p) => p.name);
  assert.ok(names.includes('Bot1') && names.includes('Bot2'), 'bots must be visible to players');

  // /status is what the GATEWAY reads to decide whether a world is occupied, and what the
  // world itself reads to decide whether the sim peer may sleep.
  const st = await (await fetch(`http://127.0.0.1:${server.port}/status`)).json() as
    { playerCount: number; connectedCount: number };
  assert.equal(st.connectedCount, 0,
    'bots counted as connected humans: the world never idles, the sim peer never sleeps, '
    + 'and each bot eats a maxPlayers slot a real player then cannot use');
});

// PRESSURE: the flows a video (or a bored tester) will actually hit — repeatedly, out of
// order, and from more than one person. A bot that only works once, or that answers a request
// it should refuse, is worse than no bot: it would "prove" a broken feature works.
test('bots survive repeat invites, several humans, and refusals', async (t) => {
  const server = await startServer({
    requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { dev: { bots: 4, botPrefix: 'Bot', botNames: ['Bot1', 'Bot2', 'Bot3', 'Bot4'] },
      login: { allowHarnessAuth: true } } as never,
  });
  t.after(() => server.close());

  const a = await TestClient.connect(server.port);
  t.after(() => a.close());
  await a.joinAsNew('Ann', 'hunter22');
  const b = await TestClient.connect(server.port);
  t.after(() => b.close());
  await b.joinAsNew('Bob', 'hunter22');

  // 1. Two humans befriend the SAME bot. A bot is not exclusive.
  a.sendEvent('FriendRequest', { name: 'Bot1' });
  await a.waitEvent('FriendList',
    (v) => ((v as { friends?: { acct: string }[] }).friends ?? []).some((f) => f.acct === 'bot1'));
  b.sendEvent('FriendRequest', { name: 'Bot1' });
  await b.waitEvent('FriendList',
    (v) => ((v as { friends?: { acct: string }[] }).friends ?? []).some((f) => f.acct === 'bot1'));

  // 2. Re-sending a request to a bot that is ALREADY a friend must not break anything.
  a.sendEvent('FriendRequest', { name: 'Bot1' });
  a.sendEvent('FriendRequest', { name: 'Bot1' });

  // 3. Several bots into one party, and the party keeps every one of them.
  for (const n of ['Bot1', 'Bot2', 'Bot3']) a.sendEvent('PartyInvite', { name: n });
  const full = await a.waitEvent('PartyUpdate', (v) => {
    const m = (v as { members?: { acct: string }[] }).members ?? [];
    return ['bot1', 'bot2', 'bot3'].every((x) => m.some((y) => y.acct === x));
  }, 15000);
  assert.ok(full, 'the party lost bots along the way');

  // 4. A BLOCKED bot must not be befriendable — the accept runs through the same guards a
  //    human hits, so blocking has to win.
  b.sendEvent('BlockAdd', { name: 'Bot4' });
  await b.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'BlockAdd');
  b.sendEvent('FriendRequest', { name: 'Bot4' });
  const refused = await b.waitEvent('SocialResult',
    (v) => (v as { op?: string; ok?: boolean }).op === 'FriendRequest'
      && (v as { ok?: boolean }).ok === false, 8000).catch(() => null);
  assert.ok(refused, 'a blocked bot still accepted a friend request');
});

// REAL HANDLES. "Bot1" standing in town reads as scaffolding on camera, so the default names
// are player-looking — and an invalid one must fall back rather than silently produce a bot
// with no public handle (a handle is letters and digits, 3-20).
test('bots take real usernames, and a bad one falls back instead of breaking', async (t) => {
  const dataDir = tmpDataDir();
  const server = await startServer({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1',
    configOverride: {
      dev: { bots: 3, botPrefix: 'Bot', botNames: ['Kestrel', 'no', 'Talvyn'] },
      login: { allowHarnessAuth: true },
    } as never,
  });
  const names = server.api.players().map((p) => p.name);
  await server.close();

  assert.ok(names.includes('Kestrel'), `expected Kestrel, got ${names.join(', ')}`);
  assert.ok(names.includes('Talvyn'), `expected Talvyn, got ${names.join(', ')}`);
  // 'no' is too short for a handle: fall back rather than create an unnamed bot.
  assert.ok(names.includes('Bot2'), `expected the rejected name to fall back, got ${names.join(', ')}`);

  const acct = await new AccountStore(dataDir).get('Kestrel');
  assert.equal(acct?.username, 'Kestrel', 'the handle must reach the account');
});

// A BOT IS A PLAYER, AND A PLAYER IS IN ONE WORLD AT A TIME.
//
// Every world is its own process reading the same shared config, so starting bots in each one
// put a copy of every bot in every world simultaneously — that is scenery, not a player. The
// behaviour asked for is: they hang out in PUBLIC, you befriend and party them there, and when
// you switch worlds they come WITH you and stop being in the one you left.
//
// Presence is derived, and each world derives it alone: party membership lives in the shared
// store, so a bot belongs wherever a member of its party actually is, and an unpartied bot
// belongs in public. Two world processes over one data dir is exactly the real topology.
test('an unpartied bot is only in public; a partied one follows the player', async (t) => {
  const dataDir = tmpDataDir();
  const cfg = (mode: string) => ({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: mode,
    configOverride: {
      dev: { bots: 1, botPrefix: 'Bot', botNames: ['Kestrel'] },
      login: { allowHarnessAuth: true },
    } as never,
  });

  const pub = await startServer(cfg('public'));
  t.after(() => pub.close());
  const priv = await startServer(cfg('private'));
  t.after(() => priv.close());

  const inWorld = (s: { api: { players(): { name: string }[] } }): string[] =>
    s.api.players().map((p) => p.name);

  // Unpartied: public only. The private world must NOT be showing a second copy.
  assert.ok(inWorld(pub).includes('Kestrel'), 'the bot should hang out in public');
  assert.ok(!inWorld(priv).includes('Kestrel'),
    'the bot is in a world nobody invited it to — that is scenery, not a player');

  // Party with it from PUBLIC, the way a player would.
  const a = await TestClient.connect(pub.port);
  t.after(() => a.close());
  await a.joinAsNew('Ann', 'hunter22');
  a.sendEvent('PartyInvite', { name: 'Kestrel' });
  await a.waitEvent('PartyUpdate',
    (v) => ((v as { members?: { acct: string }[] }).members ?? []).some((m) => m.acct === 'kestrel'));

  // Now the SWITCH, modelled the way it really happens: the client dials the new world and
  // the old socket goes away. Leaving both connected would put one player in two worlds at
  // once, which no real switch can do — and the public world would be right to keep the bot,
  // because a party member genuinely would still be standing there.
  const b = await TestClient.connect(priv.port);
  t.after(() => b.close());
  await b.joinExisting('Ann', 'hunter22');
  a.close();

  // The bot follows: present where the player is, gone from the world they left.
  const followed = await waitFor(() => inWorld(priv).includes('Kestrel'), 12000);
  assert.ok(followed, 'the bot did not follow its party into the private world');
  const left = await waitFor(() => !inWorld(pub).includes('Kestrel'), 12000);
  assert.ok(left, 'the bot is still standing in public while partied elsewhere — two copies');
});

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return cond();
}

// PRESENCE IS SERVER-WIDE, NOT PER-WORLD. Every world is its own process with its own roster,
// so asking the local roster answered "is my friend online?" with "is my friend in MY world?".
// A friend in their own solo world read as offline, a party member elsewhere had no location,
// and the Players list showed one world's population as if it were the server's — so from solo
// there was nobody to see or invite.
test('players in another world are visible and online from here', async (t) => {
  const dataDir = tmpDataDir();
  const cfg = (mode: string) => ({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: mode,
    worldId: mode === 'public' ? 'vvardenfell' : 'priv-someone',
    configOverride: {
      dev: { bots: 1, botPrefix: 'Bot', botNames: ['Kestrel'] },
      login: { allowHarnessAuth: true },
    } as never,
  });

  const pub = await startServer(cfg('public'));
  t.after(() => pub.close());
  const priv = await startServer(cfg('private'));
  t.after(() => priv.close());

  // Ann is in the PRIVATE world; Kestrel the bot is in PUBLIC.
  const ann = await TestClient.connect(priv.port);
  t.after(() => ann.close());
  await ann.joinAsNew('Ann', 'hunter22');

  // The shared roster must REACH HER — asserted on what the client receives, which is what
  // the panel actually renders, rather than on server-side bookkeeping.
  const list = await ann.waitEvent('PlayerList',
    (v) => ((v as { players?: { name: string }[] }).players ?? []).some((p) => p.name === 'Kestrel'),
    20000).catch(() => null);
  assert.ok(list,
    'a player in another world never reached this one — nobody to see or invite from solo');
});

// A PARTY MEMBER IS ONLINE BY DEFINITION — you cannot be in a party without being connected.
// partyView asked the LOCAL roster, so a member in another world read as "Offline" while the
// player could see them standing there. Same bug as the friend list, one function over.
// And the leader can now REMOVE someone: leaving was the only way out, so a leader stuck with
// a member had to disband the whole party to be rid of them.
test('a party member in another world reads online, and the leader can remove them', async (t) => {
  const dataDir = tmpDataDir();
  const cfg = (mode: string) => ({
    requireGameData: false, dataDir, port: 0, host: '127.0.0.1', worldMode: mode,
    worldId: mode === 'public' ? 'vvardenfell' : 'priv-someone',
    configOverride: {
      dev: { bots: 1, botPrefix: 'Bot', botNames: ['Kestrel'] },
      login: { allowHarnessAuth: true },
    } as never,
  });
  const pub = await startServer(cfg('public'));
  t.after(() => pub.close());
  const priv = await startServer(cfg('private'));
  t.after(() => priv.close());

  // Party with the bot in PUBLIC, then move to the private world and look at the panel.
  const a = await TestClient.connect(pub.port);
  t.after(() => a.close());
  await a.joinAsNew('Ann', 'hunter22');
  a.sendEvent('PartyInvite', { name: 'Kestrel' });
  await a.waitEvent('PartyUpdate',
    (v) => ((v as { members?: { acct: string }[] }).members ?? []).some((m) => m.acct === 'kestrel'));

  const b = await TestClient.connect(priv.port);
  t.after(() => b.close());
  await b.joinExisting('Ann', 'hunter22');
  a.close();

  const view = await b.waitEvent('PartyUpdate', (v) => {
    const m = ((v as { members?: { acct: string; online?: boolean }[] }).members ?? [])
      .find((x) => x.acct === 'kestrel');
    return m !== undefined && m.online === true;
  }, 20000).catch(() => null);
  assert.ok(view, 'a party member in another world reads as offline — impossible, and visible');

  // The leader removes them.
  b.sendEvent('PartyKick', { acct: 'kestrel' });
  const gone = await b.waitEvent('PartyUpdate',
    (v) => !((v as { members?: { acct: string }[] }).members ?? []).some((m) => m.acct === 'kestrel'),
    15000).catch(() => null);
  assert.ok(gone, 'the leader could not remove a party member');
});
