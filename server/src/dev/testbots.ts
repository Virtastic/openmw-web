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
  prefix: string;
  /** Where a bot stands: the STARTER VILLAGE, the same point [rules] respawn* names — the
   *  town every character reaches after chargen. Reused rather than a second setting, so a
   *  deployment configures "where players begin" exactly once. */
  spawn: { cellKey: string; x: number; y: number; z: number };
  /** Content record ids. Empty = no appearance broadcast, so no puppet is spawned. */
  look?: { race: string; head: string; hair: string; class: string };
  /** Character docs live here; a bot needs one to have a character at all. */
  players: PlayerStore;
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
  const look = deps.look;
  const timers = new Set<NodeJS.Timeout>();
  const names: string[] = [];
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

  for (let i = 1; i <= count; i++) {
    const name = `${prefix}${i}`;
    const accountKey = name.toLowerCase();
    let self: Player | undefined;

    const peer: Peer = {
      sendEvent(evt: string, body: JsLike): void {
        const b = (body ?? {}) as Record<string, unknown>;
        const from = b['fromAcct'];
        if (typeof from !== 'string' || !self) return;
        // The two events a human would see a prompt for.
        const op = evt === 'FriendRequestReceived' ? 'FriendAccept'
          : evt === 'PartyInviteReceived' ? 'PartyAccept' : undefined;
        if (!op) return;
        replyLater(() => {
          if (!self) return;
          // EXACTLY what a client sends: both accepts take the other side's account key, and
          // going through handleEvent means every guard a human hits — blocked, party full,
          // no such request — applies to a bot too.
          social.handleEvent(self, op, new Map<string, JsLike>([['acct', from]]) as never);
          log('info', 'devbot.accepted', { bot: name, op, from });
        });
      },
      sendBinary: () => true,
      sendBinaryFrame: () => true,
      disconnect: () => { /* a bot has no socket to close */ },
    };

    // AWAITED, BEFORE THE BOT EXISTS TO ANYONE. A friend request resolves a typed name
    // through the account index, so a bot that is in the roster while its account is still
    // being written is unreachable by the very flow it exists to exercise — a race that would
    // only ever show up as "the bot ignored me" in the first seconds after boot. No account,
    // no bot.
    const account = await ensureBotAccount(accounts, name);
    if (!account) continue;

    // A REAL CHARACTER, standing in the starter village. Without one a bot is an account with
    // nothing behind it: no slot on the account, no doc, and no position — so it cannot be
    // anywhere, and every surface that reads a character (the Players panel, a party row, the
    // world itself) has nothing to show. The slot is adopted as COMPLETE because a bot never
    // runs chargen, and an incomplete slot is treated as creation-in-progress everywhere.
    const charId = `c${createHash('sha1').update(`devbot:${accountKey}`).digest('hex').slice(0, 24)}`;
    const adopted = accounts.adoptCharacter(account, charId, name);
    if (adopted === 'full') log('warn', 'devbot.slot_full', { bot: name });

    players.update(charId, (doc) => {
      doc.position = { cellKey: spawn.cellKey, x: spawn.x, y: spawn.y, z: spawn.z };
      // Appearance is what makes a puppet spawn for other clients. Written only when the
      // deployment supplied content ids: handleAppearance REFUSES an incomplete one, and a
      // half-written appearance is worse than none — it withholds the whole player record.
      if (look && look.race && look.head && look.class) {
        doc.appearance = { race: look.race, head: look.head, hair: look.hair,
          class: look.class, name, isMale: true };
      }
    });

    self = roster.addAuthed(name, accountKey, 0, peer, '127.0.0.1');
    // Visible, not present: shown in every player-facing list, but never counted as an
    // occupant for capacity or world lifecycle. See Player.bot.
    self.bot = true;
    self.charId = charId;
    self.cellKey = spawn.cellKey;
    // A pose, so the movement broadcaster has something to send and the bot stands somewhere
    // rather than at the origin.
    self.pose = { x: spawn.x, y: spawn.y, z: spawn.z, yaw: 0, pitch: 0, anim: 0 } as never;
    roster.joinWorld(self);

    // Tell everyone already here what this bot looks like. Late joiners get it from the
    // roster/appearance replay the same way they do for any player.
    if (look && look.race && look.head && look.class) {
      for (const p of roster.inWorld()) {
        if (p.id === self.id) continue;
        p.peer.sendEvent('PlayerAppearance', {
          id: self.id, race: look.race, head: look.head, hair: look.hair,
          class: look.class, name, isMale: true,
        } as never);
      }
    }
    bots.push(self);
    names.push(name);
  }

  if (count > 0) {
    log('warn', 'devbot.enabled', {
      count, names,
      why: 'dev/test bots are ONLINE and auto-accept friend requests and party invites.'
        + ' Set [dev] bots = 0 (or unset OMW_DEV_BOTS) on any server real players can reach.',
    });
  }

  return {
    names,
    stop(): void {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const b of bots) roster.remove(b);
    },
  };
}
