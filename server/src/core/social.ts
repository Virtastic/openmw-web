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
import type { LValue, JsLike } from '../proto/lser';
import type { WorldBrowser } from './worldbrowser';
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

// Who may see where you are, and who may invite you.
//   public  — anyone in the world (the lobby list shows your cell)
//   friends — friends only (the default; matches what Phase C shipped)
//   party   — only your current party
//   private — nobody; you appear online with no location, and invites are refused
// This is a PRIVACY control, so the server enforces it on every path that could disclose a
// location or deliver an invite. A client-side filter would be decorative.
export const PRESENCE_MODES = ['public', 'friends', 'party', 'private'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];
export const DEFAULT_PRESENCE: PresenceMode = 'friends';

export interface PartyView {
  leader: AccountKey;
  members: { acct: AccountKey; name: string; online: boolean; playerId?: number; cellKey?: string }[];
}

export type SocialFailure =
  | 'no_such_player'
  | 'blocked'
  | 'already_friends'
  | 'self'
  | 'too_many_requests'
  | 'no_request'
  | 'not_online'
  | 'private'
  | 'not_in_party'
  | 'not_leader'
  | 'party_full'
  | 'already_in_party';

export interface SocialDeps {
  store: SocialStore;
  roster: Roster;
  // Display name for an account that may be offline. Returns undefined for an unknown one.
  displayName(acct: AccountKey): string | undefined;
  // Resolve a typed-in display name to an account key (case-insensitive).
  resolveName(name: string): AccountKey | undefined;
  now(): number;
  // F3: absent when no gateway is configured, in which case the Worlds tab says so rather
  // than pretending there is nothing to see.
  worlds?: WorldBrowser;
}

interface PendingInvite {
  from: AccountKey;
  expires: number;
}

interface Party {
  id: number;
  leader: AccountKey;
  members: Set<AccountKey>;
}

export class Social {
  private readonly d: SocialDeps;
  private readonly tuning: SocialTuning;
  // acct -> timer that will announce them offline once the grace window lapses.
  private readonly offlineTimers = new Map<AccountKey, NodeJS.Timeout>();
  // Invites are session state and stay in memory: persisting them means resurrecting dead
  // invitations after a restart, pointing at a session that no longer exists.
  private readonly invites = new Map<AccountKey, PendingInvite[]>();
  // Parties are SESSION state and stay in memory. Persisting them means restoring a party
  // after a restart whose members are all offline and whose leader may never return — a
  // group that exists on paper and cannot be left.
  private readonly parties = new Map<number, Party>();
  private readonly partyOf = new Map<AccountKey, number>();
  private nextPartyId = 1;
  private readonly maxParty = 8;

  constructor(deps: SocialDeps, tuning: SocialTuning = socialTuning) {
    this.d = deps;
    this.tuning = tuning;
    this.worlds = deps.worlds;
  }

  private readonly worlds?: WorldBrowser;

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
      // cellKey is gated by the SUBJECT's presence mode, not merely by friendship: a player
      // who set themselves to party-only or private stays hidden from friends too, which is
      // the entire point of choosing it.
      const showWhere = p !== undefined && p.cellKey !== undefined && this.maySeeLocation(acct, f.account);
      out.push({
        acct: f.account,
        name: this.d.displayName(f.account) ?? f.account,
        online: p !== undefined,
        ...(p ? { playerId: p.id, ...(showWhere ? { cellKey: p.cellKey } : {}) } : {}),
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
      this.sendParty(acct);
      return; // no PresenceUpdate at all — they were never shown offline
    }
    this.sendFriendList(player);
    this.sendParty(acct);
    this.notifyFriends(acct, true);
  }

  onLeave(player: Player): void {
    const acct = player.accountKey;
    this.invites.delete(acct);
    // Party membership survives a brief drop, exactly like presence: being dropped from
    // your group because your connection blipped is worse than a stale row for a few
    // seconds. It is cleared when the offline announcement finally fires.
    this.invites.delete(acct);
    const existing = this.offlineTimers.get(acct);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(acct);
      // Re-check: the account may have come back on a different connection.
      if (this.onlinePlayer(acct)) return;
      this.partyLeave(acct); // the grace window has lapsed: they really are gone
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
    // 'private' means do not contact me, not just do not locate me.
    if (this.presenceMode(targetAcct) === 'private') return 'private';
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

  // ------------------------------------------------------------ presence mode

  presenceMode(acct: AccountKey): PresenceMode {
    const raw = this.d.store.getPresenceMode(acct);
    return (PRESENCE_MODES as readonly string[]).includes(raw ?? '') ? (raw as PresenceMode) : DEFAULT_PRESENCE;
  }

  setPresenceMode(player: Player, mode: string): SocialFailure | 'ok' {
    if (!(PRESENCE_MODES as readonly string[]).includes(mode)) return 'no_such_player';
    this.d.store.setPresenceMode(player.accountKey, mode);
    // Everyone who can see this player re-reads them: going private must take effect now,
    // not whenever their next friend list happens to be rebuilt.
    this.sendFriendList(player);
    this.sendParty(player.accountKey);
    for (const f of this.d.store.friendsOf(player.accountKey)) {
      const p = this.onlinePlayer(f.account);
      if (p) this.sendFriendList(p);
    }
    return 'ok';
  }

  // May `viewer` see where `subject` is? The single place this question is answered, so a
  // new surface cannot accidentally disclose a location the player asked to hide.
  private maySeeLocation(viewer: AccountKey, subject: AccountKey): boolean {
    if (viewer === subject) return true;
    if (this.d.store.blockedEitherWay(viewer, subject)) return false;
    switch (this.presenceMode(subject)) {
      case 'public': return true;
      case 'friends': return this.d.store.areFriends(viewer, subject);
      case 'party': return this.samePartyAs(viewer, subject);
      case 'private': return false;
    }
  }

  // ------------------------------------------------------------------- party

  private samePartyAs(a: AccountKey, b: AccountKey): boolean {
    const pa = this.partyOf.get(a);
    return pa !== undefined && pa === this.partyOf.get(b);
  }

  partyView(acct: AccountKey): PartyView | null {
    const id = this.partyOf.get(acct);
    if (id === undefined) return null;
    const party = this.parties.get(id);
    if (!party) return null;
    return {
      leader: party.leader,
      members: [...party.members].map((m) => {
        const p = this.onlinePlayer(m);
        return {
          acct: m,
          name: this.d.displayName(m) ?? m,
          online: p !== undefined,
          // A party member's location is shown to the party regardless of mode 'party',
          // but 'private' still hides it — opting out has to mean something even here.
          ...(p ? { playerId: p.id, ...(p.cellKey && this.presenceMode(m) !== 'private' ? { cellKey: p.cellKey } : {}) } : {}),
        };
      }),
    };
  }

  private sendParty(acct: AccountKey): void {
    const p = this.onlinePlayer(acct);
    if (!p) return;
    const view = this.partyView(acct);
    p.peer.sendEvent('PartyUpdate', view === null
      ? { leader: '', members: [] as unknown as never }
      : { leader: view.leader, members: view.members as unknown as never });
  }

  private broadcastParty(id: number): void {
    const party = this.parties.get(id);
    if (!party) return;
    for (const m of party.members) this.sendParty(m);
  }

  // Inviting when you have no party creates one with you as leader. Requiring an explicit
  // "create party" step first is a pure ceremony tax: nobody wants a party of one.
  partyInvite(player: Player, targetAcct: AccountKey): SocialFailure | 'ok' {
    const from = player.accountKey;
    if (targetAcct === from) return 'self';
    if (this.d.store.blockedEitherWay(from, targetAcct)) return 'blocked';
    if (this.presenceMode(targetAcct) === 'private') return 'private';
    const target = this.onlinePlayer(targetAcct);
    if (!target) return 'not_online';
    if (this.partyOf.has(targetAcct)) return 'already_in_party';

    let id = this.partyOf.get(from);
    if (id === undefined) {
      id = this.nextPartyId++;
      this.parties.set(id, { id, leader: from, members: new Set([from]) });
      this.partyOf.set(from, id);
    }
    const party = this.parties.get(id)!;
    if (party.leader !== from) return 'not_leader';
    if (party.members.size >= this.maxParty) return 'party_full';

    const now = this.d.now();
    const list = (this.invites.get(targetAcct) ?? []).filter((i) => i.expires > now && i.from !== from);
    list.push({ from, expires: now + this.tuning.inviteTtlMs });
    this.invites.set(targetAcct, list);
    target.peer.sendEvent('PartyInviteReceived', { fromAcct: from, fromName: player.name });
    this.sendParty(from);
    return 'ok';
  }

  partyAccept(player: Player, fromAcct: AccountKey): SocialFailure | 'ok' {
    const me = player.accountKey;
    const now = this.d.now();
    const list = (this.invites.get(me) ?? []).filter((i) => i.expires > now);
    if (!list.some((i) => i.from === fromAcct)) return 'no_request';
    if (this.d.store.blockedEitherWay(me, fromAcct)) return 'blocked';
    if (this.partyOf.has(me)) return 'already_in_party';
    const id = this.partyOf.get(fromAcct);
    const party = id !== undefined ? this.parties.get(id) : undefined;
    if (!party) return 'not_in_party';
    if (party.members.size >= this.maxParty) return 'party_full';
    party.members.add(me);
    this.partyOf.set(me, party.id);
    this.invites.set(me, list.filter((i) => i.from !== fromAcct));
    this.broadcastParty(party.id);
    return 'ok';
  }

  partyLeave(acct: AccountKey): void {
    const id = this.partyOf.get(acct);
    if (id === undefined) return;
    const party = this.parties.get(id);
    this.partyOf.delete(acct);
    if (!party) return;
    party.members.delete(acct);
    // The leader leaving hands over rather than dissolving the group: everyone else being
    // silently ejected because one person left is worse than an arbitrary successor.
    if (party.leader === acct) {
      const next = [...party.members][0];
      if (next) party.leader = next;
    }
    if (party.members.size <= 1) {
      for (const m of party.members) {
        this.partyOf.delete(m);
        this.sendParty(m);
      }
      this.parties.delete(id);
    } else {
      this.broadcastParty(id);
    }
    this.sendParty(acct); // the leaver gets an empty party
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
      // F3 world browser. Async, unlike every other case here: it calls out to the gateway.
      // The handler still returns true immediately — the reply arrives as its own event when
      // the gateway answers, so a slow directory can never stall the player's session.
      case 'WorldList': {
        // ALWAYS reply. `this.worlds` is undefined when no gateway is configured, and an
        // optional-chained call there would silently send nothing — leaving the client
        // waiting forever on a request that was received and understood. A player staring
        // at "Loading worlds..." with no explanation is the worst of both worlds.
        if (!this.worlds) {
          player.peer.sendEvent('WorldList', { error: 'no_gateway', worlds: [], myPort: 0 });
          return true;
        }
        void this.worlds.list(player).then((r) => {
          // Mapped field by field rather than forwarded wholesale: the gateway's record
          // carries ownerAccount, and echoing another player's account key into a client
          // would leak identity the lobby has no business showing.
          player.peer.sendEvent('WorldList', {
            error: r.error ?? '',
            // So the UI can mark the world the player is standing in rather than offering
            // a "join" that reconnects them to where they already are.
            myPort: this.worlds?.ownPort ?? 0,
            worlds: r.worlds.map((w) => ({
              id: w.id, mode: w.mode, name: w.name, host: w.host, port: w.port,
              playerCount: w.playerCount, maxPlayers: w.maxPlayers, up: w.up,
            })),
          });
        });
        return true;
      }
      case 'WorldCreate': {
        if (!this.worlds) {
          player.peer.sendEvent('WorldCreate', { ok: false, error: 'no_gateway' });
          return true;
        }
        void this.worlds.create(player, str('id'), str('mode')).then((r) => {
          player.peer.sendEvent('WorldCreate', {
            ok: r.world !== undefined,
            error: r.error ?? '',
            ...(r.world ? {
              world: {
                id: r.world.id, mode: r.world.mode, name: r.world.name,
                host: r.world.host, port: r.world.port,
              },
            } : {}),
          });
        });
        return true;
      }
      case 'PresenceMode': {
        const r = this.setPresenceMode(player, str('mode'));
        this.reply(player, 'PresenceMode', r === 'ok', r === 'ok' ? str('mode') : r);
        return true;
      }
      case 'PartyInvite': {
        const r = this.partyInvite(player, str('acct'));
        this.reply(player, 'PartyInvite', r === 'ok', r);
        return true;
      }
      case 'PartyAccept': {
        const r = this.partyAccept(player, str('acct'));
        this.reply(player, 'PartyAccept', r === 'ok', r);
        return true;
      }
      case 'PartyLeave':
        this.partyLeave(player.accountKey);
        this.reply(player, 'PartyLeave', true, 'ok');
        return true;
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
