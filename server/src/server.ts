// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Composition root: wires config, stores, gates, plugins, HTTP and WS into a running
// server. main.ts is the CLI face; tests call startServer() directly.

import { mkdirSync } from 'node:fs';
import { WebSocket } from 'ws';
import { loadConfig, type Config, type DeepPartial } from './config';
import { AccountStore } from './core/accounts';
import { PlayerStore } from './persist/playerstore';
import type { StateCtx } from './core/playerstate';
import { Roster } from './core/players';
import { ContentGate, EngineGate } from './core/manifest';
import { CommandRegistry, registerCoreCommands, type CommandContext } from './core/commands';
import { broadcastChat, type ChatMessageBody } from './core/chat';
import { HookBus } from './plugins/loader';
import type { PluginApi } from './plugins/api';
import { MoveBroadcaster } from './core/movement';
import { Connection, type ServerCtx } from './net/connection';
import { attachWss } from './net/ws';
import { createHttpServer } from './net/http';
import { IpConnTracker, IpRateLimiter } from './net/ratelimit';
import { disconnectMsg } from './proto/session';
import { log } from './log';

export const VERSION = '0.1.0';

export interface StartOptions {
  dataDir: string;
  port: number;
  host?: string;
  configOverride?: DeepPartial<Config>; // tests
}

export interface RunningServer {
  port: number;
  config: Config;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  mkdirSync(opts.dataDir, { recursive: true });
  const config = loadConfig(opts.dataDir, opts.configOverride);
  const accounts = new AccountStore(opts.dataDir);
  const playerStore = new PlayerStore(opts.dataDir);
  const roster = new Roster();
  const startedAt = Date.now();
  // At flush time the store pulls the freshest position from the live session, so pose
  // updates never need to dirty the doc.
  playerStore.setLivePositionProvider((key) => {
    const p = roster.activeForAccount(key);
    return p?.cellKey && p.pose ? { cellKey: p.cellKey, x: p.pose.x, y: p.pose.y, z: p.pose.z } : undefined;
  });

  const api: PluginApi = {
    config,
    log,
    players: () => roster.inWorld().map((p) => ({ id: p.id, name: p.name, rank: p.rank })),
    chat: (target, msg: ChatMessageBody) => {
      if (target === 'all') broadcastChat(roster, msg);
      else roster.get(target)?.peer.sendEvent('ChatMessage', msg);
    },
    sendEvent: (target, name, body) => {
      if (target === 'all') for (const p of roster.inWorld()) p.peer.sendEvent(name, body);
      else roster.get(target)?.peer.sendEvent(name, body);
    },
  };
  const hooks = new HookBus(config.plugins, api);

  const commands = new CommandRegistry();
  registerCoreCommands(commands);
  const commandCtx: CommandContext = {
    roster,
    onCommand: (player, name, args) => hooks.command({ id: player.id, name: player.name, rank: player.rank }, name, args),
  };

  const stateCtx: StateCtx = {
    roster,
    store: playerStore,
    onPlayerDeath: (player) => {
      log('info', 'player.death', { id: player.id, name: player.name });
      hooks.playerDeath({ id: player.id, name: player.name, rank: player.rank });
    },
  };

  const ctx: ServerCtx = {
    config,
    accounts,
    roster,
    content: new ContentGate(config.content.enforce),
    engine: new EngineGate(config.engine.enforce),
    loginLimiter: new IpRateLimiter(config.limits.loginPerMinPerIp),
    commands,
    commandCtx,
    hooks,
    players: playerStore,
    stateCtx,
  };

  const httpServer = createHttpServer(() => ({
    name: config.server.name,
    players: roster.inWorld().map((p) => ({
      id: p.id,
      name: p.name,
      cellKey: p.cellKey ?? null,
      ...(playerStore.getCached(p.accountKey)?.stats?.level !== undefined
        ? { level: playerStore.getCached(p.accountKey)!.stats!.level }
        : {}),
    })),
    maxPlayers: config.server.maxPlayers,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    version: VERSION,
  }));

  const ipTracker = new IpConnTracker(config.limits.maxConnsPerIp);
  const connections = new Set<Connection>();

  const wss = attachWss(httpServer, config.limits.maxMsgBytes, (ws, ip) => {
    if (!ipTracker.acquire(ip)) {
      log('info', 'conn.ip_cap_refused', { ip });
      if (ws.readyState === WebSocket.OPEN) ws.send(disconnectMsg('RATE', 'too many connections from your address'));
      ws.close(1008, 'RATE');
      return;
    }
    const conn: Connection = new Connection(ws, ip, ctx, () => {
      connections.delete(conn);
      ipTracker.release(ip);
    });
    connections.add(conn);
    log('info', 'conn.open', { ip });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host ?? '0.0.0.0', resolve);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  const moveBroadcaster = new MoveBroadcaster(roster);
  moveBroadcaster.start();
  hooks.serverStart();
  log('info', 'server.start', { port, dataDir: opts.dataDir, version: VERSION });

  let closed = false;
  return {
    port,
    config,
    flush: async () => {
      await accounts.flush();
      await playerStore.flushAll();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      moveBroadcaster.stop();
      hooks.serverStop();
      for (const conn of [...connections]) conn.disconnect('SHUTDOWN', 'server shutting down');
      wss.close();
      await accounts.close();
      await playerStore.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      log('info', 'server.stop', {});
    },
  };
}
