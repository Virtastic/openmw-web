// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Composition root: wires config, stores, gates, plugins, HTTP and WS into a running
// server. main.ts is the CLI face; tests call startServer() directly.

import pkg from '../package.json';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig, type Config, type DeepPartial } from './config';
import { AccountStore } from './core/accounts';
import { AttioHook } from './integrations/attio';
import { ContentTable } from './core/content-table';
import { QuestRepair } from './core/quest-repair';
import { adminRoutes as adminDashboardRoutes } from './net/admin/routes';
import { exportDataDir, summariseMetrics } from './net/admin/ops';
import { writeCaddyfile, launcherEnabled } from './net/admin/caddy-config';
import { orderedContent } from './net/admin/api-mods';
import { ResetTokens, sendMail, notifyEvent, type MailConfig } from './net/admin/notify';
import { SetupToken } from './net/admin/setup-token';
import { passwordProblem } from './net/admin/auth';
import { deleteAccount } from './persist/erase';
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
import { Roster, type Player } from './core/players';
import { ContentGate, EngineGate } from './core/manifest';
import {
  CommandRegistry,
  registerCoreCommands,
  registerAdminCommands,
  registerReportCommand,
  type CommandContext,
} from './core/commands';
import { Moderation } from './core/moderation';
import { Admin, ADMIN_COMMANDS } from './core/admin';
import { ResumeStore } from './core/resume';
import { broadcastChat, type ChatMessageBody } from './core/chat';
import { HookBus } from './plugins/loader';
import type { PluginApi } from './plugins/api';
import { MoveBroadcaster, interestFromLimits } from './core/movement';
import { configureAuthority } from './core/authority';
import { Connection, type ServerCtx } from './net/connection';
import { attachWss } from './net/ws';
import { createHttpServer, setTrustCloudflareIp, type HttpRoute } from './net/http';
import { OidcService } from './auth/oidc';
import { IdentityStore, LoginTicketStore, SessionIndex } from './auth/identities';
import { createAuthRoutes } from './auth/routes';
import { ensureVanillaManifest } from './data/vanilla-manifest';
import { Locker, loadVanillaManifest } from './data/locker';
import { lockerStorageFrom, blobRoutes, FsStorage } from './data/fsstorage';
import { mwDataRoutes } from './net/mwdata-routes';
import { createSysInfo } from './net/admin/sysinfo';
/** Just the parts of the storage backend the saves API needs. */
type SaveStorageLike = {
  presignGet(k: string): Promise<string>;
  presignPut(k: string, n: number): Promise<string>;
  objectSize?(k: string): Promise<number | undefined>;
};
import { presentMods, readModDoc, resolveMods } from './core/mods';
import { saveRoutes, eraseSaves } from './data/save-routes';
import { lockerRoutes } from './data/locker-routes';
import { LockerSessionStore, AdminSessionStore } from './auth/identities';
import { IpConnTracker, IpRateLimiter } from './net/ratelimit';
import { disconnectMsg } from './proto/session';
import { log, recentLogs, onLog } from './log';
import { startTestBots } from './dev/testbots';
import { metrics } from './metrics';
import { SimPeerSupervisor } from './core/simpeer';
import { WorldBrowser } from './core/worldbrowser';
import { parseExterior, isChargenCell } from './core/movement';
import { detectGameData, findPeerBinary, gameDataDir, buildPeerCfg, buildPeerSettings, type GameData } from './core/gamedata';

// From package.json, not a literal: the hardcoded copy sat at 1.1.0 while v1.2.0 shipped,
// so a freshly updated server kept reporting itself out of date. One source of truth, and
// the release workflow refuses a tag that does not match it.
export const VERSION: string = (pkg as { version: string }).version;

// Compose extra HTTP route handlers into one: try each in order, first to claim wins.
// createHttpServer/createAuthRoutes take a single `also` hook, and we have two (admin +
// locker), so fold them here rather than threading a list through every caller.
function chainRoutes(...routes: HttpRoute[]): HttpRoute {
  return async (req, res, url) => {
    for (const r of routes) { if (await r(req, res, url)) return true; }
    return false;
  };
}


export interface StartOptions {
  /**
   * In-process callers only (the test suite). false = do not refuse to boot without game
   * data, a peer binary and a server password. NOT a config key and NOT an env var, so a
   * real deployment cannot reach it: production always runs its own simulation or refuses
   * to start. A server built with false has no sim peer, so its cells have no holder.
   */
  requireGameData?: boolean;
  /** Where the served game client lives, for the engine update button. Tests inject a tmp
   *  dir; the docker layout is auto-detected at /client. */
  clientDir?: string;
  dataDir: string;
  port: number;
  host?: string;
  // F1/F3: state that must be the SAME for a player across every world — accounts, SSO
  // identities, friends/party/presence, and bans. Defaults to dataDir, so a single-world
  // self-hoster is completely unaffected and existing data dirs keep working in place.
  // Under the F3 gateway every world is pointed at one shared dir, which is what makes
  // "log in once, see your friends wherever they are, a ban means banned" true.
  //
  // What deliberately does NOT move: cells and custom records stay PER WORLD. Character
  // docs DO live in the shared dir (character slots: one character follows its player
  // across worlds; only positions inside the doc are world-scoped) — the dupe firewall is
  // the public world's economy rules, not per-world inventories.
  sharedDir?: string;
  // World identity/authorization, normally injected by the gateway via OMW_WORLD_* env;
  // options take precedence so tests can run several differently-shaped worlds in one
  // process without fighting over process.env.
  worldId?: string;
  worldMode?: string; // 'private' | 'party'
  worldOwner?: string; // accountKey; '' only on a standalone (non-gateway) stack
  /** Test seam: how long a party world stays open after its owner disconnects. */
  ownerGraceMs?: number;
  configOverride?: DeepPartial<Config>; // tests
}

export interface RunningServer {
  port: number;
  config: Config;
  // The same surface plugins get. Exposed so an embedder (and the test suite) can drive
  // world actions and server-pushed GUI without loading a plugin.
  api: PluginApi;
  /** Account store, so tests can seed players without going through the wire protocol. */
  accounts: AccountStore;
  /** What the content scan decided at boot, including the operator's saved load order. */
  gameData: GameData;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  mkdirSync(opts.dataDir, { recursive: true });
  const sharedDir = opts.sharedDir ?? opts.dataDir;
  if (sharedDir !== opts.dataDir) mkdirSync(sharedDir, { recursive: true });
  // F3: a gateway-spawned world has an empty data dir, so the operator's config + game data
  // both live in the SHARED dir. loadConfig merges shared/config.toml; gamedata is resolved
  // from the shared dir too (below) so 500MB of Morrowind is not copied per world.
  const config = loadConfig(opts.dataDir, opts.configOverride, sharedDir);
  // Deployment property, set once: whether CF-Connecting-IP means anything here. Logged
  // because getting it wrong is silent in both directions — on, and a misconfigured edge lets
  // a client name its own address; off behind Cloudflare, and every player shares the edge's
  // address, which turns per-IP limits back into one global bucket.
  setTrustCloudflareIp(config.limits.trustCloudflareIp);
  log('info', 'net.client_ip_mode', {
    trustCloudflareIp: config.limits.trustCloudflareIp,
    note: config.limits.trustCloudflareIp
      ? 'CF-Connecting-IP trusted from a private peer; the edge MUST strip client copies'
      : 'CF-Connecting-IP ignored; set [limits] trustCloudflareIp when Cloudflare is in front',
  });
  // Read live by core/authority.ts, which WorldState builds without ever seeing the config.
  configureAuthority({
    reviewMs: config.authority.reviewSec * 1000,
    actorSilenceMs: config.authority.actorSilenceSec * 1000,
  });
  const accounts = new AccountStore(sharedDir);
  // Character docs live in the SHARED dir so a character follows its player across worlds;
  // positions inside the doc are scoped by world id. The world's own players/ dir is the
  // pre-slot legacy location, read only during migration.
  const worldId = opts.worldId ?? process.env.OMW_WORLD_ID ?? 'default';
  // Runtime-mutable: a character's Solo world flips to Party IN PLACE (the owner stays put,
  // their world simply starts admitting party members) rather than the owner travelling to a
  // separate party world. Only ever flips between 'private' and 'party'; a public world never
  // flips. See SetWorldMode below and mayJoinWorld.
  // There is no public world. A gateway world boots private (the owner's own game) and the
  // owner flips it to 'party' to admit friends; a standalone stack has no gateway and the
  // account system is its door.
  let worldMode = opts.worldMode ?? process.env.OMW_WORLD_MODE ?? 'private';
  if (worldMode === 'public') {
    // A stale env or config asking for the deleted mode must not quietly become admit-all.
    log('warn', 'world.public_mode_removed', { requested: 'public', using: 'private' });
    worldMode = 'private';
  }
  const worldModeAtBoot = worldMode;

  // Background writes still in flight. close() drains these BEFORE shutting the stores, so a
  // fire-and-forget write can never land on a closed database — which both throws an unhandled
  // rejection and LOSES the write. ChargenComplete is the one that hurts: the flag it sets is
  // what the shared world's "has this character been created" gate reads, so a player who
  // finishes creation exactly as the server restarts is left unable to join the public world
  // with nothing on screen explaining why. Self-pruning, so it cannot grow without bound.
  const inFlight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>): void => {
    inFlight.add(p);
    void p.catch(() => undefined).finally(() => inFlight.delete(p));
  };
  const worldOwner = (opts.worldOwner ?? process.env.OMW_WORLD_OWNER ?? '').toLowerCase();
  // EVERY GATEWAY WORLD HAS AN OWNER. '' used to mean "unowned, therefore public"; that
  // concept is deleted, not re-homed. A gateway world that somehow boots without one fails
  // CLOSED — mayJoinWorld below admits nobody but admins — and this line is how the operator
  // finds out. A standalone stack (no OMW_WORLD_ID) legitimately has no owner: it is the
  // operator's own deployment and the account system is its door.
  if (process.env.OMW_WORLD_ID && worldOwner === '') {
    log('error', 'world.unowned', {
      world: worldId,
      note: 'gateway worlds must carry OMW_WORLD_OWNER; this world will admit only admins',
    });
  }
  const playerStore = new PlayerStore(sharedDir, worldId);
  // Onboarding CRM capture. Env var wins over toml so the key can stay out of config files
  // in deployments; empty = inert.
  const attio = new AttioHook({
    apiKey: process.env.ATTIO_API_KEY ?? config.integrations.attioApiKey,
    baseUrl: config.integrations.attioBaseUrl,
    dataDir: sharedDir,
  });
  const cellStore = new CellStore(opts.dataDir, true);
  const recordStore = new RecordStore(opts.dataDir);
  const bans = new BanStore(sharedDir);
  // Phase B: the identity index must be complete before the listener opens too — a missed
  // (iss,sub) entry would hand a returning player a brand new empty account.
  const identities = new IdentityStore(sharedDir);
  // File-backed on the shared dir: the gateway front door mints the SSO ticket, and THIS
  // (a different world process) must be able to claim it. Same dir = same tickets.
  const tickets = new LoginTicketStore(15 * 60_000, sharedDir);
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
  // Phase 4: scripted-spawn replay + the unstick tool. Built early because both the admin
  // command surface and the connection's cell-entry path need it.
  const questRepair = new QuestRepair({ roster, players: playerStore });
  // Phase 3/4 content classification (quest items, unique actors, notable items). Loaded
  // from the SHARED dir so every world in a deployment classifies identically; missing =
  // vanilla defaults, never a boot failure.
  const contentTable = await ContentTable.load(sharedDir);
  world.setQuestItems(contentTable.questItems);
  world.setEconomyRules({
    uniqueActors: contentTable.uniqueActors,
    noDrop: config.economy.noDrop,
  });
  const startedAt = Date.now();
  // Rates are measured between calls, so this must outlive a single request. The data dir is
  // the disk the operator actually cares about: it holds the game files, the locker and the
  // saves, and it is the one that fills up.
  const sysInfo = createSysInfo(sharedDir);
  // At flush time the store pulls the freshest position from the live session, so pose
  // updates never need to dirty the doc.
  playerStore.setLivePositionProvider((key) => {
    // Store keys are character ids now; a system peer's key is still its accountKey, so
    // check both. Linear scan is fine: called only at flush points, roster is small.
    const p = roster.activeForAccount(key)
      ?? [...roster.inWorld()].find((pl) => pl.charId === key);
    return p?.cellKey && p.pose ? { cellKey: p.cellKey, x: p.pose.x, y: p.pose.y, z: p.pose.z } : undefined;
  });

  // M7 needs the hook bus (map sharing policy) and the bus's api needs M7 (gui/world
  // actions), so the reference is closed over lazily — both are live before any hook or
  // any client frame can run.
  let hooks: HookBus;
  const moderation = new Moderation(sharedDir, config.moderation);
  const admin = new Admin({
    questRepair,
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
    // Owner-only time skip: the one surviving group rule. Your world, your clock — a guest
    // must not fast-forward the host's game. A standalone stack has no owner, so the owner
    // rule there admits anyone (it is the operator's own game).
    maySkipTime: (player) => {
      const policy = config.rules.timeSkip;
      if (policy === 'anyone') return { may: true, why: '' };
      if (policy === 'off') return { may: false, why: 'time does not skip in this world' };
      return worldOwner === '' || player.accountKey === worldOwner
        ? { may: true, why: '' }
        : { may: false, why: 'only the world owner can rest for everyone' };
    },
    // Phase 3.7: a reset hands the restored cell truth straight to whoever is standing
    // there, so it never needs the TES3MP kick-everyone workaround.
    world,
  });
  m7.clock.setTimeScale(config.time.scale); // config is operator truth for the scale

  const api: PluginApi = {
    config,
    log,
    players: () => roster.inWorld().map((p) => ({ id: p.id, name: p.name, rank: p.rank })),
    cellOfPlayer: (playerId) => roster.get(playerId)?.cellKey,
    posOfPlayer: (playerId) => {
      const p = roster.get(playerId);
      if (!p || p.cellKey === undefined || !p.pose) return undefined;
      return { cellKey: p.cellKey, x: p.pose.x, y: p.pose.y, z: p.pose.z };
    },
    chat: (target, msg: ChatMessageBody) => {
      if (target === 'all') broadcastChat(roster, msg);
      else roster.get(target)?.peer.sendEvent('ChatMessage', msg);
    },
    sendEvent: (target, name, body) => {
      if (target === 'all') for (const p of roster.inWorld()) p.peer.sendEvent(name, body);
      else roster.get(target)?.peer.sendEvent(name, body);
      // A RESURRECT IS ALSO THE PEER'S BUSINESS. The respawn plugin addresses the player; the
      // peer's avatar body for that player is still DEAD, and its next bar report (hp 0)
      // re-killed the respawned player every 3 s -- a death loop. Replace the avatar at the
      // respawn point, open the resurrect window, and let the client's restored bars rule
      // until the fresh body's report arrives.
      if (name === 'PlayerResurrect' && typeof target === 'number') {
        const victim = roster.get(target);
        if (victim) {
          victim.resurrectedAt = Date.now();
          victim.peerStatsAt = undefined;
          worldPeerImpl()?.peer.sendEvent('AvatarResurrect', { id: target, ...(body as object) });
        }
      }
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
  // How much scrollback a newcomer is handed. Enough to see what the room is talking about,
  // short enough that a join is not a wall of text.
  // Long enough to cover a host crash or page reload (engine boot is tens of seconds on a
  // cold cache) and short enough that a genuine quit does not strand guests in a dead world.
  const OWNER_DISCONNECT_GRACE_MS = opts.ownerGraceMs ?? 90_000;
  // The whole-world player cap: one world is one peer simulating every occupied cell, so
  // this is a memory decision as much as a policy one (see the scale ramp).
  const MAX_WORLD_PLAYERS = 32;
  const CHAT_HISTORY_KEEP = 200;
  const CHAT_HISTORY_REPLAY = 60;
  const commandCtx: CommandContext = {
    roster,
    // Mutes are enforced at DELIVERY (chat.ts), not in the client: a mute a modified
    // client can ignore is not a mute.
    isMuted: (listener, speaker) => socialRef?.isMuted(listener, speaker) ?? false,
    // The '@' tier is WORLD chat now: the people in your world are your group, no membership
    // list needed. Everyone co-present, yourself included.
    partyOf: (accountKey) => (roster.activeForAccount(accountKey)
      ? roster.humansInWorld().filter((p) => !p.bot).map((p) => p.accountKey)
      : []),
    // Opt-in per deployment: a crowded public world wants proximity say, a co-op session
    // very much does not (friends spread across the map must still be able to talk).
    sayProximity: config.rules.sayScope === 'proximity',
    // SCROLLBACK. Only the channels a newcomer may legitimately replay: 'global' and 'server'
    // are the server-wide conversation, and world chat is scoped to this world's id.
    // 'say' is proximity (replaying a conversation from a cell you were not in is noise),
    // and 'whisper' is nobody else's business.
    history: (player, channel, text) => {
      const scope = channel === 'party' ? (worldId ?? 'default') : '';
      if (channel !== 'global' && channel !== 'server' && channel !== 'party') return;
      socialStore.appendChat({
        ts: Date.now(), channel, scope,
        acct: player.accountKey, name: player.name, text,
      }, CHAT_HISTORY_KEEP);
    },
    onCommand: (player, name, args) => hooks.command({ id: player.id, name: player.name, rank: player.rank }, name, args),
  };

  // Conservation on drop: judge against what the character last declared it holds. Undefined
  // (no doc yet, or nothing declared) means "no basis to judge", never "guilty".
  // QUARANTINE: an account that has declared impossible character state. Character data is
  // client-authored (playerstate.ts) and the server can only detect, not prevent — so bound
  // the blast radius instead: in the SHARED world such an account cannot hand anything to
  // anyone (no drops, no container puts, no PvP). Their own campaign is untouched, because
  // cheating there harms nobody.
  //
  // Movement anomalies are deliberately NOT counted: those fire on a stalled connection
  // delivering a batch late, and punishing bad wifi is not the goal.
  // NOT unowned_drop. ObjectSpawnRequest is the generic "place an object", not "drop from
  // inventory" — scripts legitimately place things nobody carries (s31 spawns a CHEST). That
  // signal is worth recording but it is NOT evidence of a declared-state cheat, and using it
  // here would quarantine honest players through the same false positive that forced the
  // earlier drop-enforcement backout. Re-add it once the protocol distinguishes the two.
  const DECLARED_STATE_ANOMALIES = ['inventory_stack', 'inventory_breadth', 'level_jump'];
  const isQuarantined = (accountKey: string): boolean => {
    const seen = moderation.anomaliesFor(accountKey);
    return DECLARED_STATE_ANOMALIES.some((k) => (seen[k] ?? 0) > 0);
  };
  world.setQuarantineCheck(isQuarantined);
  world.setDropEnforcement(config.economy.refuseUnownedDrops);

  world.setInventoryOracle((player, recordId) => {
    const inv = playerStore.getCached(player.charId)?.inventory;
    if (!inv) return undefined; // no doc to judge by: never treated as guilt
    const declared = inv.find((i) => i.id === recordId)?.n ?? 0;
    // ...plus anything acquired since that snapshot was taken. Without this the count is
    // stale by up to the 2 s inventory diff, which is exactly long enough for "pick up, drop"
    // to look like a drop of something you never had.
    return declared + (player.pendingAcquired?.get(recordId) ?? 0);
  });
  world.setInventoryDebit((player, recordId, count) => {
    const led = player.pendingAcquired;
    const have = led?.get(recordId);
    if (led === undefined || have === undefined) return;
    const left = have - count;
    if (left > 0) led.set(recordId, left);
    else led.delete(recordId);
  });
  world.setModerationNote((accountKey, kind) => moderation.noteAnomaly(accountKey, kind));

  // Close this world to everyone who is not its owner: tell each guest to go home (their
  // client knows its own world and dials it), then drop anyone still here after a grace. The
  // grace is for the trip to happen cleanly, not for them to keep playing.
  //
  // NEVER THE SIM PEER. "Guests" means people; the peer is this world's own simulator, and
  // evicting it threw away authority over every cell the owner was standing in — so going
  // Solo froze the NPCs and rubber-banded the player when it came back. It is not in the
  // party, so no door is being closed on it.
  const closeToGuests = (reason: string): void => {
    for (const conn of [...connections]) {
      const p = conn.player;
      if (!p || p.accountKey === worldOwner || p.rank >= 1) continue;
      if (p.system === true) continue;
      // The owner's CHARACTER name, off the live roster — never the account display name,
      // which carries the signed-in person's real name.
      p.peer.sendEvent('WorldClosed',
        { reason, by: roster.activeForAccount(worldOwner)?.name ?? '' });
      const t = setTimeout(() => {
        if (connections.has(conn)) conn.disconnect('KICKED', 'this world is no longer open to your party');
      }, 5000);
      t.unref();
    }
  };

  // THE world peer, one resolver for every caller (input, avatar batches, bar/item reports,
  // AvatarState, PvP, anchors/authority). Assigned once simPeers exists (below); until then
  // it answers undefined. The supervisor's own spawn wins; else the LOWEST-id system peer --
  // stable across roster order, so two system peers cannot each be "the" peer to different
  // sites (that split brain sent input to one and authority to the other).
  let worldPeerImpl: () => Player | undefined = () => undefined;
  const stateCtx: StateCtx = {
    worldPeer: () => worldPeerImpl(),
    roster,
    store: playerStore,
    // Chargen named the character: put that name on the slot, replacing the placeholder the
    // slot was auto-created with. Only ever an upgrade — a slot the player already named is
    // left alone.
    // Same sink the movement envelope feeds: anomalies are what moderation acts on.
    noteAnomaly: (accountKey, kind) => moderation.noteAnomaly(accountKey, kind),
    onCharacterNamed: (player, name) => {
      // TRACKED: this writes the name the player typed in chargen onto their slot. Untracked,
      // a shutdown landing between the read and the write both loses the name and throws from
      // a detached promise onto a closed database — the same shape as the ChargenComplete bug.
      track(accounts.get(player.accountKey).then((account) => {
        if (account) accounts.nameCharacter(account, player.charId, name);
      }));
    },
    onPlayerDeath: (player) => {
      log('info', 'player.death', { id: player.id, name: player.name });
      hooks.playerDeath({ id: player.id, name: player.name, rank: player.rank });
    },
  };

  const combat = new Combat({
    roster,
    worldPeer: () => worldPeerImpl(),
    maxHitDamage: config.limits.maxHitDamage,
    holderOf: (cellKey) => world.holderOf(cellKey),
    epochOf: (cellKey) => world.epochOf(cellKey),
    allowPlayerHit: (attacker, victimId, name) =>
      hooks.playerHit({ id: attacker.id, name: attacker.name, rank: attacker.rank }, victimId, name),
  });

  // Deliver swings that were parked while a cell had no simulator (combat.ts `hold`). Wired
  // here because the world is built before the combat relay and neither should import the other.
  world.onHolderGained = (cellKey) => combat.flushCell(cellKey);

  const quests = new Quests({
    roster,
    cells: cellStore,
    players: playerStore,
    isShared: (family) => hooks.shareFamily(family),
    regressAllowed: (questId) => hooks.journalRegress(questId),
    // Where a journal advance is persisted: the world owner's character (guests keep loot,
    // not quests), or the player's own on a standalone stack with no owner.
    journalTarget: (player) =>
      (worldOwner !== '' ? roster.activeForAccount(worldOwner)?.charId : player.charId),
    ownerCharId: () => (worldOwner === '' ? undefined : roster.activeForAccount(worldOwner)?.charId),
    worldGlobals: config.sharing.worldGlobals,
    worldPeer: () => worldPeerImpl(),
  });

  // Phase C. The store is opened here so its lifetime matches the server's; social.stop()
  // clears presence timers that would otherwise keep the process alive on shutdown.
  // Phase 3.5 storage locker. S3 creds from env; disabled (inert) when no endpoint/keys.
  // The origin a browser reaches this server on, which used to be its own settings field.
  // The operator answered it in the wizard: the domain there is what the proxy config was
  // generated from and what the certificate was issued for, so restating it under another
  // name was a second chance to get it wrong, silently — a bad value mints upload and
  // savegame URLs the browser cannot reach, and nothing reports that until a transfer fails.
  // An explicit [locker].publicBase still wins inside lockerStorageFrom, so a hand-tuned
  // deployment behind an unusual proxy is unaffected.
  const lockerBase = config.setup.domain
    ? `https://${config.setup.domain}`
    : `http://127.0.0.1:${opts.port}`;
  const lockerStorage = lockerStorageFrom(config.locker, sharedDir, lockerBase);
  const locker = new Locker({
    dataDir: sharedDir,
    maxBytesPerAccount: config.locker.maxBytesPerAccount,
    storage: lockerStorage,
  });
  // The files the locker will accept: retail Morrowind by sha256, derived from the operator's
  // own game data when they have not supplied a manifest. The asset pack is a BSA served by
  // us, not uploaded, so it is not in this set.
  //
  // Both this process and the front door do this, and both must: whichever starts first
  // generates and the other reads the file (the check is a cheap access()). Wiring only one
  // of them left a world process configured with vanilla:0 whenever it won the race, which
  // refuses every upload while the front door looks correctly configured.
  await ensureVanillaManifest(sharedDir, gameDataDir(sharedDir));
  locker.configureAccepted(await loadVanillaManifest(sharedDir), [], {
    acceptByNameAndSize: config.locker.acceptByNameAndSize,
  });
  const lockerSessions = new LockerSessionStore();
  const adminSessions = new AdminSessionStore();
  // Claiming the first administrator account needs proof of access to this machine. Armed
  // only while nobody holds the dashboard owner role; see setup-token.ts for why account
  // state alone was not a safe gate.
  const setupToken = new SetupToken(opts.dataDir);
  if (!accounts.hasDashboardOwner()) setupToken.arm();
  const resetTokens = new ResetTokens();
  // Operational alerts ride the log stream the server already writes, filtered by the
  // operator's [notifications].events list. Nothing is sent unless they configured it.
  const unhookNotifier = onLog((entry) => {
    const { ts, level, event, ...fields } = entry;
    if (event.startsWith('notify.')) return; // never report on the reporter
    notifyEvent({
      ...mailCfg(),
      to: config.notifications.to,
      webhookUrl: config.notifications.webhookUrl,
      events: config.notifications.events,
    }, event, fields);
  });

  // Logged AFTER the notifier is wired up, deliberately: a dashboard-written config that
  // failed to load means the settings an operator saved are silently not in effect, which
  // is precisely the thing they must not discover by accident. Emitting it before the
  // subscriber existed would have made it the one event that never notifies anyone.
  if (config.dashboardFallback) {
    log('error', 'admin.config_fallback', {
      usedInstead: config.dashboardFallback,
      note: 'settings saved in the dashboard did not load; an earlier version was used. '
        + 'Review Settings and save again.',
    });
  }
  const mailCfg = (): MailConfig => ({
    host: config.notifications.smtpHost,
    port: config.notifications.smtpPort,
    user: config.notifications.smtpUser,
    pass: config.notifications.smtpPass,
    from: config.notifications.from,
  });
  // Maintenance mode: set from the dashboard, read by the connection path. PERSISTED to a
  // marker file, because its stated use case is "turn it on, change settings, restart" —
  // and every settings change ends in a restart. In-memory it silently switched itself off
  // at exactly that restart and readmitted players into the half-edited server, which is
  // the one thing it exists to prevent. The dashboard's own toggle is how it comes off.
  // The reverse proxy's config, regenerated from the current answers on every boot. Written
  // here rather than only when the wizard saves, so a data directory restored from a backup,
  // or one whose file was deleted, comes back with a working proxy instead of needing the
  // wizard re-run. No-ops when the content already matches.
  writeCaddyfile(opts.dataDir, {
    domain: config.setup.domain,
    launcher: launcherEnabled(),
    internal: config.setup.hosting === 'internal',
    port: config.setup.httpPort,
  });

  const maintenanceFile = join(opts.dataDir, 'maintenance');
  const maintenance = { on: false, message: '' };
  try {
    const saved = JSON.parse(readFileSync(maintenanceFile, 'utf8')) as { on?: boolean; message?: string };
    maintenance.on = saved.on === true;
    maintenance.message = String(saved.message ?? '');
    if (maintenance.on) log('warn', 'server.maintenance_restored', { message: maintenance.message });
  } catch { /* no marker: not in maintenance, the common case */ }
  let socialRef: Social | undefined; // read by mute checks and presence (built above)
  // Armed when the owner of a party world disconnects; cleared on close(). See onPlayerLeftWorld.
  let ownerGraceTimer: NodeJS.Timeout | undefined;
  const socialStore = new SocialStore(sharedDir);
  const social = new Social({
    store: socialStore,
    roster,
    worldId: worldId ?? 'default',
    // The USERNAME is the public handle (accounts.ts: "shown everywhere in-game — nametags,
    // chat, friends, admin views"). account.name is the LOGIN IDENTIFIER, and for an SSO
    // account it is the provider's name claim, i.e. the person's real name. Every social
    // surface — party rows, friend rows, transition notices — reads this one resolver, so
    // returning account.name here put real names on all of them at once.
    // [login] requireProfile is off by default, so a username is not guaranteed. The fallback
    // is the CHARACTER name, never account.name — a missing handle is a cosmetic gap, the
    // login identifier is a privacy leak. Turn requireProfile on and the fallback goes unused.
    displayName: (acct) => accounts.cachedByKey(acct)?.username ?? roster.activeForAccount(acct)?.name,
    // Resolution must accept what players SEE, which is now the username.
    resolveName: (name) => accounts.keyForUsername(name) ?? (accounts.existsNow(name) ? name.toLowerCase() : undefined),
    now: () => Date.now(),
    // A4/3.8: the context-menu report writes to the same queue as /report.
    report: (doc) => moderation.reports.write({
      ts: new Date().toISOString(),
      reporter: doc.reporter,
      target: doc.target,
      reason: doc.voice ? `[voice] ${doc.reason}` : doc.reason,
      // The lines immediately before the report: without them a moderator reading the
      // queue has an accusation and nothing to weigh it against.
      context: moderation.chat.context(),
    }),
    // F3: only when a gateway is configured. Without one the Worlds tab reports that this
    // is a standalone world, which is an honest answer and a valid setup.
    ...(config.gateway.url
      ? { worlds: new WorldBrowser({ gatewayUrl: config.gateway.url,
          serverToken: config.gateway.serverToken, ownPort: () => port }) }
      : {}),
  });
  socialRef = social;

  const contentGate = new ContentGate(config.content.enforce);
  // Approved cosmetic mods (meshes/textures) may differ between players; record-bearing

  const ctx: ServerCtx = {
    worldPeer: () => worldPeerImpl(),
    config,
    accounts,
    roster,
    content: contentGate,
    engine: new EngineGate(config.engine.enforce, config.engine.pin),
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
    track,
    sessions,
    attio,
    // Phase 4: one-shot scripted encounters replayed for a character who was not there.
    questSpawnsOnEntry: (player, cellKey) => questRepair.onCellEntry(player, cellKey),
    questRepair,
    // THE AUTHORIZATION. The friends list is the only door into somebody's world: Solo
    // (private) admits nobody, Party admits the owner's FRIENDS up to the whole-world cap.
    // Admins always (moderation must be able to enter anywhere). A standalone stack has no
    // owner and admits its own accounts; an unowned GATEWAY world fails closed.
    mayJoinWorld: (accountKey: string, rank: number): boolean => {
      if (rank >= 1) return true;
      if (worldOwner === '') return !process.env.OMW_WORLD_ID;
      if (accountKey === worldOwner) return true;
      if (worldMode !== 'party') return false;
      if (!socialStore.areFriends(worldOwner, accountKey)) return false;
      // humanCount, not humansInWorld(): authed players still loading count too, or ten
      // friends dialling in the same second all pass a cap none has crossed yet.
      return roster.humanCount < MAX_WORLD_PLAYERS;
    },
    // A world that empties reverts to how it booted. Without this, flipping your world to
    // party once left it party FOREVER: the gateway reuses a running world as-is, so the next
    // session silently rejoined a joinable world instead of the solo one it asked for.
    onWorldEmpty: () => {
      if (worldMode !== worldModeAtBoot) {
        log('info', 'world.mode_reverted', { from: worldMode, to: worldModeAtBoot });
        worldMode = worldModeAtBoot;
      }
    },
    // Owner-only: flip this world between private (solo) and party (joinable by the owner's
    // party) without respawning it. Admins may flip too. Public worlds never flip.
    worldId,
    worldMode: (): string => worldMode,
    setWorldMode: (accountKey: string, rank: number, mode: string): 'ok' | 'not_owner' | 'bad_mode' | 'not_flippable' => {
      if (rank < 1 && accountKey !== worldOwner) return 'not_owner';
      if (mode !== 'private' && mode !== 'party') return 'bad_mode';
      worldMode = mode;
      log('info', 'world.mode_flip', { world: worldId, owner: worldOwner, mode });
      // The UI must never GUESS which world it is in. It used to render Solo/Party/Public from
      // a localStorage note of what the player last clicked, which survived reloads and
      // reconnects and so could claim you were somewhere you were not. The server owns this.
      for (const conn of connections) conn.player?.peer.sendEvent('WorldMode', { mode });
      // mayJoinWorld only gates ARRIVAL. Flipping back to Solo therefore closed the door
      // while leaving every guest standing inside. Closing means closing: tell each guest
      // to go home (their client knows its own world and dials it), then drop anyone still
      // here. The grace is for the switch to happen cleanly, not for them to keep playing.
      if (mode === 'private') closeToGuests('owner_went_solo');
      return 'ok';
    },
    // A guest world with no host is nobody's world. Called when a player leaves; acts only if
    // that player was the owner.
    wrongWorldForCharacter: (accountKey: string, charId: string): boolean => {
      // Only gateway-spawned character worlds have the suffix contract; standalone servers
      // and GUESTS (who bring their own characters into a host's world by design) are
      // exempt. The owner's own character must match the world made for it.
      if (!process.env.OMW_WORLD_ID) return false;
      if (accountKey !== worldOwner) return false;
      const m = /-([0-9a-f]{8})$/.exec(worldId);
      return m !== null && !charId.endsWith(m[1]!);
    },
    // Scrollback on arrival: the server-wide conversation, plus this player's own party.
    // Ordinary ChatMessage events in the order they were said, so the client needs no new
    // handling — history is the same messages, earlier.
    replayChat: (player): void => {
      const lines = [
        ...socialStore.recentChat('', CHAT_HISTORY_REPLAY),
        ...socialStore.recentChat(worldId ?? 'default', CHAT_HISTORY_REPLAY),
      ].sort((a, b) => a.ts - b.ts);
      for (const l of lines) {
        // A listener who muted the speaker never received the line live, and must not get it
        // through the back door on their next join. The same is true of a BLOCK, which is the
        // stronger control and was not applied here at all — a blocked player's lines came
        // back on every join.
        if (l.acct !== player.accountKey
          && (socialRef?.isMuted(player.accountKey, l.acct)
            || socialStore.blockedEitherWay(player.accountKey, l.acct))) continue;
        player.peer.sendEvent('ChatMessage', {
          channel: l.channel as 'global' | 'server' | 'party',
          ...(l.channel === 'server' ? {} : { from: l.name }),
          text: l.text,
        });
      }
    },
    onPlayerLeftWorld: (accountKey: string): void => {
      // Only OUR row: a player who moved to another world has already written a row naming
      // that world, and deleting theirs from the world they left would blink them offline.
      socialStore.clearPresence(accountKey, worldId ?? 'default', Date.now());
      if (worldOwner === '' || accountKey !== worldOwner) return;
      if (worldMode !== 'party') return;
      // GRACE, THEN CLOSE. A host who crashes or reloads should come back to their guests,
      // not to an empty world — so guests keep playing through the window and the world
      // closes only if the owner does not return. The timer re-checks the roster on expiry,
      // which is what makes a rejoin cancel the close without needing a rejoin hook.
      log('info', 'world.owner_left', { world: worldId, owner: worldOwner, graceMs: OWNER_DISCONNECT_GRACE_MS });
      broadcastChat(roster, {
        channel: 'server',
        text: 'the host has disconnected — the world stays open a moment for them to return',
      });
      if (ownerGraceTimer) clearTimeout(ownerGraceTimer);
      ownerGraceTimer = setTimeout(() => {
        ownerGraceTimer = undefined;
        if (roster.activeForAccount(worldOwner)) return; // the host is back; nothing closes
        log('info', 'world.owner_gone', { world: worldId, owner: worldOwner });
        worldMode = 'private';
        for (const conn of connections) conn.player?.peer.sendEvent('WorldMode', { mode: 'private' });
        closeToGuests('owner_left');
      }, OWNER_DISCONNECT_GRACE_MS);
      ownerGraceTimer.unref();
    },
    // Spawn-near-leader: when a NON-owner freshly joins a party world (a friend/party member
    // dialling in — never the owner, never a resume-in-place), place them at the owner's live
    // position so they land next to the leader rather than at some default corner. Returns null
    // when it should not apply (not party, is the owner, owner not present/located yet).
    guestSpawn: (accountKey: string): { cellKey: string; x: number; y: number; z: number } | null => {
      if (worldMode !== 'party' || worldOwner === '' || accountKey === worldOwner) return null;
      const owner = roster.activeForAccount(worldOwner);
      if (!owner || !owner.cellKey || !owner.pose) return null;
      return { cellKey: owner.cellKey, x: owner.pose.x, y: owner.pose.y, z: owner.pose.z };
    },
    // Chargen gate only when this world is spawned by a gateway (OMW_WORLD_ID set) and is not
    // the private world at boot — a standalone server has no other world to create the
    // character in, and a later flip to party must not retroactively force chargen on members.
    chargenGate: !!process.env.OMW_WORLD_ID && worldModeAtBoot !== 'private',
    motd: () => motd,
  };

  // The web dashboard. Its three original endpoints keep their exact shapes (scripts point
  // at them); everything else is new surface gated on account roles rather than the shared
  // token, which now survives only as an automation credential.
  const adminRoutes = adminDashboardRoutes({
    dataDir: opts.dataDir,
    sharedDir,
    config: () => config,
    accounts,
    sessions: adminSessions,
    loginLimiter: new IpRateLimiter(config.limits.loginPerMinPerIp),
    // A valid session is still bounded. Generous enough that a person clicking around never
    // notices, tight enough that a stolen token cannot be used to hammer /console.
    apiLimiter: new IpRateLimiter(600),
    sharedToken: config.admin.dashboardToken,
    setupToken,
    gameDataDir: gameDataDir(sharedDir),
    version: VERSION,

    runCommand: async (actor, line) => {
      const parts = line.replace(/^\//, '').trim().split(/\s+/);
      const cmd = (parts.shift() ?? '').toLowerCase();
      // A synthetic actor: the dashboard operator is not standing in the world, so they get
      // a Player shaped just enough for the command table to rank-check and name them in the
      // audit line. Commands that move the actor's own body (/tp, /tpto) are refused rather
      // than given a fake position — see commandCatalog's inGameOnly below.
      const online = roster.activeForAccount(actor.accountKey);
      const synthetic = online ?? ({
        id: -1,
        name: actor.name,
        accountKey: actor.accountKey,
        charId: actor.accountKey,
        rank: actor.rank,
        ip: '(dashboard)',
        inWorld: false,
        moveSeq: 0,
        poseVersion: 0,
        peer: { disconnect: () => {}, send: () => {} },
      } as unknown as Player);
      if (!online && (cmd === 'tp' || cmd === 'tpto')) {
        return { ok: false, message: `/${cmd} moves you, so it only works while you are in the world.` };
      }
      const message = await admin.exec(synthetic, cmd, parts);
      log('info', 'admin.console', { by: actor.accountKey, cmd });
      return { ok: true, message };
    },
    commandCatalog: () => Object.entries(ADMIN_COMMANDS).map(([name, spec]) => ({
      name,
      usage: spec.usage,
      help: spec.help,
      minRank: spec.minRank,
      ...(name === 'tp' || name === 'tpto' ? { inGameOnly: true } : {}),
    })),

    recentLogs: (limit, filter) => recentLogs(limit, filter),
    metricsSnapshot: () => summariseMetrics(),

    // The game client bundle, when this deployment mounts it (docker-compose mounts
    // ./play at /client). Absent on other layouts, and the update routes say so honestly.
    clientDir: opts.clientDir ?? (existsSync('/client') ? '/client' : undefined),
    maintenance: {
      get: () => ({ on: maintenance.on, message: maintenance.message }),
      set: (on, message) => {
        maintenance.on = on;
        maintenance.message = message;
        try {
          if (on) writeFileSync(maintenanceFile, JSON.stringify({ on, message }));
          else rmSync(maintenanceFile, { force: true });
        } catch (e) {
          // A read-only data dir: the switch still works for this process's lifetime.
          log('warn', 'server.maintenance_persist_failed', { error: String(e) });
        }
        if (on) {
          for (const p of roster.humansInWorld()) {
            p.peer.disconnect('SHUTDOWN', message || 'server is going into maintenance');
          }
        }
      },
    },
    restart: (reason) => {
      log('warn', 'server.restart_requested', { reason });
      // The SAME graceful path SIGTERM already takes — connections closed, stores flushed —
      // rather than a second shutdown implementation that would drift from it. Docker's
      // restart policy brings the process back with whatever was just saved.
      process.kill(process.pid, 'SIGTERM');
    },
    exportData: async (res) => exportDataDir(opts.dataDir, res),

    // Savegames for the dashboard. Same storage and same shared dir the player path uses, so
    // an imported save is indistinguishable from one the game uploaded.
    saveStorage: () => (lockerStorage as SaveStorageLike | undefined),
    maxSaveBytesPerAccount: config.locker.maxSaveBytesPerAccount,

    mailConfigured: () => config.notifications.smtpHost !== '',
    sendPasswordReset: async (name) => {
      // Every failure path here is silent BY DESIGN. The endpoint answers identically
      // whether the account exists, has no address, or has no dashboard access, because a
      // difference in any of those is an account-and-email enumeration oracle. The operator
      // who typed their own name knows which it was; an attacker learns nothing.
      try {
        const account = await accounts.get(name);
        if (!account?.email || !account.dashboardRole) return;
        const token = resetTokens.mint(name.toLowerCase());
        const base = config.locker.publicBase || `http://127.0.0.1:${port}`;
        await sendMail(mailCfg(), account.email,
          'Reset your openmw-mp admin password',
          [
            `Someone asked to reset the password for "${account.name}" on ${config.server.name}.`,
            '',
            'Open this link to choose a new one. It works once and expires in 30 minutes:',
            `${base}/admin#reset=${token}`,
            '',
            'If this was not you, nothing has changed and you can ignore this message.',
          ].join('\n'));
        log('info', 'admin.reset_sent', { account: name.toLowerCase() });
      } catch (err) {
        log('warn', 'admin.reset_send_failed', { error: String(err) });
      }
    },
    applyPasswordReset: async (token, password) => {
      const accountKey = resetTokens.consume(token);
      if (!accountKey) return { ok: false, message: 'that link has expired or was already used' };
      const weak = passwordProblem(password, accountKey);
      if (weak) return { ok: false, message: `password ${weak}` };
      if (!await accounts.setPassword(accountKey, password)) {
        return { ok: false, message: 'account not found' };
      }
      // Any session opened with the old password is no longer the person's session as far
      // as we can tell, so end all of them.
      adminSessions.revokeAccount(accountKey);
      await accounts.flush();
      log('warn', 'admin.password_reset', { account: accountKey });
      return { ok: true, message: 'password changed — sign in with it now' };
    },
    deleteAccount: async (key) => {
      // Erasure was written to run offline against a quiet data dir. Live, the risk is the
      // account store's write-behind flushing a cached copy back after the delete, so: cut
      // the session, drain the queue, and only then erase.
      roster.activeForAccount(key)?.peer.disconnect('KICKED', 'account erased');
      await accounts.flush();
      const report = await deleteAccount(opts.dataDir, key);
      if (!report.account && !report.player) {
        return { ok: false, message: 'nothing found under that name' };
      }
      return {
        ok: true,
        message: `erased ${key}: account=${report.account} character=${report.player} ` +
          `bans=${report.bans} identities=${report.identities}`,
      };
    },

    overview: async () => ({
      world: { id: worldId, mode: worldMode },
      maxPlayers: config.server.maxPlayers,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      system: await sysInfo(),
      // SINGLE PLAYER HAS PLAYERS TOO, they just never join a world: the browser runs the
      // engine and only ever talks to the locker. `players` below is the WS roster, so it is
      // permanently empty in that mode and the dashboard reported "0 in the world" to an
      // operator who was playing at that moment. Five minutes is a compromise between the
      // save mirror's own cadence and not showing somebody who has closed the tab.
      playing: lockerSessions.activeSince(5 * 60 * 1000),
      players: roster.humansInWorld().map((p) => ({
        id: p.id,
        name: p.name,
        account: p.accountKey,
        cellKey: p.cellKey ?? null,
        rank: p.rank,
        anomalies: moderation.anomaliesFor(p.accountKey),
      })),
    }),
    reports: async (limit) => ({
      reports: (await moderation.reports.list(Math.min(Math.max(1, limit || 20), 100))).map(({ doc }) => ({
        ts: doc.ts,
        reporter: doc.reporter.name,
        target: doc.target.name,
        reason: doc.reason,
      })),
    }),
    action: async (kind, target, detail) => {
      const online = target === '' ? undefined : roster.activeForAccount(target.toLowerCase());
      switch (kind) {
        case 'kick':
          if (!online) return { ok: false, message: `${target} is not online` };
          online.peer.disconnect('KICKED', detail || 'kicked by a moderator');
          return { ok: true, message: `kicked ${target}` };
        case 'ban':
          bans.banAccount(target, 'dashboard', detail || 'banned by a moderator');
          online?.peer.disconnect('BANNED', detail || 'banned by a moderator');
          return { ok: true, message: `banned ${target}` };
        case 'unban':
          return { ok: bans.unbanAccount(target), message: `unban ${target}` };
        case 'mute':
        case 'unmute': {
          // Server-side mute rides the same account-level list the voice/chat client
          // controls use, so a moderator mute and a player mute mean the same thing.
          socialRef?.setServerMuted(target.toLowerCase(), kind === 'mute');
          return { ok: true, message: `${kind}d ${target}` };
        }
        case 'broadcast':
          if (detail === '') return { ok: false, message: 'nothing to say' };
          broadcastChat(roster, { channel: 'server', text: detail });
          return { ok: true, message: 'broadcast sent' };
        case 'resetCell':
          await m7.resetCellNow(target);
          return { ok: true, message: `reset ${target}` };
        default:
          return { ok: false, message: `unknown action ${kind}` };
      }
    },
  });

  const httpServer = createHttpServer(() => ({
    name: config.server.name,
    motd,
    contentPolicy: config.content.enforce,
    enginePolicy: config.engine.enforce,
    // ALWAYS FALSE, and the field is kept only because launchers read it.
    //
    // This used to be `config.server.password !== ''`, which was already misleading and
    // became actively wrong once that value started generating itself: [server].password is
    // exclusively the sim peer's credential and is never checked against a player (see
    // checkAuthGate in net/connection.ts, which says so at length). Reporting true made a
    // launcher prompt for a join password that nothing would ever verify — a door with no
    // lock and no handle. There is no player-facing server password in this protocol.
    requiresPassword: false,
    allowsRegistration: config.login.allowRegistration && config.login.inviteCode === '',
    playerCount: roster.humansInWorld().length,
    connectedCount: roster.humanCount, // F3: keeps a world alive while a player is loading / at chargen
    // Live, not configured: the supervisor's own count of running engines. One peer carries
    // the whole world now, so this is normally 0 or 1; the gateway's governor still reads it.
    peerCount: simPeers.running,
    pvp: config.rules.pvp,
    players: roster.humansInWorld().map((p) => ({
      id: p.id,
      name: p.name,
      cellKey: p.cellKey ?? null,
      ...(playerStore.getCached(p.charId)?.stats?.level !== undefined
        ? { level: playerStore.getCached(p.charId)!.stats!.level }
        : {}),
    })),
    maxPlayers: config.server.maxPlayers,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    version: VERSION,
  }), config.metrics, createAuthRoutes({
    config,
    oidc,
    identities,
    adminSessions, // return=admin SSO flows mint dashboard sessions from the same store

    tickets,
    sessions,
    lockerSessions,
    accounts,
    bans,
    // SSO round trips draw from the same per-IP auth budget as Register/Login: one
    // attacker should not get a second, separate allowance by using the HTTP door.
    limiter: new IpRateLimiter(config.limits.loginPerMinPerIp),
  }, chainRoutes(
    adminRoutes,
    // Before the locker: blob URLs carry their capability in the path, not a Bearer header.
    blobRoutes(lockerStorage instanceof FsStorage ? lockerStorage : undefined),
    // "This server hands out the files" — the wizard's other delivery answer. Reads the
    // stored answer per request, so switching it off in the dashboard stops the serving
    // without a restart.
    mwDataRoutes({
      gameDataDir: gameDataDir(sharedDir),
      deliveryModel: () => config.setup.deliveryModel,
      // Re-read per request, like the delivery answer above: enabling a mod in the dashboard
      // should reach the next player to load the page, not the next restart.
      modDoc: () => presentMods(gameDataDir(sharedDir), readModDoc(opts.dataDir)),
    }),
    saveRoutes({
      storage: lockerStorage, sessions: lockerSessions, dataDir: sharedDir,
      maxBytesPerAccount: config.locker.maxSaveBytesPerAccount,
    }),
    lockerRoutes({
      locker, sessions: lockerSessions,
      eraseSaves: (acct) => eraseSaves(sharedDir, acct, lockerStorage),
    }),
  )), () => (setupMode ? blockers : []));
  // Derived at scrape time from the roster, so no teardown path can strand the gauge.
  // humansInWorld, not inWorld: the sim peer is infrastructure. Counting it here would make
  // every world look like it has a player in it — the reason maxPlayers and the roster exclude
  // it too — and an operator reading this gauge for capacity would be reading one peer per
  // cluster as load.
  const unhookGauge = metrics.sessionsInWorld.addCollector(() => roster.humansInWorld().length);

  // Phase H4: the on-demand simulation peer. Wired at ONE point rather than hooked into
  // join/leave in connection.ts, because ensure()/markIdle() are idempotent by design and a
  // periodic observation of the roster cannot drift out of sync with it the way paired
  // hooks can (a missed leave would strand a peer forever — exactly the leak the reaper
  // exists to prevent). Disabled by default; see [simPeer] in config.default.toml.
  // Tier detection. The peer's manifest becomes the world's canonical content list once it
  // connects (see connection.ts handleHello) — the server cannot DERIVE that list, because a
  // real client's includes engine-resource entries (builtin.omwscripts, *.omwgame) that no
  // data folder contains.
  // The operator's saved load order, if the dashboard's mod manager has ever written one.
  const gameData = detectGameData(gameDataDir(sharedDir), orderedContent(gameDataDir(sharedDir), opts.dataDir));
  log('info', 'gamedata.detect', { ok: gameData.ok, reason: gameData.reason });

  // THE SIM PEER IS NOT OPTIONAL. There is exactly one mode: the server runs its own headless
  // engine, and that engine is the only thing allowed to simulate NPCs. What used to be "tier
  // 1" — no game data, NPCs simulated by whichever player's browser was nearest — is gone,
  // because a player's machine authoring NPC state for everyone else is precisely the thing
  // server authority exists to prevent. Without a peer, cells have no eligible holder at all
  // and NPCs never move for anyone, so booting in that state would be shipping a broken world
  // that reports itself healthy. Refuse instead, and say exactly which piece is missing.
  // opts.requireGameData is a CODE-level seam for in-process callers (the test suite builds
  // dozens of servers and cannot ship 500MB of retail data). Deliberately not a config key and
  // not an env var: an operator cannot reach it, so a real deployment can never opt out of
  // running its own simulation. This is not tier 1 returning through the back door — a server
  // built this way has no peer, so its cells simply have no holder.
  //
  // SETUP MODE, and why it replaces refusing to boot.
  //
  // The rule above is right about the danger: a server with no peer must never look like a
  // working world. It was wrong about the remedy. Dying at startup puts the problem and the
  // only page that explains it behind the same door — a fresh `docker compose up` exits
  // before serving anything, and an operator who finishes the setup wizard and presses
  // Restart gets a container that crash-loops with the dashboard gone. Both observed.
  //
  // Setup mode keeps the safety property and drops the self-lockout. When the world cannot
  // be simulated the server comes up, serves ONLY the admin surface, refuses every game
  // connection with the reason, logs it at error level, and reports itself UNHEALTHY so a
  // healthcheck or a monitor still sees a broken server. Nothing about it claims to be a
  // working world; it is a wrench you can reach, instead of a locked door.
  //
  // Note this is no longer conditional on whether setup has happened. Tying it to "no owner
  // yet" meant completing the wizard armed the crash-loop for the very next restart, which
  // is the worst possible moment. requireGameData:false remains the code-level seam the test
  // suite uses; an operator still cannot reach it.
  config.simPeer.binary = findPeerBinary(config.simPeer.binary);
  const blockers: string[] = [];
  if (!gameData.ok) {
    blockers.push(`${gameData.reason} — copy your Morrowind Data Files (Morrowind.esm and `
      + 'Morrowind.bsa at minimum) into the game data folder');
  }
  if (!config.simPeer.binary) {
    blockers.push('no headless openmw binary found: set [simPeer].binary, or use an image '
      + 'that includes one. The server simulates NPCs itself and cannot without it');
  }
  if (config.server.password === '') {
    blockers.push('[server].password is empty — the sim peer authenticates with it, and an '
      + 'empty one refuses every peer');
  }
  // SINGLE PLAYER DOES NOT SIMULATE ANYTHING HERE, so none of the above applies to it.
  //
  // The two modes are genuinely different products sharing a server. In multiplayer this
  // process owns the world and runs a headless OpenMW to move every NPC, so no game data
  // means no world and the blockers above are exactly right. Single player is the launcher's
  // "cloud locker": the engine runs in the player's own browser against their own uploaded
  // files, and this server holds accounts, that library and their saves. It has no world to
  // simulate, so demanding a sim peer and a server-side copy of Morrowind put a perfectly
  // healthy locker into setup mode, refusing the player it was set up for and reporting
  // itself unhealthy for a job it was never asked to do.
  //
  // Read from the wizard's stored answer, which until now nothing outside the dashboard UI
  // ever consulted. Absent (an upgrade, or setup never finished) means multiplayer, so an
  // existing deployment keeps every guard it had.
  const singlePlayerOnly = config.setup.deploymentMode === 'single';
  if (singlePlayerOnly && blockers.length > 0) {
    log('info', 'server.single_player_mode', {
      skipped: blockers,
      note: 'Single player: the engine runs in the player\'s browser against their own '
        + 'uploaded files, so this server needs neither game data nor a sim peer. It serves '
        + 'accounts, the file locker and saves.',
    });
  }
  const setupMode = blockers.length > 0 && opts.requireGameData !== false && !singlePlayerOnly;
  if (setupMode) {
    log('error', 'server.setup_mode', {
      blockers,
      note: 'The world cannot run yet, so players are refused and this server reports '
        + 'itself unhealthy. The admin dashboard at /admin is up: fix the items above there '
        + 'or on disk, then restart.',
    });
  }
  config.simPeer.enabled = gameData.ok && config.simPeer.binary !== '';
  log('info', 'simpeer.ready_to_spawn', {
    binary: config.simPeer.binary,
    content: gameData.contentFiles.join(', '),
  });

  // Per-world peer config. Each world process is its own dataDir, so its sim peer gets its own
  // config + user-data dirs (default under the world's dataDir) — two worlds' peers must not
  // share a userdata dir. The peer's openmw.cfg is GENERATED here from the detected game data
  // (buildPeerCfg): data=, content= in load order, fallback-archive= per BSA, resources=.
  if (config.simPeer.enabled && gameData.ok) {
    const cfgDir = config.simPeer.configDir || join(opts.dataDir, 'peer-config');
    const udDir = config.simPeer.userDataDir || join(opts.dataDir, 'peer-userdata');
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(udDir, { recursive: true });
    // F15: seed this world's navmesh cache from a prebuilt db, if one is configured.
    //
    // The peer caches navmesh to <user-data>/navmesh.db and a warm restart regenerates NOTHING --
    // measured on the peer image: cold adds 138 collision shapes and builds a 3.55MB db, warm adds
    // 0 and the file comes back byte-identical. The catch is that every world has its own
    // user-data dir on purpose (two worlds must not share one), so each newly spawned world pays
    // the cold cost again -- and the gateway spawns and idle-reaps worlds continuously.
    //
    // COPIED, never symlinked or shared: openmw disables writes when it detects another process
    // on the same navmeshdb ('writes to navmeshdb are disabled to avoid concurrent writes from
    // multiple processes'), which would leave every world after the first unable to extend its
    // own cache. Each world gets its own writable copy that starts warm.
    //
    // Only seeds when the destination is absent, so a world that has already built its own cache
    // is never clobbered, and a restart of an existing world keeps whatever it learned.
    const navmeshTemplate = config.simPeer.navmeshTemplate;
    const navmeshDest = join(udDir, 'navmesh.db');
    if (navmeshTemplate && !existsSync(navmeshDest)) {
      try {
        copyFileSync(navmeshTemplate, navmeshDest);
        log('info', 'simpeer.navmesh_seeded',
          { from: navmeshTemplate, to: navmeshDest, bytes: statSync(navmeshDest).size });
      } catch (err) {
        // Never fatal: a missing or unreadable template just means this world generates its own
        // navmesh the slow way, which is exactly the behaviour before this existed.
        log('warn', 'simpeer.navmesh_seed_failed', { from: navmeshTemplate, error: String(err) });
      }
    }
    // Resources ship beside the binary (…/bin/openmw -> …/share/openmw/resources); override
    // via OMW_SIMPEER_RESOURCES if a build lays them out differently.
    const resources = process.env.OMW_SIMPEER_RESOURCES
      || join(dirname(config.simPeer.binary), '..', 'share', 'openmw', 'resources');
    // WITH THE MODS. The peer simulates the world the players are in, so it has to load the
    // same content they do. Without this it ran vanilla while every browser ran the mod list:
    // the two disagree about what exists, and ContentGate — which is there to catch exactly
    // that — would refuse every player from a server the operator had just configured.
    //
    // Read here rather than at boot, so the cfg written on a restart reflects whatever the
    // dashboard last saved.
    writeFileSync(join(cfgDir, 'openmw.cfg'),
      buildPeerCfg(gameData, resources,
        resolveMods(presentMods(gameDataDir(sharedDir), readModDoc(opts.dataDir)))));
    // Pace the peer. Headless means nothing else will.
    writeFileSync(join(cfgDir, 'settings.cfg'), buildPeerSettings());
    config.simPeer.configDir = cfgDir;
    config.simPeer.userDataDir = udDir;
    log('info', 'simpeer.cfg_written', { configDir: cfgDir, resources });
  }

  const simPeers = new SimPeerSupervisor({
    settings: config.simPeer,
    wsUrl: () => `ws://127.0.0.1:${port}/ws`,
    password: config.server.password,
  });
  ctx.simPeers = simPeers;
  ctx.gameDataOk = gameData.ok;
  // ONE PEER, EVERY OCCUPIED CELL. A peer used to be one ~450 MB engine process per occupied
  // cell (3dd85a68), deployed because anchored cells LOADED but never TICKED: the engine's
  // animation/movement gate still measured range from the peer's own avatar. That gate is
  // fixed at the source now (mwmechanics/actorutil nearestSimDistanceSqr — every range check
  // measures from the nearest anchor), and STATUS.md measured the consolidation as free:
  // 8 anchored cells cost no more than 1, because the ESM store and every subsystem are
  // shared. So the fan-out was paying N processes for something one process already does —
  // and it broke the gateway's memory governor besides (a world's cost stopped being a
  // constant, MP-BACKLOG P3).
  //
  // Anchors are WORLD POSITIONS — each player's live pose — not grid coordinates. A
  // cell-centre anchor covered its own cell but reached only ~3072 units into a neighbour
  // against the 7168 processing range, leaving a ring of loaded-but-frozen cells around
  // every anchor. Positions make coverage follow players exactly, like single-player.
  //
  // The supervisor keeps its multi-key machinery: it costs nothing and is the spill valve if
  // the scale ramp ever shows frame time going superlinear in anchored cells.
  const WORLD_KEY = 'world';
  worldPeerImpl = (): Player | undefined => {
    const sys = roster.inWorld().filter((pp) => pp.system === true);
    return sys.find((pp) => simPeers.keyOfAccount(pp.name) === WORLD_KEY)
      ?? sys.sort((a, b) => a.id - b.id)[0];
  };
  // Anchors held past occupancy (idle-decay): cellKey -> last known position + expiry.
  // Walking a cell border must not flap the peer's grid; dropping an anchor is cheap.
  const heldAnchors = new Map<string, { x: number; y: number; z: number; until: number }>();
  // Cells the peer currently holds, so authority is DIFFED rather than re-entered every tick
  // (re-entering bumps the epoch and forces a full re-sync).
  const claimed = new Set<string>();
  let lastAnchorCells = ''; // log throttle: one simpeer.anchors line per change
  let warnedUnsimulated = ''; // throttle for simpeer.cells_unsimulated
  // Is the world actually being SIMULATED? Read live from the roster rather than kept as
  // state: a peer can arrive, die and be respawned, and the roster is the only thing that is
  // right at every moment. It also stays correct for an operator running their own peer
  // instead of one this supervisor spawned — bookkeeping about who we spawned would call
  // that world unsimulated forever and hold every join behind a loading screen.
  ctx.simReady = () => roster.inWorld().some((p) => p.system === true);
  const simPeerPass = (): void => {
    if (!config.simPeer.enabled) return;
    // humansInWorld, NOT inWorld: the peer itself is in-world, so counting it would keep the
    // world looking busy forever and the reaper would never fire.
    // Bots excluded: they are visible players but need no simulation, and anchoring the peer
    // to a cell only a bot stands in would hold a headless engine on an empty world.
    const humans = roster.humansInWorld()
      .filter((p) => p.cellKey !== undefined && !p.bot);
    // START THE PEER WHEN A HUMAN CONNECTS, NOT WHEN ONE REACHES A CELL. humanCount counts
    // authed players who are still loading or in character creation; the peer takes 2-4s to
    // become ready (simpeer.ready startupMs), so waiting for a cell meant the player was
    // handed control BEFORE anything held authority over where they stood. Booting it against
    // the loading client spends that startup on time the player is already waiting through.
    if (roster.humanCount === 0) {
      heldAnchors.clear();
      claimed.clear();
      simPeers.markIdle(WORLD_KEY);
      simPeers.sweep();
      return;
    }

    // CHARGEN CELLS ARE NEVER SIMULATED BY THE PEER, and this is not an optimisation.
    //
    // The peer boots with --start and no --new-game, so its own chargenstate is -1 (creation
    // finished, worldimp.cpp:336-342). The opening is driven entirely by Morrowind.esm's
    // mwscripts on the actors in the prison ship and census office, and the engine writes
    // chargenstate exactly once — every step toward -1 is those scripts running. The moment
    // the peer holds one of those cells, the client receives ActorAuthorityInfo, attaches
    // puppets over every actor there (actors.lua) and puppet.lua disables their AI. The
    // scripts then run only in the peer's world, where the tutorial is already over, so
    // nobody advances the sequence and character creation stalls forever.
    //
    // Unheld is the CORRECT state here: with no holder the client never attaches puppets and
    // keeps running its own local AI, which is exactly what the opening needs. Named chargen
    // rooms are filtered, plus any cell holding a player who has not finished creation (the
    // walk between those rooms is ordinary exterior and cannot be recognised by name).
    const inChargenCells = new Set(humans.filter((p) => p.inChargen === true).map((p) => p.cellKey!));
    const now = Date.now();
    const idleMs = Math.max(0, config.simPeer.anchorIdleSec) * 1000;
    // FRESH POSITIONS EVERY PASS. 32 players x 3 floats every 5 s is nothing, and a stale
    // anchor position is the one thing that reintroduces frozen NPCs.
    for (const p of humans) {
      const ck = p.cellKey!;
      if (isChargenCell(ck) || inChargenCells.has(ck)) continue;
      const prev = heldAnchors.get(ck);
      heldAnchors.set(ck, {
        x: p.pose?.x ?? prev?.x ?? 0,
        y: p.pose?.y ?? prev?.y ?? 0,
        z: p.pose?.z ?? prev?.z ?? 0,
        until: now + idleMs,
      });
    }
    for (const [ck, a] of [...heldAnchors]) if (a.until <= now) heldAnchors.delete(ck);

    // EVERY held cell is covered, interior or exterior, by ONE peer. Exteriors anchor by
    // position; interiors anchor by NAME, because an interior has no coordinate. Both are
    // held without the peer standing in them, so players spread across the map are all
    // simulated from a single process. Before interiors could be anchored, an indoor quest
    // simply never advanced — chargen is entirely indoors, which is why it stalled at the
    // census office every time.
    const cells = [...heldAnchors.keys()].sort();
    const anchors: { x: number; y: number; z: number }[] = [];
    const interiors: string[] = [];
    for (const ck of cells) {
      const a = heldAnchors.get(ck)!;
      if (parseExterior(ck)) anchors.push({ x: a.x, y: a.y, z: a.z });
      else interiors.push(ck);
    }

    // Where the peer's own avatar stands: a real player's position, so a cold boot lands on
    // ground that exists rather than a computed point inside terrain. Vestigial for
    // simulation now that every anchor ticks — [simPeer].startCell covers the cold boot with
    // nobody placed yet.
    const stand = humans.find((p) => p.cellKey !== undefined && heldAnchors.has(p.cellKey)
      && parseExterior(p.cellKey) !== undefined)
      ?? humans.find((p) => p.cellKey !== undefined && heldAnchors.has(p.cellKey));
    const place = stand
      ? { cellKey: stand.cellKey!, x: stand.pose?.x ?? 0, y: stand.pose?.y ?? 0, z: stand.pose?.z ?? 0 }
      : undefined;

    simPeers.ensure(WORLD_KEY, place);
    // Retire any per-cell peers left over from the fan-out era (or an operator's stale
    // supervisor state): one process carries the world now.
    for (const k of simPeers.keys()) if (k !== WORLD_KEY) simPeers.markIdle(k);
    simPeers.sweep();

    // The supervisor's own spawn is preferred, but ANY connected system peer serves: one
    // world has one peer, and a peer the supervisor did not spawn (the harness pre-starts
    // its own so the boots overlap; an operator may too) authenticated with the same peer
    // password. Input forwarding already resolves the peer this way (connection.ts).
    const peerPlayer = worldPeerImpl();
    if (!peerPlayer) {
      // The peer being down is now a GENUINE anomaly, not a capacity warning: there is no
      // maxPeers arithmetic to blame, just a process that is starting, crashed, or backing
      // off. Say so once per change; authority re-enters cleanly when it returns.
      claimed.clear();
      const line = cells.join(',');
      if (cells.length > 0 && warnedUnsimulated !== line) {
        warnedUnsimulated = line;
        log('warn', 'simpeer.cells_unsimulated', {
          unsimulated: line,
          note: 'the world peer is not up (starting, crashed, or in restart backoff)',
        });
      }
      return;
    }
    warnedUnsimulated = '';

    // Sent EVERY pass, deliberately: positions move, and the engine gates its own grid
    // rebuild on the derived cell set (Scene::setSimAnchors), so a resend is cheap there.
    peerPlayer.peer.sendEvent('SimAnchors', { anchors, interiors, ...(place ? { place } : {}) });

    // AUTHORITY FOR EVERY ANCHORED CELL, on the one peer. The old revoke loop ("authority
    // follows the peer that can actually simulate") is gone because after the engine fix it
    // can simulate all of them. Diffed so epochs are stable.
    for (const gone of [...claimed].filter((c) => !heldAnchors.has(c))) {
      world.authorityLeave(peerPlayer.id, gone, true);
      claimed.delete(gone);
    }
    for (const ck of cells) {
      // Re-assert even a CLAIMED cell whose holder is no longer the peer: the peer's own
      // avatar cell change (handleCellChange) releases the cell it walked out of, and the
      // claimed-diff alone would never re-enter it -- leaving an anchored cell dormant until
      // idle-decay. authorityEnter is idempotent when the peer already holds it.
      if (claimed.has(ck) && world.holderOf(ck) === peerPlayer.id) continue;
      world.authorityEnter(peerPlayer, ck);
      claimed.add(ck);
    }

    const anchorLine = cells.join(',');
    if (anchorLine !== lastAnchorCells) {
      lastAnchorCells = anchorLine;
      log('info', 'simpeer.anchors', {
        world: worldId, exteriors: anchors.length, interiors: interiors.length,
        occupied: humans.map((p) => `${p.name}@${p.cellKey}${p.inChargen === true ? ' [chargen]' : ''}`),
        simulating: anchorLine,
      });
    }
  };
  const simPeerTick = setInterval(simPeerPass, 5_000);
  // A peer finishing its hello should not wait up to a full tick to be put to work —
  // that is 5s of the player holding a loading screen for no reason.
  ctx.onPeerJoined = () => simPeerPass();
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
    // Setup mode: the admin surface is up so the operator can finish configuring, but there
    // is no world to join yet. Saying so beats a connection that appears to work and then
    // drops a player into cells nothing can simulate.
    if (setupMode) {
      log('info', 'conn.setup_mode_refused', { ip });
      metrics.connRefused.inc({ reason: 'setup_mode' });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(disconnectMsg('SHUTDOWN',
          'this server has not been set up yet — the operator needs to add game data'));
      }
      ws.close(1013, 'SETUP');
      ipTracker.release(ip);
      return;
    }
    // Maintenance mode, refused here for the same reason an IP ban is: before a roster slot,
    // an argon2 hash or any world state is spent on someone who is not getting in. The
    // operator's message goes back verbatim so "back in ten minutes" actually reaches them.
    if (maintenance.on) {
      log('info', 'conn.maintenance_refused', { ip });
      metrics.connRefused.inc({ reason: 'maintenance' });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(disconnectMsg('SHUTDOWN', maintenance.message || 'server is under maintenance'));
      }
      ws.close(1012, 'MAINTENANCE');
      ipTracker.release(ip);
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
  // SERVER-WIDE PRESENCE. Each world publishes its own occupants into the shared store so
  // every other world can answer "who is online?" for the whole server rather than for its own
  // process — friends in another world used to read as offline, party members had no location,
  // and the Players list showed one world's population as if it were everyone. Refreshed on a
  // heartbeat and read with a TTL, so a world that dies without cleaning up ages out.
  const presenceWorld = worldId ?? 'default';
  const publishPresence = (): void => {
    const now = Date.now();
    for (const p of roster.inWorld()) {
      if (p.system) continue; // the sim peer is infrastructure, not a player
      socialStore.setPresence(p.accountKey, presenceWorld, p.name, p.cellKey, p.bot === true, now);
    }
  };
  // THE PLAYERS LIST IS THE SERVER'S, NOT THIS WORLD'S. Roster.joinWorld sends a PlayerList
  // built from this process's occupants, which is all it can see — so the panel showed the
  // world you were standing in and called it "players". You should be able to see, and invite,
  // anyone connected to the server from wherever you are. Rebroadcast the shared view; the
  // client's PlayerList handler already replaces its roster wholesale.
  //
  // A remote player carries no id: connection ids are local to the process that holds the
  // socket, and inventing one would let the UI offer actions that address nothing. Social ops
  // resolve by NAME, so every button still works on a row from another world.
  const broadcastServerRoster = (): void => {
    const everyone = social.onlineEverywhere();
    if (everyone.length === 0) return;
    for (const p of roster.humansInWorld()) {
      if (p.bot) continue; // nothing is listening on a bot's peer
      // Three queries for this viewer, not three per candidate. See Social.relationsFor.
      const relation = social.relationsFor(p.accountKey);
      // PER RECIPIENT, because the interesting part of a row is the RELATIONSHIP: the panel
      // offered "add friend" to people you were already friends with, and to people whose
      // request you had already sent, since a row carried only {id, name}. Flags, not account
      // keys — a key is the login identifier, which for an SSO account is a real name.
      const list = everyone
        .filter((r) => r.account !== p.accountKey) // your own row is rendered from what you know
        .map((r) => {
          const local = roster.activeForAccount(r.account);
          return {
            ...(local && local.inWorld ? { id: local.id } : {}),
            name: r.name,
            ...relation(r.account),
          };
        });
      p.peer.sendEvent('PlayerList', { players: list as unknown as never });
    }
  };

  publishPresence();
  const presenceTick = setInterval(() => {
    // WRAPPED, BECAUSE A THROW HERE KILLED THE WHOLE WORLD. Everything below writes to the
    // shared social database, which every world process has open at once. A synchronous throw
    // out of a timer callback is an uncaughtException, and main.ts turns that into
    // process.exit(1) — so one contended write ejected every player in this world. Presence is
    // a heartbeat: missing a beat is survivable, and the next one is 10 seconds away.
    try {
      publishPresence();
      broadcastServerRoster();
      // The friend and party panels are pushed on RELATIONSHIP changes, which never fire when a
      // member simply walks into another world — so they kept saying "Offline" about someone
      // standing in plain sight. Presence moves on this heartbeat; the views follow it.
      social.refreshPresenceViews();
      // Expired friend requests and invites. Swept here rather than on their own timer:
      // this is already the once-per-10s social heartbeat, and sweepExpired had NO production
      // caller at all — only a test — so the rows accumulated forever.
      socialStore.sweepExpired(Date.now());
      socialStore.prunePresence(Date.now());
    } catch (err) {
      log('warn', 'presence.tick_failed', { error: String(err) });
    }
  }, 10_000);
  presenceTick.unref();
  // DEV/TEST BOTS. Off unless [dev] bots (or OMW_DEV_BOTS) says otherwise — see dev/testbots.
  // Started AFTER hooks so plugins see a normal roster, and given the world's respawn cell so
  // interest-managed broadcasts reach them.
  // Bots run in every world PROCESS, but presence decides where they actually appear: an
  // unpartied bot is in public only, and a partied one follows its party — including into a
  // private world when the leader switches. See dev/testbots reconcile().
  if (config.dev.bots > 0) {
    // SAY SO, LOUDLY. dev/testbots' own header promises "boot logs a warning whenever any are
    // running" and nothing did. These register REAL accounts and claim real usernames, which
    // stay reserved after the bots are switched off — so an operator who set OMW_DEV_BOTS once
    // in production had no way to notice.
    log('warn', 'devbots.enabled', {
      count: Math.min(config.dev.bots, 16),
      note: 'test bots register real accounts and reserve real usernames; do not run in production',
    });
  }
  const devBots = config.dev.bots > 0
    ? await startTestBots({
      roster, social, accounts, players: playerStore,
      // WHERE BOTS HANG OUT. There is no public world; the gathering place is a world that
      // booted in party mode. Each world process decides for itself from its own boot mode,
      // with no cross-process messaging.
      isPublic: worldModeAtBoot === 'party',
      count: Math.min(config.dev.bots, 16), // a sanity ceiling; this is a dev aid, not a load test
      names: config.dev.botNames,
      prefix: config.dev.botPrefix,
      // The starter village — the same point respawn uses, so "where players begin" is
      // configured once per deployment rather than twice.
      spawn: {
        cellKey: config.rules.respawnCellKey,
        x: config.rules.respawnX, y: config.rules.respawnY, z: config.rules.respawnZ,
      },
      looks: config.dev.botLooks,
      look: {
        race: config.dev.botRace, head: config.dev.botHead,
        hair: config.dev.botHair, class: config.dev.botClass,
      },
    })
    : undefined;
  log('info', 'server.start', { port, dataDir: opts.dataDir, sharedDir, version: VERSION });

  let closed = false;
  return {
    port,
    config,
    api,
    accounts,
    gameData,
    flush: async () => {
      // Drain background writes first: they WRITE, so they must finish before the flush that
      // is supposed to persist everything, let alone before the stores close.
      while (inFlight.size) await Promise.allSettled([...inFlight]);
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
      devBots?.stop();
      clearInterval(presenceTick);
      unhookGauge();
      unhookBufferedGauge();
      // The test suite builds dozens of servers in one process; a subscriber left behind
      // would keep a closed server's config alive and fire on the next server's log lines.
      unhookNotifier();
      clearInterval(simPeerTick);
      if (ownerGraceTimer) clearTimeout(ownerGraceTimer);
      simPeers.stopAll(); // never leave an engine running after the server it fed is gone
      moveBroadcaster.stop();
      social.stop(); // pending presence timers would keep the process alive
      await m7.stop();
      hooks.serverStop();
      for (const conn of [...connections]) conn.disconnect('SHUTDOWN', 'server shutting down');
      wss.close();
      // AFTER the disconnect loop, never before it: dropping a connection writes the player's
      // presence back through Social, so closing this first made shutdown race its own
      // teardown and throw "database is not open" from inside a hook that had already
      // returned. A store outlives every writer to it.
      // Stop the HTTP door BEFORE any store closes. An in-flight /auth/* request writes to
      // the account store as it completes, so leaving the listener open until the end raced
      // shutdown and surfaced as an intermittent "database is not open" thrown from a hook
      // that had already returned.
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      // QUIESCE every writer, THEN close. Draining the world after closing the stores it
      // writes through was the same bug in the other direction.
      await world.drain();
      // Background writes registered with track(). This drain existed only in flush(), which
      // the real SIGTERM/SIGINT path never calls (main.ts goes close() -> process.exit), so a
      // tracked write could still be running when the stores closed under it — losing the
      // write and throwing from a detached promise. ChargenComplete is the one that hurts:
      // its flag is what the shared world's "character created" gate reads.
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      await accounts.flush();
      await playerStore.flushAll();
      await bans.flush();
      await moderation.flush();
      // Now nothing is left to write. A store outlives every writer to it.
      socialStore.close();
      await accounts.close();
      await playerStore.close();
      await attio.close();
      await cellStore.close();
      await recordStore.close();
      resume.clear();
      oidc.close();
      tickets.clear();
      log('info', 'server.stop', {});
    },
  };
}
