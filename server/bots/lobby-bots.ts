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
// WHERE TO STAND. A bot with no cell is in no cell: invisible to everyone and out of range
// for say/local chat. Waiting to learn a cell from someone else's movement only works if a
// human happens to walk across a cell boundary while the bots are up — which is how three
// bots sat "online" and unseeable. Default to Seyda Neen, where chargen leaves you.
const startCell = arg('--cell', '-2,-9');
const startPos = arg('--at', '-12288,-69632,0').split(',').map(Number);
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
      // email AND username: [login] requireProfile gates SessionReady on both, so a bot
      // without an address would hold at ProfileNeeded forever waiting for a picker it has
      // no UI to answer with.
      name, createdAt: now, lastSeenAt: now, rank: 0, username: name,
      email: `${key}@bots.invalid`,
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

  // FOLLOW THE PLAYER. Bots used to sit at the origin sending random poses, which means they
  // are in whatever cell the server defaults to and you never see them. Nobody wants to test
  // against players they cannot find.
  //
  // PlayerCellChange is relayed to EVERY in-world player (playerstate.ts), so a bot learns
  // where you are without knowing a single coordinate — which also means this keeps working
  // wherever chargen drops you, rather than hardcoding Seyda Neen and hoping.
  let follow: { cellKey: string; x: number; y: number; z: number } | null = null;
  let myCell = '';
  const isBot = (who: string): boolean => roster.some((r) => r.toLowerCase() === who.toLowerCase());
  // Stand a few paces off so three bots are not inside each other or inside you.
  const offset = (): number => (Math.random() - 0.5) * 260;

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
      // Where the humans are. Both carry a pose; PlayerCellChange is the one that crosses
      // cells, which is what actually gets a bot into the room with you.
      case 'PlayerCellChange':
      case 'PlayerMove': {
        const who = String(v['name'] ?? '');
        if (who && isBot(who)) break;      // following each other converges them on nothing
        const cell = String(v['cellKey'] ?? '');
        const x = Number(v['x']), y = Number(v['y']), z = Number(v['z']);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) break;
        follow = { cellKey: cell || follow?.cellKey || '', x, y, z };
        if (follow.cellKey && follow.cellKey !== myCell) {
          myCell = follow.cellKey;
          c.sendCellChange(myCell, x + offset(), y + offset(), z);
          console.log(`[${name}] following ${who || 'a player'} into ${myCell}`);
        }
        break;
      }
      default:
        break;
    }
  };
  // Take the starting cell immediately, before any event arrives.
  myCell = startCell;
  c.sendCellChange(myCell, startPos[0]! + offset(), startPos[1]! + offset(), startPos[2] ?? 0);
  follow = { cellKey: myCell, x: startPos[0]!, y: startPos[1]!, z: startPos[2] ?? 0 };

  setInterval(() => {
    for (; cursor < c.inbox.events.length; cursor++) {
      const e = c.inbox.events[cursor]!;
      try { handle(e.name, e.value); } catch (err) { console.error(`[${name}]`, err); }
    }
  }, 200);

  // A pose every second: without movement the bot is not a visible player to anyone else.
  // Once a player is known, mill about NEAR THEM instead of at the origin.
  setInterval(() => {
    if (follow) {
      c.sendMove({ x: follow.x + offset(), y: follow.y + offset(), z: follow.z });
      return;
    }
    c.sendMove({ x: Math.random() * 200, y: Math.random() * 200, z: 0 });
  }, 1000);
}

// Report what actually JOINED, not what was asked for. Printing "3 bots online" while all
// three failed (single-use tickets already spent is the common case) sends you debugging the
// server instead of re-minting — it cost exactly that once.
const results = await Promise.all(roster.map((n) =>
  bot(n).then(() => n).catch((e) => { console.error(`[${n}] failed:`, e); return null; })));
const live = results.filter((n): n is string => n !== null);
if (live.length === 0) {
  console.error(`\nNO bots joined (${roster.length} attempted). Tickets are SINGLE-USE: mint`
    + ' fresh ones and pass them with --tickets.');
  process.exit(1);
}
console.log(`\n${live.length}/${roster.length} bots online: ${live.join(', ')}\nCtrl+C to stop.`);
