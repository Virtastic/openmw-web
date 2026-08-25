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
  goldSplit?: boolean;
  rollOnRare?: boolean;
  /** Party difficulty scaling. Leader-toggled; [rules] partyScaling is only the default. */
  scaling?: boolean;
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

/** How long a presence row stays believable without a refresh. Comfortably longer than the
 *  heartbeat, so a hiccup does not blink everyone offline, and short enough that a world which
 *  died without cleaning up ages out rather than leaving ghosts online forever. */
const PRESENCE_TTL_MS = 30_000;

export interface SocialDeps {
  store: SocialStore;
  roster: Roster;
  /** This world's id, so shared presence can name where a player actually is. */
  worldId?: string;
  /** [rules] partyScaling — the DEFAULT for a party that has never touched the toggle. Not the
   *  answer itself: the leader's choice, once made, outranks it. */
  defaultPartyScaling?: boolean;
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
    target: { id: number | null; account: string; name: string; cellKey: string | null };
    reason: string;
    voice: boolean;
  }): Promise<unknown>;
  // Phase 4: a vote in an open loot roll (the roll itself lives in PartyRules).
  lootVote?(player: Player, rollId: string, choice: 'need' | 'pass'): boolean;
}

interface Party {
  key: string; // stable, opaque, platform-wide (persisted; survives world hops + handover)
  leader: AccountKey;
  // Where the group currently is, recorded by partyTravel. Without it a late joiner had
  // nothing to dial: joinFriend assumed every party lives in its own `party-<key>` world,
  // which is wrong the moment a leader takes the group to public (or never leaves their own
  // world at all). In-memory on purpose — it describes a live location, and after a restart
  // there is no group standing anywhere to point at.
  at?: { id: string; mode: string; host: string; port: number; wsPath?: string };
  members: Set<AccountKey>;
}

// A party untouched for this long dissolves on next load — the guard that lets membership
// persist (required for cross-world travel) without restarts resurrecting dead groups.
export const PARTY_STALE_MS = 24 * 60 * 60 * 1000;

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
  // Parties PERSIST (socialstore) because travel moves members between world processes —
  // the party has to exist wherever its members land, so the store is the truth and this
  // map is a per-process cache hydrated on join. Staleness (PARTY_STALE_MS) is what keeps
  // a restart from resurrecting groups whose members are gone for good.
  private readonly parties = new Map<string, Party>();
  private readonly partyOf = new Map<AccountKey, string>();
  /** Cached for a second: a friend list of N would otherwise scan the table N times. */
  private presenceCache: { at: number; rows: PresenceRow[] } | undefined;
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

  /** Re-send the friend and party panels to everyone here.
   *
   *  Those views are pushed when the RELATIONSHIP changes — someone accepts, leaves, is
   *  removed — which is correct for membership and useless for presence: a member walking into
   *  another world changes nothing about the party, so the panel kept whatever it last said.
   *  It said "Offline" about someone the player could see standing in front of them. Presence
   *  now moves on its own heartbeat, so the views have to follow it. */
  /** DISCONNECT RULES. Party membership is deliberately durable — it must survive a member
   *  hopping between world processes, which is the entire point of party travel — but nothing
   *  distinguished a hop from quitting, so a party outlived everyone in it and a player who
   *  reconnected was mysteriously still in one.
   *
   *  A grace separates the two: leaving one world to join another looks identical to
   *  disconnecting for the few seconds in between. Past the grace it is a departure.
   *    - the LEADER gone  -> the party disbands, and members are told
   *    - a MEMBER gone    -> that member is removed
   *
   *  Idempotent, because every world process runs this over the same shared store: a party
   *  already dissolved has no members to sweep, and a member already removed is not in one. */
  sweepDisconnected(graceMs: number): void {
    const gone = this.d.store.goneLongerThan(this.d.now(), graceMs);
    for (const acct of gone) {
      const row = this.d.store.partyOfAccount(acct);
      if (!row) continue;
      const key = row.key;
      this.loadParty(acct);
      const party = this.parties.get(key);
      if (!party || !party.members.has(acct)) continue;
      if (party.leader === acct) {
        const members = [...party.members];
        for (const m of members) {
          this.partyOf.delete(m);
          this.d.store.partyRemoveMember(m);
          // Told, or the party simply evaporates and nobody knows why. Guests are returned to
          // their own world by the world-close path; this is the membership half.
          if (m !== acct) {
            this.onlinePlayer(m)?.peer.sendEvent('SocialNotice',
              { kind: 'party_disbanded', why: 'leader_left',
                by: this.d.displayName(acct) ?? acct } as never);
          }
        }
        this.parties.delete(key);
        this.d.store.partyDissolve(key);
        log('info', 'party.disbanded_leader_gone', { leader: acct, members: members.length });
      } else {
        this.partyLeave(acct);
        log('info', 'party.member_dropped', { account: acct });
      }
    }
  }

  /** A player who joins while in a party belongs WITH the party, not alone in their own
   *  world. Membership is durable across a disconnect (deliberately — see sweepDisconnected),
   *  so reconnecting used to drop you into your solo world while the panel insisted you were
   *  in a party: two true statements that cannot both be right.
   *
   *  Shared presence knows which world the leader is actually in, so the client can be told to
   *  follow. Returns true when a hand-off was sent. */
  routeJoinerToParty(player: Player, worldIdHere: string): boolean {
    const key = this.partyOf.get(player.accountKey) ?? this.d.store.partyOfAccount(player.accountKey)?.key;
    if (key === undefined) return false;
    this.loadParty(player.accountKey);
    const party = this.parties.get(key);
    if (!party || party.leader === player.accountKey) return false; // the leader IS the destination
    const where = this.presenceOf(party.leader);
    // Leader offline: sweepDisconnected will dissolve this shortly. Sending someone to chase a
    // world nobody is in would be worse than leaving them where they are.
    if (!where.online || !where.world || where.world === worldIdHere) return false;
    player.peer.sendEvent('PartyTravel', {
      worldId: where.world,
      wsPath: `/w/${where.world}`,
      leaderName: this.d.displayName(party.leader) ?? party.leader,
    } as never);
    log('info', 'party.rejoin_routed', {
      account: player.accountKey, to: where.world, leader: party.leader,
    });
    return true;
  }

  refreshPresenceViews(): void {
    this.presenceCache = undefined; // the whole point is to pick up what changed elsewhere
    for (const p of this.d.roster.inWorld()) {
      if (p.system || p.bot) continue; // nothing is listening on those peers
      this.sendFriendList(p);
      if (this.partyOf.has(p.accountKey) || this.d.store.partyOfAccount(p.accountKey)) {
        this.sendParty(p.accountKey);
      }
    }
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

  // Hydrate this process's party cache from the store: the member may have formed the
  // party in another world. Stale parties dissolve here rather than coming back as
  // zombies.
  // allowSolo: a party of ONE is normally stale rubbish and gets dissolved on join. It is
  // legitimate and transient in exactly one case — a leader who has sent an invite nobody has
  // accepted yet. Hydrating that party (to accept the invite from another world) must not
  // destroy the very thing it came to load.
  private loadParty(acct: AccountKey, allowSolo = false): void {
    // NO EARLY RETURN ON A CACHE HIT. This used to begin `if (this.partyOf.has(acct)) return`,
    // and the two maps were only ever ADDED to for remote changes — deletions happened only
    // for actions taken in THIS process. So every membership change made in another world was
    // invisible here permanently: a member who left in world B stayed listed in world A, and
    // refreshPresenceViews re-asserted them to everyone every 10 seconds; a leader handover in
    // B never arrived, so two processes each believed a different account led and both passed
    // isPartyLeader; and partyMembersOf — which is the AUTHORIZATION check for VoiceSignal —
    // kept returning someone who had left, so they stayed reachable by voice.
    //
    // The store is the truth and it is one indexed row plus one member query, so reconcile
    // against it every time instead of trusting a cache with no invalidation.
    // A party of ONE is normally stale rubbish, but it is legitimate and transient while an
    // invite is outstanding — partyInvite creates the party then writes the invite. This
    // process created it, so its presence in the cache is the evidence: dissolving on a
    // reconcile would destroy the party the invitee is about to accept into.
    const known = this.partyOf.has(acct);
    const row = this.d.store.partyOfAccount(acct);
    if (!row) {
      // Gone in the store means gone here, including the party object if we were its last
      // local trace.
      const stale = this.partyOf.get(acct);
      if (stale !== undefined) {
        this.partyOf.delete(acct);
        const p = this.parties.get(stale);
        p?.members.delete(acct);
        if (p && p.members.size === 0) this.parties.delete(stale);
      }
      return;
    }
    const members = this.d.store.partyMembers(row.key);
    if (members.length <= 1 && !allowSolo && !known) {
      this.d.store.partyDissolve(row.key);
      this.partyOf.delete(acct);
      this.parties.delete(row.key);
      return;
    }
    this.d.store.partySweepStale(this.d.now() - PARTY_STALE_MS);
    if (!this.d.store.partyOfAccount(acct)) return; // it was stale and just dissolved
    let party = this.parties.get(row.key);
    if (!party) {
      party = { key: row.key, leader: row.leader, members: new Set(members) };
      this.parties.set(row.key, party);
    }
    // Mutated in place, not replaced: callers hold the object across a loadParty.
    party.leader = row.leader; // a handover made in another world lands here
    const live = new Set(members);
    for (const m of [...party.members]) {
      if (live.has(m)) continue;
      party.members.delete(m);
      if (this.partyOf.get(m) === row.key) this.partyOf.delete(m);
    }
    for (const m of members) {
      party.members.add(m);
      this.partyOf.set(m, row.key);
    }
  }

  onJoin(player: Player): void {
    const acct = player.accountKey;
    this.loadParty(acct);
    // Cancel a pending offline announcement: this is a reconnect inside the grace window,
    // so as far as friends are concerned they never left.
    const t = this.offlineTimers.get(acct);
    if (t) {
      clearTimeout(t);
      this.offlineTimers.delete(acct);
      this.sendFriendList(player);
      this.sendParty(acct);
      this.drainInvites(player);
      return; // no PresenceUpdate at all — they were never shown offline
    }
    this.sendFriendList(player);
    this.sendParty(acct);
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
    // Party membership survives a brief drop, exactly like presence: being dropped from
    // your group because your connection blipped is worse than a stale row for a few
    // seconds. It is cleared when the offline announcement finally fires.
    const existing = this.offlineTimers.get(acct);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(acct);
      // Re-check: the account may have come back on a different connection.
      if (this.onlinePlayer(acct)) return;
      // Membership PERSISTS through going offline — the member may be mid-hop to another
      // world (party travel), and being ejected because a reconnect took 20 seconds is
      // exactly the Skyrim-Together complaint this design removes. They leave a party via
      // PartyLeave, a kick, or the staleness sweep — never by a dropped socket.
      const pk = this.partyOf.get(acct);
      if (pk !== undefined) this.broadcastParty(pk);
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
  private deliverInvite(to: AccountKey, from: AccountKey, fromName: string, kind: string): void {
    const p = this.onlinePlayer(to);
    if (!p) return;
    p.peer.sendEvent(kind === 'party' ? 'PartyInviteReceived' : 'InviteReceived',
      { fromAcct: from, fromName });
  }

  // Everything addressed to this player while they were elsewhere (or offline).
  private drainInvites(player: Player): void {
    for (const inv of this.d.store.invitesFor(player.accountKey, this.d.now())) {
      if (this.d.store.blockedEitherWay(player.accountKey, inv.from)) continue;
      this.deliverInvite(player.accountKey, inv.from,
        this.d.displayName(inv.from) ?? inv.from, inv.kind);
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
    this.deliverInvite(targetAcct, from, player.name, 'world');
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
      case 'party': return this.samePartyAs(viewer, subject);
      case 'private': return false;
    }
  }

  // ------------------------------------------------------------------- party

  private samePartyAs(a: AccountKey, b: AccountKey): boolean {
    this.loadParty(a); this.loadParty(b);
    const pa = this.partyOf.get(a);
    return pa !== undefined && pa === this.partyOf.get(b);
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

  // Phase 4 party rules the LEADER toggles for the group. Defaults chosen so a party that
  // never opens the panel still behaves the way friends expect: gold splits (first-grab on
  // gold is the one thing that reliably breeds resentment), rolling does not interrupt.
  partySettings(acct: AccountKey): { goldSplit: boolean; rollOnRare: boolean; scaling: boolean } {
    this.loadParty(acct);
    const key = this.partyOf.get(acct);
    if (key === undefined) return { goldSplit: false, rollOnRare: false, scaling: false };
    return {
      goldSplit: (this.d.store.partySetting(key, 'goldSplit') ?? 'true') === 'true',
      rollOnRare: (this.d.store.partySetting(key, 'rollOnRare') ?? 'false') === 'true',
      // Difficulty scaling is OPT-IN and the LEADER is who opts in. [rules] partyScaling supplies
      // the default (shipped off): people come to co-op to play Morrowind together, not to have
      // it quietly made harder because a friend walked in. But a group that wants the challenge
      // has to be able to ASK — and for a while it could not, because the config default was
      // flipped off while this map still only knew about loot, leaving scaling operator-only.
      scaling: (this.d.store.partySetting(key, 'scaling')
        ?? (this.d.defaultPartyScaling ? 'true' : 'false')) === 'true',
    };
  }

  setPartySetting(player: Player, name: string, value: boolean): SocialFailure | 'ok' {
    this.loadParty(player.accountKey);
    const key = this.partyOf.get(player.accountKey);
    const party = key !== undefined ? this.parties.get(key) : undefined;
    if (!party) return 'not_in_party';
    if (party.leader !== player.accountKey) return 'not_leader';
    if (name !== 'goldSplit' && name !== 'rollOnRare' && name !== 'scaling') return 'no_such_player';
    this.d.store.setPartySetting(key!, name, value ? 'true' : 'false');
    for (const m of party.members) this.sendParty(m);
    return 'ok';
  }

  isPartyLeader(acct: AccountKey): boolean {
    this.loadParty(acct);
    const key = this.partyOf.get(acct);
    const party = key !== undefined ? this.parties.get(key) : undefined;
    return party?.leader === acct;
  }

  // Phase 4: party membership for quest credit / loot rules. Hydrates from the store so a
  // member who formed the party in another world still counts here. Empty when solo.
  /** The party's id, for scoping things that belong to it (chat scrollback). */
  partyIdOf(acct: AccountKey): string | undefined {
    this.loadParty(acct);
    return this.partyOf.get(acct);
  }

  partyMembersOf(acct: AccountKey): AccountKey[] {
    this.loadParty(acct);
    const key = this.partyOf.get(acct);
    const party = key !== undefined ? this.parties.get(key) : undefined;
    return party ? [...party.members] : [];
  }

  partyView(acct: AccountKey): PartyView | null {
    this.loadParty(acct);
    const id = this.partyOf.get(acct);
    if (id === undefined) return null;
    const party = this.parties.get(id);
    if (!party) return null;
    const settings = this.partySettings(acct);
    return {
      leader: party.leader,
      // Members see the rules in force even though only the leader may change them:
      // "why did my gold split" should be answerable by looking at the panel.
      goldSplit: settings.goldSplit,
      rollOnRare: settings.rollOnRare,
      scaling: settings.scaling,
      members: [...party.members].map((m) => {
        const p = this.onlinePlayer(m);
        // SERVER-WIDE, like the friend list. This asked the LOCAL roster, so a party member in
        // another world showed as OFFLINE — which is not merely wrong, it is impossible: you
        // cannot be in a party without being online, and the panel said so while the player
        // could literally see them standing there.
        const where = this.presenceOf(m);
        return {
          acct: m,
          name: this.d.displayName(m) ?? m,
          online: where.online,
          // A party member's location is shown to the party regardless of mode 'party',
          // but 'private' still hides it — opting out has to mean something even here.
          ...(p ? { playerId: p.id } : {}),
          ...(where.cellKey && this.presenceMode(m) !== 'private' ? { cellKey: where.cellKey } : {}),
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
      : {
        leader: view.leader,
        goldSplit: view.goldSplit === true,
        rollOnRare: view.rollOnRare === true,
        members: view.members as unknown as never,
      });
  }

  private broadcastParty(key: string): void {
    const party = this.parties.get(key);
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
    // Same as invite(): reachable means AVAILABLE, not co-present. Deliberately NOT gated on a
    // live presence row — those are written on a 10s heartbeat, so gating here would refuse an
    // invite to someone who joined eight seconds ago. An invite to a player who is genuinely
    // offline is harmless now that the party is created on ACCEPT: it sits in the mailbox,
    // drains on their next join if it is still inside the TTL, and leaves nothing behind if
    // not.
    if (!this.isAvailable(targetAcct)) return 'not_online';
    // Ask the STORE, not the local map: partyOf is hydrated on join, so it knows nothing
    // about a player who is partied over in another world — and would happily double-invite
    // them into a second group.
    if (this.d.store.partyOfAccount(targetAcct) !== undefined) return 'already_in_party';

    // THE PARTY IS CREATED ON ACCEPT, NOT ON INVITE. Creating it here put the inviter into a
    // real, persisted party of ONE the moment they clicked invite — and the check above reads
    // the store, so from everyone else's side they were now 'already_in_party' and could not
    // be invited by anybody. If the invitee never accepted (they were offline, or just did
    // not), the invite expired in two minutes and the phantom party outlived it: "I invited
    // Bob, he never got it, and now nobody can invite me."
    this.loadParty(from, true);
    const key = this.partyOf.get(from);
    const party = key !== undefined ? this.parties.get(key) : undefined;
    if (party) {
      if (party.leader !== from) return 'not_leader';
      if (party.members.size >= this.maxParty) return 'party_full';
    }

    const now = this.d.now();
    this.d.store.addInvite(from, targetAcct, 'party', now, this.tuning.inviteTtlMs);
    this.deliverInvite(targetAcct, from, player.name, 'party');
    if (party) this.sendParty(from);
    return 'ok';
  }

  /** A party key: stable, opaque and platform-wide — persisted, so it survives world hops and
   *  leader handover. */
  private newPartyKey(): string {
    return `p${this.d.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
  }

  partyAccept(player: Player, fromAcct: AccountKey): SocialFailure | 'ok' {
    const me = player.accountKey;
    const now = this.d.now();
    if (!this.d.store.hasInvite(fromAcct, me, now)) return 'no_request';
    if (this.d.store.blockedEitherWay(me, fromAcct)) return 'blocked';
    if (this.partyOf.has(me)) return 'already_in_party';
    // Hydrate the INVITER's party from the shared store. partyOf/parties are per-process
    // caches filled on join, so accepting an invite that arrived from another world found
    // nothing here and answered 'not_in_party' — the party exists, just not in this process.
    this.loadParty(fromAcct, true);
    let key = this.partyOf.get(fromAcct);
    let party = key !== undefined ? this.parties.get(key) : undefined;
    if (!party) {
      // First acceptance makes the party. The inviter had none because partyInvite no longer
      // creates one — see the note there.
      key = this.newPartyKey();
      party = { key, leader: fromAcct, members: new Set([fromAcct]) };
      this.parties.set(key, party);
      this.partyOf.set(fromAcct, key);
      this.d.store.partyCreate(key, fromAcct, now);
    }
    // The cap is enforced by the STORE, in the same call as the insert: this local check is
    // per-process, so two accepts landing in two different worlds both saw room.
    if (!this.d.store.partyAddMember(party.key, me, now, this.maxParty)) {
      this.d.store.removeInvite(fromAcct, me); // spent either way; see the note below
      return 'party_full';
    }
    party.members.add(me);
    this.partyOf.set(me, party.key);
    this.d.store.removeInvite(fromAcct, me);
    this.broadcastParty(party.key);
    return 'ok';
  }

  // Put a player who just joined a party where that party actually is. Three cases, in the
  // order they are cheapest to satisfy:
  //   leader co-present here -> no dial at all, just stand next to them (the invite-teleport
  //     path the client already handles; guestSpawn does the same for arrivals).
  //   party has travelled   -> send them to the recorded world.
  //   neither               -> stay put. The leader is in a world we cannot name, and dialling
  //     a guess (an empty `party-<key>`) is worse than not moving: it strands the joiner
  //     somewhere nobody is.
  private routeToParty(player: Player): void {
    const key = this.partyOf.get(player.accountKey);
    const party = key !== undefined ? this.parties.get(key) : undefined;
    if (!party) return;
    const leader = this.onlinePlayer(party.leader);
    if (leader && leader.cellKey && leader.pose) {
      player.peer.sendEvent('InviteAccepted',
        { cellKey: leader.cellKey, x: leader.pose.x, y: leader.pose.y, z: leader.pose.z });
      return;
    }
    if (!party.at) return;
    player.peer.sendEvent('PartyTravel', {
      target: party.at.mode === 'public' ? 'public' : 'party',
      worldId: party.at.id, mode: party.at.mode, host: party.at.host, port: party.at.port,
      // The leader's public handle. displayName resolves to the USERNAME (see server.ts),
      // which is what every other social surface shows; empty when they have not set one.
      leaderName: this.d.displayName(party.leader) ?? '',
    });
  }

  /** Leader removes a member. Reuses partyLeave so leader succession, dissolution below two
   *  members, and the store writes all stay in ONE place — a second copy of that logic is how
   *  a party ends up half-dissolved. */
  partyKick(byAcct: AccountKey, target: AccountKey): 'ok' | 'not_leader' | 'no_party' | 'not_member' | 'self' {
    if (byAcct === target) return 'self'; // leaving is PartyLeave; this is for removing someone else
    this.loadParty(byAcct);
    const key = this.partyOf.get(byAcct);
    if (key === undefined) return 'no_party';
    const party = this.parties.get(key);
    if (!party) return 'no_party';
    if (party.leader !== byAcct) return 'not_leader';
    if (!party.members.has(target)) return 'not_member';
    this.partyLeave(target);
    // Tell them, or being removed is indistinguishable from the party vanishing.
    this.onlinePlayer(target)?.peer.sendEvent('SocialNotice',
      { kind: 'party_kicked', by: this.d.displayName(byAcct) ?? byAcct } as never);
    return 'ok';
  }

  partyLeave(acct: AccountKey): void {
    const key = this.partyOf.get(acct);
    if (key === undefined) return;
    const party = this.parties.get(key);
    this.partyOf.delete(acct);
    this.d.store.partyRemoveMember(acct);
    if (!party) return;
    party.members.delete(acct);
    // The leader leaving hands over rather than dissolving the group: everyone else being
    // silently ejected because one person left is worse than an arbitrary successor.
    if (party.leader === acct) {
      const next = [...party.members][0];
      if (next) {
        party.leader = next;
        this.d.store.partySetLeader(key, next, this.d.now());
      }
    }
    if (party.members.size <= 1) {
      for (const m of party.members) {
        this.partyOf.delete(m);
        this.d.store.partyRemoveMember(m);
        this.sendParty(m);
      }
      this.parties.delete(key);
      this.d.store.partyDissolve(key);
    } else {
      this.broadcastParty(key);
    }
    this.sendParty(acct); // the leaver gets an empty party
  }

  // Going Solo is a statement that this world is yours alone, so it ends the group rather
  // than handing it over the way partyLeave does: the members were in the leader's world by
  // the leader's invitation, and silently promoting one of them leaves a party nobody chose
  // sitting in a world that just closed to them. Each member goes back to their own world
  // (their client dials home on the empty PartyUpdate). No-op unless `acct` leads a party.
  partyDisband(acct: AccountKey): boolean {
    const key = this.partyOf.get(acct);
    const party = key !== undefined ? this.parties.get(key) : undefined;
    if (!party || key === undefined || party.leader !== acct) return false;
    for (const m of party.members) {
      this.partyOf.delete(m);
      this.d.store.partyRemoveMember(m);
      this.sendParty(m);
    }
    this.parties.delete(key);
    this.d.store.partyDissolve(key);
    log('info', 'social.party_disband', { party: key, leader: acct });
    return true;
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
      case 'PartyInvite': {
        const inviteTarget = this.targetAcct(body);
        if (inviteTarget === undefined) { this.reply(player, 'PartyInvite', false, 'no_such_player'); return true; }
        const r = this.partyInvite(player, inviteTarget);
        this.reply(player, 'PartyInvite', r === 'ok', r);
        return true;
      }
      case 'PartyAccept': {
        const r = this.partyAccept(player, str('acct'));
        this.reply(player, 'PartyAccept', r === 'ok', r);
        // Accepting used to only change membership: you were "in a party" that could be in
        // another world entirely, with nothing telling your client to go there. Route on the
        // way in, the same as travel does.
        if (r === 'ok') this.routeToParty(player);
        return true;
      }
      // Phase 2.5 party voice: WebRTC signaling relayed between PARTY MEMBERS ONLY.
      // The server never sees audio — it forwards offer/answer/ICE so two browsers can
      // open a direct peer connection, which is why a mesh needs no media server. Being
      // party-scoped is the access control: an SDP offer to a stranger is how a voice
      // system becomes a way to force a connection on someone.
      case 'VoiceSignal': {
        const to = str('acct');
        const members = this.partyMembersOf(player.accountKey);
        if (!members.includes(to) || to === player.accountKey) {
          this.reply(player, 'VoiceSignal', false, 'not_in_party');
          return true;
        }
        if (this.d.store.isMuted(to, player.accountKey)) {
          // A muted speaker is not told they are muted (that invites retaliation); the
          // signal is simply not delivered, so no connection is ever offered.
          this.reply(player, 'VoiceSignal', true, 'ok');
          return true;
        }
        const target = this.onlinePlayer(to);
        if (!target) {
          this.reply(player, 'VoiceSignal', false, 'not_online');
          return true;
        }
        const payload = body?.get('payload');
        target.peer.sendEvent('VoiceSignal', {
          fromAcct: player.accountKey,
          fromName: player.name,
          kind: str('kind'), // offer | answer | ice
          payload: typeof payload === 'string' ? payload : '',
        });
        this.reply(player, 'VoiceSignal', true, 'ok');
        return true;
      }
      // Phase 3.8: report from the player context menu. Same store and the same bounded
      // reason as the /report command — this is the surface, not a second system. Being an
      // event rather than a typed command is what makes it one click from the social hub,
      // which is the difference between a report flow that gets used and one that does not.
      case 'ReportPlayer': {
        const targetAcct = this.targetAcct(body);
        const reason = str('reason').slice(0, 500);
        if (targetAcct === undefined) { this.reply(player, 'ReportPlayer', false, 'no_such_player'); return true; }
        if (targetAcct === player.accountKey) {
          this.reply(player, 'ReportPlayer', false, 'self');
          return true;
        }
        if (reason === '') {
          this.reply(player, 'ReportPlayer', false, 'no_reason');
          return true;
        }
        const target = this.onlinePlayer(targetAcct);
        void this.d.report?.({
          reporter: { id: player.id, account: player.accountKey, name: player.name },
          target: {
            id: target?.id ?? null,
            account: targetAcct,
            name: this.d.displayName(targetAcct) ?? targetAcct,
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
      case 'LootRollVote': {
        const r = this.d.lootVote?.(player, str('id'), str('choice') === 'need' ? 'need' : 'pass');
        this.reply(player, 'LootRollVote', r !== false, r === false ? 'no_roll' : 'ok');
        return true;
      }
      case 'PartySetting': {
        const r = this.setPartySetting(player, str('name'), str('value') === 'true');
        this.reply(player, 'PartySetting', r === 'ok', r);
        return true;
      }
      case 'MuteAdd': {
        const muteTarget = this.targetAcct(body);
        if (muteTarget === undefined) { this.reply(player, 'MuteAdd', false, 'no_such_player'); return true; }
        const r = this.mute(player, muteTarget);
        this.reply(player, 'MuteAdd', r === 'ok', r);
        return true;
      }
      case 'MuteRemove':
        this.unmute(player, str('acct'));
        this.reply(player, 'MuteRemove', true, 'ok');
        return true;
      // The leader may remove a member. Leaving was the only way out, so a leader stuck with
      // someone had to disband the whole party to be rid of them.
      case 'PartyKick': {
        // The account key comes straight from the party view the client is looking at, and is
        // authorised by MEMBERSHIP, not by presence: targetAcct only accepts someone in THIS
        // world, and a party member is very often in another one — which is the entire reason
        // the party is shared state. partyKick refuses anything that is not a member.
        const target = str('acct');
        if (target === '') { this.reply(player, 'PartyKick', false, 'no_such_player'); return true; }
        const r = this.partyKick(player.accountKey, target);
        this.reply(player, 'PartyKick', r === 'ok', r);
        return true;
      }
      case 'PartyLeave':
        this.partyLeave(player.accountKey);
        this.reply(player, 'PartyLeave', true, 'ok');
        return true;
      // Party travel (plan 2.5.1): the leader moves the whole group between the party's
      // campaign world and public. Async like WorldList/WorldCreate — the gateway is
      // consulted off the session's hot path, and every member co-present in THIS world
      // gets a PartyTravel event telling their client where to dial. Members elsewhere
      // hydrate the party from the store when they arrive wherever they are going.
      case 'PartyTravel': {
        void this.partyTravel(player, str('target'));
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

  // Leader-only. target 'party' = the group's own campaign world (created on first travel,
  // owned by the CURRENT leader — the world persists under whoever led when it was first
  // made, which is the plan's "persisted under the owner's account"); target 'public' =
  // the platform's public world. The server only TELLS clients where to go — each member's
  // client dials the new world itself and re-auths there (same character, per plan).
  async partyTravel(player: Player, target: string): Promise<void> {
    const from = player.accountKey;
    const key = this.partyOf.get(from);
    const party = key !== undefined ? this.parties.get(key) : undefined;
    if (!party) {
      this.reply(player, 'PartyTravel', false, 'not_in_party');
      return;
    }
    if (party.leader !== from) {
      this.reply(player, 'PartyTravel', false, 'not_leader');
      return;
    }
    if (!this.worlds || !this.worlds.enabled) {
      this.reply(player, 'PartyTravel', false, 'no_gateway');
      return;
    }

    // PUBLIC is the only destination a party travels to. There used to be a dedicated
    // `party-<key>` world as well, which was a blank process containing nobody's progress —
    // it contradicted the rule that a leader flipping to Party keeps their OWN world (and
    // stays the quest authority) instead of being moved somewhere empty. A party is together
    // either in the leader's world flipped to 'party' or in the shared world; there is no
    // third place, so there is no third world to create.
    if (target !== 'public') {
      this.reply(player, 'PartyTravel', false, 'bad_target');
      return;
    }
    const r = await this.worlds.list(player);
    const dest = r.worlds.find((w) => w.mode === 'public' && w.up);
    if (!dest) {
      this.reply(player, 'PartyTravel', false, r.error ?? 'no_public_world');
      return;
    }

    this.d.store.partyTouch(party.key, this.d.now());
    party.at = { id: dest.id, mode: dest.mode, host: dest.host, port: dest.port, wsPath: dest.wsPath };
    // Fan out to every member co-present in THIS world (the offline/elsewhere ones keep
    // their membership and can follow via the party panel when they see where it went).
    for (const m of party.members) {
      const p = this.onlinePlayer(m);
      p?.peer.sendEvent('PartyTravel', {
        target,
        worldId: dest.id,
        mode: dest.mode,
        host: dest.host,
        ...(dest.wsPath ? { wsPath: dest.wsPath } : {}),
        port: dest.port,
        leaderName: player.name,
      });
    }
    log('info', 'social.party_travel', { party: party.key, target, worldId: dest.id, leader: from });
  }

  // "Join a friend": go where they are. The single shared public world makes this
  // deterministic without the gateway tracking per-player location:
  //   - Offline (peeled into their solo world) -> refused; a solo session is unjoinable.
  //   - In a party -> auto-join that party (friends + space) and travel to its world.
  //   - Otherwise (Online, no party) -> they're out in the one PUBLIC world; go there.
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

    const theirParty = this.partyOf.get(targetAcct);
    if (theirParty !== undefined) {
      const party = this.parties.get(theirParty);
      if (!party) return fail('not_in_party');
      if (this.partyOf.get(me) !== theirParty) {
        if (this.partyOf.has(me)) return fail('already_in_party');
        if (party.members.size >= this.maxParty) return fail('party_full');
        party.members.add(me);
        this.partyOf.set(me, party.key);
        this.d.store.partyAddMember(party.key, me, this.d.now());
        this.broadcastParty(party.key);
      }
      // Where the group ACTUALLY is, else the leader's OWN world — which is where a party
      // that never travelled is sitting. Never `party-<key>`: creating one dialled you into
      // an empty world whenever the party was somewhere else.
      const dest = party.at ?? await this.worlds.ownerWorld(party.leader);
      if (!dest) return fail('not_travelled');
      player.peer.sendEvent('JoinFriend', {
        ok: true, worldId: dest.id, mode: dest.mode, host: dest.host, port: dest.port, friendName,
        ...(dest.wsPath ? { wsPath: dest.wsPath } : {}),
      });
      return;
    }
    // No party. If they are sitting in their OWN world, that is where they are — go there.
    // Their world decides whether to admit us (mayJoinWorld: Solo refuses, Party admits the
    // owner's party), which is the correct place for that call, not here.
    const own = await this.worlds.ownerWorld(targetAcct);
    if (own) {
      player.peer.sendEvent('JoinFriend', {
        ok: true, worldId: own.id, mode: own.mode, host: own.host, port: own.port, friendName,
        ...(own.wsPath ? { wsPath: own.wsPath } : {}),
      });
      return;
    }
    // Otherwise they are out in the shared world.
    const r = await this.worlds.list(player);
    const pub = r.worlds.find((w) => w.mode === 'public' && w.up);
    if (!pub) return fail(r.error ?? 'no_public_world');
    player.peer.sendEvent('JoinFriend', {
      ok: true, worldId: pub.id, mode: pub.mode, host: pub.host, port: pub.port, friendName,
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
