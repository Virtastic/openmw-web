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
import { MSG_EVENT, ProtoError, unpackEnvelope, unpackEvent, packEvent } from '../proto/envelope';
import { lserDecode, lserEncode, jsToL, LserError, type JsLike } from '../proto/lser';
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

  constructor(
    private readonly ws: WebSocket,
    readonly ip: string,
    private readonly ctx: ServerCtx,
    private readonly onClosed: () => void,
  ) {
    this.msgBucket = new TokenBucket(ctx.config.limits.msgsPerSec);
    this.byteBucket = new TokenBucket(ctx.config.limits.bytesPerSec);
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
      this.ctx.roster.remove(this.player);
      this.ctx.hooks.playerDisconnect({ id: this.player.id, name: this.player.name, rank: this.player.rank });
      this.ctx.accounts.touchLastSeen(this.player.accountKey);
    }
    this.onClosed();
  }

  // --------------------------------------------------------------- receiving

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.state === 'CLOSED') return;
    if (!this.byteBucket.take(data.byteLength) || !this.msgBucket.take(1)) {
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
    this.lastClientSeq = envelope.seq;
    if (envelope.type !== MSG_EVENT) {
      log('debug', 'conn.reserved_type_dropped', { ip: this.ip, type: envelope.type });
      return;
    }
    if (this.state !== 'IN_WORLD' || !this.player) {
      log('warn', 'conn.event_before_in_world', { ip: this.ip, state: this.state });
      return;
    }
    const { name, body } = unpackEvent(envelope.payload);
    if (name !== 'ChatSend') {
      log('warn', 'conn.unknown_event_dropped', { ip: this.ip, name });
      return;
    }
    let value;
    try {
      value = lserDecode(body);
    } catch (err) {
      // Malformed LSER: drop the frame, keep the session (rate limits bound abuse).
      log('warn', 'conn.bad_lser', { ip: this.ip, name, error: err instanceof LserError ? err.code : String(err) });
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
    this.finishAuth(result);
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
    this.finishAuth(account);
  }

  private finishAuth(account: Account): void {
    if (this.state !== 'HELLO_OK') return; // raced a disconnect while hashing
    const accountKey = account.name.toLowerCase();
    const existing = this.ctx.roster.activeForAccount(accountKey);
    if (existing) existing.peer.disconnect('SUPERSEDED', 'account logged in from another connection');
    this.account = account;
    this.player = this.ctx.roster.addAuthed(account.name, accountKey, account.rank, this);
    this.state = 'AUTHED';
    this.authing = false;
    const sessionToken = randomBytes(16).toString('hex');
    // serverSeq = binary seq already consumed for this connection (0: none yet).
    this.sendText(welcome(this.player.id, sessionToken, this.ctx.config.server.motd, this.outSeq));
    this.ctx.hooks.playerAuthed({ id: this.player.id, name: this.player.name, rank: this.player.rank });
    log('info', 'player.authed', { id: this.player.id, name: this.player.name, ip: this.ip });
  }

  private handleReady(): void {
    if (!this.player) return;
    this.state = 'IN_WORLD';
    this.ctx.roster.joinWorld(this.player);
    this.ctx.hooks.playerJoinWorld({ id: this.player.id, name: this.player.name, rank: this.player.rank });
  }
}
