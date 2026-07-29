// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Companions to test the social features against: they sit in the world, answer chat, and
// accept whatever you send them. soak.ts already covers load (movement, combat, containers);
// this covers the things that need a WILLING SECOND PLAYER — friend requests, party invites,
// travel. Kept dumb on purpose: every bot auto-accepts, so anything you send resolves.
//
//   npx tsx bots/lobby-bots.ts --port 9000 [--bots 3] [--names Ashka,Drels,Vera]
//
// ponytail: no CLI framework, no state machine — a switch on the event name is the whole bot.

import { TestClient } from '../test/helpers';

const arg = (flag: string, dflt: string): string => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : dflt;
};

const port = Number(arg('--port', '9000'));
const names = arg('--names', '').split(',').filter(Boolean);
const count = names.length || Number(arg('--bots', '3'));
const roster = names.length ? names : Array.from({ length: count }, (_, i) => `Bot${i + 1}`);

const REPLIES = [
  'hey', 'ready when you are', 'nice one', 'on my way', 'still here',
  'invite me', 'what are we doing', 'following you',
];

async function bot(name: string): Promise<void> {
  const c = await TestClient.connect(port);
  await c.joinAsNew(name);
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
        if (!text || who.toLowerCase() === name.toLowerCase()) break; // never answer itself
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
