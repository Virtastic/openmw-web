// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase C: friends, presence and invites. Storage lives in socialstore.ts; this file is the
// policy — who may see whom, who may contact whom, and what a reconnect looks like to your
// friends.
//
// Identity on the wire is the ACCOUNT KEY (`acct`), never the player id. Player ids are
// per-session, so an id-keyed friendship would expire on every reconnect; the live playerId
// is carried alongside, and only when the friend is actually online.

import type { Player, Roster } from './players';
import type { SocialStore, AccountKey } from './socialstore';
import type { LValue } from '../proto/lser';
import { log } from '../log';

export interface SocialTuning {
  requestTtlMs: number;
  maxOutstandingRequests: number;
  inviteTtlMs: number;
  // A rejoin within this window never shows as offline to friends. Without it, a client
  // that drops and auto-reconnects (which A1 makes routine) flashes offline/online to
  // everyone who has friended them.
  presenceGraceMs: number;
}

export const socialTuning: SocialTuning = {
  requestTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxOutstandingRequests: 50,
  inviteTtlMs: 2 * 60 * 1000,
  presenceGraceMs: 15_000,
};

export interface FriendView {
  acct: AccountKey;
  name: string;
  online: boolean;
  playerId?: number;
  cellKey?: string;
}

export type SocialFailure =
  | 'no_such_player'
  | 'blocked'
  | 'already_friends'
  | 'self'
  | 'too_many_requests'
  | 'no_request'
  | 'not_online';

export interface SocialDeps {
  store: SocialStore;
  roster: Roster;
  // Display name for an account that may be offline. Returns undefined for an unknown one.
  displayName(acct: AccountKey): string | undefined;
  // Resolve a typed-in display name to an account key (case-insensitive).
  resolveName(name: string): AccountKey | undefined;
  now(): number;
}

interface PendingInvite {
  from: AccountKey;
  expires: number;
}

export class Social {
  private readonly d: SocialDeps;
  private readonly tuning: SocialTuning;
  // acct -> timer that will announce them offline once the grace window lapses.
  private readonly offlineTimers = new Map<AccountKey, NodeJS.Timeout>();
  // Invites are session state and stay in memory: persisting them means resurrecting dead
  // invitations after a restart, pointing at a session that no longer exists.
  private readonly invites = new Map<AccountKey, PendingInvite[]>();

  constructor(deps: SocialDeps, tuning: SocialTuning = socialTuning) {
    this.d = deps;
    this.tuning = tuning;
  }

  // ------------------------------------------------------------------ presence

  private onlinePlayer(acct: AccountKey): Player | undefined {
    const p = this.d.roster.activeForAccount(acct);
    return p?.inWorld ? p : undefined;
  }

  // cellKey is included ONLY for friends. It is a location disclosure, and a stranger — or
  // someone this player has blocked — must never receive it.
  friendList(acct: AccountKey): FriendView[] {
    const out: FriendView[] = [];
    for (const f of this.d.store.friendsOf(acct)) {
      const p = this.onlinePlayer(f.account);
      out.push({
        acct: f.account,
        name: this.d.displayName(f.account) ?? f.account,
        online: p !== undefined,
        ...(p ? { playerId: p.id, ...(p.cellKey ? { cellKey: p.cellKey } : {}) } : {}),
      });
    }
    return out;
  }

  private sendFriendList(player: Player): void {
    player.peer.sendEvent('FriendList', { friends: this.friendList(player.accountKey) as unknown as never });
  }

  // Tell this account's friends about a presence change. Blocks are honoured here too: a
  // block should stop presence leaking in both directions, not just stop messages.
  private notifyFriends(acct: AccountKey, online: boolean): void {
    const p = online ? this.onlinePlayer(acct) : undefined;
    for (const f of this.d.store.friendsOf(acct)) {
      if (this.d.store.blockedEitherWay(acct, f.account)) continue;
      const peer = this.onlinePlayer(f.account);
      if (!peer) continue;
      peer.peer.sendEvent('PresenceUpdate', {
        acct,
        online,
        ...(p ? { playerId: p.id } : {}),
      });
    }
  }

  onJoin(player: Player): void {
    const acct = player.accountKey;
    // Cancel a pending offline announcement: this is a reconnect inside the grace window,
    // so as far as friends are concerned they never left.
    const t = this.offlineTimers.get(acct);
    if (t) {
      clearTimeout(t);
      this.offlineTimers.delete(acct);
      this.sendFriendList(player);
      return; // no PresenceUpdate at all — they were never shown offline
    }
    this.sendFriendList(player);
    this.notifyFriends(acct, true);
  }

  onLeave(player: Player): void {
    const acct = player.accountKey;
    this.invites.delete(acct);
    const existing = this.offlineTimers.get(acct);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(acct);
      // Re-check: the account may have come back on a different connection.
      if (this.onlinePlayer(acct)) return;
      this.notifyFriends(acct, false);
    }, this.tuning.presenceGraceMs);
    timer.unref?.();
    this.offlineTimers.set(acct, timer);
  }

  // Test/shutdown hook: pending timers would otherwise hold a process open.
  stop(): void {
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
  }

  // ------------------------------------------------------------------- friends

  requestFriend(player: Player, name: string): SocialFailure | 'sent' | 'accepted' {
    const from = player.accountKey;
    const to = this.d.resolveName(name);
    if (!to) return 'no_such_player';
    if (to === from) return 'self';
    if (this.d.store.blockedEitherWay(from, to)) return 'blocked';
    if (this.d.store.areFriends(from, to)) return 'already_friends';
    const now = this.d.now();

    // If they already asked us, this IS the acceptance. Otherwise two people who both
    // pressed "add friend" sit forever holding requests for each other.
    if (this.d.store.hasRequest(to, from, now)) {
      this.completeFriendship(from, to, now);
      return 'accepted';
    }
    if (this.d.store.outstandingFrom(from, now) >= this.tuning.maxOutstandingRequests) {
      return 'too_many_requests';
    }
    this.d.store.addRequest(from, to, now, this.tuning.requestTtlMs);
    const target = this.onlinePlayer(to);
    target?.peer.sendEvent('FriendRequestReceived', { fromAcct: from, fromName: player.name });
    return 'sent';
  }

  acceptFriend(player: Player, fromAcct: AccountKey): SocialFailure | 'ok' {
    const me = player.accountKey;
    const now = this.d.now();
    if (!this.d.store.hasRequest(fromAcct, me, now)) return 'no_request';
    // Checked at ACCEPT time, not only at request time: a block placed after the request
    // was sent must still take effect.
    if (this.d.store.blockedEitherWay(me, fromAcct)) {
      this.d.store.removeRequest(fromAcct, me);
      return 'blocked';
    }
    this.completeFriendship(me, fromAcct, now);
    return 'ok';
  }

  private completeFriendship(a: AccountKey, b: AccountKey, now: number): void {
    this.d.store.addFriend(a, b, now);
    this.d.store.removeRequest(a, b);
    this.d.store.removeRequest(b, a);
    for (const acct of [a, b]) {
      const p = this.onlinePlayer(acct);
      if (p) this.sendFriendList(p);
    }
    log('info', 'social.friend_added', { a, b });
  }

  removeFriend(player: Player, other: AccountKey): void {
    this.d.store.removeFriend(player.accountKey, other);
    // Both sides get a fresh list: an unfriend that only updates the initiator leaves the
    // other player believing they still have a friend they cannot see.
    for (const acct of [player.accountKey, other]) {
      const p = this.onlinePlayer(acct);
      if (p) this.sendFriendList(p);
    }
  }

  // -------------------------------------------------------------------- blocks

  block(player: Player, name: string): SocialFailure | 'ok' {
    const target = this.d.resolveName(name);
    if (!target) return 'no_such_player';
    if (target === player.accountKey) return 'self';
    const now = this.d.now();
    this.d.store.addBlock(player.accountKey, target, now);
    // Blocking implies unfriending and drops any pending requests either way — otherwise a
    // blocked person remains in the friends list, still leaking presence and location.
    this.d.store.removeFriend(player.accountKey, target);
    this.d.store.removeRequest(player.accountKey, target);
    this.d.store.removeRequest(target, player.accountKey);
    this.dropInvitesBetween(player.accountKey, target);
    this.sendFriendList(player);
    const other = this.onlinePlayer(target);
    if (other) this.sendFriendList(other);
    return 'ok';
  }

  unblock(player: Player, target: AccountKey): void {
    this.d.store.removeBlock(player.accountKey, target);
  }

  // ------------------------------------------------------------------- invites

  private dropInvitesBetween(x: AccountKey, y: AccountKey): void {
    for (const [to, list] of this.invites) {
      const kept = list.filter((i) => !((to === x && i.from === y) || (to === y && i.from === x)));
      if (kept.length === 0) this.invites.delete(to);
      else this.invites.set(to, kept);
    }
  }

  invite(player: Player, targetAcct: AccountKey): SocialFailure | 'ok' {
    const from = player.accountKey;
    if (targetAcct === from) return 'self';
    if (this.d.store.blockedEitherWay(from, targetAcct)) return 'blocked';
    const target = this.onlinePlayer(targetAcct);
    if (!target) return 'not_online';
    const now = this.d.now();
    const list = (this.invites.get(targetAcct) ?? []).filter((i) => i.expires > now);
    // One live invite per sender: re-inviting refreshes rather than stacking.
    const kept = list.filter((i) => i.from !== from);
    kept.push({ from, expires: now + this.tuning.inviteTtlMs });
    this.invites.set(targetAcct, kept);
    target.peer.sendEvent('InviteReceived', { fromAcct: from, fromName: player.name });
    return 'ok';
  }

  // ------------------------------------------------------------------ dispatch

  // Returns true when the event belonged to this family, matching the other core modules.
  // Every failure is reported back to the caller rather than dropped: a friend request that
  // silently does nothing is indistinguishable from a broken server to the player.
  handleEvent(player: Player, name: string, value: LValue | undefined): boolean {
    // LSER decodes tables to Map, not to a plain object. Reading it as an object silently
    // yields '' for every field, which the policy then correctly reports as
    // "no_such_player" — a failure that looks like a lookup bug and is actually a decode
    // bug. Matches the accessor every other event family uses.
    const body = value instanceof Map ? value : undefined;
    const str = (k: string): string => {
      const v = body?.get(k);
      return typeof v === 'string' ? v : '';
    };
    switch (name) {
      case 'FriendRequest': {
        const r = this.requestFriend(player, str('name'));
        this.reply(player, 'FriendRequest', r === 'sent' || r === 'accepted', r);
        return true;
      }
      case 'FriendAccept': {
        const r = this.acceptFriend(player, str('acct'));
        this.reply(player, 'FriendAccept', r === 'ok', r);
        return true;
      }
      case 'FriendRemove':
        this.removeFriend(player, str('acct'));
        this.reply(player, 'FriendRemove', true, 'ok');
        return true;
      case 'BlockAdd': {
        const r = this.block(player, str('name'));
        this.reply(player, 'BlockAdd', r === 'ok', r);
        return true;
      }
      case 'BlockRemove':
        this.unblock(player, str('acct'));
        this.reply(player, 'BlockRemove', true, 'ok');
        return true;
      case 'InviteSend': {
        const r = this.invite(player, str('acct'));
        this.reply(player, 'InviteSend', r === 'ok', r);
        return true;
      }
      case 'InviteAccept': {
        const r = this.acceptInvite(player, str('acct'));
        if (r.ok) {
          player.peer.sendEvent('InviteAccepted', { cellKey: r.cellKey, x: r.x, y: r.y, z: r.z });
        } else {
          this.reply(player, 'InviteAccept', false, r.reason);
        }
        return true;
      }
      default:
        return false;
    }
  }

  private reply(player: Player, op: string, ok: boolean, detail: string): void {
    player.peer.sendEvent('SocialResult', { op, ok, detail });
  }

  // Returns the inviter's live position for the client to travel to, or a failure.
  acceptInvite(player: Player, fromAcct: AccountKey):
  | { ok: true; cellKey: string; x: number; y: number; z: number }
  | { ok: false; reason: SocialFailure } {
    const now = this.d.now();
    const list = (this.invites.get(player.accountKey) ?? []).filter((i) => i.expires > now);
    if (!list.some((i) => i.from === fromAcct)) return { ok: false, reason: 'no_request' };
    if (this.d.store.blockedEitherWay(player.accountKey, fromAcct)) return { ok: false, reason: 'blocked' };
    const host = this.onlinePlayer(fromAcct);
    if (!host || !host.cellKey || !host.pose) return { ok: false, reason: 'not_online' };
    this.invites.set(player.accountKey, list.filter((i) => i.from !== fromAcct));
    return { ok: true, cellKey: host.cellKey, x: host.pose.x, y: host.pose.y, z: host.pose.z };
  }
}
