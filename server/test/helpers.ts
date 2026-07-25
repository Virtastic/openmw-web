// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Test-side omw-mp/1 client: JSON session tier + binary event tier over a real ws socket.

import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packEvent, packEnvelope, unpackEnvelope, unpackEvent, MSG_EVENT, MSG_PLAYER_MOVE, MSG_PLAYER_MOVE_BATCH, MSG_ACTOR_MOVE_BATCH } from '../src/proto/envelope';
import { lserEncode, lserDecode, jsToL, lToJs, type JsLike } from '../src/proto/lser';
import type { ManifestEntry } from '../src/proto/session';
import { packMove, packActorMoveBatch, unpackMoveBatch, unpackActorMoveBatch, type PlayerPose, type BatchEntry, type ActorEntry, type ActorMoveBatch } from '../src/proto/movement';

export function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'openmw-mp-test-'));
}

export const MANIFEST: ManifestEntry[] = [
  { name: 'Morrowind.esm', size: 79837557, idx: 0 },
  { name: 'mp.omwscripts', size: 1234, idx: 1 },
];

type JsonMsg = { t: string; [key: string]: unknown };
type EventMsg = { name: string; seq: number; value: unknown };
type BatchMsg = { seq: number; entries: BatchEntry[] };
type ActorBatchMsg = { seq: number; batch: ActorMoveBatch };
type Inbox = { json: JsonMsg[]; events: EventMsg[]; batches: BatchMsg[]; actorBatches: ActorBatchMsg[] };

export class TestClient {
  readonly inbox: Inbox = { json: [], events: [], batches: [], actorBatches: [] };
  readonly closed: Promise<{ code: number; reason: string }>;
  isClosed = false;
  private seq = 0;
  private waiters: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const env = unpackEnvelope(data);
        if (env.type === MSG_EVENT) {
          const { name, body } = unpackEvent(env.payload);
          this.inbox.events.push({ name, seq: env.seq, value: lToJs(lserDecode(body)) });
        } else if (env.type === MSG_PLAYER_MOVE_BATCH) {
          this.inbox.batches.push({ seq: env.seq, entries: unpackMoveBatch(env.payload) });
        } else if (env.type === MSG_ACTOR_MOVE_BATCH) {
          this.inbox.actorBatches.push({ seq: env.seq, batch: unpackActorMoveBatch(env.payload) });
        }
      } else {
        this.inbox.json.push(JSON.parse(data.toString('utf8')) as JsonMsg);
      }
      this.wake();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.isClosed = true;
        this.wake();
        resolve({ code, reason: reason.toString() });
      });
    });
    ws.on('error', () => {}); // surfaced via closed/connect rejection instead
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  // subprotocol: null = offer none (must be refused by the server).
  static connect(port: number, subprotocol: string | null = 'omw-mp.1'): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = subprotocol
        ? new WebSocket(`ws://127.0.0.1:${port}/ws`, subprotocol)
        : new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('open', () => resolve(new TestClient(ws)));
      ws.once('error', reject);
    });
  }

  sendJson(obj: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(obj));
  }

  sendEvent(name: string, body: JsLike): void {
    this.ws.send(packEvent(++this.seq, name, lserEncode(jsToL(body))));
  }

  sendRawBinary(buf: Buffer): void {
    this.ws.send(buf);
  }

  // seq override lets tests exercise the stale-drop path.
  sendMove(pose: Partial<PlayerPose>, seq?: number): void {
    const full: PlayerPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 128, flags: 0, animVel: 0, counter: 0, ...pose };
    this.ws.send(packEnvelope(MSG_PLAYER_MOVE, seq ?? ++this.seq, packMove(full)));
  }

  sendCellChange(cellKey: string, x = 0, y = 0, z = 0): void {
    this.sendEvent('PlayerCellChange', { cellKey, x, y, z });
  }

  sendActorMoveBatch(epoch: number, entries: ActorEntry[]): void {
    this.ws.send(packEnvelope(MSG_ACTOR_MOVE_BATCH, ++this.seq, packActorMoveBatch(epoch, entries)));
  }

  waitActorBatch(pred: (b: ActorBatchMsg) => boolean = () => true, timeoutMs = 3000): Promise<ActorBatchMsg> {
    return this.waitFor(
      () => {
        const i = this.inbox.actorBatches.findIndex(pred);
        return i === -1 ? undefined : this.inbox.actorBatches.splice(i, 1)[0];
      },
      'actor batch',
      timeoutMs,
    );
  }

  hello(manifest: ManifestEntry[] = MANIFEST, engineHash = 'abcdef123456'): void {
    this.sendJson({ t: 'SessionHello', proto: 1, engineHash, lserVersion: 0, manifest });
  }

  register(account: string, password: string, extra: Record<string, unknown> = {}): void {
    this.sendJson({ t: 'SessionRegister', account, password, ...extra });
  }

  login(account: string, password: string, extra: Record<string, unknown> = {}): void {
    this.sendJson({ t: 'SessionLoginRequest', account, password, ...extra });
  }

  private async waitFor<T>(pick: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = pick();
      if (found !== undefined) return found;
      if (this.isClosed) throw new Error(`socket closed while waiting for ${what}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // Consumes (removes) the first matching JSON message.
  waitJson(t: string, timeoutMs = 3000): Promise<JsonMsg> {
    return this.waitFor(
      () => {
        const i = this.inbox.json.findIndex((m) => m.t === t);
        return i === -1 ? undefined : this.inbox.json.splice(i, 1)[0];
      },
      `json ${t}`,
      timeoutMs,
    );
  }

  // Waits for SessionDisconnect with a specific code (does not require the close yet).
  async waitDisconnect(code: string, timeoutMs = 3000): Promise<JsonMsg> {
    const msg = await this.waitFor(
      () => {
        const i = this.inbox.json.findIndex((m) => m.t === 'SessionDisconnect' && m.code === code);
        return i === -1 ? undefined : this.inbox.json.splice(i, 1)[0];
      },
      `SessionDisconnect ${code}`,
      timeoutMs,
    );
    return msg;
  }

  // Consumes the first matching event.
  waitEvent(name: string, pred: (value: unknown) => boolean = () => true, timeoutMs = 3000): Promise<EventMsg> {
    return this.waitFor(
      () => {
        const i = this.inbox.events.findIndex((e) => e.name === name && pred(e.value));
        return i === -1 ? undefined : this.inbox.events.splice(i, 1)[0];
      },
      `event ${name}`,
      timeoutMs,
    );
  }

  // Consumes the first matching PlayerMoveBatch.
  waitBatch(pred: (b: BatchMsg) => boolean = () => true, timeoutMs = 3000): Promise<BatchMsg> {
    return this.waitFor(
      () => {
        const i = this.inbox.batches.findIndex(pred);
        return i === -1 ? undefined : this.inbox.batches.splice(i, 1)[0];
      },
      'move batch',
      timeoutMs,
    );
  }

  // Full happy path up to IN_WORLD. Returns the Welcome fields tests assert on (it is
  // consumed from the inbox here, so it cannot be looked up afterwards).
  async joinAsNew(account: string, password = 'hunter22'): Promise<{ playerId: number; welcome: JsonMsg }> {
    this.hello();
    await this.waitJson('SessionHelloOk');
    this.register(account, password);
    const w = await this.waitJson('SessionWelcome');
    this.sendJson({ t: 'SessionReady' });
    return { playerId: w['playerId'] as number, welcome: w };
  }

  close(): void {
    this.ws.close();
  }
}
