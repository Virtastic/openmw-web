// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Per-socket session state machine per PROTOCOL.md:
// CONNECTED -> (Hello <= timeout) -> HELLO_OK -> (auth) -> AUTHED -> (Ready) -> IN_WORLD.
// Text frames = JSON session tier; binary frames = enveloped event tier.

import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Config } from '../config';
import type { AccountStore, Account } from '../core/accounts';
import type { ContentGate, EngineGate } from '../core/manifest';
import type { Player, Peer, Roster } from '../core/players';
import type { CommandRegistry, CommandContext } from '../core/commands';
import type { HookBus } from '../plugins/loader';
import { handleChatSend } from '../core/chat';
import { TokenBucket, IpRateLimiter } from './ratelimit';
import { MSG_EVENT, MSG_PLAYER_MOVE, ProtoError, unpackEnvelope, unpackEvent, packEvent, packEnvelope } from '../proto/envelope';
import { unpackMove } from '../proto/movement';
import { MAX_ABS_COORD } from '../core/movement';
import { handleStateEvent, syncStateOnJoin, type StateCtx } from '../core/playerstate';
import type { WorldState } from '../core/worldstate';
import type { PlayerStore, PlayerDoc } from '../persist/playerstore';
import { lserDecode, lserEncode, jsToL, LserError, type JsLike, type LValue } from '../proto/lser';
import {
  parseSessionMessage,
  helloOk,
  welcome,
  pong,
  disconnectMsg,
  SessionParseError,
  type ClientSessionMsg,
  type SessionHello,
  type SessionRegister,
  type SessionLoginRequest,
  type DisconnectCode,
} from '../proto/session';
import { log } from '../log';

export type SessionState = 'CONNECTED' | 'HELLO_OK' | 'AUTHED' | 'IN_WORLD' | 'CLOSED';

// Everything a connection needs from the composed server; kept as an interface so
// connection.ts has no import cycle with server.ts.
export interface ServerCtx {
  config: Config;
  accounts: AccountStore;
  roster: Roster;
  content: ContentGate;
  engine: EngineGate;
  loginLimiter: IpRateLimiter;
  commands: CommandRegistry;
  commandCtx: CommandContext;
  hooks: HookBus;
  players: PlayerStore;
  stateCtx: StateCtx;
  world: WorldState;
}

export class Connection implements Peer {
  state: SessionState = 'CONNECTED';
  player?: Player;
  private account?: Account;
  private outSeq = 0;
  private lastClientSeq = 0; // informational for the event tier
  private helloTimer?: NodeJS.Timeout;
  private contentHeld = false;
  private engineHeld = false;
  private authing = false;
  private readonly msgBucket: TokenBucket;
  private readonly byteBucket: TokenBucket;
  private readonly moveBucket: TokenBucket; // movement has its own budget (PROTOCOL.md M1)

  constructor(
    private readonly ws: WebSocket,
    readonly ip: string,
    private readonly ctx: ServerCtx,
    private readonly onClosed: () => void,
  ) {
    this.msgBucket = new TokenBucket(ctx.config.limits.msgsPerSec);
    this.byteBucket = new TokenBucket(ctx.config.limits.bytesPerSec);
    this.moveBucket = new TokenBucket(ctx.config.limits.moveMsgsPerSec);
    this.helloTimer = setTimeout(() => {
      if (this.state === 'CONNECTED') this.disconnect('BAD_PROTO', 'SessionHello not received in time');
    }, ctx.config.limits.helloTimeoutMs);
    ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(data, isBinary));
    ws.on('error', (err) => log('warn', 'conn.socket_error', { ip: this.ip, error: String(err) }));
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

  sendBinary(type: number, payload: Buffer): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(packEnvelope(type, ++this.outSeq, payload));
  }

  disconnect(code: DisconnectCode, detail: string): void {
    if (this.state === 'CLOSED') return;
    log('info', 'conn.disconnect', { ip: this.ip, code, detail, player: this.player?.name });
    this.sendText(disconnectMsg(code, detail));
    this.cleanup();
    this.ws.close(1000, code);
  }

  // Idempotent teardown shared by disconnect() and abrupt socket close. Synchronous so a
  // superseding login sees the roster slot freed before it claims the account.
  private cleanup(): void {
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSED';
    clearTimeout(this.helloTimer);
    if (this.contentHeld) this.ctx.content.release();
    if (this.engineHeld) this.ctx.engine.release();
    if (this.player) {
      // Logout flush: capture the freshest position explicitly (the roster entry is
      // about to go away) and write the doc. Only players with an existing doc are
      // touched — a connect/quit without any state must not fabricate an empty snapshot.
      const { accountKey, cellKey, pose } = this.player;
      if (this.ctx.players.getCached(accountKey)) {
        this.ctx.players.update(accountKey, (doc) => {
          if (cellKey && pose) doc.position = { cellKey, x: pose.x, y: pose.y, z: pose.z };
        });
        void this.ctx.players.flushKey(accountKey);
      }
      this.ctx.roster.remove(this.player);
      if (this.player.cellKey) this.ctx.world.onCellVacated(this.player.cellKey);
      this.ctx.hooks.playerDisconnect({ id: this.player.id, name: this.player.name, rank: this.player.rank });
      this.ctx.accounts.touchLastSeen(this.player.accountKey);
    }
    this.onClosed();
  }

  // --------------------------------------------------------------- receiving

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.state === 'CLOSED') return;
    // PlayerMove frames bypass the general msg bucket and draw from their own budget
    // (bytes still count: 26 B/frame is noise next to bytesPerSec).
    const isMove = isBinary && data.byteLength >= 2 && data.readUInt16LE(0) === MSG_PLAYER_MOVE;
    if (!this.byteBucket.take(data.byteLength) || !(isMove ? this.moveBucket : this.msgBucket).take(1)) {
      this.disconnect('RATE', isMove ? 'movement rate limit exceeded' : 'message rate limit exceeded');
      return;
    }
    try {
      if (isBinary) this.onBinary(data);
      else this.onText(data.toString('utf8'));
    } catch (err) {
      if (err instanceof SessionParseError || err instanceof ProtoError) {
        this.disconnect('BAD_PROTO', err.message);
      } else {
        log('error', 'conn.internal_error', { ip: this.ip, error: String(err) });
        this.disconnect('BAD_PROTO', 'internal error');
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
      case 'SessionLoginRequest': {
        this.requireState('HELLO_OK', msg.t);
        if (this.authing) return; // duplicate auth message while hashing; drop
        this.authing = true;
        const p = msg.t === 'SessionRegister' ? this.handleRegister(msg) : this.handleLogin(msg);
        p.catch((err) => {
          log('error', 'conn.auth_error', { ip: this.ip, error: String(err) });
          this.disconnect('AUTH_FAILED', 'internal auth error');
        });
        return;
      }
      case 'SessionReady':
        this.requireState('AUTHED', msg.t);
        this.handleReady();
        return;
    }
  }

  private requireState(want: SessionState, what: string): void {
    if (this.state !== want) throw new SessionParseError(`${what} not valid in state ${this.state}`);
  }

  private onBinary(data: Buffer): void {
    const envelope = unpackEnvelope(data);
    if (envelope.type !== MSG_EVENT && envelope.type !== MSG_PLAYER_MOVE) {
      log('debug', 'conn.reserved_type_dropped', { ip: this.ip, type: envelope.type });
      return;
    }
    if (this.state !== 'IN_WORLD' || !this.player) {
      log('warn', 'conn.binary_before_in_world', { ip: this.ip, state: this.state, type: envelope.type });
      return;
    }
    if (envelope.type === MSG_PLAYER_MOVE) {
      this.handleMove(envelope.seq, envelope.payload);
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
      return;
    }
    if (name === 'PlayerCellChange') {
      this.handleCellChange(value);
      return;
    }
    if (this.ctx.world.handleEvent(this.player, name, value)) return; // M3 family
    if (handleStateEvent(this.ctx.stateCtx, this.player, name, value)) return; // M2 family
    if (name !== 'ChatSend') {
      log('warn', 'conn.unknown_event_dropped', { ip: this.ip, name });
      return;
    }
    handleChatSend(
      this.ctx.commandCtx,
      this.ctx.commands,
      { onChat: (p, t) => this.ctx.hooks.chat({ id: p.id, name: p.name, rank: p.rank }, t) },
      this.player,
      value,
    );
  }

  // 0x0100 PlayerMove: stale-seq drop, bounds sanity, store latest pose.
  private handleMove(seq: number, payload: Buffer): void {
    const player = this.player!;
    if (seq <= player.moveSeq) return; // stale or replayed frame
    const pose = unpackMove(payload);
    if (
      !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.z) ||
      Math.abs(pose.x) > MAX_ABS_COORD || Math.abs(pose.y) > MAX_ABS_COORD || Math.abs(pose.z) > MAX_ABS_COORD
    ) {
      log('warn', 'conn.move_out_of_bounds', { ip: this.ip, player: player.name, x: pose.x, y: pose.y, z: pose.z });
      return;
    }
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
    // Cell change is a specced persistence flush point.
    this.ctx.players.update(player.accountKey, (doc) => (doc.position = { cellKey, x, y, z }), 'now');
    log('info', 'player.cell_change', { id: player.id, cellKey });
    for (const p of this.ctx.roster.inWorld())
      p.peer.sendEvent('PlayerCellChange', { id: player.id, cellKey, x, y, z });
    // M3: entering a cell always yields its delta doc; the vacated cell may flush.
    this.ctx.world.sendCellState(player, cellKey);
    if (oldCell && oldCell !== cellKey) this.ctx.world.onCellVacated(oldCell);
  }

  // ----------------------------------------------------------------- states

  private handleHello(msg: SessionHello): void {
    if (msg.proto !== 1) {
      this.disconnect('BAD_PROTO', `unsupported protocol version ${msg.proto}`);
      return;
    }
    if (msg.lserVersion !== 0) {
      this.disconnect('BAD_PROTO', `unsupported lserVersion ${msg.lserVersion}`);
      return;
    }
    if (this.ctx.roster.count >= this.ctx.config.server.maxPlayers) {
      this.disconnect('SERVER_FULL', 'server is full');
      return;
    }
    const engineCheck = this.ctx.engine.check(msg.engineHash);
    if (!engineCheck.ok) {
      this.disconnect('BAD_ENGINE', engineCheck.detail);
      return;
    }
    this.engineHeld = true;
    const contentCheck = this.ctx.content.check(msg.manifest);
    if (!contentCheck.ok) {
      this.disconnect('BAD_CONTENT', contentCheck.detail);
      return;
    }
    this.contentHeld = true;
    // msg.resumeToken: reserved for M1 session resume ([login].resumeWindowSec); ignored.
    clearTimeout(this.helloTimer);
    this.state = 'HELLO_OK';
    this.sendText(helloOk(this.ctx.config.server.name, this.ctx.config.content.enforce));
  }

  private checkAuthGate(serverPassword: string | undefined): boolean {
    if (!this.ctx.loginLimiter.allow(this.ip)) {
      this.disconnect('RATE', 'too many auth attempts');
      return false;
    }
    const want = this.ctx.config.server.password;
    if (want !== '' && serverPassword !== want) {
      this.disconnect('AUTH_FAILED', 'wrong server password');
      return false;
    }
    return true;
  }

  private async handleRegister(msg: SessionRegister): Promise<void> {
    if (!this.checkAuthGate(msg.serverPassword)) return;
    const cfg = this.ctx.config.login;
    if (!cfg.allowRegistration) {
      this.disconnect('AUTH_FAILED', 'registration is disabled');
      return;
    }
    if (cfg.inviteCode !== '' && msg.inviteCode !== cfg.inviteCode) {
      this.disconnect('AUTH_FAILED', 'invalid invite code');
      return;
    }
    const result = await this.ctx.accounts.register(msg.account, msg.password);
    if (result === 'badname') {
      this.disconnect('AUTH_FAILED', 'account name must be 2-24 chars of A-Z a-z 0-9 _ - space');
      return;
    }
    if (result === 'exists') {
      this.disconnect('AUTH_FAILED', 'account already exists');
      return;
    }
    // A register can still have a doc (account file deleted by an operator but player
    // doc kept, or supersede races); load for consistency with login.
    const doc = await this.ctx.players.get(result.name.toLowerCase());
    this.finishAuth(result, doc);
  }

  private async handleLogin(msg: SessionLoginRequest): Promise<void> {
    if (!this.checkAuthGate(msg.serverPassword)) return;
    const account = await this.ctx.accounts.verifyLogin(msg.account, msg.password);
    if (!account) {
      this.disconnect('AUTH_FAILED', 'unknown account or wrong password');
      return;
    }
    if (account.banned) {
      this.disconnect('BANNED', 'account is banned');
      return;
    }
    const doc = await this.ctx.players.get(account.name.toLowerCase());
    this.finishAuth(account, doc);
  }

  private finishAuth(account: Account, doc?: PlayerDoc): void {
    if (this.state !== 'HELLO_OK') return; // raced a disconnect while hashing
    const accountKey = account.name.toLowerCase();
    const existing = this.ctx.roster.activeForAccount(accountKey);
    if (existing) existing.peer.disconnect('SUPERSEDED', 'account logged in from another connection');
    this.account = account;
    this.player = this.ctx.roster.addAuthed(account.name, accountKey, account.rank, this);
    this.state = 'AUTHED';
    this.authing = false;
    const sessionToken = randomBytes(16).toString('hex');
    // playerRecord: only a doc with an appearance skips chargen — a position-only doc
    // (player quit mid-chargen after a cell change) must not.
    const record = doc?.appearance ? doc : null;
    // serverSeq = binary seq already consumed for this connection (0: none yet).
    this.sendText(welcome(this.player.id, sessionToken, this.ctx.config.server.motd, this.outSeq, record));
    this.ctx.hooks.playerAuthed({ id: this.player.id, name: this.player.name, rank: this.player.rank });
    log('info', 'player.authed', { id: this.player.id, name: this.player.name, ip: this.ip });
  }

  private handleReady(): void {
    if (!this.player) return;
    this.state = 'IN_WORLD';
    this.ctx.roster.joinWorld(this.player);
    syncStateOnJoin(this.ctx.stateCtx, this.player); // M2 late-joiner appearance/equipment sync
    this.ctx.hooks.playerJoinWorld({ id: this.player.id, name: this.player.name, rank: this.player.rank });
  }
}
