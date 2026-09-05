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
import { SocialStore, type AccountKey, type PresenceRow } from './socialstore';
import type { LValue, LTable, JsLike } from '../proto/lser';
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
//   public  — anyone in the world
//   friends — friends only (the default; matches what Phase C shipped)
//   private — nobody; you appear online with no location, and invites are refused
// This is a PRIVACY control, so the server enforces it on every path that could disclose a
// location or deliver an invite. A client-side filter would be decorative.
// ('party' was a mode once; the party concept is gone and the migration maps it to 'friends'.)
export const PRESENCE_MODES = ['public', 'friends', 'private'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];
export const DEFAULT_PRESENCE: PresenceMode = 'friends';

export type SocialFailure =
  | 'no_such_player'
  | 'blocked'
  | 'already_friends'
  | 'self'
  | 'too_many_requests'
  | 'no_request'
  | 'not_online'
  | 'private';

/** How long a presence row stays believable without a refresh. Comfortably longer than the
 *  heartbeat, so a hiccup does not blink everyone offline, and short enough that a world which
 *  died without cleaning up ages out rather than leaving ghosts online forever. */
const PRESENCE_TTL_MS = 30_000;

export interface SocialDeps {
  store: SocialStore;
  roster: Roster;
  /** This world's id, so shared presence can name where a player actually is. */
  worldId?: string;
  // Display name for an account that may be offline. Returns undefined for an unknown one.
  displayName(acct: AccountKey): string | undefined;
  // Resolve a typed-in display name to an account key (case-insensitive).
  resolveName(name: string): AccountKey | undefined;
  now(): number;
  // F3: absent when no gateway is configured, in which case the Worlds tab says so rather
  // than pretending there is nothing to see.
  worlds?: WorldBrowser;
  // A4/3.8: file a report into the moderation queue (the same store /report writes).
  report?(doc: {
    reporter: { id: number; account: string; name: string };
    target: { id: number | null; account: string | null; name: string; cellKey: string | null };
    reason: string;
    voice: boolean;
  }): Promise<unknown>;
}

export class Social {
  private readonly d: SocialDeps;
  private readonly tuning: SocialTuning;
  // acct -> timer that will announce them offline once the grace window lapses.
  private readonly offlineTimers = new Map<AccountKey, NodeJS.Timeout>();
  // Latched by stop(). Guards against re-arming timers while the server is tearing down.
  private stopped = false;
  // Invites live in the SHARED STORE (socialstore `invite`), not here. They used to be an
  // in-memory Map, which meant an invite could only ever reach someone already connected to
  // the SAME world process — so "invite your friend" worked exactly when you did not need
  // it. A TTL plus the expiry sweep is what stops a restart resurrecting dead invitations,
  // which is what the memory-only design was really buying.
  /** Cached for a second: a friend list of N would otherwise scan the table N times. */
  private presenceCache: { at: number; rows: PresenceRow[] } | undefined;

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

  /** PRESENCE IS SERVER-WIDE, not per-world. Every world is its own process with its own
   *  roster, so asking the local roster alone answered "is my friend online?" with "is my
   *  friend in MY world?" — a friend in their own solo world read as offline, and a party
   *  member elsewhere had no location. Local first (it is authoritative and current), then the
   *  shared presence table for everyone else. */
  private presenceOf(acct: AccountKey): { online: boolean; cellKey?: string; world?: string } {
    const local = this.onlinePlayer(acct);
    if (local) return { online: true, cellKey: local.cellKey, world: this.d.worldId };
    const row = this.presentRows().find((r) => r.account === acct);
    return row ? { online: true, cellKey: row.cellKey, world: row.world } : { online: false };
  }

  /** Cached for one tick of calls: a friend list of N asks N times, and this is a table scan. */
  private presentRows(): PresenceRow[] {
    const now = this.d.now();
    if (this.presenceCache && now - this.presenceCache.at < 1000) return this.presenceCache.rows;
    const rows = this.d.store.presentEverywhere(now, PRESENCE_TTL_MS);
    this.presenceCache = { at: now, rows };
    return rows;
  }

  /** How the VIEWER stands with this person: already friends, or a request pending in either
   *  direction. The Players list offered "add friend" to everyone — including people you were
   *  already friends with, and people whose request you had already sent — because a roster row
   *  carries only {id, name} and the client was guessing the account key from the display name,
   *  which has not matched since handles were introduced.
   *
   *  Computed here and sent as FLAGS rather than shipping the account key: an account key is
   *  the login identifier, which for an SSO account is the person's real name. The panel needs
   *  to know the relationship, not who someone is. */
  relationTo(viewer: AccountKey, subject: AccountKey): { friend?: true; reqOut?: true; reqIn?: true } {
    if (viewer === subject) return {};
    const now = this.d.now();
    if (this.d.store.areFriends(viewer, subject)) return { friend: true };
    if (this.d.store.hasRequest(viewer, subject, now)) return { reqOut: true };
    if (this.d.store.hasRequest(subject, viewer, now)) return { reqIn: true };
    return {};
  }

  /** relationTo for a WHOLE list, in three queries instead of three per subject.
   *
   *  The Players panel is rebuilt every 10 seconds for every player in the world, against
   *  everyone online server-wide — so relationTo ran once per PAIR, each call costing up to
   *  three freshly-prepared SQLite statements against the cross-process WAL file, on the event
   *  loop. At 200 players here and 256 online that is ~51,000 pairs and up to ~150,000
   *  synchronous queries every 10 seconds, in every world process at once. Invisible below
   *  about 50 concurrent players and a wall above it. */
  relationsFor(viewer: AccountKey): (subject: AccountKey) => { friend?: true; reqOut?: true; reqIn?: true } {
    const now = this.d.now();
    const friends = new Set(this.d.store.friendsOf(viewer).map((f) => f.account));
    const out = new Set(this.d.store.sentTo(viewer, now));
    const inc = new Set(this.d.store.pendingFor(viewer, now));
    return (subject) => {
      if (viewer === subject) return {};
      if (friends.has(subject)) return { friend: true };
      if (out.has(subject)) return { reqOut: true };
      if (inc.has(subject)) return { reqIn: true };
      return {};
    };
  }

  /** Everyone online anywhere on the server, for the Players list. */
  onlineEverywhere(): PresenceRow[] {
    return this.presentRows();
  }

  /** Re-send the friend panel to everyone here.
   *
   *  The view is pushed when the RELATIONSHIP changes — someone accepts, leaves, is removed —
   *  which is correct for membership and useless for presence: the panel said "Offline" about
   *  someone the player could see standing in front of them. Presence moves on its own
   *  heartbeat, so the view has to follow it. */
  refreshPresenceViews(): void {
    this.presenceCache = undefined; // the whole point is to pick up what changed elsewhere
    for (const p of this.d.roster.inWorld()) {
      if (p.system || p.bot) continue; // nothing is listening on those peers
      this.sendFriendList(p);
    }
  }

  // cellKey is included ONLY for friends. It is a location disclosure, and a stranger — or
  // someone this player has blocked — must never receive it.
  friendList(acct: AccountKey): FriendView[] {
    const out: FriendView[] = [];
    for (const f of this.d.store.friendsOf(acct)) {
      const p = this.onlinePlayer(f.account);
      // cellKey is gated by the SUBJECT's presence mode, not merely by friendship: a player
      // who set themselves to private stays hidden from friends too, which is
      // the entire point of choosing it.
      // Availability is a hard gate over connectedness: an Offline player is CONNECTED (they
      // are off in their own solo world) but must read as offline to friends — hidden, and
      // with no location, exactly as if disconnected.
      // Server-wide: `p` is only this world's copy, and a friend elsewhere is still online.
      const where = this.presenceOf(f.account);
      const available = where.online && this.isAvailable(f.account);
      const showWhere = available && where.cellKey !== undefined && this.maySeeLocation(acct, f.account);
      out.push({
        acct: f.account,
        name: this.d.displayName(f.account) ?? f.account,
        online: available,
        // playerId is a LOCAL connection id and only means anything in this world — a friend
        // elsewhere is online with no id here, which is exactly right: you cannot click
        // through to a session this process does not hold. The location comes from shared
        // presence, so it is correct wherever they are.
        ...(available && p ? { playerId: p.id } : {}),
        ...(showWhere ? { cellKey: where.cellKey } : {}),
      });
    }
    return out;
  }

  // Friends, and the two lists a player can only ever ADD to from the panel: who they have
  // blocked and who they have muted. Without them there was no way back -- the typed
  // commands never offered one either -- so a mis-click was permanent.
  private sendFriendList(player: Player): void {
    const acct = player.accountKey;
    const named = (a: AccountKey): { acct: string; name: string } => ({ acct: a, name: this.d.displayName(a) ?? a });
    player.peer.sendEvent('FriendList', {
      friends: this.friendList(acct) as unknown as never,
      blocked: this.d.store.blockedBy(acct).map(named) as unknown as never,
      muted: this.d.store.mutesOf(acct).map(named) as unknown as never,
    });
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
      this.drainInvites(player);
      return; // no PresenceUpdate at all — they were never shown offline
    }
    this.sendFriendList(player);
    // Anything sent to them while they were in another world (or offline) arrives now.
    this.drainInvites(player);
    this.notifyFriends(acct, true);
  }

  onLeave(player: Player): void {
    const acct = player.accountKey;
    // Shutdown closes the sockets, so onLeave fires for every connected player DURING
    // teardown — after stop() has already drained the map. Scheduling here would arm a
    // timer nothing will ever clear, and presenceGraceMs later it wakes up and calls
    // notifyFriends against a closed SQLite handle ("database is not open", uncaught).
    // unref() hides it in production (the process exits first) but under test the process
    // stays alive and it kills whatever test is running.
    if (this.stopped) return;
    // Invites deliberately SURVIVE a disconnect now: they live in the shared store so they
    // can reach another world, and binning them on logout would defeat that.
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
  // Latches `stopped` so a socket closing later in teardown cannot arm a fresh timer —
  // clearing the map is not enough on its own, since onLeave still runs after this.
  stop(): void {
    this.stopped = true;
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

  // Push an invite to the target if they are in THIS world. If they are not, the row in the
  // store is the delivery: whichever world they next join drains it in onJoin.
  private deliverInvite(to: AccountKey, from: AccountKey, fromName: string): void {
    const p = this.onlinePlayer(to);
    if (!p) return;
    p.peer.sendEvent('InviteReceived', { fromAcct: from, fromName });
  }

  // Everything addressed to this player while they were elsewhere (or offline).
  private drainInvites(player: Player): void {
    for (const inv of this.d.store.invitesFor(player.accountKey, this.d.now())) {
      if (this.d.store.blockedEitherWay(player.accountKey, inv.from)) continue;
      this.deliverInvite(player.accountKey, inv.from,
        this.d.displayName(inv.from) ?? inv.from);
    }
  }


  private dropInvitesBetween(x: AccountKey, y: AccountKey): void {
    this.d.store.removeInvite(x, y);
    this.d.store.removeInvite(y, x);
  }

  invite(player: Player, targetAcct: AccountKey): SocialFailure | 'ok' {
    const from = player.accountKey;
    if (targetAcct === from) return 'self';
    if (this.d.store.blockedEitherWay(from, targetAcct)) return 'blocked';
    // 'private' means do not contact me, not just do not locate me.
    if (this.presenceMode(targetAcct) === 'private') return 'private';
    // Availability is the reachability rule — NOT "are they in my world". Requiring the
    // latter meant you could only invite someone already standing next to you, which is the
    // one case where you did not need an invite. Being in another world is the normal case.
    if (!this.isAvailable(targetAcct)) return 'not_online';
    const now = this.d.now();
    // Persisted, not held in memory: worlds are separate processes, so an in-memory invite
    // could only reach someone already standing next to you. One row per sender, so
    // re-inviting refreshes rather than stacking.
    this.d.store.addInvite(from, targetAcct, 'world', now, this.tuning.inviteTtlMs);
    this.deliverInvite(targetAcct, from, player.name);
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
    for (const f of this.d.store.friendsOf(player.accountKey)) {
      const p = this.onlinePlayer(f.account);
      if (p) this.sendFriendList(p);
    }
    return 'ok';
  }

  // ------------------------------------------------------------ availability
  // Online/Offline — a DIFFERENT axis from presence (see availability_pref). Offline hides
  // the player from friends' online lists and refuses inbound invites/joins; the client
  // pairs it with peeling into the solo world. Default Online.

  availability(acct: AccountKey): 'online' | 'offline' {
    return this.d.store.getAvailability(acct) === 'offline' ? 'offline' : 'online';
  }

  isAvailable(acct: AccountKey): boolean {
    return this.availability(acct) !== 'offline';
  }

  setAvailability(player: Player, state: string): SocialFailure | 'ok' {
    if (state !== 'online' && state !== 'offline') return 'no_such_player';
    this.d.store.setAvailability(player.accountKey, state);
    // Take effect immediately: refresh the player's own list, and push presence to friends so
    // an Offline player vanishes from their online lists at once (not on the next rebuild).
    this.sendFriendList(player);
    this.notifyFriends(player.accountKey, state === 'online');
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
      case 'private': return false;
    }
  }

  // ---------------------------------------------------------------------- mutes

  // Player-level mute: persistent by design. A mute that evaporates on relog is not a
  // control, it is a suggestion — and "I can silence this person" is the single thing that
  // keeps an open voice/chat space usable.
  mute(player: Player, targetAcct: AccountKey): SocialFailure | 'ok' {
    if (targetAcct === player.accountKey) return 'self';
    this.d.store.addMute(player.accountKey, targetAcct, this.d.now());
    return 'ok';
  }

  unmute(player: Player, targetAcct: AccountKey): void {
    this.d.store.removeMute(player.accountKey, targetAcct);
  }

  // Moderator mute: one row under the server pseudo-muter, so every listener's check is
  // the same query and nobody has to remember to consult two lists.
  setServerMuted(targetAcct: AccountKey, muted: boolean): void {
    if (muted) this.d.store.addMute(SocialStore.SERVER_MUTER, targetAcct, this.d.now());
    else this.d.store.removeMute(SocialStore.SERVER_MUTER, targetAcct);
    log('info', 'social.server_mute', { account: targetAcct, muted });
  }

  isMuted(listener: AccountKey, speaker: AccountKey): boolean {
    return this.d.store.isMuted(listener, speaker);
  }

  // ------------------------------------------------------------------ dispatch

  // Returns true when the event belonged to this family, matching the other core modules.
  // Every failure is reported back to the caller rather than dropped: a friend request that
  // silently does nothing is indistinguishable from a broken server to the player.
  // Resolve an op's target to a REAL account key. The client's roster carries {id, name}
  // only, and it used to guess the key as the lowercased display name — wrong since
  // usernames, so mute/invite/report all landed on a phantom account and reported success.
  // A name is resolved against the live roster (you target people you can SEE); a raw acct
  // is accepted only if someone in this world actually has it.
  private targetAcct(body: LTable | undefined): string | undefined {
    const s = (k: string): string => {
      const v = body?.get(k);
      return typeof v === 'string' ? v : '';
    };
    const nm = s('name');
    if (nm !== '') return this.d.roster.findByName(nm)?.accountKey;
    const acct = s('acct');
    if (acct === '') return undefined;
    return this.d.roster.inWorld().some((p) => p.accountKey === acct) ? acct : undefined;
  }

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
        // By NAME from the panel (the account key is not on the wire), by acct from the older
        // request list. targetAcct takes either.
        const who = this.targetAcct(body) ?? str('acct');
        const r = this.acceptFriend(player, who);
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
        this.sendFriendList(player);
        return true;
      }
      case 'BlockRemove':
        this.unblock(player, str('acct'));
        this.reply(player, 'BlockRemove', true, 'ok');
        this.sendFriendList(player);
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
          // The Public switch has died silently at four different layers. This is the one the
          // server can see: whether the list was asked for, and what came back.
          log('info', 'world.list_served', {
            account: player.name, error: r.error ?? '', count: r.worlds.length,
            publicUp: r.worlds.filter((w) => w.mode === 'public' && w.up).length,
          });
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
              ...(w.wsPath ? { wsPath: w.wsPath } : {}),
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
                ...(r.world.wsPath ? { wsPath: r.world.wsPath } : {}),
              },
            } : {}),
          });
        });
        return true;
      }
      case 'PresenceMode': {
        // The client's generic social:<Op>:<arg> router puts the argument in `acct`, so accept
        // either. Reading only `mode` meant every privacy change was refused with
        // no_such_player, silently, forever.
        const mode = str('mode') || str('acct');
        const r = this.setPresenceMode(player, mode);
        this.reply(player, 'PresenceMode', r === 'ok', r === 'ok' ? mode : r);
        return true;
      }
      case 'SetAvailability': {
        const state = str('state') || str('acct');
        const r = this.setAvailability(player, state);
        this.reply(player, 'SetAvailability', r === 'ok', r === 'ok' ? state : r);
        return true;
      }
      case 'JoinFriend': {
        void this.joinFriend(player, str('acct'));
        return true;
      }
      // Phase 3.8: report from the player context menu. Same store and the same bounded
      // reason as the /report command — this is the surface, not a second system. Being an
      // event rather than a typed command is what makes it one click from the social hub,
      // which is the difference between a report flow that gets used and one that does not.
      case 'ReportPlayer': {
        // THE ONLY WAY TO REPORT, now that the typed /report is gone -- so it must accept
        // what /report accepted: a name that is no longer online. The griefer who logs off
        // the moment they are done is the ordinary case, not the edge. An online player
        // resolves to an account; an offline name is recorded as typed, with no account.
        const typed = str('name').trim().slice(0, 64);
        const targetAcct = this.targetAcct(body) ?? (typed !== '' ? this.d.resolveName(typed) : undefined);
        const reason = str('reason').slice(0, 500);
        if (targetAcct === undefined && typed === '') { this.reply(player, 'ReportPlayer', false, 'no_such_player'); return true; }
        if (targetAcct === player.accountKey) {
          this.reply(player, 'ReportPlayer', false, 'self');
          return true;
        }
        if (reason === '') {
          this.reply(player, 'ReportPlayer', false, 'no_reason');
          return true;
        }
        const target = targetAcct ? this.onlinePlayer(targetAcct) : undefined;
        void this.d.report?.({
          reporter: { id: player.id, account: player.accountKey, name: player.name },
          target: {
            id: target?.id ?? null,
            account: targetAcct ?? null,
            name: (targetAcct && this.d.displayName(targetAcct)) ?? typed,
            cellKey: target?.cellKey ?? null,
          },
          reason,
          // Voice abuse is worth flagging separately: it leaves no chat-log trace, so a
          // moderator reading the queue would otherwise have nothing to look at.
          voice: str('voice') === 'true',
        });
        log('info', 'social.reported', { by: player.accountKey, target: targetAcct });
        this.reply(player, 'ReportPlayer', true, 'ok');
        return true;
      }
      case 'MuteAdd': {
        const muteTarget = this.targetAcct(body);
        if (muteTarget === undefined) { this.reply(player, 'MuteAdd', false, 'no_such_player'); return true; }
        const r = this.mute(player, muteTarget);
        this.reply(player, 'MuteAdd', r === 'ok', r);
        this.sendFriendList(player);
        return true;
      }
      case 'MuteRemove':
        this.unmute(player, str('acct'));
        this.reply(player, 'MuteRemove', true, 'ok');
        this.sendFriendList(player);
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

  // "Join a friend": go to THEIR world. This is the one and only door into someone else's
  // game — there is no public world and no party to route through. The friend's own world
  // decides whether to admit the caller (mayJoinWorld: Solo refuses, Party admits friends up
  // to the cap), which is the correct place for that call, not here.
  // Friendship is required both ways — you cannot chase a stranger across worlds.
  async joinFriend(player: Player, targetAcct: AccountKey): Promise<void> {
    const me = player.accountKey;
    const fail = (detail: string): void => player.peer.sendEvent('JoinFriend', { ok: false, error: detail });
    if (targetAcct === '' || targetAcct === me) return fail('self');
    if (!this.d.store.areFriends(me, targetAcct)) return fail('not_friends');
    if (this.d.store.blockedEitherWay(me, targetAcct)) return fail('blocked');
    if (!this.isAvailable(targetAcct)) return fail('not_online');
    if (!this.worlds || !this.worlds.enabled) return fail('no_gateway');
    const friendName = this.d.displayName(targetAcct) ?? targetAcct;
    const own = await this.worlds.ownerWorld(targetAcct);
    if (!own) return fail('not_online');
    player.peer.sendEvent('JoinFriend', {
      ok: true, worldId: own.id, mode: own.mode, host: own.host, port: own.port, friendName,
      ...(own.wsPath ? { wsPath: own.wsPath } : {}),
    });
  }

  // Returns the inviter's live position for the client to travel to, or a failure.
  acceptInvite(player: Player, fromAcct: AccountKey):
  | { ok: true; cellKey: string; x: number; y: number; z: number }
  | { ok: false; reason: SocialFailure } {
    const now = this.d.now();
    if (!this.d.store.hasInvite(fromAcct, player.accountKey, now)) return { ok: false, reason: 'no_request' };
    if (this.d.store.blockedEitherWay(player.accountKey, fromAcct)) return { ok: false, reason: 'blocked' };
    const host = this.onlinePlayer(fromAcct);
    if (!host || !host.cellKey || !host.pose) return { ok: false, reason: 'not_online' };
    this.d.store.removeInvite(fromAcct, player.accountKey);
    return { ok: true, cellKey: host.cellKey, x: host.pose.x, y: host.pose.y, z: host.pose.z };
  }
}
