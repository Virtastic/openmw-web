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
import { Social } from './core/social';
import { SocialStore } from './core/socialstore';
import { WorldM7 } from './core/m7';
import { Roster } from './core/players';
import { ContentGate, EngineGate } from './core/manifest';
import {
  CommandRegistry,
  registerCoreCommands,
  registerAdminCommands,
  registerReportCommand,
  type CommandContext,
} from './core/commands';
import { Moderation } from './core/moderation';
import { Admin } from './core/admin';
import { ResumeStore } from './core/resume';
import { broadcastChat, type ChatMessageBody } from './core/chat';
import { HookBus } from './plugins/loader';
import type { PluginApi } from './plugins/api';
import { MoveBroadcaster, interestFromLimits } from './core/movement';
import { configureAuthority } from './core/authority';
import { Connection, type ServerCtx } from './net/connection';
import { attachWss } from './net/ws';
import { createHttpServer } from './net/http';
import { OidcService } from './auth/oidc';
import { IdentityStore, LoginTicketStore, SessionIndex } from './auth/identities';
import { createAuthRoutes } from './auth/routes';
import { IpConnTracker, IpRateLimiter } from './net/ratelimit';
import { disconnectMsg } from './proto/session';
import { log } from './log';
import { metrics } from './metrics';
import { SimPeerSupervisor } from './core/simpeer';
import { WorldBrowser } from './core/worldbrowser';

export const VERSION = '0.1.0';

export interface StartOptions {
  dataDir: string;
  port: number;
  host?: string;
  // F1/F3: state that must be the SAME for a player across every world — accounts, SSO
  // identities, friends/party/presence, and bans. Defaults to dataDir, so a single-world
  // self-hoster is completely unaffected and existing data dirs keep working in place.
  // Under the F3 gateway every world is pointed at one shared dir, which is what makes
  // "log in once, see your friends wherever they are, a ban means banned" true.
  //
  // What deliberately does NOT move: cells, player docs and custom records stay PER WORLD.
  // One account with a character per world is the safe shape — a character carried between
  // worlds would let items be duplicated by joining a second world with the same inventory.
  sharedDir?: string;
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
  const sharedDir = opts.sharedDir ?? opts.dataDir;
  if (sharedDir !== opts.dataDir) mkdirSync(sharedDir, { recursive: true });
  const config = loadConfig(opts.dataDir, opts.configOverride);
  // M4 election tuning is read live by core/authority.ts, which WorldState builds without
  // ever seeing the config; push it before anything can elect.
  configureAuthority({
    unknownRttMs: config.authority.unknownRttMs,
    shedPenaltyMs: config.authority.shedPenaltyMs,
    improveMs: config.authority.improveMs,
    improveRatio: config.authority.improveRatio,
    degradeScoreMs: config.authority.degradeScoreMs,
    sustainMs: config.authority.sustainSec * 1000,
    cooldownMs: config.authority.cooldownSec * 1000,
    settleMs: config.authority.settleSec * 1000,
    reviewMs: config.authority.reviewSec * 1000,
  });
  const accounts = new AccountStore(sharedDir);
  const playerStore = new PlayerStore(opts.dataDir);
  const cellStore = new CellStore(opts.dataDir);
  const recordStore = new RecordStore(opts.dataDir);
  const bans = new BanStore(sharedDir);
  await bans.ready(); // the ban list must be authoritative before the listener opens
  // Phase B: the identity index must be complete before the listener opens too — a missed
  // (iss,sub) entry would hand a returning player a brand new empty account.
  const identities = new IdentityStore(sharedDir);
  await identities.ready();
  const tickets = new LoginTicketStore();
  const sessions = new SessionIndex();
  const oidc = new OidcService(config.auth);
  await cellStore.ready(); // netId ceiling must be loaded before any spawn
  await recordStore.ready(); // custom-record ids must not restart from 1 after a reboot
  const roster = new Roster();
  // M8: /motd rewrites this at runtime; SessionWelcome and the motd plugin read it here.
  let motd = config.server.motd;
  const resume = new ResumeStore(config.login.resumeWindowSec);
  const interest = interestFromLimits(config.limits);
  const world = new WorldState(roster, cellStore, interest);
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
  const moderation = new Moderation(sharedDir, config.moderation);
  const admin = new Admin({
    roster,
    accounts,
    bans,
    resume,
    moderation,
    allowConsole: config.admin.allowConsole,
    motd: () => motd,
    setMotd: (text) => {
      motd = text;
      config.server.motd = text; // plugins and Welcome read config.server.motd
    },
    allow: (actor, cmd) => hooks.adminCommand({ id: actor.id, name: actor.name, rank: actor.rank }, cmd),
    // Closed over lazily, like `hooks` above: the command registry is built further down,
    // and this is only ever called once a client is connected. Sharing it means the admin
    // window's menu and the chat /help can never disagree about what a rank permits.
    helpLines: (rank) => commands.helpLines(rank),
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
  registerReportCommand(commands, moderation);
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

  // Phase C. The store is opened here so its lifetime matches the server's; social.stop()
  // clears presence timers that would otherwise keep the process alive on shutdown.
  const socialStore = new SocialStore(sharedDir);
  const social = new Social({
    store: socialStore,
    roster,
    displayName: (acct) => accounts.cachedByKey(acct)?.name,
    // Resolution is by display name because that is what a player types, but everything
    // stored keys on the account — names are mutable and reusable.
    resolveName: (name) => (accounts.existsNow(name) ? name.toLowerCase() : undefined),
    now: () => Date.now(),
    // F3: only when a gateway is configured. Without one the Worlds tab reports that this
    // is a standalone world, which is an honest answer and a valid setup.
    ...(config.gateway.url
      ? { worlds: new WorldBrowser({ gatewayUrl: config.gateway.url, ownPort: () => port }) }
      : {}),
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
    social,
    m7,
    admin,
    bans,
    resume,
    moderation,
    tickets,
    sessions,
    motd: () => motd,
  };

  const httpServer = createHttpServer(() => ({
    name: config.server.name,
    motd,
    contentPolicy: config.content.enforce,
    enginePolicy: config.engine.enforce,
    requiresPassword: config.server.password !== '',
    allowsRegistration: config.login.allowRegistration && config.login.inviteCode === '',
    playerCount: roster.humansInWorld().length,
    pvp: config.rules.pvp,
    players: roster.humansInWorld().map((p) => ({
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
  }), config.metrics, createAuthRoutes({
    config,
    oidc,
    identities,
    tickets,
    sessions,
    accounts,
    bans,
    // SSO round trips draw from the same per-IP auth budget as Register/Login: one
    // attacker should not get a second, separate allowance by using the HTTP door.
    limiter: new IpRateLimiter(config.limits.loginPerMinPerIp),
  }));
  // Derived at scrape time from the roster, so no teardown path can strand the gauge.
  const unhookGauge = metrics.sessionsInWorld.addCollector(() => roster.inWorld().length);

  // Phase H4: the on-demand simulation peer. Wired at ONE point rather than hooked into
  // join/leave in connection.ts, because ensure()/markIdle() are idempotent by design and a
  // periodic observation of the roster cannot drift out of sync with it the way paired
  // hooks can (a missed leave would strand a peer forever — exactly the leak the reaper
  // exists to prevent). Disabled by default; see [simPeer] in config.default.toml.
  const simPeers = new SimPeerSupervisor({
    settings: config.simPeer,
    wsUrl: () => `ws://127.0.0.1:${port}/ws`,
    password: config.server.password,
  });
  const WORLD_KEY = 'world'; // one world per process today; F3 (multi-world) is not built
  const simPeerTick = setInterval(() => {
    if (!config.simPeer.enabled) return;
    // humansInWorld, NOT inWorld: the peer itself is in-world, so counting it would keep
    // the world looking busy forever and the reaper would never fire.
    if (roster.humansInWorld().length > 0) simPeers.ensure(WORLD_KEY);
    else simPeers.markIdle(WORLD_KEY);
    simPeers.sweep();
  }, 5_000);
  simPeerTick.unref();
  metrics.simPeerRunning.addCollector(() => simPeers.running);

  const ipTracker = new IpConnTracker(config.limits.maxConnsPerIp);
  const connections = new Set<Connection>();
  // Same shape as the roster gauge: summed from the live sockets at scrape time, so a
  // teardown path can never strand it.
  const unhookBufferedGauge = metrics.outboundBuffered.addCollector(() => {
    let total = 0;
    for (const c of connections) total += c.bufferedBytes;
    return total;
  });

  const wss = attachWss(httpServer, config.limits.maxMsgBytes, (ws, ip) => {
    // M8: an IP ban is refused at accept — the cheapest possible answer, before any
    // parsing, argon2 work or roster slot is spent on the connection.
    const ipBan = bans.isIpBanned(ip);
    if (ipBan) {
      log('info', 'conn.ip_banned', { ip });
      metrics.connRefused.inc({ reason: 'ip_banned' });
      if (ws.readyState === WebSocket.OPEN) ws.send(disconnectMsg('BANNED', `address banned: ${ipBan.reason}`));
      ws.close(1008, 'BANNED');
      return;
    }
    if (!ipTracker.acquire(ip)) {
      log('info', 'conn.ip_cap_refused', { ip });
      metrics.connRefused.inc({ reason: 'ip_cap' });
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
    metrics.connOpened.inc();
  }, config.authority.rttProbeSec * 1000);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host ?? '0.0.0.0', resolve);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  const moveBroadcaster = new MoveBroadcaster(roster, undefined, interest);
  moveBroadcaster.start();
  m7.start(); // clock ticking + cell-reset sweep before plugins register schedules
  hooks.serverStart();
  log('info', 'server.start', { port, dataDir: opts.dataDir, sharedDir, version: VERSION });

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
      await moderation.flush(); // a backup taken after SIGUSR1 must include the chat log
    },
    close: async () => {
      if (closed) return;
      closed = true;
      unhookGauge();
      unhookBufferedGauge();
      clearInterval(simPeerTick);
      simPeers.stopAll(); // never leave an engine running after the server it fed is gone
      moveBroadcaster.stop();
      social.stop(); // pending presence timers would keep the process alive
      socialStore.close();
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
      await moderation.flush();
      resume.clear();
      oidc.close();
      tickets.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      log('info', 'server.stop', {});
    },
  };
}
