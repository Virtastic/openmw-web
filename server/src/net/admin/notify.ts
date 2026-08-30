// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Email and webhooks: password recovery, and telling an operator something happened while
// they were not looking.
//
// SMTP is spoken directly over node:tls rather than pulling in nodemailer. What we need is
// one submission conversation to an operator-configured relay — EHLO, AUTH, MAIL, RCPT,
// DATA — against a service every provider implements the same way. That is ~120 lines here
// versus a dependency tree for a protocol we use one narrow slice of. If this ever needs
// OAuth2 relays, DKIM signing or attachments, take the dependency; it will have earned it.
//
// Everything is optional. With no SMTP host configured nothing is sent, no error is raised,
// and password recovery simply is not offered — an operator who never set up mail should
// not see a "forgot password" link that silently does nothing.

import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { createConnection, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { log } from '../../log';

export interface MailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export interface NotifyConfig extends MailConfig {
  to: string;
  webhookUrl: string;
  events: string[];
}

// ---------------------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------------------

/** Read one complete SMTP reply, which may be several 250-continuation lines. */
function readReply(sock: Socket | TLSSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('smtp timeout')); }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      // A reply is finished when the last line's 4th character is a space rather than '-'.
      const lines = buf.split('\r\n').filter((l) => l !== '');
      const last = lines[lines.length - 1];
      if (last && last.length >= 4 && last[3] === ' ') { cleanup(); resolve(buf); }
    };
    const onErr = (err: Error): void => { cleanup(); reject(err); };
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onErr);
    };
    sock.on('data', onData);
    sock.on('error', onErr);
  });
}

function expect(reply: string, ...codes: string[]): void {
  if (!codes.some((c) => reply.startsWith(c))) {
    // Trim: a server's rejection text can be long, and it goes into a log line.
    throw new Error(`smtp refused: ${reply.trim().slice(0, 200)}`);
  }
}

/**
 * Send one message. Implicit TLS on 465, STARTTLS on anything else (587 and 25 in
 * practice) — plaintext submission is never attempted, because these credentials are the
 * operator's real mail account.
 */
export async function sendMail(
  cfg: MailConfig,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  if (cfg.host === '') throw new Error('no SMTP host configured');
  const timeoutMs = 15_000;

  let sock: Socket | TLSSocket = cfg.port === 465
    ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : createConnection({ host: cfg.host, port: cfg.port });

  const say = async (line: string, ...ok: string[]): Promise<string> => {
    sock.write(`${line}\r\n`);
    const reply = await readReply(sock, timeoutMs);
    if (ok.length) expect(reply, ...ok);
    return reply;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const ev = cfg.port === 465 ? 'secureConnect' : 'connect';
      sock.once(ev, () => resolve());
      sock.once('error', reject);
      sock.setTimeout(timeoutMs, () => reject(new Error('smtp connect timeout')));
    });
    expect(await readReply(sock, timeoutMs), '220');

    const ehlo = await say(`EHLO ${hostnameForEhlo(cfg.from)}`, '250');

    if (cfg.port !== 465) {
      if (!/STARTTLS/i.test(ehlo)) {
        throw new Error('server does not offer STARTTLS; refusing to send credentials in the clear');
      }
      await say('STARTTLS', '220');
      const plain = sock as Socket;
      sock = tlsConnect({ socket: plain, servername: cfg.host });
      await new Promise<void>((resolve, reject) => {
        sock.once('secureConnect', () => resolve());
        sock.once('error', reject);
      });
      await say(`EHLO ${hostnameForEhlo(cfg.from)}`, '250');
    }

    if (cfg.user !== '') {
      // AUTH LOGIN: base64 user, then base64 password. PLAIN would do, but LOGIN is the one
      // every provider accepts.
      await say('AUTH LOGIN', '334');
      await say(Buffer.from(cfg.user).toString('base64'), '334');
      await say(Buffer.from(cfg.pass).toString('base64'), '235');
    }

    await say(`MAIL FROM:<${cfg.from}>`, '250');
    await say(`RCPT TO:<${to}>`, '250', '251');
    await say('DATA', '354');

    const message = [
      `From: ${cfg.from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      `Date: ${new Date().toUTCString()}`,
      '',
      // Dot-stuffing: a line that is just "." would otherwise end the message early.
      body.replace(/\r?\n\./g, '\n..'),
      '.',
    ].join('\r\n');
    sock.write(`${message}\r\n`);
    expect(await readReply(sock, timeoutMs), '250');

    await say('QUIT');
  } finally {
    sock.destroy();
  }
}

/** EHLO wants a hostname; the sender's domain is the closest honest thing we have. */
function hostnameForEhlo(from: string): string {
  const at = from.lastIndexOf('@');
  return at === -1 ? 'openmw-mp' : from.slice(at + 1) || 'openmw-mp';
}

// ---------------------------------------------------------------------------------------
// password recovery
// ---------------------------------------------------------------------------------------

interface ResetToken { accountKey: string; expiresAt: number; used: boolean }

/**
 * Single-use, short-lived password reset tokens.
 *
 * In memory, not on disk: a reset link that survives a restart is a credential sitting in a
 * file, and the window this needs to cover is minutes. A restart invalidating outstanding
 * links is a fine trade for that.
 */
export class ResetTokens {
  private readonly tokens = new Map<string, ResetToken>();
  constructor(private readonly ttlMs = 30 * 60 * 1000) {}

  mint(accountKey: string): string {
    this.sweep();
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(hashToken(token), { accountKey, expiresAt: Date.now() + this.ttlMs, used: false });
    return token;
  }

  /** Consume a token. Returns the account it belongs to, or undefined for anything else. */
  consume(token: string): string | undefined {
    if (token === '') return undefined;
    const entry = this.tokens.get(hashToken(token));
    if (!entry || entry.used || entry.expiresAt <= Date.now()) return undefined;
    entry.used = true;
    return entry.accountKey;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of [...this.tokens]) if (v.expiresAt <= now) this.tokens.delete(k);
  }
}

// Stored hashed, so a memory dump or a stray log of this map is not a set of live reset
// links. Constant-time comparison is not needed on a hash lookup, but the hash is.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Guard against timing differences leaking whether an account exists. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------------------
// event notifications
// ---------------------------------------------------------------------------------------

/**
 * Fire configured notifications for a structured log event.
 *
 * Deliberately a filtered tap on log() calls that already exist rather than a general
 * pub/sub: the interesting moments (a ban, a console command, a config rollback) are
 * already logged with the right fields, and a second event system would be a second place
 * for them to be missed.
 *
 * Never throws and never blocks the caller — a mail server being down must not turn a ban
 * into a failed request.
 */
export function notifyEvent(cfg: NotifyConfig, event: string, fields: Record<string, unknown>): void {
  if (!cfg.events.includes(event)) return;

  const summary = `${event} ${Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`;

  if (cfg.webhookUrl !== '') {
    void fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Slack, Discord and Mattermost all accept {text}; anything else gets the structured
      // fields alongside it and can pick what it wants.
      body: JSON.stringify({ text: `openmw-mp: ${summary}`, event, ...fields }),
    }).catch((err: unknown) => log('warn', 'notify.webhook_failed', { event, error: String(err) }));
  }

  if (cfg.host !== '' && cfg.to !== '') {
    void sendMail(cfg, cfg.to, `openmw-mp: ${event}`, summary)
      .catch((err: unknown) => log('warn', 'notify.mail_failed', { event, error: String(err) }));
  }
}
