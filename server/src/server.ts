// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Composition root: wires config, stores, gates, plugins, HTTP and WS into a running
// server. main.ts is the CLI face; tests call startServer() directly.

import { VERSION } from './version';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig, assertMultiplayer, type Config, type DeepPartial } from './config';
import { AccountStore } from './core/accounts';
import { ContentTable } from './core/content-table';
import { QuestRepair } from './core/quest-repair';
import { adminRoutes as adminDashboardRoutes } from './net/admin/routes';
import { exportDataDir, summariseMetrics } from './net/admin/ops';
import { writeCaddyfile } from './net/admin/caddy-config';
import { clientRoutes, defaultClientDir } from './net/client-routes';
import { saveSection } from './net/admin/settings-store';
import { orderedContent } from './net/admin/api-mods';
import { notifyFromLog, type MailConfig } from './net/admin/notify';
import { SetupToken } from './net/admin/setup-token';
import { passwordReset } from './net/admin/reset';
import { deleteAccount } from './persist/erase';
import { PlayerStore } from './persist/playerstore';
import { CellStore } from './persist/cellstore';
import { RecordStore } from './persist/recordstore';
import { BanStore } from './persist/banstore';
import { pushAvatarsToPeer } from './core/playerstate';
import type { StateCtx } from './core/playerstate';
import { WorldState } from './core/worldstate';
import { Combat } from './core/combat';
import { Quests } from './core/quests';
import { Social } from './core/social';
import { SocialStore } from './core/socialstore';
import { Trades, TradeLedger } from './core/trade';
import { PvpConsent } from './core/pvp-consent';
import { BusyFlags } from './core/busy';
import { Titles } from './core/titles';
import { HelperRewards } from './core/helperrewards';
import { GOLD_ID, hintGold } from './core/economy';
import { serverWhisper } from './core/chat';
import { Binding } from './core/binding';
import { AdminAudit, LoginLog } from './core/admin-audit';
import { Schedule } from './core/schedule';
import type { JsLike } from './proto/lser';
import { WorldM7 } from './core/m7';
import { Roster, type Player } from './core/players';
import { ContentGate, EngineGate } from './core/manifest';
import type { ChatContext } from './core/chat';
import { Moderation, reportView } from './core/moderation';
import { Admin, ADMIN_COMMANDS, dashboardRank, operatorRank } from './core/admin';
import { ResumeStore } from './core/resume';
import { broadcastChat, makeChatFilter, replayWindow, noviceEligible, type ChatMessageBody } from './core/chat';
import { HookBus } from './plugins/loader';
import type { PluginApi } from './plugins/api';
import { MoveBroadcaster, interestFromLimits } from './core/movement';
import { configureAuthority, setOnSilentPeer, noteAnchorsChanged } from './core/authority';
import { Connection, type ServerCtx } from './net/connection';
import { attachWss } from './net/ws';
import { createHttpServer, gateAdmin, type HttpRoute } from './net/http';
import { OidcService } from './auth/oidc';
import { IdentityStore, LoginTicketStore, SessionIndex } from './auth/identities';
import { createAuthRoutes } from './auth/routes';
import { ensureVanillaManifest } from './data/vanilla-manifest';
import { Locker, loadVanillaManifest } from './data/locker';
import { lockerStorageFrom, blobRoutes, FsStorage, lockerPublicBase, requestBase } from './data/fsstorage';
import { mwDataRoutes } from './net/mwdata-routes';
import { createSysInfo } from './net/admin/sysinfo';
/** Just the parts of the storage backend the saves API needs. */
type SaveStorageLike = {
  presignGet(k: string): Promise<string>;
  presignPut(k: string, n: number): Promise<string>;
  objectSize?(k: string): Promise<number | undefined>;
};
import { presentMods, readModDoc, resolveMods } from './core/mods';
import { eraseSaves } from './data/save-routes';
import { lockerRoutes, esmOwnerGate } from './data/locker-routes';
import { LockerSessionStore, AdminSessionStore } from './auth/identities';
import { IpConnTracker, IpRateLimiter } from './net/ratelimit';
import { disconnectMsg } from './proto/session';
import { log, logHistory } from './log';
import { startTestBots } from './dev/testbots';
import { metrics } from './metrics';
import { SimPeerSupervisor } from './core/simpeer';
import { PeerLoad } from './peers/peerload';
import { RegionMap, partitionAnchors, AnchorSender, type AnchorPlayer } from './peers/regions';
import { parseExterior, isChargenCell } from './core/movement';
import { detectGameData, findPeerBinary, gameDataDir, buildPeerCfg, buildPeerSettings, hashContentFiles, type GameData } from './core/gamedata';

// [rules] timeSkip="owner": the one world has no owning player, so moving the shared clock is a
// staff power (OT3-53). 2 = admin.
const TIME_SKIP_RANK = 2;

// The version is in ./version (shared with the multiplayer server); re-exported so
// existing importers keep working.
export { VERSION };

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
  presenceMs?: number; // social heartbeat period (tests shorten it)
  configOverride?: DeepPartial<Config>; // tests
}

export interface RunningServer {
  port: number;
  config: Config;
  // The same surface plugins get. Exposed so an embedder (and the test suite) can drive
  // world actions without loading a plugin.
  api: PluginApi;
  /** Account store, so tests can seed players without going through the wire protocol. */
  accounts: AccountStore;
  /** The operator command gate and the roster it acts on. The dashboard is the only door in
   *  production; the test suite goes through the gate directly, as the dashboard does. */
  admin: Admin;
  roster: Roster;
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
  assertMultiplayer(config);
  // Read live by core/authority.ts, which WorldState builds without ever seeing the config.
  configureAuthority({
    reviewMs: config.authority.reviewSec * 1000,
    actorSilenceMs: config.authority.actorSilenceSec * 1000,
  });
  const accounts = new AccountStore(sharedDir);
  // Character docs live in the SHARED dir so a character follows its player across worlds;
  // positions inside the doc are scoped by world id.
  const worldId = opts.worldId ?? process.env.OMW_WORLD_ID ?? 'default';
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
  const playerStore = new PlayerStore(sharedDir, worldId);
  const cellStore = new CellStore(opts.dataDir, true);
  // SHARED, not per world (backlog 315): the player doc carries custom-record ids across
  // worlds, so the registry that mints them must be one per deployment.
  const recordStore = new RecordStore(sharedDir);
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
  // THE PLAYED MARKER (backlog 322). The gateway's never-joined reaper discards a world
  // directory nobody ever played in; it used to test world/world.db, which the sqlite
  // constructor above creates the moment a world boots, so it never fired. The marker is
  // written on the first HUMAN join (onPlayerJoined) -- and backfilled here for a world
  // played before the marker existed, so a revival is never mistaken for a fresh spawn.
  const playedMarker = join(opts.dataDir, '.played');
  const markPlayed = (): void => {
    if (existsSync(playedMarker)) return;
    try { writeFileSync(playedMarker, ''); }
    catch (err) { log('warn', 'world.played_marker_failed', { error: String(err) }); }
  };
  if (cellStore.cellsWithDeltas().length > 0) markPlayed();
  await recordStore.ready(); // custom-record ids must not restart from 1 after a reboot
  const roster = new Roster();
  // M8: /motd rewrites this at runtime; SessionWelcome and the motd plugin read it here.
  let motd = config.server.motd;
  const resume = new ResumeStore(config.login.resumeWindowSec);
  // Tickets the previous process parked at a graceful shutdown (ResumeStore.save), read once.
  const resumeFile = join(opts.dataDir, 'resume-tickets.json');
  { const n = resume.load(resumeFile); if (n > 0) log('info', 'resume.restored', { tickets: n }); }
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
  world.setStashes(contentTable.stashes); // OT3-179
  // OT3-178: the party standing in the looter's cell shares a notable item's trade window.
  const binding = new Binding(contentTable.questItems, contentTable.notableItems);
  world.setBinding(binding, (p) => (socialStore.partyOf(p.accountKey)?.members ?? [])
    .map((a) => roster.activeForAccount(a))
    .filter((m): m is Player => m !== undefined && m.inWorld && m.cellKey === p.cellKey)
    .map((m) => m.charId));
  world.setCharacterKills({
    bump: (charId, refId) => {
      let n = 0;
      playerStore.update(charId, (doc) => { n = ((doc.kills ??= {})[refId] ?? 0) + 1; doc.kills[refId] = n; }, 'debounced');
      return n;
    },
    all: (charId) => Object.entries(playerStore.getCached(charId)?.kills ?? {}),
  });
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
    // check both. OT3-87: both are map hits, so a sweep stays O(N).
    const p = roster.activeForAccount(key) ?? roster.activeForChar(key);
    return p?.cellKey && p.pose ? { cellKey: p.cellKey, x: p.pose.x, y: p.pose.y, z: p.pose.z } : undefined;
  });

  // M7 needs the hook bus (map sharing policy) and the bus's api needs M7 (gui/world
  // actions), so the reference is closed over lazily — both are live before any hook or
  // any client frame can run.
  let hooks: HookBus;
  const moderation = new Moderation(sharedDir, config.moderation);
  // OT3-190: a scheduled MOTD goes through the same path as /motd (set + announce).
  const schedule = new Schedule(opts.dataDir, (kind, text) => {
    if (kind === 'motd') {
      motd = text;
      config.server.motd = text;
    }
    broadcastChat(roster, { channel: 'server', text });
  });
  schedule.start();
  // OT3-177: the swap writes both docs; the ledger sits next to them in the shared dir.
  // Built before Admin: /restoreitem (OT3-181) writes to it too.
  const tradeLedger = new TradeLedger(sharedDir);
  const admin = new Admin({
    questRepair,
    roster,
    accounts,
    bans,
    resume,
    moderation,
    allowConsole: config.admin.allowConsole,
    setMentor: (p, state) => socialRef?.setMentor(p, state, true) ?? 'not_ready',
    motd: () => motd,
    setMotd: (text) => {
      motd = text;
      config.server.motd = text; // plugins and Welcome read config.server.motd
    },
    allow: (actor, cmd) => hooks.adminCommand({ id: actor.id, name: actor.name, rank: actor.rank }, cmd),
    audit: new AdminAudit(opts.dataDir),
    logins: new LoginLog(sharedDir), // OT3-186
    schedule, // OT3-190
    restore: (charKey, at) => playerStore.restoreTo(charKey, at), // OT3-184
    setMuted: (acct, muted, until, reason) => socialRef?.setServerMuted(acct, muted, until, reason), // OT3-185
    ledger: (e) => tradeLedger.write(e), // OT3-181
    chars: { // OT3-180..182
      async resolve(who) {
        const account = await accounts.get(accounts.keyForUsername(who) ?? who.toLowerCase());
        const latest = account?.characters?.slice().sort((x, y) => (y.lastPlayedAt ?? '').localeCompare(x.lastPlayedAt ?? ''))[0];
        if (latest) return latest.id;
        return (await playerStore.get(who)) ? who : undefined;
      },
      edit: (charKey, fn) => playerStore.update(charKey, fn, 'now'),
      rename: (charKey, name) => accounts.renameCharacter(charKey, name), // OT3-194
      safePoint: () => ({ cellKey: config.rules.respawnCellKey, x: config.rules.respawnX, y: config.rules.respawnY, z: config.rules.respawnZ }),
    },
  });
  const m7 = new WorldM7({
    roster,
    cells: cellStore,
    records: recordStore,
    isMapShared: () => hooks.shareFamily('map'),
    players: playerStore,
    // One world, no owner (OT3-53): 'owner' means the operator's staff, so it keys on rank.
    maySkipTime: (player) => {
      if (config.rules.timeSkip === 'off') return { may: false, why: 'time does not skip in this world' };
      if (config.rules.timeSkip === 'owner' && player.rank < TIME_SKIP_RANK) {
        return { may: false, why: 'only staff can move the world clock' };
      }
      return { may: true, why: '' };
    },
    restsPersonal: () => config.rules.timeSkip !== 'off', // OT3-108
    // Phase 3.7: a reset hands the restored cell truth straight to whoever is standing
    // there, so it never needs the TES3MP kick-everyone workaround.
    world,
  });
  m7.clock.setTimeScale(config.time.scale); // config is operator truth for the scale

  const pvpConsent = new PvpConsent({ // OT3-163
    findByName: (name) => roster.findByName(name),
    byId: (id) => roster.get(id),
    tell: serverWhisper,
    now: () => Date.now(),
  });
  const api: PluginApi = {
    config,
    log,
    pvpConsent: (a, v) => pvpConsent.consent(a, v),
    diedInDuel: (id) => pvpConsent.diedInDuel(id),
    players: () => roster.inWorld().map((p) => ({ id: p.id, name: p.name, rank: p.rank })),
    cellOfPlayer: (playerId) => roster.get(playerId)?.cellKey,
    levelOfPlayer: (playerId) => { const p = roster.get(playerId); return p ? levelOf(p) : 1; },
    partyOnline: (playerId) => {
      const p = roster.get(playerId);
      if (!p) return [];
      return (socialStore.partyOf(p.accountKey)?.members ?? [])
        .filter((a) => a !== p.accountKey)
        .map((a) => roster.activeForAccount(a))
        .filter((m): m is Player => m !== undefined && m.inWorld)
        .map((m) => m.id);
    },
    shrinesOf: (playerId) => {
      const p = roster.get(playerId);
      return { shrines: (p && playerStore.getCached(p.charId)?.shrines) || [], outside: p?.lastOutside };
    },
    maxHealthOf: (playerId) => {
      const p = roster.get(playerId);
      return p ? playerStore.getCached(p.charId)?.stats?.dynamic?.hp.b : undefined;
    },
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
          victim.resurrectedAt = victim.respawnAt = Date.now();
          victim.avatarDead = false; // the respawn's refill must flow (a corpse is not healed)
          victim.peerStatsAt = undefined;
          peerForImpl(victim.cellKey)?.peer.sendEvent('AvatarResurrect', { id: target, ...(body as object) });
        }
      }
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
    },
  };
  hooks = new HookBus(config.plugins, api);

  // How much scrollback a newcomer is handed. Enough to see what the room is talking about,
  // short enough that a join is not a wall of text.
  // Capacity is enforced once, in connection.ts (SERVER_FULL), against [server] maxPlayers:
  // the number /status and the dashboard advertise.
  const CHAT_HISTORY_KEEP = 200;
  const CHAT_HISTORY_REPLAY = 60;
  const levelOf = (p: Player): number => playerStore.getCached(p.charId)?.stats?.level ?? 1;
  const chatCtx: ChatContext = {
    roster,
    // Mutes are enforced at DELIVERY (chat.ts), not in the client: a mute a modified
    // client can ignore is not a mute. A block (either direction) silences live chat too;
    // before, it only filtered join replay and blocked players kept talking live.
    isMuted: (listener, speaker) => (socialRef?.isMuted(listener, speaker) ?? false)
      || socialStore.blockedEitherWay(listener, speaker),
    // The '@' tier is WORLD chat now: the people in your world are your group, no membership
    // list needed. Everyone co-present, yourself included.
    worldOf: (accountKey) => (roster.activeForAccount(accountKey)
      ? roster.humansInWorld().filter((p) => !p.bot).map((p) => p.accountKey)
      : []),
    partyMembers: (accountKey) => socialStore.partyOf(accountKey)?.members ?? [],
    // Opt-in per deployment: a crowded public world wants proximity say, a co-op session
    // very much does not (friends spread across the map must still be able to talk).
    sayProximity: config.rules.sayScope === 'proximity',
    globalCooldownMs: config.limits.globalChatCooldownSec * 1000,
    filter: makeChatFilter(config.limits.chatFilterWords, config.limits.chatFilterLinks), // OT3-185
    noviceOk: (p) => noviceEligible(levelOf(p), socialStore.getMentor(p.accountKey)),
    // SCROLLBACK. Only the channels a newcomer may legitimately replay: 'global' and 'server'
    // are the server-wide conversation, and world chat is the one world's. History is scoped
    // by channel only (OT3-46). Party chat is the party's and is never replayed (OT3-110);
    // rows stored as 'party' before the rename were world chat and simply age out.
    // 'say' is proximity (replaying a conversation from a cell you were not in is noise),
    // and 'whisper' is nobody else's business.
    history: (player, channel, text) => {
      if (channel !== 'global' && channel !== 'server' && channel !== 'world') return;
      socialStore.appendChat({
        ts: Date.now(), channel, scope: channel,
        acct: player.accountKey, name: player.name, text,
      }, CHAT_HISTORY_KEEP);
    },
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
  world.charMemberVars = (charId, cellKey) => playerStore.getCached(charId)?.memberVars?.[cellKey]; // OT3-113
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
    const have = led?.get(recordId) ?? 0;
    const fromCredit = Math.min(have, count);
    if (led && have > 0) {
      if (have - fromCredit > 0) led.set(recordId, have - fromCredit);
      else led.delete(recordId);
    }
    // The rest came out of the DECLARED pack, so the doc says so now rather than at the next
    // 2 s inventory diff: a player who dropped a thing for a friend and lost their connection
    // before that diff used to relog still holding it, the friend holding it too.
    const fromDoc = count - fromCredit;
    if (fromDoc <= 0) return;
    playerStore.update(player.charId, (doc) => {
      const inv = doc.inventory;
      const at = inv?.findIndex((i) => i.id === recordId) ?? -1;
      if (!inv || at < 0) return;
      const left = inv[at]!.n - fromDoc;
      if (left > 0) inv[at]!.n = left;
      else inv.splice(at, 1);
      // ...and its STATE (#236): the entries are one per stack, so the dropped count comes
      // off the tail -- whole entries while they fit, then the last one shrinks. Leaving them
      // restored the survivor of two same-record items with the dropped one's wear.
      const bucket = doc.itemStates?.[recordId];
      if (!bucket) return;
      let debit = fromDoc;
      while (debit > 0 && bucket.length > 0) {
        const tail = bucket[bucket.length - 1]!;
        const size = tail.n ?? 1;
        if (size > debit) { tail.n = size - debit; break; }
        bucket.pop();
        debit -= size;
      }
      if (bucket.length === 0) delete doc.itemStates![recordId];
    });
  });
  world.setModerationNote((accountKey, kind) => moderation.noteAnomaly(accountKey, kind));

  // THE world peer, one resolver for every caller (input, avatar batches, bar/item reports,
  // AvatarState, PvP, anchors/authority). Assigned once simPeers exists (below); until then
  // it answers undefined. The supervisor's own spawn wins; else the LOWEST-id system peer --
  // stable across roster order, so two system peers cannot each be "the" peer to different
  // sites (that split brain sent input to one and authority to the other).
  let worldPeerImpl: () => Player | undefined = () => undefined;
  // OT3-99: faction titles for nameplates (PlayerTitles, on change).
  const titles = new Titles({ roster, factionsOf: (p) => playerStore.getCached(p.charId)?.factions });
  // OT3-105: busy players (menus, dialogue). The world peer is told every edge.
  const busy = new BusyFlags({
    now: () => Date.now(),
    notify: (p, b) => worldPeerImpl()?.peer.sendEvent('PlayerBusy', { id: p.id, busy: b }),
  });
  // OT3-202: per-region resolvers (assigned with worldPeerImpl once simPeers exists). With one
  // region these are all the same peer, so every call site behaves as it did.
  let peerForImpl: (cellKey?: string) => Player | undefined = () => undefined;
  let isPeerImpl: (p: Player) => boolean = () => false;
  let allPeersImpl: () => Player[] = () => [];
  const stateCtx: StateCtx = {
    onDamaged: (p) => busy.damaged(p),
    worldPeer: () => worldPeerImpl(),
    peerFor: (ck) => peerForImpl(ck),
    isPeer: (p) => isPeerImpl(p),
    roster,
    store: playerStore,
    harness: config.limits.harness,
    clientAuthority: config.limits.clientAuthority, // the WoW model: the owner's fall damage (hp.fall) is taken
    holderOf: (cellKey) => world.holderOf(cellKey), // bars only from an avatar the peer simulates
    recordOf: (id) => recordStore.get(id), // #359: active-effect adds budgeted by real magnitude
    isKnownItem: (id) => contentTable.isKnownItem(id), // P4: invented record ids are dropped
    isKnownSpell: (id) => contentTable.isKnownSpell(id), // OT3-9: invented spell ids are refused
    chargenCeiling: (a) => contentTable.chargenCeiling(a), // OT3-9: creation's stats, clamped at ChargenComplete
    // Chargen named the character: put that name on the slot, replacing the placeholder the
    // slot was auto-created with. Only ever an upgrade — a slot the player already named is
    // left alone.
    // Same sink the movement envelope feeds: anomalies are what moderation acts on.
    noteAnomaly: (accountKey, kind) => moderation.noteAnomaly(accountKey, kind),
    characterNameRefusal: (player, name) => accounts.characterNameRefusal(name, player.accountKey),
    onCharacterNamed: (player, name) => {
      // TRACKED: this writes the name the player typed in chargen onto their slot. Untracked,
      // a shutdown landing between the read and the write both loses the name and throws from
      // a detached promise onto a closed database — the same shape as the ChargenComplete bug.
      track(accounts.get(player.accountKey).then((account) => {
        if (account) accounts.nameCharacter(account, player.charId, name);
      }));
    },
    onPlayerDeath: (player) => {
      // #35: PvP attribution -- the last player to land a harmful hit, if within 10 s.
      const hit = player.lastHitBy;
      const killedBy = hit && Date.now() - hit.at < 10_000 ? { id: hit.id, name: hit.name } : undefined;
      log('info', 'player.death', { id: player.id, name: player.name, ...(killedBy ? { killedBy } : {}) });
      // A dead player is out of the conversation: the client tears the Dialogue window
      // down, so an NPC still locked to the corpse would refuse everyone else until the
      // cell changed (backlog 33). `quests` is declared below; this runs long after.
      quests.releaseDialogueLocks(player.id);

      hooks.playerDeath({ id: player.id, name: player.name, rank: player.rank });
    },
  };

  const combat = new Combat({
    roster,
    worldPeer: () => worldPeerImpl(),
    peerFor: (ck) => peerForImpl(ck),
    maxHitDamage: config.limits.maxHitDamage,
    harness: config.limits.harness,
    holderOf: (cellKey) => world.holderOf(cellKey),
    epochOf: (cellKey) => world.epochOf(cellKey),
    allowPlayerHit: (attacker, victimId, name) =>
      hooks.playerHit({ id: attacker.id, name: attacker.name, rank: attacker.rank }, victimId, name),
    revive: (healer, victimId) =>
      hooks.playerRevive({ id: healer.id, name: healer.name, rank: healer.rank }, victimId),
    spellBounds: (id) => {
      const known = contentTable.spellBounds(id);
      if (known) return known;
      // A spellmaker record carries its own effects (RecordStore, #359).
      const fx = (recordStore.get(id)?.data as { effects?: { magnitudeMax?: unknown; duration?: unknown }[] } | undefined)?.effects;
      if (!Array.isArray(fx)) return undefined;
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
      return { mag: Math.max(0, ...fx.map((e) => num(e.magnitudeMax))), dur: Math.max(0, ...fx.map((e) => num(e.duration))) };
    },
    knowsSource: (caster, id) => {
      const doc = playerStore.getCached(caster.charId);
      // Case-blind: engine record ids are, and a spell the client names "Fireball" is the doc's "fireball".
      const want = id.toLowerCase();
      if (doc?.spells?.some((s) => s.toLowerCase() === want)) return 'spell';
      return doc?.inventory?.some((i) => i.id.toLowerCase() === want) === true ? 'item' : false;
    },
  });

  // Deliver swings that were parked while a cell had no simulator (combat.ts `hold`). Wired
  // here because the world is built before the combat relay and neither should import the other.
  world.onHolderGained = (cellKey) => combat.flushCell(cellKey);

  // OT3-91: helpers (party members the quest credit gave nothing) are paid gold, via the ledger.
  const helperRewards = new HelperRewards({
    now: () => Date.now(),
    levelOf: (p) => levelOf(p),
    mentorOk: (p) => socialStore.getMentor(p.accountKey) !== 'revoked',
    give: (p, gold, note) => {
      hintGold(p, 'quest');
      p.peer.sendEvent('AdminGive', { recordId: GOLD_ID, count: gold, note });
    },
    ledger: (e) => tradeLedger.write(e),
  });
  const quests = new Quests({
    helperReward: (w, h, q, i) => void helperRewards.reward(w, h, q, i),
    roster,
    cells: cellStore,
    players: playerStore,
    regressAllowed: (questId) => hooks.journalRegress(questId),
    worldGlobals: config.sharing.worldGlobals,
    worldPeer: () => worldPeerImpl(),
    peerFor: (ck) => peerForImpl(ck),
    allPeers: () => allPeersImpl(),
    holderOf: (cellKey) => world.holderOf(cellKey),
    inQueue: (fn) => world.inQueue(fn),
    noteAnomaly: (accountKey, kind) => moderation.noteAnomaly(accountKey, kind), // #366
    partyMembers: (acct) => social.partyMembers(acct), // OT3-90; social is built below, called later
  });
  world.talkingTo = (refKey, playerId) => quests.isDialogueHolder(refKey, playerId);
  world.personalDisposition = (player, ref, cellKey, d) => quests.notePersonalDisposition(player, ref, cellKey, d);

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
  const lockerBase = lockerPublicBase(config.setup.domain, opts.port, config.locker.publicBase);
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
  locker.configureAccepted(await loadVanillaManifest(sharedDir), { esmHashes: config.locker.esmHashes });
  // Persisted for the same reason as the gateway's: a restart must not sign a playing
  // player out (see LockerSessionStore).
  const lockerSessions = new LockerSessionStore(24 * 60 * 60 * 1000, sharedDir, (k) => !!bans.isAccountBanned(k));
  const adminSessions = new AdminSessionStore();
  // Claiming the first administrator account needs proof of access to this machine. Armed
  // only while nobody holds the dashboard owner role; see setup-token.ts for why account
  // state alone was not a safe gate.
  const setupToken = new SetupToken(opts.dataDir);
  if (!accounts.hasDashboardOwner()) setupToken.arm();
  // Operational alerts ride the log stream the server already writes, filtered by the
  // operator's [notifications].events list. Nothing is sent unless they configured it.
  const unhookNotifier = notifyFromLog(() => ({
    ...mailCfg(),
    to: config.notifications.to,
    webhookUrl: config.notifications.webhookUrl,
    events: config.notifications.events,
  }));

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
  // The game client bundle, when this deployment mounts it (docker-compose mounts ./play at
  // /client). Served by clientRoutes below and updated by the dashboard.
  const clientDir = opts.clientDir ?? (existsSync(defaultClientDir()) ? defaultClientDir() : undefined);

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
    // Cache first (it carries the display casing), then the SHARED usernames table for
    // accounts this process has never seen — a friend in their own world, the sender of a
    // pending request — then the live roster. Without the middle step every cross-world row
    // fell through to the account key, which is the login identifier.
    displayName: (acct) => accounts.cachedByKey(acct)?.username
      ?? accounts.usernameOf(acct)
      ?? roster.activeForAccount(acct)?.name,
    // Resolution must accept what players SEE, which is now the username.
    resolveName: (name) => accounts.keyForUsername(name) ?? (accounts.existsNow(name) ? name.toLowerCase() : undefined),
    now: () => Date.now(),
    levelOf,
    journalOf: (p) => playerStore.getCached(p.charId)?.journal ?? {},
    busyOf: (p) => busy.isBusy(p.id),
    vitalsOf: (p) => {
      const d = playerStore.getCached(p.charId)?.stats?.dynamic;
      return d ? { hp: [d.hp.c, d.hp.b], mp: [d.mp.c, d.mp.b], ft: [d.ft.c, d.ft.b] } : undefined;
    },
    // A4/3.8: the context-menu report writes to the same queue as /report.
    report: async (doc) => moderation.reports.write({
      ts: new Date().toISOString(),
      reporter: doc.reporter,
      target: doc.target,
      reason: doc.reason,
      // What the two of them said: without it a moderator reading the queue has an
      // accusation and nothing to weigh it against. OT3-188: theirs, not the global ring.
      context: await moderation.chat.contextFor([doc.reporter.account, ...(doc.target.account ? [doc.target.account] : [])]),
    }),
  });
  socialRef = social;

  const trades = new Trades({
    findByName: (name) => roster.findByName(name),
    inventoryOf: (charId) => playerStore.getCached(charId)?.inventory ?? [],
    setInventory: (charId, inv) => playerStore.update(charId, (doc) => { doc.inventory = inv; }, 'now'),
    send: (p, event, body) => p.peer.sendEvent(event, body as JsLike),
    ledger: (e) => tradeLedger.write(e),
    noteAnomaly: (acct, kind) => moderation.noteAnomaly(acct, kind),
    binding,
    now: () => Date.now(),
  });

  const contentGate = new ContentGate(config.content.enforce);
  // Approved cosmetic mods (meshes/textures) may differ between players; record-bearing

  const ctx: ServerCtx = {
    worldPeer: () => worldPeerImpl(),
    peerFor: (ck) => peerForImpl(ck),
    isPeer: (p) => isPeerImpl(p),
    config,
    accounts,
    roster,
    content: contentGate,
    engine: new EngineGate(config.engine.enforce, config.engine.pin),
    loginLimiter: new IpRateLimiter(config.limits.loginPerMinPerIp),
    // Tickets are server-minted and unguessable; this bounds a flood, not a guess (connection.ts
    // checkAuthGate). 60 a minute covers a LAN party reconnecting after a restart.
    ticketLimiter: new IpRateLimiter(60),
    chatCtx,
    hooks,
    players: playerStore,
    stateCtx,
    world,
    combat,
    quests,
    social,
    trades,
    pvpConsent,
    busy,
    m7,
    admin,
    bans,
    resume,
    moderation,
    tickets,
    track,
    sessions,
    // Phase 4: one-shot scripted encounters replayed for a character who was not there.
    questSpawnsOnEntry: (player, cellKey) => questRepair.onCellEntry(player, cellKey),
    questRepair,
    worldId,
    // Scrollback on arrival: the server-wide conversation, plus world chat.
    // Ordinary ChatMessage events in the order they were said, so the client needs no new
    // handling — history is the same messages, earlier.
    replayChat: (player): void => {
      const lines = replayWindow(
        socialStore.recentChat('global', CHAT_HISTORY_REPLAY),
        socialStore.recentChat('server', CHAT_HISTORY_REPLAY),
        socialStore.recentChat('world', CHAT_HISTORY_REPLAY),
      );
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
    },
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
    // The multiplayer server proxies an operator's clicks to this game with the platform
    // credential; see gatewayPrincipal in net/admin/auth.ts. Loopback only.
    gatewayToken: config.gateway.serverToken,
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
      // OT3-191: the rank is the DASHBOARD role's (routes.ts hands 2 to every moderator;
      // a plain moderator is a rank-1 helper unless their account holds 2), never the
      // in-game rank of a character the operator happens to have online.
      const rank = actor.rank >= 3 ? 3 : actor.rank >= 2 ? dashboardRank('moderator', (await accounts.get(actor.accountKey))?.rank) : 0;
      const live = roster.activeForAccount(actor.accountKey);
      const online = live && (Object.create(live, { rank: { value: rank } }) as Player);
      const synthetic = online ?? ({
        id: -1,
        name: actor.name,
        accountKey: actor.accountKey,
        charId: actor.accountKey,
        rank,
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
      log('info', 'admin.console', { by: actor.accountKey, cmd, args: parts.join(' ').slice(0, 200) });
      return { ok: true, message };
    },
    commandCatalog: () => Object.entries(ADMIN_COMMANDS).map(([name, spec]) => ({
      name,
      usage: spec.usage,
      help: spec.help,
      minRank: spec.minRank,
      ...(name === 'tp' || name === 'tpto' ? { inGameOnly: true } : {}),
    })),

    recentLogs: (limit, filter) => logHistory(limit, filter),
    metricsSnapshot: () => summariseMetrics(),

    // Absent on other layouts, and the update routes say so honestly.
    clientDir,
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
    ...passwordReset({
      accounts, sessions: adminSessions, mail: mailCfg,
      base: () => lockerPublicBase(config.setup.domain, port, config.locker.publicBase),
      serverName: () => config.server.name,
    }),
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
      world: { id: worldId, mode: 'public' },
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
        // The roster's mute/unmute buttons were the only way to mute, and nothing showed
        // whether someone WAS muted.
        muted: socialRef?.isMuted(SocialStore.SERVER_MUTER, p.accountKey) ?? false,
      })),
    }),
    reports: async (limit) => ({
      reports: (await moderation.reports.list(Math.min(Math.max(1, limit || 20), 100))).map(reportView),
    }),
    action: async (kind, target, detail, by) => {
      const online = target === '' ? undefined : roster.activeForAccount(target.toLowerCase());
      // OT3-191: every action on a PERSON goes through the command table, so the dashboard
      // obeys the same rank ladder and outrank rule as /kick and lands in admin_audit. The
      // operator's rank comes from their account (operatorRank), not the route's role.
      const asStaff = async (cmd: string, args: string[], done: RegExp) => {
        const name = by || 'dashboard';
        const actor = { id: -1, name, accountKey: name.toLowerCase(), charId: '', ip: '(dashboard)',
          rank: await operatorRank(accounts, name), inWorld: false, peer: { disconnect: () => {}, send: () => {} } } as unknown as Player;
        const message = await admin.exec(actor, cmd, args);
        return { ok: done.test(message), message };
      };
      switch (kind) {
        case 'kick':
          if (!online) return { ok: false, message: `${target} is not online` };
          return asStaff('kick', [online.name, ...(detail ? [detail] : [])], /^Kicked /);
        case 'ban':
          return asStaff('ban', [target, ...(detail ? [detail] : [])], /^Banned /);
        case 'unban':
          return asStaff('unban', [target], /^Unbanned /);
        case 'mute':
          return asStaff('mute', [target, 'perm', ...(detail ? [detail] : [])], /^Muted /);
        case 'unmute':
          return asStaff('unmute', [target], /^Unmuted /);
        case 'broadcast':
          if (detail === '') return { ok: false, message: 'nothing to say' };
          broadcastChat(roster, { channel: 'server', text: detail });
          return { ok: true, message: 'broadcast sent' };
        case 'resetCell':
          await m7.resetCellNow(target);
          return { ok: true, message: `reset ${target}` };
        case 'respawnHere': {
          // WHERE SOMEBODY IS STANDING, rather than four numbers nobody knows.
          //
          // Respawn is a cell key plus a world-space X/Y/Z, and the settings page asked an
          // operator to type all four. Nobody knows the grid coordinates of Balmora, and the
          // shipped default is the DEMO's cell — respawn.ts already warns that it is wrong for
          // real content, which is an admission that the field is unusable as it stands.
          //
          // A dropdown of named cities would need a table of coordinates for every deployment's
          // content, and this server cannot read one: core/esm.ts parses the TES3 header and
          // nothing else, so it does not know what cells exist, let alone where in them the
          // ground is. Guessing would put players inside rock or out at sea.
          //
          // The player already solved it by walking there. This takes their live position,
          // which is by construction a place a person can stand, and works for vanilla, mods
          // and Tamriel Rebuilt alike without knowing anything about any of them.
          if (!online) return { ok: false, message: `${target} is not online` };
          if (!online.cellKey || !online.pose) {
            return { ok: false, message: `${target} has not finished loading into the world yet` };
          }
          const at = { cellKey: online.cellKey, x: online.pose.x, y: online.pose.y, z: online.pose.z };
          const saved = saveSection(opts.dataDir, 'rules', {
            respawnCellKey: at.cellKey, respawnX: at.x, respawnY: at.y, respawnZ: at.z,
          }, sharedDir);
          if (!saved.ok) return { ok: false, message: saved.error };
          log('warn', 'admin.respawn_moved', { ...at, from: target });
          return {
            ok: true,
            message: `respawn set to where ${target} is standing (${at.cellKey}) — it applies on restart`,
          };
        }
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
    // the whole world now, so this is normally 0 or 1.
    peerCount: simPeers.running,
    pvp: config.rules.pvp,
    mode: 'public',
    players: roster.humansInWorld().map((p) => ({
      id: p.id,
      name: p.name,
      cellKey: p.cellKey ?? null,
      // For the gateway (whose /status read is internal): "is this character in the world".
      ...(process.env.OMW_WORLD_ID ? { charId: p.charId } : {}),
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
    gateAdmin(adminRoutes, () => config.admin.allowFrom),
    // Before the locker: blob URLs carry their capability in the path, not a Bearer header.
    blobRoutes(lockerStorage instanceof FsStorage ? lockerStorage : undefined),
    // "This server hands out the files" — the wizard's other delivery answer. Reads the
    // stored answer per request, so switching it off in the dashboard stops the serving
    // without a restart.
    mwDataRoutes({
      gameDataDir: gameDataDir(sharedDir),
      // Re-read per request, like the delivery answer above: enabling a mod in the dashboard
      // should reach the next player to load the page, not the next restart.
      modDoc: () => presentMods(gameDataDir(sharedDir), readModDoc(sharedDir)),
      allowStockSwap: () => config.content.allowStockSwap,
      mayServe: esmOwnerGate(locker, lockerSessions),
    }),
    lockerRoutes({
      locker, sessions: lockerSessions,
      eraseSaves: (acct) => eraseSaves(sharedDir, acct, lockerStorage),
      baseFor: (req) => requestBase(req, config.locker.hosts, lockerBase),
    }),
    // Last: the player app, for any path nothing above claimed (issue #203).
    ...(clientDir ? [clientRoutes({
      clientDir,
    })] : []),
  )), () => (setupMode ? blockers : []));
  // Derived at scrape time from the roster, so no teardown path can strand the gauge.
  // humansInWorld, not inWorld: the sim peer is infrastructure. Counting it here would make
  // every world look like it has a player in it — the reason maxPlayers and the roster exclude
  // it too — and an operator reading this gauge for capacity would be reading one peer per
  // cluster as load.
  const unhooks: (() => void)[] = []; // metric collectors to release at close
  const unhookGauge = metrics.sessionsInWorld.addCollector(() => roster.humansInWorld().length);
  const backupStatus = join(opts.dataDir, 'backup-status.json');
  const unhookBackupAge = metrics.backupAgeSec.addCollector(() =>
    existsSync(backupStatus) ? Math.round((Date.now() - statSync(backupStatus).mtimeMs) / 1000) : -1);

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
  const gameData = detectGameData(gameDataDir(sharedDir), orderedContent(gameDataDir(sharedDir), sharedDir));
  log('info', 'gamedata.detect', { ok: gameData.ok, reason: gameData.reason });
  // Backlog 299: the peer's manifest is pinned with the server's own plugin hashes, so
  // 'strict' can tell a same-named, different-version plugin from the world's copy.
  // Read per call, so a dashboard change to a swap lands without a restart.
  const modStack = () => resolveMods(presentMods(gameDataDir(sharedDir), readModDoc(sharedDir)),
    { allowStockSwap: config.content.allowStockSwap });
  contentGate.hashes = () =>
    hashContentFiles(gameData, presentMods(gameDataDir(sharedDir), readModDoc(sharedDir)).mods, modStack());
  contentGate.swapped = () => new Map(modStack().swaps.map((s) => [s.file.toLowerCase(), s.name]));

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
  const setupMode = blockers.length > 0 && opts.requireGameData !== false;
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
    // Resources ship beside the binary (…/bin/openmw -> …/share/openmw/resources).
    const resources = join(dirname(config.simPeer.binary), '..', 'share', 'openmw', 'resources');
    // WITH THE MODS. The peer simulates the world the players are in, so it has to load the
    // same content they do. Without this it ran vanilla while every browser ran the mod list:
    // the two disagree about what exists, and ContentGate — which is there to catch exactly
    // that — would refuse every player from a server the operator had just configured.
    //
    // Read here rather than at boot, so the cfg written on a restart reflects whatever the
    // dashboard last saved.
    writeFileSync(join(cfgDir, 'openmw.cfg'),
      buildPeerCfg(gameData, resources,
        resolveMods(presentMods(gameDataDir(sharedDir), readModDoc(sharedDir)),
          { allowStockSwap: config.content.allowStockSwap })));
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
  // OT3-30: a world whose peer has ever reported its list starts pinned to it, so the gap
  // before this boot's peer says hello is not an adopt-first window for a modified client.
  // The peer's hello still re-pins (connection.ts), so a changed data folder wins.
  const lastList = cellStore.contentList();
  if (gameData.ok && lastList?.length) {
    contentGate.setAuthoritative(lastList.map((name, idx) => ({ name, idx, size: 0 })), false);
  }
  // ONE PEER, EVERY OCCUPIED CELL. A peer used to be one ~450 MB engine process per occupied
  // cell (3dd85a68), deployed because anchored cells LOADED but never TICKED: the engine's
  // animation/movement gate still measured range from the peer's own avatar. That gate is
  // fixed at the source now (mwmechanics/actorutil nearestSimDistanceSqr — every range check
  // measures from the nearest anchor), and STATUS.md measured the consolidation as free:
  // 8 anchored cells cost no more than 1, because the ESM store and every subsystem are
  // shared. So the fan-out was paying N processes for something one process already does.
  //
  // Anchors are WORLD POSITIONS — each player's live pose — not grid coordinates. A
  // cell-centre anchor covered its own cell but reached only ~3072 units into a neighbour
  // against the 7168 processing range, leaving a ring of loaded-but-frozen cells around
  // every anchor. Positions make coverage follow players exactly, like single-player.
  //
  // The supervisor keeps its multi-key machinery: it costs nothing and is the spill valve if
  // the scale ramp ever shows frame time going superlinear in anchored cells.
  // REGIONS (OT3-77/202). Each region has its own peer, keyed by region id; the default region
  // is 'world', so a deployment with no [[simPeer.regions]] is the one-peer world it always was.
  const regionMap = new RegionMap(config.simPeer.regions ?? []);
  ctx.regionOfCell = (cellKey) => regionMap.regionOf(cellKey);
  const SPARE_KEY = 'spare';
  // [simPeer].warmSpare: one extra peer, started and hello'd but holding nothing, promoted into
  // the first region that needs a peer (skips the ~11 s cold start). Only meaningful with 2+ regions.
  const wantSpare = (): boolean => regionMap.size > 1 && config.simPeer.warmSpare !== false;
  const lastPeerOfRegion = new Map<string, number>();
  const peerOfRegion = (region: string): Player | undefined => {
    const sys = roster.inWorld().filter((pp) => pp.system === true);
    const isRegionKey = (k: string | undefined): boolean => k !== undefined && regionMap.ids.includes(k);
    const chosen = sys.find((pp) => simPeers.keyOfAccount(pp.name) === region)
      // The default region also accepts a peer this supervisor did not spawn (the harness
      // pre-starts its own; an operator may too): any system peer not keyed to a region.
      ?? (region === regionMap.defaultId
        ? sys.filter((pp) => { const k = simPeers.keyOfAccount(pp.name); return !isRegionKey(k) && k !== SPARE_KEY; })
            .sort((a, b) => a.id - b.id)[0]
        : undefined);
    // A FLIP ORPHANS THE LOSER'S CELLS. When the supervisor's own peer joins beside one an
    // operator or the harness started, the answer changes instantly -- input, poses and bar
    // reports move to the new peer while every cell is still HELD by the old one, whose
    // batches are now rejected. Nothing released those cells until it disconnected, so the
    // world was unsimulated in exactly the cells that had a holder. Release on the change.
    const lastId = lastPeerOfRegion.get(region);
    if (chosen && lastId !== undefined && chosen.id !== lastId) {
      log('warn', 'simpeer.world_peer_changed', { region, from: lastId, to: chosen.id,
        note: 'releasing the previous peer cells so the new one can take them' });
      world.authorityReleaseEverything(lastId, undefined, false);
      // ...and hand the newcomer the characters it is now responsible for. Releasing the
      // loser's cells only frees them; without this the new peer takes them holding an
      // avatar for nobody, and every player in them freezes (see pushAvatarsToPeer).
      pushAvatarsToPeer(stateCtx, chosen);
    }
    if (chosen) lastPeerOfRegion.set(region, chosen.id);
    return chosen;
  };
  worldPeerImpl = (): Player | undefined => peerOfRegion(regionMap.defaultId);
  peerForImpl = (cellKey) => peerOfRegion(cellKey === undefined ? regionMap.defaultId : regionMap.regionOf(cellKey));
  // OT3-70: per-region capacity series. Peer load is measured on batch arrival (peers/peerload.ts);
  // held cells and sessions come straight from the state the pass already keeps.
  const peerLoad = new PeerLoad();
  const regionOfPeer = (peer: Player): string => {
    const k = simPeers.keyOfAccount(peer.name);
    return k !== undefined && regionMap.ids.includes(k) ? k : regionMap.defaultId;
  };
  ctx.notePeerBatch = (peer, n) => peerLoad.noteBatch(regionOfPeer(peer), Date.now(), n);
  allPeersImpl = () => regionMap.ids.map(peerOfRegion).filter((x): x is Player => x !== undefined);
  isPeerImpl = (p) => p.system === true && allPeersImpl().includes(p);
  // Anchors held past occupancy (idle-decay): cellKey -> last known position + expiry.
  // Walking a cell border must not flap the peer's grid; dropping an anchor is cheap.
  const heldAnchors = new Map<string, { x: number; y: number; z: number; until: number }>();
  // The exterior cells AROUND each player, held for their NPCs (cellKey -> expiry). Both
  // engines load and run the 3x3 around a player; holding only the middle cell left each
  // engine running its own AI for the eight around it, so NPCs across a cell border stood in
  // different places on the peer and on the player's screen, and the player's avatar walked
  // into NPCs they could not see (dev box, 2026-09-23). Held, the peer streams them and every
  // client puppets them (actors.lua attaches on the first ActorMoveBatch for an actor).
  const heldRing = new Map<string, number>();
  world.peerHolds = (cellKey) => heldAnchors.has(cellKey) || heldRing.has(cellKey);
  // Per-region peer bookkeeping (each peer is diffed against its own last pass).
  const regionRt = new Map<string, {
    claimed: Set<string>;               // cells this region's peer holds authority for (diffed, not re-entered)
    ring: Map<string, boolean>;         // the exterior ring around its anchors: has the peer been sent the record
    ringPeer?: number;                  // ring is tied to one peer id; a new peer starts from an empty ring
    placedPeer?: number;                // the peer id whose dummy has been placed (ONCE per peer)
    lastAnchorCells: string;            // log throttle: one simpeer.anchors line per change
    warnedUnsimulated: string;          // throttle for simpeer.cells_unsimulated
    sender: AnchorSender;               // which SimAnchors messages are worth sending (OT3-135)
    senderPeer?: number;
  }>();
  const rtOf = (region: string) => {
    let r = regionRt.get(region);
    if (!r) {
      r = { claimed: new Set(), ring: new Map(), lastAnchorCells: '', warnedUnsimulated: '', sender: new AnchorSender() };
      regionRt.set(region, r);
    }
    return r;
  };
  const lastRegionOf = new Map<number, string>(); // player id -> region as of the last pass (region.handoff)
  const lastExterior = new Map<number, string>(); // player id -> last exterior cell (learns interior doors)
  // Is the world actually being SIMULATED? Read live from the roster rather than kept as
  // state: a peer can arrive, die and be respawned, and the roster is the only thing that is
  // right at every moment. It also stays correct for an operator running their own peer
  // instead of one this supervisor spawned — bookkeeping about who we spawned would call
  // that world unsimulated forever and hold every join behind a loading screen.
  // NO PEER CONFIGURED AND NONE EVER SEEN = NOTHING IS COMING: say ready, or every join on a
  // peerless server (a test host, single-player) sits behind the client's settle hold for the
  // full ceiling (300 s since backlog 274 — #97 lost every no-peer scenario to it). Once an
  // operator's own peer has been here the roster is the answer again, so its outage is still
  // announced (325) and the client drops its peer-rules.
  let peerSeen = false;
  // Is the cell's region being SIMULATED? A cell with no cellKey yet belongs to the default
  // region. One region's peer dying leaves the others ready (OT3-205).
  ctx.simReady = (cellKey) => {
    const region = cellKey === undefined ? regionMap.defaultId : regionMap.regionOf(cellKey);
    const now = roster.inWorld().some((p) => {
      if (p.system !== true) return false;
      const k = simPeers.keyOfAccount(p.name);
      return k === region || (region === regionMap.defaultId && !regionMap.ids.includes(k ?? '') && k !== SPARE_KEY);
    });
    if (now) peerSeen = true;
    return now || (!config.simPeer.enabled && !peerSeen);
  };
  const simPeerPass = (): void => {
    if (!config.simPeer.enabled) return;
    // humansInWorld, NOT inWorld: the peer itself is in-world, so counting it would keep the
    // world looking busy forever and the reaper would never fire.
    // Bots excluded: they are visible players but need no simulation, and anchoring the peer
    // to a cell only a bot stands in would hold a headless engine on an empty world.
    const humans = roster.humansInWorld()
      .filter((p) => p.cellKey !== undefined && !p.bot);
    // THE PEER IS ALWAYS UP (OT3-131). One public world, booted with the gateway: its peer
    // starts on the first pass and is never idled for being empty, so a deploy's first join
    // (and every resume after it) lands on a world that already holds authority instead of
    // waiting out ~11 s of peer start. Empty, it simply holds nothing: the anchors are dropped
    // here and the claimed-diff below releases every cell it held.
    if (roster.humanCount === 0) {
      heldAnchors.clear();
      heldRing.clear();
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
    // A JUST-JOINED PLAYER'S CELL IS NOT YET WHERE THEY ARE. The client reports 0,0 for a few
    // dozen ms at join, before its restore places it (dev box, 2026-09-23: 0,0 at 19:01:12.580,
    // -2,-9 76 ms later). A cell change triggers this pass, which anchored 0,0: the peer loaded
    // and held the island's centre for the whole idle grace while the player was joining.
    // Anchoring waits JOIN_SETTLE_MS past the join; the chargen sanctuary still sees everyone.
    const JOIN_SETTLE_MS = 1_500;
    const settled = humans.filter((p) => p.joinedWorldAt === undefined || now - p.joinedWorldAt >= JOIN_SETTLE_MS);
    // FRESH POSITIONS EVERY PASS. 32 players x 3 floats every 5 s is nothing, and a stale
    // anchor position is the one thing that reintroduces frozen NPCs.
    for (const p of settled) {
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
    // An EXTERIOR outlives its last human by anchorIdleSec (a door hop, a reconnect). An
    // INTERIOR does not (backlog 382): every anchored interior is a whole cell the peer keeps
    // active, and a shop run co-anchoring three of them per city sent TR NPCs into invisible
    // walls. Its authority and state persist; only the anchor goes, the pass its last human
    // leaves.
    const occupied = new Set(humans.map((p) => p.cellKey!));
    for (const [ck, a] of [...heldAnchors]) {
      if (a.until <= now || (!parseExterior(ck) && !occupied.has(ck))) heldAnchors.delete(ck);
    }

    // THE RING AROUND EACH PLAYER. Safe now where it was not when this was narrowed to one
    // cell: every player is an anchor at their OWN position (below), so every NPC a player's
    // engine processes (within its processing range of that player) is within the same range
    // of an anchor on the peer -- the peer simulates everything it holds that anyone can see.
    // Never within one cell of someone still in character creation: the sanctuary around
    // the opening (see inChargenCells above) must stay unheld, neighbours included.
    const chargenNear = (ck: string): boolean => {
      if (isChargenCell(ck) || inChargenCells.has(ck)) return true;
      const e = parseExterior(ck);
      if (!e) return false;
      for (const c of inChargenCells) {
        const f = parseExterior(c);
        if (f && Math.abs(f.x - e.x) <= 1 && Math.abs(f.y - e.y) <= 1) return true;
      }
      return false;
    };
    for (const p of settled) {
      if (p.inChargen === true) continue;
      const e = parseExterior(p.cellKey!);
      if (!e) continue;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const n = `${e.x + dx},${e.y + dy}`;
          if (!heldAnchors.has(n) && !chargenNear(n)) heldRing.set(n, now + idleMs);
        }
      }
    }
    for (const [ck, until] of [...heldRing]) {
      if (until <= now || heldAnchors.has(ck) || chargenNear(ck)) heldRing.delete(ck);
    }

    // EVERY held cell is covered, interior or exterior, by ONE peer. Exteriors anchor by
    // position; interiors anchor by NAME, because an interior has no coordinate. Both are
    // held without the peer standing in them, so players spread across the map are all
    // simulated from a single process. Before interiors could be anchored, an indoor quest
    // simply never advanced — chargen is entirely indoors, which is why it stalled at the
    // census office every time.
    const held = new Set<string>([...heldAnchors.keys(), ...heldRing.keys()]);
    // LEARN WHICH EXTERIOR EACH INTERIOR IS ENTERED FROM: an interior belongs to its door's region.
    for (const p of humans) {
      const ck = p.cellKey!;
      if (parseExterior(ck)) lastExterior.set(p.id, ck);
      else { const from = lastExterior.get(p.id); if (from !== undefined) regionMap.learnDoor(ck, from); }
      // A border crossing is today's authority handoff between two region peers; logged for
      // deploy/mp-health.py. Only with 2+ regions: one region has no borders.
      if (regionMap.size > 1) {
        const to = regionMap.regionOf(ck);
        const was = lastRegionOf.get(p.id);
        if (was !== undefined && was !== to) log('info', 'region.handoff', { from: was, to, name: p.name, cellKey: ck });
        lastRegionOf.set(p.id, to);
      }
    }
    const here = new Set(humans.map((p) => p.id));
    for (const id of [...lastExterior.keys()]) if (!here.has(id)) lastExterior.delete(id);
    for (const id of [...lastRegionOf.keys()]) if (!here.has(id)) lastRegionOf.delete(id);
    // ONE ANCHOR PER PLAYER, not per cell. Keyed by cell, the last player processed won, so
    // two players at opposite edges of one cell (up to 11,585 u apart, past the 7168 u
    // processing range) left the NPCs beside one of them held but unsimulated -- frozen
    // puppets on that player's screen. A cell whose players have all gone keeps its last
    // position until idle-decay, as before.
    const anchorPlayers: AnchorPlayer[] = [];
    const anchoredByPlayer = new Set<string>();
    for (const p of settled) {
      const ck = p.cellKey!;
      if (!heldAnchors.has(ck) || !parseExterior(ck) || !p.pose) continue;
      anchorPlayers.push({ cellKey: ck, x: p.pose.x, y: p.pose.y, z: p.pose.z });
      anchoredByPlayer.add(ck);
    }
    for (const ck of [...heldAnchors.keys()].sort()) {
      const a = heldAnchors.get(ck)!;
      if (parseExterior(ck) && !anchoredByPlayer.has(ck)) anchorPlayers.push({ cellKey: ck, x: a.x, y: a.y, z: a.z });
    }
    // The split: each region's peer gets its own SimAnchors (a player near a border anchors both
    // sides), and claims only the cells it owns.
    const parts = partitionAnchors(regionMap, anchorPlayers, held);

    // Start, promote or idle each region's peer. The default region is always up (OT3-131);
    // others run while they own a held cell. A warm spare is promoted in place of a cold start.
    for (const r of regionMap.ids) {
      if (r === regionMap.defaultId || parts.get(r)!.claim.length > 0) {
        if (r !== regionMap.defaultId && !simPeers.has(r) && simPeers.promote(SPARE_KEY, r)) {
          log('info', 'simpeer.spare_promoted', { region: r });
        }
        // Where the peer's own avatar boots: a real player's position, so a cold boot lands on
        // ground that exists. Exteriors only (backlog 382).
        const stand = humans.find((p) => p.cellKey !== undefined && heldAnchors.has(p.cellKey)
          && parseExterior(p.cellKey) !== null && regionMap.regionOf(p.cellKey) === r);
        simPeers.ensure(r, stand
          ? { cellKey: stand.cellKey!, x: stand.pose?.x ?? 0, y: stand.pose?.y ?? 0, z: stand.pose?.z ?? 0 }
          : undefined);
      } else simPeers.markIdle(r);
    }
    if (wantSpare()) simPeers.ensure(SPARE_KEY);
    // Retire any peer that is neither a region nor the spare (the fan-out era, or an operator's
    // stale supervisor state).
    for (const k of simPeers.keys()) if (k !== SPARE_KEY && !regionMap.ids.includes(k)) simPeers.markIdle(k);
    simPeers.sweep();

    for (const r of regionMap.ids) {
      const part = parts.get(r)!;
      const rt = rtOf(r);
      const own = new Set(part.claim);
      // The supervisor's own spawn is preferred, but ANY connected system peer serves the default
      // region (the harness pre-starts its own; an operator may too). Input forwarding resolves
      // the peer this way (connection.ts).
      const peerPlayer = peerOfRegion(r);
      if (!peerPlayer) {
        // The peer being down is a GENUINE anomaly: a process that is starting, crashed, or
        // backing off. Say so once per change; authority re-enters cleanly when it returns.
        rt.claimed.clear();
        const line = part.claim.join(',');
        if (part.claim.length > 0 && rt.warnedUnsimulated !== line) {
          rt.warnedUnsimulated = line;
          log('warn', 'simpeer.cells_unsimulated', {
            region: r,
            unsimulated: line,
            note: 'the region peer is not up (starting, crashed, or in restart backoff)',
          });
        }
        continue;
      }
      rt.warnedUnsimulated = '';

      // THE DUMMY IS PLACED ONCE, THEN LEFT ALONE. It used to follow the first player's cell, and
      // every follow was a peer cell change: authority released and re-claimed around it, the
      // actors' AI packages reset by the teleport ("moving very slowly, everything is strange",
      // dev box 2026-09-23). Nothing needs it to follow: what the peer simulates is the anchor
      // list. A new peer is placed afresh.
      const stand = humans.find((p) => p.cellKey !== undefined && heldAnchors.has(p.cellKey)
        && parseExterior(p.cellKey) !== null && regionMap.regionOf(p.cellKey) === r);
      const place = stand
        ? { cellKey: stand.cellKey!, x: stand.pose?.x ?? 0, y: stand.pose?.y ?? 0, z: stand.pose?.z ?? 0 }
        : undefined;
      const placeNow = place !== undefined && rt.placedPeer !== peerPlayer.id;
      if (rt.senderPeer !== peerPlayer.id) { rt.sender.reset(); rt.senderPeer = peerPlayer.id; }
      // OT3-135: the engine rebuilds its grid only when the derived cell set changes, so a resend
      // of an unchanged list is pure traffic. Send on a membership change, a move past
      // ANCHOR_DRIFT_UNITS, the dummy placement, or the heartbeat (a peer that missed one converges).
      if (rt.sender.shouldSend({ anchors: part.anchors, interiors: part.interiors }, now, placeNow)) {
        if (placeNow) rt.placedPeer = peerPlayer.id;
        peerPlayer.peer.sendEvent('SimAnchors', { anchors: part.anchors, interiors: part.interiors, ...(placeNow ? { place } : {}) });
      }

      // AUTHORITY FOR EVERY CLAIMED CELL, on the owning region's peer. Diffed so epochs are stable.
      for (const gone of [...rt.claimed].filter((c) => !own.has(c))) {
        world.authorityLeave(peerPlayer.id, gone, true);
        rt.claimed.delete(gone);
      }
      for (const ck of part.claim) {
        // Re-assert even a CLAIMED cell whose holder is no longer the peer: the peer's own
        // avatar cell change (handleCellChange) releases the cell it walked out of, and the
        // claimed-diff alone would never re-enter it. authorityEnter is idempotent.
        if (rt.claimed.has(ck) && world.holderOf(ck) === peerPlayer.id) continue;
        world.authorityEnter(peerPlayer, ck);
        rt.claimed.add(ck);
      }

      // THE RING'S RECORD, ONE PASS LATE. From here on the peer hears every relay for the
      // exteriors around its anchors (worldstate hears), but what happened there BEFORE -- the
      // door opened an hour ago -- lives only in the cell doc. Sent on the pass AFTER a cell
      // joins the ring, not this one: SimAnchors only REQUESTS the grid change, a record that
      // lands first resolves no refs and is dropped. Re-sent only when a cell leaves the ring
      // and comes back.
      if (rt.ringPeer !== peerPlayer.id) { rt.ring.clear(); rt.ringPeer = peerPlayer.id; }
      const inRing = new Set<string>();
      for (const ck of part.claim) {
        const e = parseExterior(ck);
        if (!e) continue;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const n = `${e.x + dx},${e.y + dy}`;
            if (!held.has(n)) inRing.add(n);
          }
        }
      }
      for (const ck of [...rt.ring.keys()]) if (!inRing.has(ck)) rt.ring.delete(ck);
      for (const ck of inRing) {
        const sent = rt.ring.get(ck);
        if (sent === undefined) rt.ring.set(ck, false);
        else if (!sent) { world.sendCellState(peerPlayer, ck); rt.ring.set(ck, true); }
      }

      // A COUNT, not a roll call (OT3-135): the line used to name every occupant and the whole
      // cell list, and grew with the player count on every change.
      const anchorLine = part.claim.join(',');
      if (anchorLine !== rt.lastAnchorCells) {
        rt.lastAnchorCells = anchorLine;
        noteAnchorsChanged(now); // the peer is about to load cells: no silence verdict for a while (383)
        log('info', 'simpeer.anchors', {
          world: worldId, region: r, exteriors: part.anchors.length, interiors: part.interiors.length,
          occupied: humans.filter((p) => regionMap.regionOf(p.cellKey!) === r).length,
          simulating: part.claim.length,
        });
      }
    }
  };
  // Every 2 s (was 5): anchors are player positions, and a running player covers ~1000 u
  // between passes at 5 s -- the edge of the peer's processing range trailing the edge of
  // theirs. The pass is diffed (authority, ring, the log line), so a shorter one costs little.
  // OT3-164: the peer vetoes player damage on story actors (companion.lua, combat.lua); this
  // tells it who may. Every pass, not diffed: the peer maps playerId -> avatar on receipt and an
  // avatar spawned since the last one needs mapping. A few hundred bytes every 2 s.
  const pushStoryLicence = (): void => {
    if (contentTable.storyActors.size === 0) return;
    const journalOf = (p: { charId: string }) => playerStore.getCached(p.charId)?.journal ?? {};
    const humans = roster.humansInWorld().filter((p) => !p.bot).map((p) => ({
      id: p.id,
      journal: journalOf(p),
      party: (socialStore.partyOf(p.accountKey)?.members ?? [])
        .filter((a) => a !== p.accountKey)
        .map((a) => roster.activeForAccount(a))
        .filter((m): m is Player => m !== undefined)
        .map(journalOf),
    }));
    const licence = contentTable.storyLicence(humans);
    for (const peer of allPeersImpl()) peer.peer.sendEvent('StoryLicense', licence);
  };
  const simPeerTick = setInterval(() => { simPeerPass(); pushStoryLicence(); social.pushPartyUpdates(); titles.tick(); busy.sweep((id) => roster.get(id)); }, 2_000);
  // A peer finishing its hello should not wait up to a full tick to be put to work —
  // that is 5s of the player holding a loading screen for no reason.
  ctx.onPeerJoined = () => simPeerPass();
  // The joiner's row goes out at once, not at the next beat: the world it may have left a
  // session in evicts that session on ITS next beat, and the write is what it keys on.
  ctx.onPlayerJoined = (p) => {
    if (p.system || p.bot) return;
    markPlayed();
    try { socialStore.setPresence(p.accountKey, presenceWorld, p.name, p.cellKey, false, Date.now(), 'public', p.charId); }
    catch (err) { log('warn', 'presence.join_write_failed', { error: String(err) }); }
  };
  simPeerTick.unref();
  metrics.simPeerRunning.addCollector(() => simPeers.running);
  const unhookRegionMetrics = [
    metrics.opQueueDepth.addCollector(() => world.queueDepth),
    metrics.sessionsInRegion.addCollector(() => {
      const n = new Map<string, number>(regionMap.ids.map((r) => [r, 0]));
      for (const p of roster.humansInWorld()) {
        const r = regionMap.regionOf(p.cellKey ?? '');
        n.set(r, (n.get(r) ?? 0) + 1);
      }
      return [...n].map(([region, value]) => ({ labels: { region }, value }));
    }),
    metrics.peerUp.addCollector(() => regionMap.ids.map((region) => ({ labels: { region }, value: peerOfRegion(region) ? 1 : 0 }))),
    metrics.peerHeldCells.addCollector(() => regionMap.ids.map((region) => ({ labels: { region }, value: rtOf(region).claimed.size }))),
    metrics.peerFrameMs.addCollector(() => regionMap.ids.flatMap((region) => {
      const s = peerLoad.sample(region);
      return s ? [{ labels: { region, quantile: '0.5' }, value: s.p50 }, { labels: { region, quantile: '0.99' }, value: s.p99 }] : [];
    })),
    metrics.peerSimReal.addCollector(() => regionMap.ids.flatMap((region) => {
      const s = peerLoad.sample(region);
      return s ? [{ labels: { region }, value: s.simReal }] : [];
    })),
    metrics.peerActiveActors.addCollector(() => regionMap.ids.flatMap((region) => {
      const s = peerLoad.sample(region);
      return s ? [{ labels: { region }, value: s.actors }] : [];
    })),
  ];
  unhooks.push(...unhookRegionMetrics);
  // A WEDGED PEER IS RESTARTED, NOT JUST LOGGED (backlog 324). Its reader thread still pongs,
  // so the socket never drops and every cell it holds stays frozen for ever; when authority
  // sees all its actor-bearing cells silent, stop it -- the exit is a crash to the supervisor
  // and the ordinary ensure() pass respawns it after the backoff. An unmanaged peer (the
  // harness's own) is not ours to kill.
  setOnSilentPeer((holderId, cells) => {
    // OT3-205: only the SILENT region's peer is restarted; the others keep simulating.
    const region = simPeers.keyOfAccount(roster.get(holderId)?.name ?? '');
    if (region === undefined || !regionMap.ids.includes(region)) return;
    log('error', 'simpeer.restart_silent', { holderId, region, cells: cells.length });
    simPeers.stop(region);
  });

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
      // IP_CAP, not RATE: RATE is terminal on the client (a flood is not re-litigated by a
      // retry), but for a player this is almost always their own dying socket after a wifi
      // blip still counting against the address for a few seconds. The client retries this one.
      if (ws.readyState === WebSocket.OPEN) ws.send(disconnectMsg('IP_CAP', 'too many connections from your address'));
      ws.close(1008, 'IP_CAP');
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
  const moveBroadcaster = new MoveBroadcaster(roster, undefined, interest,
    (recipient, sender) => socialStore.partyOf(recipient.accountKey)?.members.includes(sender.accountKey) === true);
  moveBroadcaster.start();
  ctx.relayPose = (p) => moveBroadcaster.relayNow(p);
  m7.start(); // clock ticking + cell-reset sweep before plugins register schedules
  hooks.serverStart();
  // SERVER-WIDE PRESENCE. Each world publishes its own occupants into the shared store so
  // every other world can answer "who is online?" for the whole server rather than for its own
  // process — friends in another world used to read as offline, party members had no location,
  // and the Players list showed one world's population as if it were everyone. Refreshed on a
  // heartbeat and read with a TTL, so a world that dies without cleaning up ages out.
  const presenceWorld = worldId ?? 'default';
  // ONE CHARACTER, ONE WORLD. The in-process rule is "the newcomer wins" (SUPERSEDED, in
  // connection.ts); across processes nothing enforced it, and the same character in two
  // worlds meant two sessions flushing one doc last-writer-wins -- an inventory from one tab
  // under a position from the other. The presence row is the arbiter: a row another world
  // wrote AFTER this session joined means the character was opened there, and this session
  // is the one to drop. Checked on the heartbeat, so the overlap is at most one beat.
  const presenceWritten = new Map<string, { sig: string; at: number }>();
  const PRESENCE_REFRESH_MS = 20_000; // the row's TTL is 30 s (social.ts PRESENCE_TTL_MS)
  const publishPresence = (): void => {
    const now = Date.now();
    for (const p of roster.inWorld()) {
      if (p.system) continue; // the sim peer is infrastructure, not a player
      const row = p.bot ? undefined : socialStore.presenceOf(p.accountKey);
      // Same CHARACTER only (backlog 334): char A in world X and char B (same account) in Y
      // are two players, not a duplicate. A pre-334 row without char_id still supersedes.
      if (row && !row.offline && row.world !== presenceWorld && row.updatedAt > (p.joinedWorldAt ?? 0)
        && (row.charId === undefined || row.charId === p.charId)) {
        log('info', 'presence.superseded_elsewhere', { account: p.accountKey, name: p.name, by: row.world });
        p.peer.disconnect('SUPERSEDED', 'this character was opened in another world');
        continue;
      }
      // OT3-76: a row is rewritten when it CHANGED, or before the readers' TTL would age it out
      // (PRESENCE_REFRESH_MS) -- not for every player on every beat.
      const sig = `${p.name}|${p.cellKey ?? ''}|${p.charId}|${p.joinedWorldAt ?? 0}`;
      const prev = presenceWritten.get(p.accountKey);
      if (prev && prev.sig === sig && now - prev.at < PRESENCE_REFRESH_MS) continue;
      socialStore.setPresence(p.accountKey, presenceWorld, p.name, p.cellKey, p.bot === true, now, 'public', p.charId);
      presenceWritten.set(p.accountKey, { sig, at: now });
    }
    for (const acct of presenceWritten.keys()) if (!roster.activeForAccount(acct)?.inWorld) presenceWritten.delete(acct);
  };
  // OT3-76: THE 10 s FULL PlayerList IS GONE. broadcastServerRoster sent every human a per-recipient
  // list of everyone online on every beat -- O(N) bytes each, O(N^2) in all, with nobody doing
  // anything. Joiners still get the list once (Roster.joinWorld) and join/leave are announced live;
  // what moves between beats is who is where, and that goes as a PresenceDelta to the friends and
  // party mates of whoever changed (Social.presenceDeltas). An idle server sends nothing.
  const broadcastServerRoster = (): void => { social.presenceDeltas(); };

  publishPresence();
  const presenceTick = setInterval(() => {
    // WRAPPED, BECAUSE A THROW HERE KILLED THE WHOLE WORLD. Everything below writes to the
    // shared social database, which every world process has open at once. A synchronous throw
    // out of a timer callback is an uncaughtException, and main.ts turns that into
    // process.exit(1) — so one contended write ejected every player in this world. Presence is
    // a heartbeat: missing a beat is survivable, and the next one is 10 seconds away.
    try {
      // The friend and party panels are pushed on RELATIONSHIP changes, which never fire when a
      // member simply walks into another world — so they kept saying "Offline" about someone
      // standing in plain sight. Presence moves on this heartbeat; the views follow it. Its own
      // try: it is also how a friend request reaches a player in another world, and a contended
      // presence write must not skip it (s136 #175).
      try { publishPresence(); broadcastServerRoster(); } catch (err) { log('warn', 'presence.publish_failed', { error: String(err) }); }
      social.refreshPresenceViews();
      // Expired friend requests and invites. Swept here rather than on their own timer:
      // this is already the once-per-10s social heartbeat, and sweepExpired had NO production
      // caller at all — only a test — so the rows accumulated forever.
      socialStore.sweepExpired(Date.now());
      quests.expireIdleDialogue(); // OT3-168
      socialStore.prunePresence(Date.now());
      // A BAN REACHES EVERY WORLD. /ban in world A wrote the shared bans.db and kicked the
      // roster of A; a guest sitting in world B played on until they next disconnected.
      // Every world checks its own roster against the shared list on this same beat.
      for (const p of roster.inWorld()) {
        if (p.system || p.bot) continue;
        if (bans.isAccountBanned(p.accountKey)) {
          log('info', 'ban.reached_world', { account: p.accountKey, name: p.name });
          p.peer.disconnect('BANNED', 'this account is banned');
        }
      }
    } catch (err) {
      log('warn', 'presence.tick_failed', { error: String(err) });
    }
  }, opts.presenceMs ?? 10_000);
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
      isPublic: true, // the one world is where bots hang out (OT3-31)
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
    admin,
    roster,
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
      schedule.stop();
      unhookGauge();
      for (const u of unhooks) u();
      unhookBackupAge();
      unhookBufferedGauge();
      // The test suite builds dozens of servers in one process; a subscriber left behind
      // would keep a closed server's config alive and fire on the next server's log lines.
      unhookNotifier();
      clearInterval(simPeerTick);
      simPeers.stopAll(); // never leave an engine running after the server it fed is gone
      moveBroadcaster.stop();
      await m7.stop();
      hooks.serverStop();
      for (const conn of [...connections]) conn.disconnect('SHUTDOWN', 'server shutting down');
      // AFTER the disconnect loop, not before: every cleanup calls social.onLeave, which arms
      // a fresh presence grace timer -- exactly the timers stop() had just cleared. Those
      // timers then fire against a store shutdown has closed, the write is dropped, and every
      // player is left with offline_since NULL: friends see them "online" in a world that no
      // longer exists, until the 5-minute staleness rule catches up.
      social.stop(); // pending presence timers would keep the process alive
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
      //
      // BOUNDED. track() accepts anything, including a promise that reaches the network, and
      // an unbounded drain hands the gateway's stop-grace timer a hang: SIGKILL then loses
      // everything this drain exists to protect -- the opposite of its purpose. Flush what we
      // have and say what was still outstanding.
      const drained = await Promise.race([
        (async () => { while (inFlight.size) await Promise.allSettled([...inFlight]); return true; })(),
        new Promise<false>((r) => setTimeout(() => r(false), 10_000).unref?.()),
      ]);
      if (!drained) {
        log('warn', 'server.drain_timeout', { stillInFlight: inFlight.size,
          note: 'flushing anyway; a tracked write did not settle within 10s' });
      }
      await accounts.flush();
      await playerStore.flushAll();
      await bans.flush();
      await moderation.flush();
      // Now nothing is left to write. A store outlives every writer to it.
      socialStore.close();
      await accounts.close();
      await playerStore.close();
      await cellStore.close();
      await recordStore.close();
      // The disconnects above parked every in-world session: hand them to the next process.
      try { const n = resume.save(resumeFile); if (n > 0) log('info', 'resume.saved', { tickets: n }); }
      catch (err) { log('warn', 'resume.save_failed', { error: String(err) }); }
      resume.clear();
      oidc.close();
      tickets.clear();
      log('info', 'server.stop', {});
    },
  };
}
