// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Companions to test the social features against: they sit in the world, answer chat, and
// accept whatever you send them. soak.ts already covers load (movement, combat, containers);
// this covers the things that need a WILLING SECOND PLAYER — friend requests, party invites,
// travel. Kept dumb on purpose: every bot auto-accepts, so anything you send resolves.
//
//   npx tsx bots/lobby-bots.ts --port 9000 --data /tmp/omw-local-data [--names Ashka,Drels]
//
// Auth: bots take the SAME door as a real player — an SSO login ticket. The account row and
// the ticket are the pair of rows the SSO callback writes, so the server's SSO-only posture is
// unchanged and no password path is opened.
//
// --tickets: pre-minted, for when the server's data dir is NOT on this filesystem. A container
// bind mount on macOS does not share SQLite's WAL shared-memory, so a ticket written from the
// host is invisible to a world process that already has the database open. Mint inside the
// container in that case and pass the strings in.
//
// ponytail: no CLI framework, no state machine — a switch on the event name is the whole bot.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { TestClient } from '../test/helpers';

const arg = (flag: string, dflt: string): string => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : dflt;
};

const port = Number(arg('--port', '9000'));
const names = arg('--names', '').split(',').filter(Boolean);
const count = names.length || Number(arg('--bots', '3'));
const roster = names.length ? names : Array.from({ length: count }, (_, i) => `Bot${i + 1}`);

const dataDir = arg('--data', '/tmp/omw-local-data');
const preMinted = arg('--tickets', '').split(',').filter(Boolean);

// Create the account if it is new, then mint a single-use login ticket for it — exactly the
// pair of rows the SSO callback writes. Tickets are 15-minute and single-use, so one per join.
function mintTicket(name: string): string {
  const key = name.toLowerCase();
  const accounts = new DatabaseSync(join(dataDir, 'accounts.db'));
  const now = new Date().toISOString();
  const row = accounts.prepare('SELECT doc FROM accounts WHERE key = ?').get(key) as { doc: string } | undefined;
  if (!row) {
    // A COMPLETED character: the shared world refuses anyone still in creation, which is the
    // right rule for players and just means a bot has to arrive pre-made.
    accounts.prepare('INSERT INTO accounts (key, doc) VALUES (?, ?)').run(key, JSON.stringify({
      name, createdAt: now, lastSeenAt: now, rank: 0, username: name,
      characters: [{ id: `c${randomBytes(12).toString('hex')}`, name, createdAt: now, lastPlayedAt: now, completed: true }],
    }));
    accounts.prepare('INSERT OR REPLACE INTO usernames (username, accountKey, reservedUntil) VALUES (?, ?, NULL)')
      .run(key, key);
  }
  accounts.close();
  // ...and a player doc WITH an appearance: the shared world's chargen gate is "has this
  // character actually been created", and an appearance is what proves it.
  const players = new DatabaseSync(join(dataDir, 'players.db'));
  const charId = (JSON.parse((new DatabaseSync(join(dataDir, 'accounts.db')))
    .prepare('SELECT doc FROM accounts WHERE key = ?').get(key)!.doc as string) as
    { characters: { id: string }[] }).characters[0]!.id;
  players.prepare('INSERT OR REPLACE INTO players (key, doc) VALUES (?, ?)').run(charId, JSON.stringify({
    appearance: { race: 'dark elf', head: 'b_n_dark elf_m_head_01', hair: 'b_n_dark elf_m_hair_02',
      isMale: true, class: 'nightblade', name },
  }));
  players.close();
  const ticket = randomBytes(32).toString('base64url');
  const tickets = new DatabaseSync(join(dataDir, 'tickets.db'));
  tickets.prepare('INSERT OR REPLACE INTO tickets (ticket, accountKey, accountName, expiresAt) VALUES (?, ?, ?, ?)')
    .run(ticket, key, name, Date.now() + 15 * 60_000);
  tickets.close();
  return ticket;
}

const REPLIES = [
  'hey', 'ready when you are', 'nice one', 'on my way', 'still here',
  'invite me', 'what are we doing', 'following you',
];

async function bot(name: string): Promise<void> {
  const c = await TestClient.connect(port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  const ticket = preMinted[roster.indexOf(name)] ?? mintTicket(name);
  c.sendJson({ t: 'SessionLoginTicket', ticket });
  await c.waitJson('SessionWelcome');
  c.sendJson({ t: 'SessionReady' });
  await c.waitEvent('PlayerList');
  // Look like a real character so the social panel shows a person, not a blank row.
  c.sendEvent('PlayerAppearance', {
    race: 'dark elf', head: 'b_n_dark elf_m_head_01', hair: 'b_n_dark elf_m_hair_02',
    isMale: true, class: 'nightblade', name,
  });
  console.log(`[${name}] in world`);

  // TestClient queues events in `inbox`; drain it rather than adding a callback to a helper
  // the whole test suite shares.
  let cursor = 0;
  const handle = (evt: string, value: unknown): void => {
    const v = (value ?? {}) as Record<string, unknown>;
    const from = String(v['acct'] ?? v['fromAcct'] ?? v['account'] ?? v['name'] ?? '');
    switch (evt) {
      case 'FriendRequestReceived':
        console.log(`[${name}] friend request from ${from} -> accepting`);
        c.sendEvent('FriendAccept', { acct: from });
        break;
      case 'PartyInviteReceived':
        console.log(`[${name}] party invite from ${from} -> accepting`);
        c.sendEvent('PartyAccept', { acct: from });
        break;
      case 'InviteReceived':
        console.log(`[${name}] world invite from ${from} -> accepting`);
        c.sendEvent('InviteAccept', { acct: from });
        break;
      case 'ChatMessage': {
        const text = String(v['text'] ?? '');
        const who = String(v['from'] ?? '');
        // Answer PEOPLE only. Bots replying to bots is an infinite loop that floods the
        // channel and drowns the message you are actually testing.
        if (!text || roster.some((r) => r.toLowerCase() === who.toLowerCase())) break;
        console.log(`[${name}] <- ${who}: ${text}`);
        // Reply on the channel it arrived on, so party chat stays in the party.
        const channel = String(v['channel'] ?? 'global');
        setTimeout(() => c.sendEvent('ChatSend', {
          text: REPLIES[Math.floor(Math.random() * REPLIES.length)]!,
          channel: channel === 'whisper' ? 'whisper' : channel,
          ...(channel === 'whisper' ? { to: who.toLowerCase() } : {}),
        }), 700);
        break;
      }
      default:
        break;
    }
  };
  setInterval(() => {
    for (; cursor < c.inbox.events.length; cursor++) {
      const e = c.inbox.events[cursor]!;
      try { handle(e.name, e.value); } catch (err) { console.error(`[${name}]`, err); }
    }
  }, 200);

  // A pose every second: without movement the bot is not a visible player to anyone else.
  setInterval(() => c.sendMove({ x: Math.random() * 200, y: Math.random() * 200, z: 0 }), 1000);
}

await Promise.all(roster.map((n) => bot(n).catch((e) => console.error(`[${n}] failed:`, e))));
console.log(`\n${roster.length} bots online: ${roster.join(', ')}\nCtrl+C to stop.`);
