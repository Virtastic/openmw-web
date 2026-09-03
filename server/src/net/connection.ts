// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Per-socket session state machine per PROTOCOL.md:
// CONNECTED -> (Hello <= timeout) -> HELLO_OK -> (auth) -> AUTHED -> (Ready) -> IN_WORLD.
// Text frames = JSON session tier; binary frames = enveloped event tier.

import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Config } from '../config';
import { validEmail, validAccountName, DEFAULT_CHARACTER_NAME, type AccountStore, type Account, type CharacterSummary } from '../core/accounts';
import type { AttioHook } from '../integrations/attio';
import type { ContentGate, EngineGate } from '../core/manifest';
import type { Player, Peer, Roster } from '../core/players';
import { INPUT_DRIVING_MS, PEER_POSE_FRESH_MS } from '../core/players';
import type { CommandRegistry, CommandContext } from '../core/commands';
import type { HookBus } from '../plugins/loader';
import { handleChatSend } from '../core/chat';
import type { Social } from '../core/social';
import type { Moderation } from '../core/moderation';
import { TokenBucket, IpRateLimiter } from './ratelimit';
import { socketRttMs } from './ws';
import { MSG_EVENT, MSG_PLAYER_MOVE, MSG_PLAYER_MOVE_BATCH, MSG_ACTOR_MOVE_BATCH, ProtoError, unpackEnvelope, unpackEvent, packEvent, packEnvelope, nextBroadcastSeq } from '../proto/envelope';
import { MSG_PLAYER_INPUT, MSG_AVATAR_MOVE_BATCH, INPUT_PAYLOAD_BYTES, packInputForward, unpackAvatarMoveBatch } from '../proto/input';
import { unpackMove } from '../proto/movement';
import { MAX_ABS_COORD , isChargenCell, parseExterior, cellsVisible } from '../core/movement';
import { handleAvatarItemStatesBatch, handleAvatarStatsBatch, handleStateEvent, syncStateOnJoin, type StateCtx } from '../core/playerstate';
import type { WorldState } from '../core/worldstate';
import type { Combat } from '../core/combat';
import type { Quests } from '../core/quests';
import type { WorldM7 } from '../core/m7';
import type { Admin } from '../core/admin';
import type { BanStore } from '../persist/banstore';
import type { ResumeStore, ResumeTicket } from '../core/resume';
import type { LoginTicketStore, SessionIndex } from '../auth/identities';
import type { PlayerStore, PlayerDoc } from '../persist/playerstore';
import { lserDecode, lserEncode, jsToL, LserError, type JsLike, type LValue } from '../proto/lser';
import {
  parseSessionMessage,
  helloOk,
  welcome,
  pong,
  disconnectMsg,
  profileResult,
  characterResult,
  SessionParseError,
  type ClientSessionMsg,
  type SessionHello,
  type SessionResume,
  type SessionRegister,
  type SessionLoginRequest,
  type SessionLoginTicket,
  type ProfileSetup,
  type CharacterCreate,
  type WelcomeCharacter,
  type DisconnectCode,
} from '../proto/session';
import { log } from '../log';
import { HARNESS_PASSWORD } from '../auth/harness';
import { metrics } from '../metrics';

export type SessionState = 'CONNECTED' | 'HELLO_OK' | 'AUTHED' | 'IN_WORLD' | 'CLOSED';

// omwmp_auth_total{op,...}. Kept apart from the message name so the label space is closed.
type AuthOp = 'register' | 'login' | 'resume' | 'ticket';

// Everything a connection needs from the composed server; kept as an interface so
// connection.ts has no import cycle with server.ts.
export interface ServerCtx {
  worldPeer(): Player | undefined; // THE world peer (server.ts): the single simulator
  config: Config;
  accounts: AccountStore;
  roster: Roster;
  content: ContentGate;
  engine: EngineGate;
  // Phase H: present only when a sim peer is configured. Used to stop retrying a peer that
  // was refused for a reason retrying cannot fix.
  simPeers?: { disablePermanently(reason: string): void; noteHello?(key: string): void };
  /** Is the world actually being SIMULATED — the peer holding cells, not merely connected?
   *  Clients hold their loading screen on this. */
  simReady?(): boolean;
  /** Run an anchor/claim pass now instead of waiting for the next periodic one. */
  onPeerJoined?(): void;
  /** Send this player their chat scrollback. Absent = no history configured. */
  replayChat?(player: Player): void;
  // Tier 2 (the server has its own valid game data). Only then may a sim peer's manifest be
  // pinned as the world's canonical content list.
  gameDataOk?: boolean;
  loginLimiter: IpRateLimiter;
  commands: CommandRegistry;
  commandCtx: CommandContext;
  hooks: HookBus;
  players: PlayerStore;
  stateCtx: StateCtx;
  world: WorldState;
  combat: Combat;
  quests: Quests;
  social: Social;
  m7: WorldM7;
  // M8 ops.
  admin: Admin;
  bans: BanStore;
  resume: ResumeStore;
  moderation: Moderation; // A4: durable chat log + report inbox
  // Phase B SSO. Both are always present; SSO being disabled just means no ticket is ever
  // minted, so redeeming one always fails.
  tickets: LoginTicketStore;
  // Register a fire-and-forget promise so shutdown can wait for it. A background write that
  // outlives close() lands on a closed database: it throws an unhandled rejection AND loses
  // the write. ChargenComplete is the one that hurts — the flag it sets is what the shared
  // world's "has this character been created" gate reads, so a player who finishes creation
  // exactly as the server restarts is left unable to join, with nothing explaining why.
  track?: (p: Promise<unknown>) => void;
  sessions: SessionIndex;
  attio: AttioHook; // onboarding CRM capture; inert when no API key is configured
  // World access control (F3): may this account be in THIS world at all? Private = owner
  // only, party = owner + friends of the owner + admins. Checked at auth, after the account
  // is resolved.
  mayJoinWorld(accountKey: string, rank: number): boolean;
  // Owner-only in-place flip of THIS world between 'private' (solo) and 'party' (joinable
  // by the owner's friends). Used by the where-am-I switcher.
  setWorldMode(accountKey: string, rank: number, mode: string): 'ok' | 'not_owner' | 'bad_mode' | 'not_flippable';
  /** A player left the world. Acts only if they were its OWNER: a guest world with no host
   *  closes after a grace window (server.ts onPlayerLeftWorld). */
  onPlayerLeftWorld?(accountKey: string): void;
  /** Is this character in the wrong PRIVATE world? Private world ids end with the last 8 of
   *  their character's id, so the owner arriving with any other character is a routing error
   *  to refuse at the door — not something to diagnose downstream, again. */
  wrongWorldForCharacter?(accountKey: string, charId: string): boolean;
  // Spawn a fresh guest at the owner's position (null when it should not apply).
  guestSpawn(accountKey: string): { cellKey: string; x: number; y: number; z: number } | null;
  // What this world IS, right now. Sent at join so the client never has to infer it.
  worldId: string;
  worldMode(): string;
  // F3 chargen gate: true only for a GATEWAY-managed party world (where a separate
  // private world exists for character creation). A standalone/single-world server is false —
  // there is no other world to create the character in, so it must admit fresh characters.
  chargenGate: boolean;
  // Called when the last player leaves, so a world can forget a runtime mode flip.
  onWorldEmpty?(): void;
  // Phase 4: one-shot scripted spawns this character is owed on entering a cell.
  questSpawnsOnEntry?(player: Player, cellKey: string): { recordId: string; questId: string }[];
  questRepair?: {
    inspect(charId: string): { journal: Record<string, number>; globals: Record<string, number> };
    setStage(charId: string, questId: string, index: number, by: string): boolean;
    clearSpawnCooldowns(charId: string, by: string): void;
  };
  motd(): string; // mutable at runtime via /motd
}

// How much wall clock must pass before a speed verdict is formed. Long enough that a burst of
// frames delivered after a network stall collapses into one honest measurement, short enough
// that three consecutive windows is still under a second of sustained impossibility.
const MOVE_WINDOW_MS = 200;

export class Connection implements Peer {
  state: SessionState = 'CONNECTED';
  player?: Player;
  private account?: Account;
  private authedVia?: string; // which auth rung succeeded; recorded in the CRM upsert
  private outSeq = 0;
  private lastClientSeq = 0;
  private internalErrors = 0; // informational for the event tier
  private helloTimer?: NodeJS.Timeout;
  private contentHeld = false;
  // Declared at Hello; carried onto the Player so cell-authority election can require it.
  private simulatesActors = false;
  private isSystem = false;
  private engineHeld = false;
  // Set by resolveCharacter when this connection's character is genuinely still in
  // Morrowind's opening sequence, so authenticate() can withhold persistence until it
  // finishes. Evidence-based: see resolveCharacter, not the `completed` flag.
  private creationInProgress = false;
  // Set when this connection is playing a character that has no slot yet: the slot is
  // written on ChargenComplete (adoptCharacter), not when the launcher asks for an id.
  private provisionalCharId: string | undefined;
  private authing = false;
  private sessionToken = ''; // M8: parked as a resume ticket when an in-world session drops
  private resumed?: ResumeTicket;
  private readonly msgBucket: TokenBucket;
  private readonly byteBucket: TokenBucket;
  private readonly moveBucket: TokenBucket; // movement has its own budget (PROTOCOL.md M1)
  // The cell's actor-authority holder streams NPC batches on top of its own pose, so it
  // must not spend the same budget as everyone else's movement.
  private readonly actorMoveBucket: TokenBucket;
  private readonly openedAt = Date.now(); // join-latency origin (== the conn.open log line)
  private closeCounted = false; // exactly one omwmp_disconnects_total sample per session

  constructor(
    private readonly ws: WebSocket,
    readonly ip: string,
    private readonly ctx: ServerCtx,
    private readonly onClosed: () => void,
  ) {
    this.msgBucket = new TokenBucket(ctx.config.limits.msgsPerSec);
    // Byte budget gets a BURST allowance above the sustained rate. Entering a dense cell is
    // legitimately bursty (the cell's container/object state goes up in one go), and with
    // burst == rate a single such moment disconnected a real player mid-tutorial with
    // "byte rate limit exceeded". Sustained throughput is still capped at bytesPerSec — the
    // burst only absorbs a short spike, which is what a token bucket is for.
    this.byteBucket = new TokenBucket(ctx.config.limits.bytesPerSec, ctx.config.limits.bytesBurst);
    this.moveBucket = new TokenBucket(ctx.config.limits.moveMsgsPerSec);
    this.actorMoveBucket = new TokenBucket(ctx.config.limits.actorMoveMsgsPerSec);
    this.helloTimer = setTimeout(() => {
      if (this.state === 'CONNECTED') this.disconnect('BAD_PROTO', 'SessionHello not received in time');
    }, ctx.config.limits.helloTimeoutMs);
    ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(data, isBinary));
    ws.on('error', (err) => log('warn', 'conn.socket_error', { ip: this.ip, error: String(err) }));
    // M4: feed the server-measured RTT to the authority fitness tracker. The measurement
    // itself lives in net/ws.ts (ping stamp echo); this only attaches it to a playerId.
    ws.on('pong', () => {
      const rtt = socketRttMs(ws);
    });
    ws.on('close', () => this.cleanup());
  }

  // ---------------------------------------------------------------- sending

  private sendText(json: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(json);
  }

  sendEvent(name: string, body: JsLike): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(packEvent(++this.outSeq, name, lserEncode(jsToL(body))));
  }

  // Bytes `ws` is holding for this client because it has not read them yet. Read through a
  // seam: a real socket drains too fast to hold a backlog on demand, so tests substitute a
  // reader (returning undefined falls back to the socket). Never set in production.
  static bufferedAmountReader?: (conn: Connection) => number | undefined;

  get bufferedBytes(): number {
    const stubbed = Connection.bufferedAmountReader?.(this);
    return stubbed ?? this.ws.bufferedAmount;
  }

  // Returns FALSE when the frame was shed (or the socket is gone). Callers that track what
  // a recipient has already seen MUST honour this: recording a shed pose as delivered leaves
  // that recipient stale until the sender happens to move again, which for someone standing
  // still is forever.
  sendBinary(type: number, payload: Buffer): boolean {
    return this.sendBinaryFrame(type, packEnvelope(type, nextBroadcastSeq(), payload));
  }

  // The lossy binary family draws its envelope seq from the server-global broadcast
  // counter, NOT this connection's outSeq: that is what lets one serialized frame serve
  // every recipient of a broadcast. See nextBroadcastSeq for why the client's stale-drop
  // still holds.
  sendBinaryFrame(type: number, frame: Buffer): boolean {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    // Movement and actor batches are the only stale-tolerant traffic on the wire, so they
    // are what gets shed when a client stops draining: a dropped pose is corrected by the
    // next one. Session- and event-tier frames (chat, journal, object ops, admin) are
    // never shed — losing one loses state, not a frame.
    if (type === MSG_PLAYER_MOVE_BATCH || type === MSG_ACTOR_MOVE_BATCH) {
      const { maxBufferedBytes, maxBufferedBytesHard } = this.ctx.config.limits;
      const buffered = this.bufferedBytes;
      if (buffered > maxBufferedBytesHard) {
        log('info', 'conn.backpressure_drop', { ip: this.ip, player: this.player?.name, buffered });
        this.disconnect('RATE', 'outbound buffer overflow (client is not reading)');
        return false;
      }
      if (buffered > maxBufferedBytes) {
        metrics.backpressureDropped.inc({ kind: type === MSG_ACTOR_MOVE_BATCH ? 'actor' : 'move' });
        return false;
      }
    }
    // Binary frames are already compact and mostly incompressible (packed poses/floats), so
    // per-message deflate buys nothing on them — but permessage-deflate allocates a ~256 KB
    // zlib context PER SOCKET, which is ~19 MB at 64 players. Skipping it is a memory fix
    // that happens to shave a little latency too.
    this.ws.send(frame, { compress: false });
    return true;
  }

  // Refuse a connection at setup (bad engine hash / bad content). Identical to disconnect()
  // for a human, but a SYSTEM peer refused here is a misconfiguration that will refuse the
  // same way every time — so the supervisor is told to stop trying rather than respawning a
  // ~360 MB process forever while players sit with frozen NPCs and nothing explains why.
  private refuseSetup(code: 'BAD_ENGINE' | 'BAD_CONTENT', detail: string): void {
    if (this.isSystem) {
      this.ctx.simPeers?.disablePermanently(`${code}: ${detail}`);
    }
    this.disconnect(code, detail);
  }

  disconnect(code: DisconnectCode, detail: string): void {
    if (this.state === 'CLOSED') return;
    log('info', 'conn.disconnect', { ip: this.ip, code, detail, player: this.player?.name });
    this.closeCounted = true;
    metrics.disconnects.inc({ code });
    this.sendText(disconnectMsg(code, detail));
    this.cleanup();
    this.ws.close(1000, code);
  }

  // Idempotent teardown shared by disconnect() and abrupt socket close. Synchronous so a
  // superseding login sees the roster slot freed before it claims the account.
  private cleanup(): void {
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSED';
    // A client that just drops the socket never goes through disconnect(); without this
    // the disconnect total would only ever see server-initiated closes.
    if (!this.closeCounted) {
      this.closeCounted = true;
      metrics.disconnects.inc({ code: 'CLIENT_CLOSE' });
    }
    clearTimeout(this.helloTimer);
    this.ctx.sessions.remove(this.sessionToken); // Phase B: no linking after the socket dies
    if (this.contentHeld) this.ctx.content.release();
    if (this.engineHeld) this.ctx.engine.release();
    if (this.player) {
      // Logout flush: capture the freshest position explicitly (the roster entry is
      // about to go away) and write the doc. Only players with an existing doc are
      // touched — a connect/quit without any state must not fabricate an empty snapshot.
      const { charId, cellKey, pose } = this.player;
      if (this.ctx.players.getCached(charId)) {
        this.ctx.players.update(charId, (doc) => {
          if (cellKey && pose) doc.position = { cellKey, x: pose.x, y: pose.y, z: pose.z };
        });
        this.ctx.track?.(this.ctx.players.flushKey(charId));
      }
      // ...and FORGET it, but ONLY IF NOBODY ELSE IS HOLDING IT. get() answers from the cache
      // and never re-reads disk, so a world that stays up kept this snapshot until it
      // restarted and overwrote whatever the player did elsewhere meanwhile — that is why the
      // release exists.
      //
      // The identity guard is not optional. A superseding login loads the new session's doc
      // into the cache and THEN tears this one down (finishAuth -> disconnect('SUPERSEDED') ->
      // cleanup, all synchronous), so an unguarded release drops the cache out from under a
      // live session. update() fabricates {} on a miss rather than reloading, so that
      // session's next write — a cell change, flushed 'now' — replaced the whole row with a
      // single position field: inventory, stats, journal, appearance, all gone. An ordinary
      // reconnect was enough. Roster.remove guards the same way for the same reason.
      const heldByAnother = this.ctx.roster.activeForAccount(this.player.accountKey);
      // Owner leaving starts the grace-then-close window (server.ts onPlayerLeftWorld) --
      // but NOT when this session was superseded by the same account reconnecting (the
      // owner is already back; guests were told "the host has disconnected" on every
      // reconnect), and not for a session that never reached the world at all.
      // IDENTITY, not existence: roster.remove() runs further down, so `heldByAnother` is
      // still THIS session unless somebody else has taken the account.
      const superseded = heldByAnother !== undefined && heldByAnother !== this.player;
      if (this.player.inWorld && !superseded) {
        this.ctx.onPlayerLeftWorld?.(this.player.accountKey);
      }
      if (heldByAnother === undefined || heldByAnother.charId !== charId) {
        this.ctx.track?.(this.ctx.players.releaseCached(charId));
      }
      // M8: park a resume ticket BEFORE the roster slot goes, so a reconnect within
      // [login] resumeWindowSec can rejoin in place instead of paying argon2 again.
      // Only in-world sessions get one: there is nothing to resume mid-auth.
      if (this.player.inWorld && !this.ctx.bans.isAccountBanned(this.player.accountKey)) {
        this.ctx.resume.park(this.sessionToken, {
          accountKey: this.player.accountKey,
          accountName: this.player.name,
          charId: this.player.charId,
          ...(this.player.cellKey ? { cellKey: this.player.cellKey } : {}),
          ...(this.player.pose ? { pose: this.player.pose } : {}),
        });
      }
      // Phase C: BEFORE roster.remove, so the grace-window timer is armed while the
      // account still resolves; a reconnect inside the window then cancels it and friends
      // never see a flicker.
      this.ctx.social.onLeave(this.player);
      this.ctx.roster.remove(this.player);
      if (this.ctx.roster.humanCount === 0) this.ctx.onWorldEmpty?.(); // neither the peer nor bots count
      // M6: drop every conversation this player held (same teardown as authority).
      this.ctx.quests.releaseDialogueLocks(this.player.id);
      // M7: relinquish weather authority and settle any dialog we owed this player an
      // answer for (a pending GUI promise must never outlive the socket).
      this.ctx.m7.onDisconnect(this.player.id);
      // M4: relinquish authority (no Revoke — socket is gone) before the cell may flush.
      // NOT gated on cellKey: a peer holds cells via ANCHORS, so one that never sent a cell
      // change of its own still has a footprint to release.
      this.ctx.world.authorityReleaseEverything(this.player.id, this.player.cellKey, false);
      if (this.player.cellKey) this.ctx.world.onCellVacated(this.player.cellKey);
      this.ctx.hooks.playerDisconnect({ id: this.player.id, name: this.player.name, rank: this.player.rank });
      this.ctx.accounts.touchLastSeen(this.player.accountKey);
    }
    this.onClosed();
  }

  // --------------------------------------------------------------- receiving

  // Label a frame by TYPE only — binary opcode, or the text message's "t" tag. Never any
  // payload: this goes to logs, and the payload can carry chat and player state.
  private frameLabel(data: Buffer, isBinary: boolean, binType: number): string {
    if (isBinary) return 'bin:' + binType;
    const head = data.toString('utf8', 0, Math.min(data.byteLength, 120));
    return 'text:' + (/"t"\s*:\s*"([A-Za-z0-9_]{1,40})"/.exec(head)?.[1] ?? '?');
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.state === 'CLOSED') return;
    // PlayerMove and ActorMoveBatch frames bypass the general msg bucket, and draw from two
    // SEPARATE movement budgets (bytes still count against bytesPerSec).
    const binType = isBinary && data.byteLength >= 2 ? data.readUInt16LE(0) : -1;
    if (!this.byteBucket.take(data.byteLength)) {
      metrics.rateLimited.inc({ budget: 'bytes' });
      log('warn', 'conn.byte_budget_exceeded', {
        ip: this.ip,
        player: this.player?.name,
        frameBytes: data.byteLength,
        frameType: this.frameLabel(data, isBinary, binType),
        limitPerSec: this.ctx.config.limits.bytesPerSec,
        burst: this.ctx.config.limits.bytesBurst,
      });
      this.disconnect('RATE', 'byte rate limit exceeded');
      return;
    }
    // Movement overruns SHED, they do not disconnect. Kicking the actor-authority holder for
    // doing the cell's shared work took the whole cell's NPCs down with it; and an own-pose
    // burst (a hitching or tab-throttled client catching up) is self-correcting, since every
    // pose is absolute. Abuse is still bounded — by bytesPerSec, which does disconnect, and
    // by msgsPerSec for everything that actually carries state.
    if (binType === MSG_ACTOR_MOVE_BATCH || binType === MSG_PLAYER_MOVE) {
      const actor = binType === MSG_ACTOR_MOVE_BATCH;
      if (!(actor ? this.actorMoveBucket : this.moveBucket).take(1)) {
        metrics.rateLimited.inc({ budget: actor ? 'actor_shed' : 'move_shed' });
        return;
      }
    } else if (!this.msgBucket.take(1)) {
      metrics.rateLimited.inc({ budget: 'msgs' });
      this.disconnect('RATE', 'message rate limit exceeded');
      return;
    }
    try {
      if (isBinary) this.onBinary(data);
      else this.onText(data.toString('utf8'));
    } catch (err) {
      if (err instanceof SessionParseError || err instanceof ProtoError) {
        this.disconnect('BAD_PROTO', err.message);
      } else {
        log('error', 'conn.internal_error', { ip: this.ip, error: String(err), system: this.isSystem });
        metrics.protocolErrors.inc({ kind: 'internal_error' });
        // Never drop the world's SIMULATOR over one bad frame: disconnecting the peer freezes
        // every cell it holds until the supervisor restarts it. Log, count, continue.
        // POST-AUTH check: `isSystem` is only the client's Hello claim, so keying the
        // exemption off it let any connection say `system: true` and become immune. A
        // genuinely stuck peer is no use either, so a run of errors still drops it -- the
        // supervisor restart is the better outcome than a peer throwing on every frame.
        const authedPeer = this.player?.system === true;
        this.internalErrors = (this.internalErrors ?? 0) + 1;
        if (!authedPeer || this.internalErrors > 20) this.disconnect('BAD_PROTO', 'internal error');
      }
    }
  }

  private onText(text: string): void {
    const msg: ClientSessionMsg | null = parseSessionMessage(text);
    if (msg === null) return; // unknown "t": ignored for forward compat within M0
    switch (msg.t) {
      case 'SessionPing': // allowed in any state (RTT/clock display)
        this.sendText(pong(msg.clientTime, Date.now()));
        return;
      case 'SessionHello':
        this.requireState('CONNECTED', msg.t);
        this.handleHello(msg);
        return;
      case 'SessionRegister':
      case 'SessionLoginRequest':
      case 'SessionLoginTicket': {
        this.requireState('HELLO_OK', msg.t);
        if (this.authing) return; // duplicate auth message while hashing; drop
        this.authing = true;
        const op: AuthOp =
          msg.t === 'SessionRegister' ? 'register' : msg.t === 'SessionLoginRequest' ? 'login' : 'ticket';
        const p =
          msg.t === 'SessionRegister'
            ? this.handleRegister(msg)
            : msg.t === 'SessionLoginRequest'
              ? this.handleLogin(msg)
              : this.handleLoginTicket(msg);
        p.catch((err) => {
          log('error', 'conn.auth_error', { ip: this.ip, error: String(err) });
          this.authFail(op, 'AUTH_FAILED', 'internal auth error');
        });
        return;
      }
      case 'SessionResume':
        this.requireState('HELLO_OK', msg.t);
        if (this.authing) return;
        this.authing = true;
        this.handleResume(msg).catch((err) => {
          log('error', 'conn.resume_error', { ip: this.ip, error: String(err) });
          this.authFail('resume', 'AUTH_FAILED', 'internal resume error');
        });
        return;
      case 'SessionReady':
        this.requireState('AUTHED', msg.t);
        // Onboarding gate: when the operator requires a profile, a session may not enter
        // the world until email + username are set. The client saw profile.required in
        // Welcome, so hitting this is a client bug or a bypass attempt — refuse, keep the
        // session alive (it can still send ProfileSetup and then Ready again).
        if (this.ctx.config.login.requireProfile && !this.isSystem && this.account
          && (this.account.email === undefined || this.account.username === undefined)) {
          this.sendText(profileResult(false, 'profile-required'));
          return;
        }
        this.handleReady();
        return;
      case 'CharacterCreate': {
        // Valid both at the select screen (AUTHED) and from the in-game hub (IN_WORLD) —
        // playing the new slot is a reconnect either way.
        if (this.state !== 'AUTHED' && this.state !== 'IN_WORLD') {
          this.requireState('AUTHED', msg.t);
          return;
        }
        this.handleCharacterCreate(msg);
        return;
      }
      case 'ProfileSetup':
        if (this.state !== 'AUTHED' && this.state !== 'IN_WORLD') {
          this.requireState('AUTHED', msg.t);
          return;
        }
        this.handleProfileSetup(msg).catch((err) => {
          log('error', 'conn.profile_error', { ip: this.ip, error: String(err) });
          this.sendText(profileResult(false, 'internal'));
        });
        return;
    }
  }

  // Character slots: add a slot. The character NAME is the in-world persona (Morrowind
  // rules: letters/digits/space and friends, like account names) — distinct from the
  // account's unique username. Selection = reconnect (or first Ready) with the new id.
  private handleCharacterCreate(msg: CharacterCreate): void {
    if (!this.account || this.isSystem) return;
    const slots = (): WelcomeCharacter[] =>
      (this.account?.characters ?? []).map(({ id, name, lastPlayedAt }) => ({ id, name, lastPlayedAt }));
    if (!validAccountName(msg.name)) {
      this.sendText(characterResult(false, slots(), 'badname'));
      return;
    }
    const created = this.ctx.accounts.createCharacter(this.account, msg.name);
    if (created === 'full') {
      this.sendText(characterResult(false, slots(), 'full'));
      return;
    }
    log('info', 'player.character_created', { account: this.account.name, char: created.id, name: msg.name });
    this.sendText(characterResult(true, slots()));
  }

  // Onboarding: validate + store email and the unique public handle; queue the CRM upsert
  // off the hot path. A rename after the fact takes the same op (cooldown applies).
  private async handleProfileSetup(msg: ProfileSetup): Promise<void> {
    if (!this.account || this.isSystem) return;
    if (!validEmail(msg.email)) {
      this.sendText(profileResult(false, 'badformat-email'));
      return;
    }
    const result = await this.ctx.accounts.setUsername(this.account, msg.username);
    if (result !== 'ok') {
      this.sendText(profileResult(false, result === 'badformat' ? 'badformat-username' : result));
      return;
    }
    this.ctx.accounts.setEmail(this.account, msg.email, msg.marketingOptIn === true);
    // The public handle IS the display name from now on; a session already in the roster
    // updates live so nametags/chat pick it up on the next frame they render it.
    if (this.player) this.player.name = this.account.username ?? this.player.name;
    this.ctx.attio.enqueue({
      email: msg.email,
      username: this.account.username ?? msg.username,
      accountKey: this.account.name.toLowerCase(),
      signupAt: this.account.createdAt,
      provider: this.authedVia ?? 'password',
      marketingOptIn: msg.marketingOptIn === true,
    });
    log('info', 'player.profile_set', {
      account: this.account.name, username: this.account.username ?? msg.username,
    });
    this.sendText(profileResult(true));
  }

  // Every auth exit funnels through here (or the success tally in finishAuth), so
  // sum(omwmp_auth_total) by op == attempts that got past the state machine.
  private authFail(op: AuthOp, result: 'AUTH_FAILED' | 'BANNED' | 'RATE', detail: string): void {
    metrics.auth.inc({ op, result });
    // WHICH RUNG OF THE LADDER FAILED. The disconnect log carries only the detail string, and
    // two very different faults share one message: a client that presented a spent ticket and
    // a client that presented no credential at all both end at "this server uses single
    // sign-on". Telling them apart decides whether the ticket handoff or the client's auth
    // ladder is at fault, and without it a real SSO failure could only be guessed at from
    // timing. The metric already knew; the log did not, and the log is what gets read.
    log('warn', 'conn.auth_failed', { ip: this.ip, op, result, detail });
    this.disconnect(result, detail);
  }

  private requireState(want: SessionState, what: string): void {
    if (this.state !== want) throw new SessionParseError(`${what} not valid in state ${this.state}`);
  }

  private onBinary(data: Buffer): void {
    const envelope = unpackEnvelope(data);
    if (envelope.type !== MSG_EVENT && envelope.type !== MSG_PLAYER_MOVE && envelope.type !== MSG_ACTOR_MOVE_BATCH
      && envelope.type !== MSG_PLAYER_INPUT && envelope.type !== MSG_AVATAR_MOVE_BATCH) {
      log('debug', 'conn.reserved_type_dropped', { ip: this.ip, type: envelope.type });
      metrics.protocolErrors.inc({ kind: 'reserved_type' });
      return;
    }
    if (this.state !== 'IN_WORLD' || !this.player) {
      log('warn', 'conn.binary_before_in_world', { ip: this.ip, state: this.state, type: envelope.type });
      metrics.protocolErrors.inc({ kind: 'binary_before_in_world' });
      return;
    }
    if (envelope.type === MSG_PLAYER_MOVE) {
      this.handleMove(envelope.seq, envelope.payload);
      return;
    }
    if (envelope.type === MSG_ACTOR_MOVE_BATCH) {
      this.ctx.world.handleActorMoveBatch(this.player, envelope.payload);
      return;
    }
    if (envelope.type === MSG_PLAYER_INPUT) {
      this.handlePlayerInput(envelope.seq, envelope.payload);
      return;
    }
    if (envelope.type === MSG_AVATAR_MOVE_BATCH) {
      this.handleAvatarMoveBatch(envelope.payload);
      return;
    }
    this.lastClientSeq = envelope.seq;
    const { name, body } = unpackEvent(envelope.payload);
    let value;
    try {
      value = lserDecode(body);
    } catch (err) {
      // Malformed LSER: drop the frame, keep the session (rate limits bound abuse).
      log('warn', 'conn.bad_lser', { ip: this.ip, name, error: err instanceof LserError ? err.code : String(err) });
      metrics.protocolErrors.inc({ kind: 'bad_lser' });
      return;
    }
    if (name === 'PlayerCellChange') {
      this.handleCellChange(value);
      return;
    }
    if (name === 'AdminCommand') {
      // M8: same gate as the slash path; the answer is always an AdminResult, including
      // refusals, so a client never has to guess whether a command silently failed.
      const body = value instanceof Map ? value : undefined;
      const player = this.player;
      // .catch IS LOAD-BEARING. admin.exec wraps command bodies, but ctx.allow and refusal()
      // sit outside that try/catch — and an unhandled rejection here reaches main.ts's
      // unhandledRejection handler, which exits the process and takes every player in this
      // world with it. A failed admin command must cost the command, not the world.
      void this.ctx.admin
        .execEvent(player, body?.get('cmd'), body?.get('args'))
        .then((text) => player.peer.sendEvent('AdminResult', { text }))
        .catch((err: unknown) => {
          log('warn', 'admin.command_failed', { player: player.name, error: String(err) });
          try {
            player.peer.sendEvent('AdminResult', { text: 'That command failed. Nothing was changed.' });
          } catch { /* the socket went away mid-command; nothing to tell */ }
        });
      return;
    }
    if (this.ctx.m7.handleEvent(this.player, name, value)) return; // M7 family
    if (this.ctx.social.handleEvent(this.player, name, value)) return; // Phase C family
    if (this.ctx.quests.handleEvent(this.player, name, value)) return; // M6 family
    if (this.ctx.combat.handleEvent(this.player, name, value)) return; // M5 family
    if (this.ctx.world.handleEvent(this.player, name, value)) return; // M3/M4 family
    if (name === 'AvatarStatsBatch') {
      // Phase 4A: the peer's avatar bar reports (system-only; forgeries dropped inside).
      handleAvatarStatsBatch(this.ctx.stateCtx, this.player, value);
      return;
    }
    if (name === 'AvatarItemStatesBatch') {
      // Phase 4D: the peer's avatar wear/charge/soul reports (system-only).
      handleAvatarItemStatesBatch(this.ctx.stateCtx, this.player, value);
      return;
    }
    if (handleStateEvent(this.ctx.stateCtx, this.player, name, value)) return; // M2 family
    if (name === 'ChargenComplete') {
      // The client's engine reports CharGenState == -1 (race/class/sign done). Until this
      // arrives the slot is provisional and an abandoned creation resets on next entry.
      // Idempotent, and re-reported on every login — which self-migrates pre-flag slots.
      // Creation is over, so this character may be saved from here on. Clearing the flag set
      // at auth is what re-enables persistence — without it the first real session after
      // chargen would also be discarded.
      if (this.player) this.ctx.players.allowSaves(this.player.charId);
      // Creation finished, so the character exists from here on. Until this point no slot was
      // written at all — nothing to reap if the player had quit instead.
      if (this.provisionalCharId !== undefined && this.player) {
        const id = this.provisionalCharId;
        // THE NAME THE PLAYER TYPED, not the slot label. onCharacterNamed already writes the
        // chargen name onto the slot — but it fires on PlayerAppearance, which arrives while
        // the slot is still PROVISIONAL and unwritten, so the rename lands on nothing. By the
        // time the slot exists (here) the appearance has stopped changing, so the diff never
        // re-sends and nothing corrects it: the character stayed "New character" forever.
        const named = this.ctx.players.getCached(this.player.charId)?.appearance?.name;
        const label = (typeof named === 'string' && named.trim() !== '') ? named : this.player.name;
        this.provisionalCharId = undefined;
        this.creationInProgress = false;
        if (this.player) this.player.inChargen = false;
        this.ctx.track?.(this.ctx.accounts.get(this.player.accountKey).then((account) => {
          if (!account) return;
          const r = this.ctx.accounts.adoptCharacter(account, id, label);
          if (r === 'full') log('warn', 'character.adopt_full', { account: account.name, charId: id });
          else if (r !== 'exists') log('info', 'character.created', { account: account.name, charId: id });
        }));
      }
      const done = this.ctx.accounts.get(this.player.accountKey).then((account) => {
        if (account && this.player) this.ctx.accounts.completeCharacter(account, this.player.charId);
      });
      this.ctx.track?.(done);
      void done;
      return;
    }
    if (name === 'SetWorldMode') {
      // The where-am-I switcher's Solo/Party flip for the OWNER of this world. Guests change
      // worlds by dialling elsewhere (JoinFriend), not by flipping this one.
      const mode = value instanceof Map && typeof value.get('mode') === 'string' ? (value.get('mode') as string) : '';
      const r = this.ctx.setWorldMode(this.player.accountKey, this.player.rank, mode);
      this.player.peer.sendEvent('SocialResult', { op: 'SetWorldMode', ok: r === 'ok', detail: r === 'ok' ? mode : r });
      return;
    }
    if (name !== 'ChatSend') {
      log('warn', 'conn.unknown_event_dropped', { ip: this.ip, name });
      metrics.protocolErrors.inc({ kind: 'unknown_event' });
      return;
    }
    handleChatSend(
      this.ctx.commandCtx,
      this.ctx.commands,
      { onChat: (p, t) => this.ctx.hooks.chat({ id: p.id, name: p.name, rank: p.rank }, t) },
      this.player,
      value,
      this.ctx.moderation,
    );
  }

  // Phase 3, 0x0102 PlayerInput: the player's raw intent, forwarded to the world peer.
  //
  // AUTHENTICATED BY CONNECTION IDENTITY — this connection owns exactly one avatar, so an
  // input frame can only ever steer its own. That is a different question from
  // ActorMoveBatch's holder/epoch validation ("may you author this CELL's actors"); do not
  // conflate them. No peer holding the world = the frame is dropped and the client-authored
  // 0x0100 path stays authoritative — that is the DEGRADED MODE, stated as policy: freezing
  // every player to preserve authority during a peer crash would trade a severe outage for
  // a security gain that is worthless while there is no simulator to cheat against.
  private handlePlayerInput(seq: number, payload: Buffer): void {
    const player = this.player!;
    if (this.isSystem) {
      metrics.playerInputDropped.inc({ reason: 'from_peer' });
      return; // the peer produces poses, never inputs
    }
    if (payload.length !== INPUT_PAYLOAD_BYTES) {
      metrics.playerInputDropped.inc({ reason: 'bad_size' });
      return;
    }
    if (player.inputSeq !== undefined && seq <= player.inputSeq) return; // stale/replayed
    player.inputSeq = seq;
    player.lastInputAt = Date.now();
    const peer = this.ctx.worldPeer();
    if (!peer) {
      metrics.playerInputDropped.inc({ reason: 'no_peer' });
      return; // degraded mode; see above
    }
    metrics.playerInputForwarded.inc();
    peer.peer.sendBinaryFrame(MSG_PLAYER_INPUT,
      packEnvelope(MSG_PLAYER_INPUT, nextBroadcastSeq(), packInputForward(player.id, payload)));
  }

  private static readonly INPUT_ACTIVE_MS = PEER_POSE_FRESH_MS; // poses: the SHORT window (players.ts); bars/items keep INPUT_DRIVING_MS

  // Phase 3, 0x0105 AvatarMoveBatch: the authoritative result, from the WORLD PEER ONLY.
  // A client sending this is forging other players' movement — refused and counted, the
  // negative control mirroring omwmp_actor_batch_rejected_total{reason="not_holder"}.
  private handleAvatarMoveBatch(payload: Buffer): void {
    const sender = this.player!;
    if (sender.system !== true) {
      metrics.avatarBatchRejected.inc({ reason: 'not_peer' });
      log('warn', 'conn.avatar_batch_forged', { from: sender.name, account: sender.accountKey });
      return;
    }
    if (sender !== this.ctx.worldPeer()) {
      // A second system peer (an operator's, a leftover) must not author poses beside the
      // world peer -- last-writer-wins per frame is visible jitter. Counted, not fatal.
      metrics.avatarBatchRejected.inc({ reason: 'not_world_peer' });
      return;
    }
    let entries;
    try {
      entries = unpackAvatarMoveBatch(payload);
    } catch {
      metrics.avatarBatchRejected.inc({ reason: 'malformed' });
      return;
    }
    const now = Date.now();
    for (const e of entries) {
      const p = this.ctx.roster.get(e.id);
      if (!p || p.system === true || !p.inWorld) continue;
      // ONLY a player actually driving the input tier is ruled by the peer's pose. A client
      // that sends no PlayerInput (an old client, a protocol bot, a browser mid-outage) has
      // an avatar with no input, which coasts to a stop -- accepting its pose here would
      // freeze that player in place for every observer while their real 0x0100 moves are
      // gated off as "peer-fresh". Measured by s42: soak bots pinned at spawn, divergence
      // 286 units and never reconverging. Stale input => that entry is ignored and the
      // client-authored path stays canonical for that player, per-player degraded mode.
      if (p.lastInputAt === undefined || now - p.lastInputAt > Connection.INPUT_ACTIVE_MS) continue;
      // Teleport grace: the avatar follows a cell change via the relay, so after one the
      // peer's stream keeps reporting the OLD position for a while -- and applying it
      // would snap the player right back (the s51 bounce loop, s22's corpse-pinning). The
      // gate is POSITIONAL, not timed: entries are dropped until the avatar's stream shows
      // up within 512 units of where the client said it landed. A timer raced the peer's
      // real catch-up and lost under load; if the avatar never arrives, the client simply
      // keeps its own authority -- which is the correct degraded state anyway.
      if (p.teleportPose !== undefined) {
        const dx = e.pose.x - p.teleportPose.x, dy = e.pose.y - p.teleportPose.y, dz = e.pose.z - p.teleportPose.z;
        const arrived = dx * dx + dy * dy + dz * dz <= 512 * 512 && e.lastInputSeq > p.teleportPose.seq;
        if (!arrived) {
          if (now - p.teleportPose.at > 30_000) {
            log('warn', 'simpeer.avatar_never_arrived', {
              id: p.id, name: p.name, note: 'avatar did not reach the teleport target; client keeps pose authority' });
            p.teleportPose = { ...p.teleportPose, at: now }; // re-arm the warn, keep gating
          }
          continue;
        }
        p.teleportPose = undefined;
      }
      // The peer's answer IS the canonical pose: it feeds the same broadcaster that fans
      // remote poses out to everyone (0x0101), so other players render the authoritative
      // result with no second channel. The owner additionally gets a PlayerStateBatch with
      // lastInputSeq to reconcile against (MoveBroadcaster tick).
      // The first avatar pose per player, once per session: when a client reports being
      // snapped somewhere wrong, this is the record of what the peer actually streamed.
      if (p.avatarPoseLogged !== true) {
        p.avatarPoseLogged = true;
        log('info', 'simpeer.avatar_first_pose', {
          id: e.id, name: p.name, x: Math.round(e.pose.x), y: Math.round(e.pose.y),
          z: Math.round(e.pose.z), lastInputSeq: e.lastInputSeq });
      }
      p.pose = e.pose;
      p.poseVersion++;
      p.lastPoseAt = now;
      p.peerPoseAt = now;
      p.lastInputSeq = e.lastInputSeq;
      // The plausibility envelope (handleMove) measures client moves against moveAnchor,
      // which only accepted CLIENT moves refreshed -- so the first client move after a peer
      // outage was judged against wherever the client last authored, possibly long ago and
      // far away. The canonical pose is the honest baseline.
      p.moveAnchor = { x: e.pose.x, y: e.pose.y, z: e.pose.z, at: now };
    }
  }

  // 0x0100 PlayerMove: stale-seq drop, bounds sanity, store latest pose.
  private handleMove(seq: number, payload: Buffer): void {
    const player = this.player!;
    if (seq <= player.moveSeq) return; // stale or replayed frame
    // Phase 3: while the PEER's pose stream is fresh, the peer's answer is the canonical
    // pose and the client's claim must not interleave with it — two writers at different
    // rates is visible jitter for every observer. The frame is still consumed (seq
    // bookkeeping), so the moment the peer goes quiet (>300 ms) the very next client frame
    // is authoritative again: the degraded mode needs no switchover signal.
    if (player.peerPoseAt !== undefined && Date.now() - player.peerPoseAt <= PEER_POSE_FRESH_MS) {
      player.moveSeq = seq;
      return;
    }
    const pose = unpackMove(payload);
    if (
      !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.z) ||
      Math.abs(pose.x) > MAX_ABS_COORD || Math.abs(pose.y) > MAX_ABS_COORD || Math.abs(pose.z) > MAX_ABS_COORD
    ) {
      log('warn', 'conn.move_out_of_bounds', { ip: this.ip, player: player.name, x: pose.x, y: pose.y, z: pose.z });
      return;
    }
    // Phase 3.6 plausibility envelope. The client authors its own position (the engine
    // simulates locally), so this cannot PROVE honesty — it bounds how far a modified
    // client can travel per unit time before the server notices and counts it. Deliberately
    // generous: Morrowind has legitimate fast movement (levitate, slowfall, 100 Speed +
    // Boots of Blinding Speed), and a false positive on a real player is worse than a
    // cheat that has to move at merely-absurd speed. Same-cell only — a cell change IS a
    // teleport by design (doors, travel, recall).
    const now = Date.now();
    const anchor = player.moveAnchor;
    // MEASURED OVER A WINDOW, NOT BETWEEN FRAMES.
    //
    // Frame spacing is ARRIVAL spacing, and a stalled connection delivers a burst: per-frame
    // that is an ordinary distance over a near-zero dt, i.e. an enormous apparent speed for a
    // player who did nothing but have bad wifi. While this only counted, that was noise in a
    // log; now that the lobby ACTS on it, it would be a rubber-band on the wrong person.
    //
    // Over a fixed window the same burst is just the distance actually covered in that window.
    // A frame arriving inside the window is still accepted and relayed — it simply does not
    // produce a verdict, because there is not yet enough elapsed time to form one.
    if (anchor !== undefined && !this.isSystem && now - anchor.at >= MOVE_WINDOW_MS) {
      const dt = (now - anchor.at) / 1000;
      const dist = Math.hypot(pose.x - anchor.x, pose.y - anchor.y, pose.z - anchor.z);
      const speed = dist / dt;
      // Units/second. Vanilla sprint is ~600; levitate + fortify speed reaches a few
      // thousand. 12000 is beyond anything the engine produces without console commands.
      // dt < 5: a longer gap is a load screen or an AFK, where displacement says nothing.
      if (speed > 12000 && dt < 5) {
        const run = (player.implausibleRun ?? 0) + 1;
        player.implausibleRun = run;
        metrics.implausibleMoves.inc();
        this.ctx.moderation.noteAnomaly(player.accountKey, 'move');
        log('warn', 'conn.move_implausible', {
          player: player.name, account: player.accountKey,
          speed: Math.round(speed), dt: Math.round(dt * 1000), run,
        });
        // A signal, not an action: every world is somebody's own game (or their friends'),
        // so this only counts. Phase 3 retires the whole envelope — with the peer simulating
        // the avatar, an implausible pose cannot be asserted in the first place.
      } else {
        player.implausibleRun = 0;
      }
      player.moveAnchor = { x: pose.x, y: pose.y, z: pose.z, at: now };
    } else if (anchor === undefined) {
      player.moveAnchor = { x: pose.x, y: pose.y, z: pose.z, at: now };
    }
    player.lastPoseAt = now;
    player.moveSeq = seq;
    player.pose = pose;
    player.poseVersion++;
  }

  // PlayerCellChange {cellKey, x, y, z}: update occupancy, refresh (or synthesize) the
  // stored pose at the new position so players who never send PlayerMove (standing still
  // after a teleport) still appear in batches, then relay to ALL in-world players with
  // the sender's id added (everyone must know who entered/left their bubble).
  private handleCellChange(body: LValue | undefined): void {
    const player = this.player!;
    const cellKey = body instanceof Map ? body.get('cellKey') : undefined;
    const x = body instanceof Map ? body.get('x') : undefined;
    const y = body instanceof Map ? body.get('y') : undefined;
    const z = body instanceof Map ? body.get('z') : undefined;
    if (
      typeof cellKey !== 'string' || cellKey.length === 0 || cellKey.length > 128 ||
      typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' ||
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) ||
      Math.abs(x) > MAX_ABS_COORD || Math.abs(y) > MAX_ABS_COORD || Math.abs(z) > MAX_ABS_COORD
    ) {
      log('warn', 'conn.bad_cell_change', { ip: this.ip, player: player.name });
      return;
    }
    const oldCell = player.cellKey;

    // TELEPORT-HOPPING, bounded without any game data.
    //
    // The speed envelope deliberately forgives a cell change, because a door IS a teleport —
    // which leaves declaring cell changes as the way around it. The server cannot tell a real
    // door from an invented one (it ships no content), but it does not have to: what it can see
    // is that WALKING is always into an ADJACENT exterior cell, and a door always goes through
    // an interior. So an exterior-to-exterior jump across the grid is never walking. It is a
    // teleport spell, a silt strider, or a lie.
    //
    // Legitimate ones are RARE — Recall and Intervention cost magicka and have somewhere to be —
    // so they are rate-limited rather than refused. That leaves a real player untouched and
    // makes the bypass useless for the thing it would actually be used for: hopping the map to
    // scout, to farm, or to stay out of reach.
    if (!this.isSystem && oldCell !== undefined && oldCell !== cellKey
        && parseExterior(oldCell) !== null && parseExterior(cellKey) !== null
        && !cellsVisible(oldCell, cellKey)) {
      const now = Date.now();
      const window = now - 60_000;
      const jumps = (player.farJumps ?? []).filter((t) => t > window);
      jumps.push(now);
      player.farJumps = jumps;
      const cap = this.ctx.config.limits.farTravelPerMin;
      if (cap > 0 && jumps.length > cap) {
        metrics.farTravelRefused.inc();
        this.ctx.moderation.noteAnomaly(player.accountKey, 'far_travel');
        log('warn', 'conn.far_travel_flood', {
          player: player.name, account: player.accountKey,
          from: oldCell, to: cellKey, inLastMinute: jumps.length, cap,
        });
        // Same as the movement envelope: a signal, never an action.
      }
    }

    // ...and this character may be owed a one-shot encounter that fired for somebody else
    // before they ever got here.
    queueMicrotask(() => {
      const owed = this.ctx.questSpawnsOnEntry?.(player, cellKey) ?? [];
      for (const spawn of owed) {
        player.peer.sendEvent('QuestSpawn', { recordId: spawn.recordId, questId: spawn.questId, cellKey });
      }
    });
    player.teleportPose = { x, y, z, at: Date.now(), seq: player.inputSeq ?? 0 }; // peer poses ignored until the avatar arrives (players.ts)
    player.cellKey = cellKey;
    const prev = player.pose;
    player.pose = {
      x, y, z,
      yaw: prev?.yaw ?? 0,
      pitch: prev?.pitch ?? 128, // level
      flags: prev?.flags ?? 0,
      animVel: 0,
      counter: 0,
    };
    player.poseVersion++;
    // A CELL CHANGE IS A LEGITIMATE TELEPORT — a door, a silt strider, Recall, Divine
    // Intervention — so the speed envelope must not measure across one. The old per-frame
    // check got this property for free, because it compared against player.pose and the block
    // above refreshes exactly that. The windowed check keeps its own baseline, so it has to be
    // told: without this, arriving anywhere by door measures as the distance between two cells
    // covered instantly, and in the lobby three of those in a row would freeze a player for
    // travelling normally.
    //
    // AND THIS IS A KNOWN BYPASS, stated rather than glossed: a modified client can move
    // anywhere it likes by declaring a PlayerCellChange instead of a PlayerMove, and this line
    // forgives it. The server ships no game data, so it cannot tell a real door from an
    // invented one — the envelope bounds travel WITHIN a cell and is not a teleport check.
    // Closing it needs the sim peer to validate arrivals against the real cell graph.
    player.moveAnchor = { x, y, z, at: Date.now() };
    player.implausibleRun = 0;
    // Cell change is a specced persistence flush point.
    this.ctx.players.update(player.charId, (doc) => (doc.position = { cellKey, x, y, z }), 'now');
    log('info', 'player.cell_change', { id: player.id, cellKey });
    for (const p of this.ctx.roster.inWorld()) {
      // Never announce the SIM PEER's movements TO A PLAYER: a client that hears them spawns
      // a puppet of the server's simulator (see MoveBroadcaster.tick). The peer still gets its
      // own echo — that is its confirmation the move landed, and it cannot puppet itself.
      if (player.system === true && p.id !== player.id) continue;
      p.peer.sendEvent('PlayerCellChange', { id: player.id, cellKey, x, y, z });
    }
    // A HUMAN LANDING SOMEWHERE NEW IS THE MOMENT THE ANCHOR SET IS WRONG. Waiting for the
    // next 5s tick meant a player could arrive in a cell the peer does not hold and be handed
    // control anyway — the loading screen had already cleared, because readiness only says a
    // peer is IN THE WORLD, not that it holds this particular cell. That gap is the tail of
    // the rubber-banding: up to five seconds of moving around an unsimulated cell before the
    // peer catches up and corrects you.
    if (player.system !== true) this.ctx.onPeerJoined?.();
    // M3: entering a cell always yields its delta doc; the vacated cell may flush.
    this.ctx.world.sendCellState(player, cellKey);
    // M4: hand off / claim authority. Leave the old cell before claiming the new one.
    //
    // A PEER RELEASES ONLY WHAT IS EMPTY. Its footprint is the ANCHOR set (simPeerPass owns
    // the grants and the idle-decay) while its avatar merely stands where `place` puts it, so
    // releasing the whole 3x3 it walked out of made OCCUPIED cells dormant until the next 5 s
    // pass re-granted them -- and now that clients are told when a cell loses its holder they
    // detach their actor puppets in that window, so a swing lands locally and forwards
    // nowhere ("my attacks do nothing", s51). A cell nobody is left standing in still folds
    // its snapshot and goes dormant, which is what makes the fold/carry path work.
    if (oldCell && oldCell !== cellKey) {
      this.ctx.world.authorityLeaveAll(player.id, oldCell, true, player.system === true);
      this.ctx.world.onCellVacated(oldCell);
      // M6: walking out of the cell ends any conversation started there.
      this.ctx.quests.releaseDialogueLocks(player.id, oldCell);
    }
    this.ctx.world.authorityEnter(player, cellKey);
  }

  // ----------------------------------------------------------------- states

  private handleHello(msg: SessionHello): void {
    // Absent = false. Only a client that explicitly claims it can simulate a cell's actors
    // is ever eligible to hold authority for one.
    this.simulatesActors = msg.simulatesActors === true;
    this.isSystem = msg.system === true;
    // proto 2 (the mp912026 overhaul): the input tier (0x0102/0x0103/0x0105) replaced
    // client movement authority, the party/voice event family is gone, and Solo/Party is
    // the whole world model. A proto-1 client would half-work and then desync confusingly;
    // BAD_PROTO with the version number is the honest refusal (the engine-hash pin would
    // also catch it, but with a "wrong engine build" message that misleads).
    if (msg.proto !== 2) {
      this.disconnect('BAD_PROTO', `unsupported protocol version ${msg.proto}`);
      return;
    }
    if (msg.lserVersion !== 0) {
      this.disconnect('BAD_PROTO', `unsupported lserVersion ${msg.lserVersion}`);
      return;
    }
    // A system peer never counts against maxPlayers and is never refused as "full": it is
    // operator infrastructure, and turning it away would be the server refusing to simulate
    // its own world. (humanCount already excludes it; the explicit guard states the intent.)
    if (!this.isSystem && this.ctx.roster.humanCount >= this.ctx.config.server.maxPlayers) {
      this.disconnect('SERVER_FULL', 'server is full');
      return;
    }
    // THE SIM PEER IS NOT A CLIENT TO BE VETTED. It is the operator's own binary, spawned by
    // this server, authenticated by [server] password — and it is a NATIVE build, so its hash
    // could never equal the wasm one a pin names even if it sent one (simpeer.ts does not set
    // OPENMW_MP_ENGINEHASH, so it sends ''). Now that `refuse` no longer waves an absent hash
    // through, running it without this exemption would refuse the peer from its own world: no
    // holder for any cell, every NPC frozen, and the server reporting itself healthy.
    const engineCheck = this.isSystem
      ? { ok: true as const }
      : this.ctx.engine.check(msg.engineHash);
    if (!engineCheck.ok) {
      this.refuseSetup('BAD_ENGINE', engineCheck.detail);
      return;
    }
    this.engineHeld = true;
    // Tier 2: the sim peer runs the SERVER's own game data, and its content list is computed
    // by the same engine code as every player's client — so it IS the world's truth. Pin it
    // BEFORE checking, because checking first meant a client that connected earlier had
    // already installed its own list as canonical (tier-1 adopt-first), the peer was then
    // measured against that stranger's list, failed, and disabled itself permanently. The
    // world then had no authority at all and every later player was judged by whoever
    // happened to arrive first.
    //
    // Safe because it is gated on gameDataOk — the server's data validated on disk — and a
    // world configured [simPeer] mode = "on" refuses to boot at all if that validation fails.
    if (this.isSystem && this.ctx.gameDataOk && !this.ctx.content.isAuthoritative) {
      this.ctx.content.setAuthoritative(msg.manifest);
    }
    const contentCheck = this.ctx.content.check(msg.manifest);
    if (!contentCheck.ok) {
      this.refuseSetup('BAD_CONTENT', contentCheck.detail);
      return;
    }
    this.contentHeld = true;
    // Tier 2: the sim peer runs the SERVER's own game data, and its content list is computed
    // by the same engine code as every player's client — so it is the world's truth. Pin it
    // the first time the peer connects; from then on players are measured against the world
    // rather than against whichever stranger happened to connect first.
    //
    // Pinned AFTER the peer's own check passes, so a peer that is itself misconfigured
    // cannot install a broken canonical list and lock everyone out.
    // NOT marked ready here. Hello happens BEFORE authentication, so a peer that failed to
    // authenticate still cleared the start deadline and logged "simpeer.ready" — which is
    // exactly how a peer that never once authenticated ran for weeks looking healthy while
    // simulating nothing. Readiness is now signalled from handleReady, after it is actually
    // in the world.
    // msg.resumeToken: reserved for M1 session resume ([login].resumeWindowSec); ignored.
    clearTimeout(this.helloTimer);
    this.state = 'HELLO_OK';
    this.sendText(helloOk(this.ctx.config.server.name, this.ctx.config.content.enforce));
  }

  private checkAuthGate(op: AuthOp, serverPassword: string | undefined): boolean {
    if (!this.ctx.loginLimiter.allow(this.ip)) {
      metrics.rateLimited.inc({ budget: 'login' });
      this.authFail(op, 'RATE', 'too many auth attempts');
      return false;
    }
    const want = this.ctx.config.server.password;
    // [server].password is ONLY the sim-peer's shared secret. It is checked exclusively for a
    // SYSTEM peer — never on a real user's auth attempt. Checking it against users would (a) make
    // the sim-peer secret brute-forceable through the public login endpoint, and (b) surface a
    // confusing "wrong server password" to SSO users. A user on an SSO server is refused later by
    // handleLogin/handleRegister with a clean "single sign-on" message, before touching any secret.
    // FAIL CLOSED. `system` is a CLIENT-DECLARED flag in SessionHello, and this is the only
    // thing standing between declaring it and holding cell authority for every NPC in the
    // world. The old `want !== ''` skipped the check entirely when no server password was
    // configured — which is the shipped default — so any registered client could send
    // {system:true} and be believed. An unset password is not permission; it means no peer
    // can authenticate here at all.
    if (this.isSystem && (want === '' || serverPassword !== want)) {
      this.authFail(op, 'AUTH_FAILED',
        want === '' ? 'this server has no [server].password, so no peer can authenticate'
          : 'wrong server password');
      return false;
    }
    return true;
  }

  // Character slots. Resolves which character this session plays: an explicit characterId
  // must belong to the account (refused otherwise — silently playing the wrong character is
  // worse than a failed login); absent means last-played. An account with no slots yet is
  // migrated here: its first character is created named after the account, adopting the
  // legacy account-keyed PlayerDoc if this world has one. System peers never come through
  // this path — a sim peer owns no character at all.
  // Returns null after authFail.
  // IS THIS SLOT STILL BEING CREATED? The single fact the chargen sanctuary turns on, and it
  // used to be computed in resolveCharacter ONLY. The resume path skips that function whenever
  // its ticket already names a character — the common case — so creationInProgress stayed at
  // its default of false and every resumed session claimed to have finished creation. The peer
  // then anchored the cell, puppeted the guard, and the escort never ran. Shared, so a future
  // auth path cannot quietly opt out of it again.
  private applyCreationState(account: Account, char: CharacterSummary, doc: PlayerDoc | undefined): void {
    // A slot that has never been played has nothing to restore and has not finished creation.
      if (!char.completed && doc === undefined) this.creationInProgress = true;
      if (!char.completed && doc !== undefined) {
        // Which unflagged docs really finished creation? Appearance/stats are useless signals —
        // they poll every second and land MID-chargen. Trustworthy ones: any journal entry
        // (chargen's own entry is written at release) or a saved position OUTSIDE the chargen
        // cells. A doc still parked in the prison ship / census office with an empty journal is
        // an abandoned creation.
        const positions = [
          ...(doc.position ? [doc.position] : []),
          ...Object.values(doc.positions ?? {}),
        ];
        const hasJournal = doc.journal !== undefined && Object.keys(doc.journal).length > 0;
        // Past the chargen cells (or holding a journal entry) means creation really finished, so
        // flag the slot complete. Anything else is creation still IN PROGRESS.
        //
        // Player state is NEVER destroyed here. An earlier revision erased docs that looked
        // "abandoned" (chargen cells + empty journal), but a refresh mid-creation is
        // indistinguishable from abandonment, so that rule deleted live progress and dropped the
        // player back at the name prompt. Resuming an in-progress creation in place is always
        // correct: the doc restores position and stats, and Morrowind's own chargen picks up
        // where it left off. The slot simply stays uncompleted until ChargenComplete arrives.
        // POSITION IS NOT EVIDENCE, and assuming it was is what broke the opening. Chargen is
        // not confined to the two named rooms: between them you are escorted across ORDINARY
        // SEYDA NEEN EXTERIOR, so "standing outside a chargen cell" describes the escort exactly
        // as well as it describes a finished character. The moment a player stepped off the
        // prison ship this marked their slot complete, inChargen went false on the next auth,
        // the peer anchored that exterior, and the guard was puppeted with his AI off — he never
        // walks up, never escorts, and the sequence stops there.
        //
        // The journal is real evidence and is enough on its own: chargen's own entry is written
        // AT RELEASE, so a slot holding any entry is past creation, and one mid-escort holds
        // none. Everything else waits for ChargenComplete, which is what actually knows.
        const finished = hasJournal;
        void positions;
        if (finished) this.ctx.accounts.completeCharacter(account, char.id);
        // Remember it: authenticate() suppresses persistence while creation is genuinely in
        // progress, and this is the only place with the evidence to tell.
        else this.creationInProgress = true;
      }
  }

  private async resolveCharacter(
    op: AuthOp,
    account: Account,
    requestedId?: string,
  ): Promise<{ char?: CharacterSummary; doc?: PlayerDoc } | null> {
    if (this.isSystem) return {};
    const accountKey = account.name.toLowerCase();
    // A NAMED CHARACTER OUTRANKS THE AUTO-CREATE. This branch used to run first
    // unconditionally, so an account with zero slots — which is exactly what a brand-new
    // player mid-first-creation looks like, since provisionals only become slots at
    // ChargenComplete — had a server-side character minted for EVERY auth, ignoring the
    // characterId the client sent. The world had been built for the character the player
    // actually chose, so the wrong-world guard refused the phantom, and the player saw
    // "belongs to a different character" on every attempt at creating their first character.
    // The decisive log line: conn.auth_char sent:<their id> resolved:<a stranger>.
    if ((!account.characters || account.characters.length === 0) && requestedId === undefined) {
      // NEVER the account name. An SSO account name is the person's real name, and a character
      // name is public: it labels the tile, rides every PlayerAppearance, and is what other
      // players see in-world. This slot is auto-created before creation has run, so it gets a
      // neutral placeholder and takes its real in-world name from chargen.
      const created = this.ctx.accounts.createCharacter(account, DEFAULT_CHARACTER_NAME);
      if (created === 'full') {
        this.authFail(op, 'AUTH_FAILED', 'no free character slot');
        return null;
      }
      return { char: created };
    }
    let char: CharacterSummary | undefined;
    if (requestedId !== undefined) {
      char = account.characters?.find((c) => c.id === requestedId);
      if (!char) {
        // No slot behind this id means creation is in flight: the launcher hands out a
        // provisional id and the slot is only written when chargen FINISHES, so an abandoned
        // creation leaves nothing to hide or delete. Accept it and carry it as provisional.
        // Safe: the id only ever names a character on THIS authenticated account, and the
        // MAX_CHARACTERS cap is enforced when the slot is actually written (adoptCharacter).
        if (!/^c[0-9a-f]{24}$/.test(requestedId)) {
          this.authFail(op, 'AUTH_FAILED', 'unknown character');
          return null;
        }
        this.provisionalCharId = requestedId;
        this.creationInProgress = true;
        return { char: { id: requestedId, name: DEFAULT_CHARACTER_NAME,
          createdAt: new Date().toISOString(), lastPlayedAt: new Date().toISOString() }, doc: undefined };
      }
    } else {
      // Reaching here without a requestedId means the list was non-empty (the empty case
      // auto-created and returned above), so the sort always yields one.
      char = [...(account.characters ?? [])].sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt))[0];
      if (!char) { this.authFail(op, 'AUTH_FAILED', 'no character'); return null; }
    }
    const doc = await this.ctx.players.get(char.id);
    this.applyCreationState(account, char, doc);
    return { char, doc };
  }

  private async handleRegister(msg: SessionRegister): Promise<void> {
    if (!this.checkAuthGate('register', msg.serverPassword)) return;
    const cfg = this.ctx.config.login;
    if (this.ctx.config.auth.requireSso && !this.systemAuthAllowed()) {
      // SSO-only server: there is nothing to register. Point them at the real door rather
      // than a flat refusal. (A password-authenticated sim peer is exempt — see systemAuthAllowed.)
      this.authFail('register', 'AUTH_FAILED', 'this server uses single sign-on — no account/password');
      return;
    }
    if (!cfg.allowRegistration) {
      this.authFail('register', 'AUTH_FAILED', 'registration is disabled');
      return;
    }
    if (cfg.inviteCode !== '' && msg.inviteCode !== cfg.inviteCode) {
      this.authFail('register', 'AUTH_FAILED', 'invalid invite code');
      return;
    }
    if (this.refuseIfBanned('register', msg.account)) return;
    if (this.refuseHarnessAuth('register', msg.password)) return;
    const result = await this.ctx.accounts.register(msg.account, msg.password);
    if (result === 'badname') {
      this.authFail('register', 'AUTH_FAILED', 'account name must be 2-24 chars of A-Z a-z 0-9 _ - space');
      return;
    }
    if (result === 'exists') {
      this.authFail('register', 'AUTH_FAILED', 'account already exists');
      return;
    }
    // A register can still adopt a doc (account file deleted by an operator but player
    // doc kept); resolveCharacter's migration path handles exactly that.
    const rc = await this.resolveCharacter('register', result, msg.characterId);
    if (!rc) return;
    this.finishAuth('register', result, rc.doc, false, rc.char);
  }

  // The client ships a fixed harness password (?mpauto=1). Refusing it unless the
  // operator opted in keeps a test affordance from being a public account-takeover path:
  // without this, anyone can create an account under any free name and anyone else can
  // then log into it, because the password is in the page source.
  private refuseHarnessAuth(op: AuthOp, password: string): boolean {
    if (this.ctx.config.login.allowHarnessAuth) return false;
    if (password !== HARNESS_PASSWORD) return false;
    log('warn', 'conn.harness_auth_refused', { ip: this.ip, op });
    this.authFail(op, 'AUTH_FAILED', 'harness auth is disabled on this server');
    return true;
  }

  // M8: a banned account is refused with BANNED at register, login and resume. Returns
  // true when the session has been closed.
  private refuseIfBanned(op: AuthOp, accountName: string): boolean {
    const ban = this.ctx.bans.isAccountBanned(accountName);
    if (!ban) return false;
    log('info', 'conn.banned_account', { ip: this.ip, account: accountName });
    this.authFail(op, 'BANNED', `account banned: ${ban.reason}`);
    return true;
  }

  // M8 SessionResume {token}. Runs in HELLO_OK, so engine + content policy have ALREADY
  // been enforced by handleHello — a resume can never be used to slip past them. An
  // unknown or expired token is AUTH_FAILED: the client falls back to a normal login.
  private async handleResume(msg: SessionResume): Promise<void> {
    if (!this.ctx.resume.enabled) {
      this.authFail('resume', 'AUTH_FAILED', 'session resume is disabled');
      return;
    }
    if (!this.ctx.loginLimiter.allow(this.ip)) {
      metrics.rateLimited.inc({ budget: 'login' });
      this.authFail('resume', 'RATE', 'too many auth attempts');
      return;
    }
    const ticket = this.ctx.resume.claim(msg.token); // single use
    if (!ticket) {
      this.authFail('resume', 'AUTH_FAILED', 'resume token expired or unknown');
      return;
    }
    if (this.refuseIfBanned('resume', ticket.accountName)) return;
    const account = await this.ctx.accounts.get(ticket.accountName);
    if (!account || account.banned) {
      this.authFail('resume', 'AUTH_FAILED', 'account no longer available');
      return;
    }
    // Character slots: resume returns to the SAME character the session was playing. A
    // pre-slot ticket (no charId) falls back to default resolution, which also migrates.
    let char: CharacterSummary | undefined;
    let doc: PlayerDoc | undefined;
    if (ticket.charId !== undefined) {
      char = account.characters?.find((c) => c.id === ticket.charId);
      if (char) {
        doc = await this.ctx.players.get(char.id);
        // THIS is the line whose absence stalled every resumed character's opening.
        this.applyCreationState(account, char, doc);
      }
    }
    if (!char && !this.isSystem) {
      // CARRY THE TICKET'S CHARACTER THROUGH. A ticket whose charId has no slot is not
      // exotic — it is every mid-chargen reconnect, because a provisional only becomes a
      // slot when creation finishes. Falling back with no requestedId resolved
      // latest-or-auto-create, i.e. silently resumed a DIFFERENT character; in the public
      // world (no world/character suffix contract) nothing would ever have said so. The
      // provisional path in resolveCharacter already knows how to honour the id.
      const rc = await this.resolveCharacter('resume', account, ticket.charId);
      if (!rc) return;
      char = rc.char;
      doc = rc.doc;
    }
    this.resumed = ticket;
    log('info', 'player.resume', { account: account.name, ip: this.ip, cellKey: ticket.cellKey ?? null });
    // The Welcome's playerRecord is what the CLIENT teleports to, and the doc's position is
    // only written on cell change / level-up / logout / sweep — so on a mid-cell reconnect it
    // is stale, and for a player who had died it is the respawn point. Resuming off it
    // rubber-banded players backwards on every reconnect (measured: 302.9 units, landing
    // exactly on respawnY). The ticket's parked pose is the live one, so prefer it.
    // ...and synthesize a doc when there is none yet (a player who joined and reloaded before
    // anything flushed still has a live pose worth returning to).
    const resumePos = ticket.cellKey && ticket.pose
      ? { cellKey: ticket.cellKey, x: ticket.pose.x, y: ticket.pose.y, z: ticket.pose.z }
      : undefined;
    const resumeDoc = resumePos ? { ...(doc ?? {}), position: resumePos } : doc;
    if (doc && !(ticket.cellKey && ticket.pose)) {
      // Loud, because falling back to the doc is exactly the rubber-band bug: whatever put
      // this session in-world without a parked pose needs finding, not silently tolerating.
      log('warn', 'player.resume_no_pose', {
        account: account.name, cellKey: ticket.cellKey ?? null, hasPose: !!ticket.pose,
      });
      metrics.resumeNoPose.inc();
    }
    this.finishAuth('resume', account, resumeDoc, true, char);
    // Put the session back where it was BEFORE Ready, so the join path re-sends the cell
    // and re-claims authority for the cell the player is standing in.
    if (this.player) {
      if (ticket.cellKey) this.player.cellKey = ticket.cellKey;
      if (ticket.pose) this.player.pose = ticket.pose;
    }
  }

  // A sim peer (isSystem, declared at hello) is infrastructure, not a user: it authenticates
  // with the shared server password — verified in checkAuthGate — never SSO. So it is exempt
  // from the SSO-only gate, but ONLY when a server password is actually configured. Without
  // that, a stranger could set system=true in hello to bypass SSO; requiring the (secret,
  // already-matched) password means only the operator's own peer clears this.
  private systemAuthAllowed(): boolean {
    return this.isSystem && this.ctx.config.server.password !== '';
  }

  private async handleLogin(msg: SessionLoginRequest): Promise<void> {
    if (!this.checkAuthGate('login', msg.serverPassword)) return;
    // Phase B: an operator can turn the password path off entirely (SSO-only server).
    // Registration is gated separately by [login].allowRegistration.
    if ((this.ctx.config.auth.requireSso || !this.ctx.config.auth.allowPasswordLogin) && !this.systemAuthAllowed()) {
      this.authFail('login', 'AUTH_FAILED', 'this server uses single sign-on — no account/password');
      return;
    }
    if (this.refuseIfBanned('login', msg.account)) return;
    if (this.refuseHarnessAuth('login', msg.password)) return;
    const account = await this.ctx.accounts.verifyLogin(msg.account, msg.password);
    if (!account) {
      this.authFail('login', 'AUTH_FAILED', 'unknown account or wrong password');
      return;
    }
    if (account.banned || this.refuseIfBanned('login', account.name)) {
      if (this.state !== 'CLOSED') this.authFail('login', 'BANNED', 'account is banned');
      return;
    }
    const rc = await this.resolveCharacter('login', account, msg.characterId);
    if (!rc) return;
    this.finishAuth('login', account, rc.doc, false, rc.char);
  }

  // Phase B: redeem the one-time ticket the SSO callback handed the browser. The ticket is
  // the ONLY thing that crosses from the HTTP side — no provider access/refresh/ID token
  // ever enters this protocol.
  //
  // Bans are re-checked here, against the RESOLVED account. refuseIfBanned() on the
  // password path runs on the client-supplied name before verification, which is harmless
  // there (an unverified name gets refused either way); here the name is not supplied at
  // all, so the ban check MUST happen after resolution or it would not happen.
  private async handleLoginTicket(msg: SessionLoginTicket): Promise<void> {
    if (!this.checkAuthGate('ticket', msg.serverPassword)) return;
    if (msg.ticket.length === 0 || msg.ticket.length > 256) {
      this.authFail('ticket', 'AUTH_FAILED', 'malformed login ticket');
      return;
    }
    // PEEK, then spend it only once the join is committed. Claiming here burned the ticket on
    // every refusal below — world access, the chargen gate — and the client's reconnect ladder
    // then retried a credential that could never work again. One click on Public produced six
    // identical "already used" refusals and a switch that appeared to do nothing at all.
    const claimed = this.ctx.tickets.peek(msg.ticket); // <=60 s, not spent yet
    if (!claimed) {
      this.authFail('ticket', 'AUTH_FAILED', 'login ticket expired or already used');
      return;
    }
    const account = await this.ctx.accounts.get(claimed.accountKey);
    if (!account) {
      // The account existed when the ticket was minted; it disappearing inside 60 s means
      // an operator erased it mid-flow. Loud, because it should be impossible.
      log('warn', 'conn.ticket_account_gone', { ip: this.ip, account: claimed.accountKey });
      this.authFail('ticket', 'AUTH_FAILED', 'account no longer available');
      return;
    }
    if (account.banned || this.refuseIfBanned('ticket', account.name)) {
      if (this.state !== 'CLOSED') this.authFail('ticket', 'BANNED', 'account is banned');
      return;
    }
    const rc = await this.resolveCharacter('ticket', account, msg.characterId);
    if (!rc) return;
    // The one fact three rounds of guessing needed: did the client's auth NAME a character?
    // Absent means the world falls back to latest-or-create, which is where every phantom
    // character and wrong-world refusal tonight came from.
    log('info', 'conn.auth_char', {
      account: account.name, sent: msg.characterId ?? null, resolved: rc.char?.id ?? null,
    });
    log('info', 'player.sso_login', { account: account.name, ip: this.ip });
    this.finishAuth('ticket', account, rc.doc, false, rc.char);
    // Committed (or refused). Spend it ONLY on success, so a refusal leaves the player with a
    // credential they can still use — on the world they came from, or on a retry here.
    if (this.state === 'AUTHED') this.ctx.tickets.claim(msg.ticket);
    else {
      // Refused after the peek reserved it: hand it back, or the reservation itself becomes
      // the spent-credential bug it was added to prevent.
      this.ctx.tickets.restore(msg.ticket);
      log('info', 'conn.ticket_kept', { reason: 'join refused', account: account.name });
    }
  }

  // forceRecord: send the doc even without an appearance. The appearance gate below exists
  // so a FRESH player still gets chargen — but a resumed player was in-world seconds ago and
  // must never be treated as fresh: withholding the record also withholds its position, so
  // the client stays wherever its boot URL dropped it instead of returning to where it was.
  private finishAuth(op: AuthOp, account: Account, doc?: PlayerDoc, forceRecord = false, char?: CharacterSummary): void {
    if (this.state !== 'HELLO_OK') return; // raced a disconnect while hashing
    const accountKey = account.name.toLowerCase();
    // World access control: knowing the port + valid credentials is NOT an invitation.
    // A private world admits its owner (and admins); a party world admits the party.
    // System peers are operator infrastructure and exempt.
    if (!this.isSystem && !this.ctx.mayJoinWorld(accountKey, account.rank)) {
      log('info', 'conn.world_refused', { ip: this.ip, account: account.name });
      this.authFail(op, 'AUTH_FAILED', 'this world is private');
      return;
    }
    // THE WRONG CHARACTER IN THE RIGHT ACCOUNT IS STILL THE WRONG WORLD. mayJoinWorld is
    // owner-scoped, so the owner was admitted to ANY of their private worlds with ANY of
    // their characters — including a still-running world of a character they had deleted.
    // Stale caches routed a player exactly there, and everything downstream (the frozen
    // chargen guard, the unsaved character, the dead Public button) was this one mistake
    // wearing masks. Causes come and go; the guard is at the door. Refusing loudly beats
    // playing quietly in a world that belongs to someone who no longer exists.
    if (!this.isSystem && char && this.ctx.wrongWorldForCharacter?.(accountKey, char.id)) {
      log('warn', 'conn.wrong_world_for_character', {
        account: account.name, charId: char.id, world: this.ctx.worldId,
      });
      this.authFail(op, 'AUTH_FAILED', 'this world belongs to a different character');
      return;
    }
    // Chargen gate (F3): a gateway party/public world refuses a character that has not finished
    // creation (no appearance yet). Creation happens in the player's PRIVATE world; only a
    // fully-created character may go out into shared worlds. System peers are exempt.
    if (!this.isSystem && this.ctx.chargenGate
        && !(doc && (doc as { appearance?: unknown }).appearance)) {
      log('info', 'conn.chargen_required', { ip: this.ip, account: account.name });
      this.authFail(op, 'AUTH_FAILED', 'finish creating your character in your private world first');
      return;
    }
    metrics.auth.inc({ op, result: 'success' });
    // One session per character: the newcomer wins and the sitting session is dropped with
    // SUPERSEDED, which the client turns into "this character was opened elsewhere".
    const existing = this.ctx.roster.activeForAccount(accountKey);
    if (existing) {
      metrics.authSuperseded.inc();
      existing.peer.disconnect('SUPERSEDED', 'this character was opened in another session');
    }
    this.account = account;
    this.authedVia = op;
    // Onboarding: the unique public handle is the display name everywhere once set; the
    // account name remains the private login identifier.
    // player.name is PEER-VISIBLE (PlayerJoinWorld, nametags, chat) AND is how admin
    // commands, bans and resume address a player. The `?? account.name` fallback therefore
    // leaks the login identifier (an SSO account's name claim is the person's real name) to
    // peers whenever no username is set — but removing it here breaks every name-based
    // lookup at once. The fix is to guarantee a username: set [login] requireProfile = true,
    // which refuses SessionReady until one exists, and this fallback becomes unreachable.
    // ponytail: config guarantee, not a second name-resolution path.
    this.player = this.ctx.roster.addAuthed(account.username ?? account.name, accountKey, account.rank, this, this.ip);
    // Character slots: every persistence path keys on charId from here on. System peers
    // keep the accountKey default (no character; marked ephemeral below).
    if (char) {
      this.player.charId = char.id;
      this.ctx.accounts.touchCharacter(account, char.id);
    }
    this.player.simulatesActors = this.simulatesActors;
    this.player.system = this.isSystem;
    // A sim peer owns no character: keep it out of players/ entirely rather than writing a
    // doc that would be restored onto the next freshly spawned peer.
    if (this.isSystem) this.ctx.players.markEphemeral(this.player.charId);
    // A character still IN character creation is not saved. Morrowind's opening is a scripted
    // sequence — the census office, the paperwork, the race/class/birthsign prompts — and a doc
    // captured partway through restores a half-built character into a script that has already
    // moved past the step that built it. What comes back is not the state that was saved.
    //
    // Gate on creationInProgress, NOT on `completed`: slots predating that flag are finished
    // but unflagged, and suppressing THEM would discard real characters. resolveCharacter
    // works out which is which from evidence (a journal entry, or a position outside the
    // chargen cells) and self-migrates the flag; this reuses that answer rather than
    // second-guessing it. Cleared when ChargenComplete arrives (below).
    else if (this.creationInProgress) this.ctx.players.suppressSaves(this.player.charId);
    // Visible to authority: a cell with a player still creating their character must NOT be
    // simulated by the peer, and the cells cannot be named — the walk from the prison ship to
    // the census office is ordinary Seyda Neen exterior, where the guard who escorts you
    // stands. Only "who is standing here" identifies it.
    this.player.inChargen = this.creationInProgress;
    // The single fact the chargen sanctuary turns on, and until now it was invisible: three
    // separate diagnoses of "the guard does not escort me" each had to INFER this from anchor
    // counts, and inference is what got them wrong. State it.
    log('info', 'conn.chargen_state', {
      world: this.ctx.worldId, player: this.player.name, charId: this.player.charId,
      inChargen: this.creationInProgress,
    });
    this.state = 'AUTHED';
    this.authing = false;
    const sessionToken = randomBytes(16).toString('hex');
    this.sessionToken = sessionToken;
    // Phase B: /auth/link/:provider authenticates with this token, so it must be
    // resolvable for exactly as long as the socket lives (cleanup() drops it).
    this.ctx.sessions.add(sessionToken, accountKey, account.name);
    // playerRecord: only a doc with an appearance skips chargen — a position-only doc
    // (player quit mid-chargen after a cell change) must not.
    const record = doc && (doc.appearance || forceRecord) ? doc : null;
    // serverSeq = binary seq already consumed for this connection (0: none yet).
    this.sendText(
      welcome(this.player.id, sessionToken, this.ctx.motd(), this.outSeq, record, {
        pvp: this.ctx.config.rules.pvp,
        difficulty: this.ctx.config.rules.difficulty,
        renderLod: this.ctx.config.limits.renderLod,
        lodNearRadius: this.ctx.config.limits.lodNearRadius,
        lodMidRadius: this.ctx.config.limits.lodMidRadius,
        lodNearMaxAvatars: this.ctx.config.limits.lodNearMaxAvatars,
      },
      (account.characters ?? []).map(({ id, name, lastPlayedAt }) => ({ id, name, lastPlayedAt })),
      char?.id ?? '',
      {
        required: this.ctx.config.login.requireProfile && !this.isSystem
          && (account.email === undefined || account.username === undefined),
        ...(account.username !== undefined ? { username: account.username } : {}),
        // The owner's own email, in the one message that only the owner receives.
        ...(account.email !== undefined ? { email: account.email } : {}),
      }),
    );
    this.ctx.hooks.playerAuthed({ id: this.player.id, name: this.player.name, rank: this.player.rank });
    log('info', 'player.authed', { id: this.player.id, name: this.player.name, ip: this.ip });
  }

  private handleReady(): void {
    if (!this.player) return;
    this.state = 'IN_WORLD';
    metrics.joinLatency.observe({}, (Date.now() - this.openedAt) / 1000);
    this.ctx.roster.joinWorld(this.player);
    // Spawn-near-owner: a fresh (non-resume) guest lands next to the world's owner.
    // Reuses the invite-teleport client path (global.lua MP_InviteAccepted -> teleport).
    if (!this.resumed) {
      const near = this.ctx.guestSpawn(this.player.accountKey);
      if (near) this.player.peer.sendEvent('InviteAccepted', near);
    }
    // CHAT SCROLLBACK. The feed lives in the page and a world change now RELOADS the page, so
    // every switch wiped the conversation and a player arriving anywhere saw an empty box with
    // no idea what was being discussed. Replayed as ordinary ChatMessage events, oldest first,
    // so the client renders them through the path it already has — history is not a different
    // kind of message, it is the same messages, earlier.
    this.ctx.replayChat?.(this.player);
    syncStateOnJoin(this.ctx.stateCtx, this.player); // M2 late-joiner appearance/equipment sync
    this.ctx.quests.sendJournalSync(this.player); // M6 full journal state at join
    this.ctx.quests.sendGlobalSync(this.player); // Phase 4 character-shadowed quest globals
    this.ctx.m7.onJoinWorld(this.player); // M7 clock + weather + RecordsSync at join
    this.ctx.social.onJoin(this.player); // Phase C FriendList + presence to friends
    // M8 resume completeness: a rejoin-in-place gets everything a fresh join gets
    // (PlayerList, M2 appearance/equipment/stats, JournalSync, WorldTime, weather,
    // RecordsSync) PLUS the cell it left off in — peers are told where the player is,
    // the cell delta doc is replayed, and cell authority is re-claimed. Without this last
    // step a resumed client would stand in an un-synced cell holding nothing.
    if (this.resumed && this.player.cellKey) {
      const { cellKey, pose } = this.player;
      for (const p of this.ctx.roster.inWorld()) {
        if (this.player.system === true && p.id !== this.player.id) continue;
        p.peer.sendEvent('PlayerCellChange', { id: this.player.id, cellKey, x: pose?.x ?? 0, y: pose?.y ?? 0, z: pose?.z ?? 0 });
      }
      this.ctx.world.sendCellState(this.player, cellKey);
      this.ctx.world.authorityEnter(this.player, cellKey);
    }
    // WHERE EVERYONE ELSE IS. Position is only ever RELAYED, so a joiner learned about the
    // players already in the world when one of them next moved — a player standing still was
    // invisible indefinitely, and a joiner who never moved was invisible to them. Send the
    // occupancy we already track, in the same PlayerCellChange shape the client handles, so
    // both directions are populated at join instead of on the next twitch.
    for (const p of this.ctx.roster.inWorld()) {
      // Same rule as the live fan-out: never hand a joiner the SIM PEER's position, or their
      // very first act in the world is to spawn a puppet of the server's simulator.
      if (p.id === this.player.id || !p.cellKey || p.system === true) continue;
      this.player.peer.sendEvent('PlayerCellChange',
        { id: p.id, cellKey: p.cellKey, x: p.pose?.x ?? 0, y: p.pose?.y ?? 0, z: p.pose?.z ?? 0 });
    }
    // The peer is in the world: authenticated, content-checked, joined. THIS is ready.
    if (this.isSystem) {
      this.ctx.simPeers?.noteHello?.('world');
      // Put it to work NOW rather than on the next 5s tick: until it has been given anchors
      // it holds nothing, and every player already here is watching a loading screen until
      // it does. That pass is also what announces readiness — server.ts owns the signal,
      // because only it knows which cells the peer actually claimed.
      this.ctx.onPeerJoined?.();
      // Tell everyone already waiting. A player who joined while the peer was still booting
      // is behind a loading screen for exactly this moment; without the push they would sit
      // out the client's ceiling instead, which is the fixed-delay guess all over again.
      for (const p of this.ctx.roster.inWorld()) {
        if (p.system === true) continue; // it is the subject of the announcement
        p.peer.sendEvent('SimReady', { ready: true });
      }
    } else {
      // A human joining an already-simulated world gets the answer immediately, so the
      // common case never holds at all. Absent (no peer configured — a test server, or
      // single-player) means nothing will ever simulate for them: say ready and let them
      // play, rather than holding a screen forever for something that is not coming.
      this.player.peer.sendEvent('SimReady', { ready: this.ctx.simReady?.() ?? true });
    }
    this.player.peer.sendEvent('WorldMode', { mode: this.ctx.worldMode() });
    this.ctx.hooks.playerJoinWorld({ id: this.player.id, name: this.player.name, rank: this.player.rank });
  }
}
