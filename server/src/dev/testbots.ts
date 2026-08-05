// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// DEV/TEST BOTS — fake players that accept friend requests and party invites.
//
// For exercising the social flows (and recording them) without a second human. A bot is an
// ordinary roster entry whose Peer, instead of writing to a socket, watches for the two
// "someone wants something from you" events and answers them through the SAME
// social.handleEvent path a real client uses. Nothing in core/social.ts knows bots exist —
// which is the point: a bot taking a private shortcut would prove the shortcut works, not the
// feature.
//
// OFF UNLESS DELIBERATELY SWITCHED ON. These occupy real roster slots and write real
// friend/party rows, so a public server running them hands strangers accounts nobody
// controls. [dev] bots = 0 by default; OMW_DEV_BOTS=<n> for a throwaway run. Boot logs a
// warning whenever any are running, because "why is Bot1 my friend" should never be a mystery.
import type { Roster, Player, Peer } from '../core/players';
import type { Social } from '../core/social';
import type { AccountStore, Account } from '../core/accounts';
import type { PlayerStore } from '../persist/playerstore';
import { randomBytes, createHash } from 'node:crypto';
import type { JsLike } from '../proto/lser';
import { log } from '../log';

export interface TestBotDeps {
  roster: Roster;
  social: Social;
  /** Bots get REAL accounts. Friend requests resolve a typed name through the account index,
   *  so a roster-only bot is unreachable by the very flow it exists to exercise — and a real
   *  account is what makes the bot behave like a player rather than a special case. */
  accounts: AccountStore;
  count: number;
  /** Handles to use, in order. Anything beyond the list falls back to `<prefix><n>`. */
  names?: string[];
  prefix: string;
  /** Where a bot stands: the STARTER VILLAGE, the same point [rules] respawn* names — the
   *  town every character reaches after chargen. Reused rather than a second setting, so a
   *  deployment configures "where players begin" exactly once. */
  spawn: { cellKey: string; x: number; y: number; z: number };
  /** Content record ids. Empty = no appearance broadcast, so no puppet is spawned. */
  look?: { race: string; head: string; hair: string; class: string };
  /** Character docs live here; a bot needs one to have a character at all. */
  players: PlayerStore;
  /** Is THIS world the public one? An unpartied bot hangs out there and nowhere else. */
  isPublic: boolean;
}

export interface RunningTestBots {
  names: string[];
  stop(): void;
}

/** The bot's account, created on first boot and reused after. Returns undefined only when the
 *  name itself is unusable, which is a configuration mistake worth refusing rather than
 *  papering over — a bot with no account is invisible to every name-resolved flow. */
async function ensureBotAccount(accounts: AccountStore, name: string): Promise<Account | undefined> {
  // Password is deliberately unguessable single-use noise: nothing should ever log in AS a
  // bot, and these servers have password login disabled anyway.
  const made = await accounts.register(name, `bot-${randomBytes(24).toString('hex')}`);
  const account = typeof made === 'string' ? await accounts.get(name) : made;
  if (!account) {
    log('error', 'devbot.account_failed', { bot: name, reason: made });
    return undefined;
  }
  // Idempotent, and re-attempted on EVERY boot: register() answers 'exists' the second time,
  // and skipping the handle then left a bot whose first attempt failed permanently without
  // one — invisible in every panel that shows usernames.
  if (account.username !== name) {
    const r = await accounts.setUsername(account, name);
    if (r !== 'ok') log('warn', 'devbot.username_failed', { bot: name, reason: r });
  }
  return account;
}

export async function startTestBots(deps: TestBotDeps): Promise<RunningTestBots> {
  const { roster, social, accounts, players, count, prefix, spawn } = deps;
  const pool = deps.names ?? [];
  const look = deps.look;
  const timers = new Set<NodeJS.Timeout>();
  const bots: Player[] = [];

  // Answers are delayed a beat so they read like a person reacting, AND so social is never
  // re-entered from inside its own dispatch: handleEvent is mid-flight for the SENDER when
  // the notification goes out, and accepting inline would mutate the party while it is being
  // iterated.
  const replyLater = (fn: () => void): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      try { fn(); } catch (err) { log('warn', 'devbot.reply_failed', { error: String(err) }); }
    }, 600);
    timers.add(t);
    t.unref?.();
  };

  // A BOT IS A PLAYER, AND A PLAYER IS IN ONE WORLD AT A TIME. Every world is its own
  // process reading the same shared config, so simply starting bots everywhere put a copy of
  // each in every world at once — which is not a player, it is scenery.
  //
  // Presence is DERIVED, and every world can derive it alone because party membership lives in
  // the shared store: a bot with a party belongs wherever a member of that party actually is,
  // and a bot with no party hangs out in public. Each world evaluates that against its own
  // roster, so a bot follows the party through a world switch and leaves the world it came
  // from, with no cross-process messaging.
  interface BotId { name: string; accountKey: string; charId: string; peer: Peer; }
  const ids: BotId[] = [];
  const here = new Map<string, Player>(); // accountKey -> our roster entry, while present

  for (let i = 1; i <= count; i++) {
    // A REAL HANDLE, not "Bot1" — these are on screen next to real players, and scaffolding
    // names read as scaffolding. Falls back to the prefix when the pool runs out.
    const candidate = pool[i - 1];
    const name = (candidate && /^[A-Za-z0-9]{3,20}$/.test(candidate)) ? candidate : `${prefix}${i}`;
    if (candidate && name !== candidate) {
      log('warn', 'devbot.bad_name', { given: candidate, using: name,
        why: 'a public handle is letters and digits only, 3-20 characters' });
    }
    const accountKey = name.toLowerCase();

    const peer: Peer = {
      sendEvent(evt: string, body: JsLike): void {
        const b = (body ?? {}) as Record<string, unknown>;
        const from = b['fromAcct'];
        if (typeof from !== 'string') return;
        const self = here.get(accountKey);
        if (!self) return;
        const op = evt === 'FriendRequestReceived' ? 'FriendAccept'
          : evt === 'PartyInviteReceived' ? 'PartyAccept' : undefined;
        if (!op) return;
        replyLater(() => {
          const live = here.get(accountKey);
          if (!live) return;
          // EXACTLY what a client sends: both accepts take the other side's account key, and
          // going through handleEvent means every guard a human hits — blocked, party full,
          // no such request — applies to a bot too.
          social.handleEvent(live, op, new Map<string, JsLike>([['acct', from]]) as never);
          log('info', 'devbot.accepted', { bot: name, op, from });
        });
      },
      sendBinary: () => true,
      sendBinaryFrame: () => true,
      disconnect: () => { /* a bot has no socket to close */ },
    };

    // AWAITED, BEFORE THE BOT EXISTS TO ANYONE. A friend request resolves a typed name through
    // the account index, so a bot in the roster whose account is still being written is
    // unreachable by the very flow it exists to exercise.
    const account = await ensureBotAccount(accounts, name);
    if (!account) continue;

    const charId = `c${createHash('sha1').update(`devbot:${accountKey}`).digest('hex').slice(0, 24)}`;
    const adopted = accounts.adoptCharacter(account, charId, name);
    if (adopted === 'full') log('warn', 'devbot.slot_full', { bot: name });

    const ringAng = ((i - 1) / Math.max(1, count)) * Math.PI * 2;
    players.update(charId, (doc) => {
      doc.position = { cellKey: spawn.cellKey,
        x: spawn.x + Math.cos(ringAng) * 120, y: spawn.y + Math.sin(ringAng) * 120, z: spawn.z };
      if (look && look.race && look.head && look.class) {
        doc.appearance = { race: look.race, head: look.head, hair: look.hair,
          class: look.class, name, isMale: true };
      }
    });

    ids.push({ name, accountKey, charId, peer });
  }

  const dressed = !!(look && look.race && look.head && look.class);

  const arrive = (b: BotId): void => {
    const self = roster.addAuthed(b.name, b.accountKey, 0, b.peer, '127.0.0.1');
    self.bot = true;
    self.charId = b.charId;
    // Stand where the party is if we are following someone, else in the starter village.
    const lead = roster.humansInWorld().find((p) => !p.bot && p.cellKey !== undefined);
    const at = lead?.pose as { x: number; y: number; z: number } | undefined;
    self.cellKey = lead?.cellKey ?? spawn.cellKey;
    // SPREAD OUT. Every bot took the exact same spawn coordinates, so three characters stood
    // INSIDE each other and the player saw one. A small ring keeps them individually visible
    // and lets you walk up to a specific one — the difference between three players and a smear.
    const idx = Math.max(0, ids.findIndex((x) => x.accountKey === b.accountKey));
    const ang = (idx / Math.max(1, ids.length)) * Math.PI * 2;
    const R = 120; // Morrowind units: adjacent, not stacked, not scattered
    const spot = at ?? { x: spawn.x, y: spawn.y, z: spawn.z };
    self.pose = { x: spot.x + Math.cos(ang) * R, y: spot.y + Math.sin(ang) * R, z: spot.z,
      yaw: 0, pitch: 0, anim: 0 } as never;
    roster.joinWorld(self);
    here.set(b.accountKey, self);
    if (dressed) {
      for (const p of roster.inWorld()) {
        if (p.id === self.id) continue;
        p.peer.sendEvent('PlayerAppearance', {
          id: self.id, race: look!.race, head: look!.head, hair: look!.hair,
          class: look!.class, name: b.name, isMale: true,
        } as never);
      }
    }
    log('info', 'devbot.arrived', { bot: b.name, cellKey: self.cellKey });
  };

  const depart = (b: BotId): void => {
    const self = here.get(b.accountKey);
    if (!self) return;
    here.delete(b.accountKey);
    roster.remove(self);
    log('info', 'devbot.departed', { bot: b.name });
  };

  const reconcile = (): void => {
    // Humans only: a bot must never be the reason another bot thinks the party is here.
    const humansHere = roster.humansInWorld().filter((p) => !p.bot).map((p) => p.accountKey);
    for (const b of ids) {
      const members = social.partyMembersOf(b.accountKey);
      const belongsHere = members.length > 0
        ? members.some((m) => humansHere.includes(m)) // follow the party
        : deps.isPublic;                              // unpartied: hang out in public
      const present = here.has(b.accountKey);
      if (belongsHere && !present) arrive(b);
      else if (!belongsHere && present) depart(b);
    }
  };

  reconcile();
  // Party membership changes in ANOTHER process (the world the invite happened in), so this
  // is polled rather than event-driven — a world switch is seconds of loading anyway.
  const tick = setInterval(reconcile, 2000);
  tick.unref?.();

  if (count > 0) {
    log('warn', 'devbot.enabled', {
      count, names: ids.map((b) => b.name),
      why: 'dev/test bots are ONLINE and auto-accept friend requests and party invites.'
        + ' Set [dev] bots = 0 (or unset OMW_DEV_BOTS) on any server real players can reach.',
    });
  }

  return {
    names: ids.map((b) => b.name),
    stop(): void {
      clearInterval(tick);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const p of here.values()) roster.remove(p);
      here.clear();
    },
  };
}
