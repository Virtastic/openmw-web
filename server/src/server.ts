// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Composition root: wires config, stores, gates, plugins, HTTP and WS into a running
// server. main.ts is the CLI face; tests call startServer() directly.

import { mkdirSync } from 'node:fs';
import { WebSocket } from 'ws';
import { loadConfig, type Config, type DeepPartial } from './config';
import { AccountStore } from './core/accounts';
import { PlayerStore } from './persist/playerstore';
import { CellStore } from './persist/cellstore';
import { RecordStore } from './persist/recordstore';
import { BanStore } from './persist/banstore';
import type { StateCtx } from './core/playerstate';
import { WorldState } from './core/worldstate';
import { Combat } from './core/combat';
import { Quests } from './core/quests';
import { WorldM7 } from './core/m7';
import { Roster } from './core/players';
import { ContentGate, EngineGate } from './core/manifest';
import { CommandRegistry, registerCoreCommands, registerAdminCommands, type CommandContext } from './core/commands';
import { Admin } from './core/admin';
import { ResumeStore } from './core/resume';
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
  // The same surface plugins get. Exposed so an embedder (and the test suite) can drive
  // world actions and server-pushed GUI without loading a plugin.
  api: PluginApi;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  mkdirSync(opts.dataDir, { recursive: true });
  const config = loadConfig(opts.dataDir, opts.configOverride);
  const accounts = new AccountStore(opts.dataDir);
  const playerStore = new PlayerStore(opts.dataDir);
  const cellStore = new CellStore(opts.dataDir);
  const recordStore = new RecordStore(opts.dataDir);
  const bans = new BanStore(opts.dataDir);
  await bans.ready(); // the ban list must be authoritative before the listener opens
  await cellStore.ready(); // netId ceiling must be loaded before any spawn
  await recordStore.ready(); // custom-record ids must not restart from 1 after a reboot
  const roster = new Roster();
  // M8: /motd rewrites this at runtime; SessionWelcome and the motd plugin read it here.
  let motd = config.server.motd;
  const resume = new ResumeStore(config.login.resumeWindowSec);
  const world = new WorldState(roster, cellStore);
  const startedAt = Date.now();
  // At flush time the store pulls the freshest position from the live session, so pose
  // updates never need to dirty the doc.
  playerStore.setLivePositionProvider((key) => {
    const p = roster.activeForAccount(key);
    return p?.cellKey && p.pose ? { cellKey: p.cellKey, x: p.pose.x, y: p.pose.y, z: p.pose.z } : undefined;
  });

  // M7 needs the hook bus (map sharing policy) and the bus's api needs M7 (gui/world
  // actions), so the reference is closed over lazily — both are live before any hook or
  // any client frame can run.
  let hooks: HookBus;
  const admin = new Admin({
    roster,
    accounts,
    bans,
    resume,
    allowConsole: config.admin.allowConsole,
    motd: () => motd,
    setMotd: (text) => {
      motd = text;
      config.server.motd = text; // plugins and Welcome read config.server.motd
    },
    allow: (actor, cmd) => hooks.adminCommand({ id: actor.id, name: actor.name, rank: actor.rank }, cmd),
  });
  const m7 = new WorldM7({
    roster,
    cells: cellStore,
    records: recordStore,
    guiTimeoutMs: Math.round(config.gui.timeoutSec * 1000),
    isMapShared: () => hooks.shareFamily('map'),
  });
  m7.clock.setTimeScale(config.time.scale); // config is operator truth for the scale

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
    gui: {
      messageBox: (playerId, text, buttons) => m7.gui.messageBox(playerId, text, buttons),
      inputDialog: (playerId, label) => m7.gui.inputDialog(playerId, label),
      listBox: (playerId, label, items) => m7.gui.listBox(playerId, label, items),
    },
    world: {
      time: () => ({ ...cellStore.worldM7().time }),
      advanceTime: (hours) => m7.clock.advance(hours),
      setTimeScale: (scale) => m7.clock.setTimeScale(scale),
      scheduleCellReset: (cellKey, intervalSec) => m7.scheduleCellReset(cellKey, intervalSec),
      unscheduleCellReset: (cellKey) => m7.unscheduleCellReset(cellKey),
      scheduledResets: () => m7.scheduledResets(),
      resetCell: (cellKey) => m7.resetCellNow(cellKey),
      promoteOwner: async (account) => {
        const found = await accounts.get(account);
        if (!found) return false;
        accounts.setRank(found.name, 3);
        const online = roster.findByName(found.name);
        if (online) online.rank = 3;
        return true;
      },
      pendingGuiCount: () => m7.gui.pendingCount(),
    },
  };
  hooks = new HookBus(config.plugins, api);

  const commands = new CommandRegistry();
  registerCoreCommands(commands);
  registerAdminCommands(commands, admin);
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

  const combat = new Combat({
    roster,
    maxHitDamage: config.limits.maxHitDamage,
    holderOf: (cellKey) => world.holderOf(cellKey),
    epochOf: (cellKey) => world.epochOf(cellKey),
    allowPlayerHit: (attacker, victimId, name) =>
      hooks.playerHit({ id: attacker.id, name: attacker.name, rank: attacker.rank }, victimId, name),
  });

  const quests = new Quests({
    roster,
    cells: cellStore,
    players: playerStore,
    isShared: (family) => hooks.shareFamily(family),
    regressAllowed: (questId) => hooks.journalRegress(questId),
  });

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
    world,
    combat,
    quests,
    m7,
    admin,
    bans,
    resume,
    motd: () => motd,
  };

  const httpServer = createHttpServer(() => ({
    name: config.server.name,
    motd,
    contentPolicy: config.content.enforce,
    enginePolicy: config.engine.enforce,
    requiresPassword: config.server.password !== '',
    allowsRegistration: config.login.allowRegistration && config.login.inviteCode === '',
    playerCount: roster.inWorld().length,
    pvp: config.rules.pvp,
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
    // M8: an IP ban is refused at accept — the cheapest possible answer, before any
    // parsing, argon2 work or roster slot is spent on the connection.
    const ipBan = bans.isIpBanned(ip);
    if (ipBan) {
      log('info', 'conn.ip_banned', { ip });
      if (ws.readyState === WebSocket.OPEN) ws.send(disconnectMsg('BANNED', `address banned: ${ipBan.reason}`));
      ws.close(1008, 'BANNED');
      return;
    }
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
  m7.start(); // clock ticking + cell-reset sweep before plugins register schedules
  hooks.serverStart();
  log('info', 'server.start', { port, dataDir: opts.dataDir, version: VERSION });

  let closed = false;
  return {
    port,
    config,
    api,
    flush: async () => {
      await accounts.flush();
      await playerStore.flushAll();
      await world.drain();
      await m7.drain();
      await cellStore.flushAll();
      await recordStore.flush();
      await bans.flush();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      moveBroadcaster.stop();
      await m7.stop();
      hooks.serverStop();
      for (const conn of [...connections]) conn.disconnect('SHUTDOWN', 'server shutting down');
      wss.close();
      await accounts.close();
      await playerStore.close();
      await world.drain(); // let queued ops land before the final cell flush
      await cellStore.close();
      await recordStore.close();
      await bans.flush();
      resume.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      log('info', 'server.stop', {});
    },
  };
}
