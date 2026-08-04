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
import type { AccountStore } from '../core/accounts';
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
  /** Cell the bots stand in, so interest-managed broadcasts reach them. */
  cellKey?: string;
}

export interface RunningTestBots {
  names: string[];
  stop(): void;
}

export function startTestBots(deps: TestBotDeps): RunningTestBots {
  const { roster, social, accounts, count, prefix } = deps;
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

    // Real account + public handle, created once and reused on later boots. The password is
    // deliberately unusable-by-design noise: nothing should ever log in AS a bot, and these
    // servers are the ones with password login disabled anyway.
    void accounts.register(name, `bot-${Math.random().toString(36).slice(2)}-${Date.now()}`)
      .then((made) => {
        if (typeof made !== 'string') accounts.setUsername(made, name).catch(() => { /* taken */ });
      })
      .catch((err) => log('warn', 'devbot.account_failed', { bot: name, error: String(err) }));

    self = roster.addAuthed(name, accountKey, 0, peer, '127.0.0.1');
    self.charId = accountKey;
    if (deps.cellKey) self.cellKey = deps.cellKey;
    roster.joinWorld(self);
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
