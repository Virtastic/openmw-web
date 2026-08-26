// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Composition root: wires config, stores, gates, plugins, HTTP and WS into a running
// server. main.ts is the CLI face; tests call startServer() directly.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig, type Config, type DeepPartial } from './config';
import { AccountStore } from './core/accounts';
import { AttioHook } from './integrations/attio';
import { ContentTable } from './core/content-table';
import { PartyRules } from './core/party-rules';
import { QuestRepair } from './core/quest-repair';
import { adminDashboardRoutes } from './net/admin-http';
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
import { createHttpServer, setTrustCloudflareIp, type HttpRoute } from './net/http';
import { OidcService } from './auth/oidc';
import { IdentityStore, LoginTicketStore, SessionIndex } from './auth/identities';
import { createAuthRoutes } from './auth/routes';
import { ensureVanillaManifest } from './data/vanilla-manifest';
import { Locker, loadVanillaManifest } from './data/locker';
import { lockerStorageFrom, blobRoutes, FsStorage } from './data/fsstorage';
import { saveRoutes, eraseSaves } from './data/save-routes';
import { lockerRoutes } from './data/locker-routes';
import { LockerSessionStore } from './auth/identities';
import { IpConnTracker, IpRateLimiter } from './net/ratelimit';
import { disconnectMsg } from './proto/session';
import { log } from './log';
import { startTestBots } from './dev/testbots';
import { metrics } from './metrics';
import { SimPeerSupervisor } from './core/simpeer';
import { WorldBrowser } from './core/worldbrowser';
import { parseExterior, isChargenCell } from './core/movement';
import { detectGameData, findPeerBinary, gameDataDir, buildPeerCfg, buildPeerSettings } from './core/gamedata';

export const VERSION = '1.1.0';

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
  worldMode?: string; // 'public' | 'private' | 'party'
  worldOwner?: string; // accountKey; '' = unowned (public)
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
  let worldMode = opts.worldMode ?? process.env.OMW_WORLD_MODE ?? 'public';
  const worldModeAtBoot = worldMode;

  // THE SHARED LOBBY'S RULE FLOOR.
  //
  // The gateway's public world is a crowd of strangers with no stake in each other's game, and
  // the shipped defaults are tuned for the opposite case — a handful of friends on a
  // self-hosted server. Two of them are actively wrong in a lobby, and one of them the code
  // already CLAIMED to enforce and did not (maySkipTime's comment read "Public worlds never
  // skip time" while it read a config value that defaults to "anyone").
  //
  // The predicate is deliberately `OMW_WORLD_ID && public`, not `public` — the same one
  // lobbyWorld and chargenGate use. A standalone self-hosted server also defaults to
  // worldMode 'public', but it IS that operator's real game, and imposing lobby rules on it
  // would be this file overruling their config for no reason.
  //
  // A FLOOR, NOT AN OVERRIDE: an operator who has stated a value in config.toml keeps it.
  // Only the shipped defaults are replaced, so this cannot silently undo a deliberate choice.
  const isSharedLobby = !!process.env.OMW_WORLD_ID && worldModeAtBoot === 'public';
  if (isSharedLobby) {
    const stated = config.stated ?? new Set<string>();
    // One stranger must not fast-forward a hundred people into the night.
    if (!stated.has('rules.timeSkip')) config.rules.timeSkip = 'off';
    // Give the lobby something to do that is not chat. Wilderness-only, so towns, shops and
    // guildhalls stay places you can stand still in; party members are already exempt.
    if (!stated.has('rules.pvp')) config.rules.pvp = true;
    if (!stated.has('rules.pvpZone')) config.rules.pvpZone = 'wilderness';
    log('info', 'world.lobby_rules', {
      timeSkip: config.rules.timeSkip, pvp: config.rules.pvp, pvpZone: config.rules.pvpZone,
    });
  }

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
  // LOBBY MODE for the gateway's shared world: character docs are read-only there, so nothing
  // looted, dropped or lost in the lobby follows anyone home. Same predicate as the rule floor
  // above and as ctx.lobbyWorld below — a STANDALONE public server is somebody's real game and
  // must keep saving. Retention matches the resume window: coming back inside it is a
  // reconnect, past it you get your real character.
  const playerStore = new PlayerStore(sharedDir, worldId, {
    lobby: isSharedLobby,
    lobbyRetainMs: Math.max(0, config.login.resumeWindowSec) * 1000,
  });
  if (isSharedLobby) log('info', 'world.lobby_persistence', { writes: 'discarded' });
  // Onboarding CRM capture. Env var wins over toml so the key can stay out of config files
  // in deployments; empty = inert.
  const attio = new AttioHook({
    apiKey: process.env.ATTIO_API_KEY ?? config.integrations.attioApiKey,
    baseUrl: config.integrations.attioBaseUrl,
    dataDir: sharedDir,
  });
  // The shared world does NOT restock containers on reset. Its cells reset on a timer and
  // what a character carries now follows them home, so restocking is an item faucet: loot,
  // wait, loot again. A campaign world still restocks, or it stays stripped forever.
  const cellStore = new CellStore(opts.dataDir, worldModeAtBoot !== 'public');
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
    // The rule follows the WORLD's nature, not just the toml: a public realm resets by
    // construction, which is exactly what makes droppable uniques a faucet.
    noDrop: config.economy.noDrop || worldMode === 'public',
  });
  const startedAt = Date.now();
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
    // Lobby only. Everywhere else a dropped item is somebody's property and wiping it would be
    // destroying real progress; in the lobby nothing can ever leave, so the item on the ground
    // could never have become anyone's. See M7.sweepLitter.
    ...(isSharedLobby ? { litterSweepSec: config.cellReset.litterSweepSec } : {}),
    isMapShared: () => hooks.shareFamily('map'),
    // Public worlds never skip time; party worlds let the leader decide for the group.
    maySkipTime: (player) => {
      const policy = config.rules.timeSkip;
      if (policy === 'anyone') return { may: true, why: '' };
      if (policy === 'off') return { may: false, why: 'time does not skip in this world' };
      const members = socialRef?.partyMembersOf(player.accountKey) ?? [];
      if (members.length === 0) return { may: true, why: '' }; // solo: your world, your clock
      const view = socialRef?.partyView(player.accountKey);
      return view && view.leader === player.accountKey
        ? { may: true, why: '' }
        : { may: false, why: 'only your party leader can rest for the group' };
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
    // Phase 3 rule helpers (PvP zoning + party friendly-fire exemption).
    arePartied: (aId, bId) => {
      const a = roster.get(aId);
      const b = roster.get(bId);
      if (!a || !b) return false;
      return socialRef?.partyMembersOf(a.accountKey).includes(b.accountKey) ?? false;
    },
    cellOfPlayer: (playerId) => roster.get(playerId)?.cellKey,
    posOfPlayer: (playerId) => {
      const p = roster.get(playerId);
      if (!p || p.cellKey === undefined || !p.pose) return undefined;
      return { cellKey: p.cellKey, x: p.pose.x, y: p.pose.y, z: p.pose.z };
    },
    partyOfPlayer: (playerId) => {
      const me = roster.get(playerId);
      if (!me) return [];
      const accts = socialRef?.partyMembersOf(me.accountKey) ?? [];
      return roster.humansInWorld()
        .filter((p) => p.id !== playerId && accts.includes(p.accountKey))
        .map((p) => p.id);
    },
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
  // How much scrollback a newcomer is handed. Enough to see what the room is talking about,
  // short enough that a join is not a wall of text.
  // Long enough to cover a world switch (a page reload plus engine boot, tens of seconds on a
  // cold cache) and short enough that a genuine quit does not leave a ghost party standing.
  const PARTY_DISCONNECT_GRACE_MS = 90_000;
  const CHAT_HISTORY_KEEP = 200;
  const CHAT_HISTORY_REPLAY = 60;
  const commandCtx: CommandContext = {
    roster,
    // Mutes are enforced at DELIVERY (chat.ts), not in the client: a mute a modified
    // client can ignore is not a mute.
    isMuted: (listener, speaker) => socialRef?.isMuted(listener, speaker) ?? false,
    partyOf: (accountKey) => socialRef?.partyMembersOf(accountKey) ?? [],
    // Opt-in per deployment: a crowded public world wants proximity say, a co-op session
    // very much does not (friends spread across the map must still be able to talk).
    sayProximity: config.rules.sayScope === 'proximity',
    // SCROLLBACK. Only the channels a newcomer may legitimately replay: 'global' and 'server'
    // are the server-wide conversation, and a party's own lines are scoped to that party.
    // 'say' is proximity (replaying a conversation from a cell you were not in is noise, and
    // in a public world it is a privacy leak), and 'whisper' is nobody else's business.
    history: (player, channel, text) => {
      const scope = channel === 'party'
        ? (socialRef?.partyIdOf(player.accountKey) ?? '')
        : '';
      if (channel === 'party' && scope === '') return; // no party, nothing to scope it to
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

  const stateCtx: StateCtx = {
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
    maxHitDamage: config.limits.maxHitDamage,
    holderOf: (cellKey) => world.holderOf(cellKey),
    epochOf: (cellKey) => world.epochOf(cellKey),
    allowPlayerHit: (attacker, victimId, name) => {
      // A quarantined account cannot bring declared stats to bear on another player in the
      // shared world. Checked before the plugin gate: this is not a rule an operator opts out
      // of by swapping the pvp plugin.
      if (worldModeAtBoot === 'public' && isQuarantined(attacker.accountKey)) {
        metrics.containedActions.inc({ action: 'pvp' });
        return false;
      }
      return hooks.playerHit({ id: attacker.id, name: attacker.name, rank: attacker.rank }, victimId, name);
    },
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
    // Where a journal advance is persisted. The same distinction the lobby rule draws:
    // a GATEWAY-managed public world is the shared lobby and persists nothing, while a
    // standalone single-world server has no owner but IS the player's real game.
    journalTarget: (player) => {
      if (worldOwner !== '') return roster.activeForAccount(worldOwner)?.charId;
      const isLobby = !!process.env.OMW_WORLD_ID && worldModeAtBoot === 'public';
      return isLobby ? undefined : player.charId;
    },
    ownerCharId: () => (worldOwner === '' ? undefined : roster.activeForAccount(worldOwner)?.charId),
    worldGlobals: config.sharing.worldGlobals,
  });

  // Phase C. The store is opened here so its lifetime matches the server's; social.stop()
  // clears presence timers that would otherwise keep the process alive on shutdown.
  // Phase 3.5 storage locker. S3 creds from env; disabled (inert) when no endpoint/keys.
  const lockerStorage = lockerStorageFrom(config.locker, sharedDir, `http://127.0.0.1:${opts.port}`);
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
  let socialRef: Social | undefined; // read by quest party-credit (built above)
  const socialStore = new SocialStore(sharedDir);
  const social = new Social({
    store: socialStore,
    roster,
    worldId: worldId ?? 'default',
    defaultPartyScaling: config.rules.partyScaling,
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
    // Phase 4: a vote in an open loot roll. The winner is decided server-side and told
    // to the party, so a client cannot award itself the artifact.
    lootVote: (player, rollId, choice) => {
      const r = partyRules.vote(rollId, player.accountKey, choice);
      if (!r.done) return true;
      for (const acct of social.partyMembersOf(player.accountKey)) {
        const p = roster.activeForAccount(acct);
        p?.peer.sendEvent('LootRollResult', {
          itemId: r.itemId,
          winner: r.winner ?? '',
          youWon: r.winner === acct,
        });
      }
      return true;
    },
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
      ? { worlds: new WorldBrowser({ gatewayUrl: config.gateway.url, ownPort: () => port }) }
      : {}),
  });
  socialRef = social;
  // Phase 4 party rules: difficulty scaling, gold split and the roll. Keyed on
  // CO-PRESENCE, so a member shopping elsewhere neither buffs your dungeon nor takes a
  // cut of what you find in it.
  const partyRules = new PartyRules({
    roster,
    partyOf: (acct) => social.partyMembersOf(acct),
    settingsOf: (acct) => social.partySettings(acct),
    isNotable: (recordId) => contentTable.isNotableItem(recordId),
    enabled: config.rules.partyScaling,
  });
  world.setPartyRules(partyRules);
  // Phase 4: scripted-spawn replay + the unstick tool. Rules and whitelist come from the
  // content table's sibling file when present; defaults cover the vanilla cases the
  // community's own fix scripts had to special-case.

  const contentGate = new ContentGate(config.content.enforce);
  // Approved cosmetic mods (meshes/textures) may differ between players; record-bearing

  const ctx: ServerCtx = {
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
    // Access control for non-public worlds. The gateway's listing filter is VISIBILITY;
    // this is the authorization: private = owner only, party = owner or a current member
    // of the party this world belongs to (worldId 'party-<partyKey>'), admins always
    // (moderation must be able to enter anywhere). Public/default worlds admit everyone.
    // Phase 4: the holder scales the fight, so it needs the co-present count. Sent to the
    // player whose situation changed; the holder applies it to the cell it simulates.
    // Phase 4: one-shot scripted encounters replayed for a character who was not there.
    questSpawnsOnEntry: (player, cellKey) => questRepair.onCellEntry(player, cellKey),
    questRepair,
    sendPartyScaling: (player) => {
      const s = partyRules.scalingFor(player);
      player.peer.sendEvent('PartyScaling', s === null
        ? { members: 1, hp: 1, damage: 1, extraSpawns: 0 }
        : { members: s.members, hp: s.hp, damage: s.damage, extraSpawns: s.extraSpawns });
    },
    mayJoinWorld: (accountKey: string, rank: number): boolean => {
      if (worldMode === 'public' || worldOwner === '') return true;
      if (rank >= 1 || accountKey === worldOwner) return true;
      if (worldMode === 'party') {
        // Admit the OWNER's current party — resolved from live party membership, not the
        // world id. This makes it work identically for a dedicated `party-<key>` world AND
        // for a private world the owner flipped to party in place (id = priv-<owner>): in
        // both, "who may join" is "whoever is in the owner's party".
        const ownerParty = socialStore.partyOfAccount(worldOwner)?.key;
        if (ownerParty !== undefined && socialStore.partyOfAccount(accountKey)?.key === ownerParty) return true;
      }
      return false;
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
      if (worldModeAtBoot === 'public') return 'not_flippable';
      if (rank < 1 && accountKey !== worldOwner) return 'not_owner';
      if (mode !== 'private' && mode !== 'party') return 'bad_mode';
      worldMode = mode;
      log('info', 'world.mode_flip', { world: worldId, owner: worldOwner, mode });
      // The UI must never GUESS which world it is in. It used to render Solo/Party/Public from
      // a localStorage note of what the player last clicked, which survived reloads and
      // reconnects and so could claim you were somewhere you were not. The server owns this.
      for (const conn of connections) conn.player?.peer.sendEvent('WorldMode', { mode });
      // mayJoinWorld only gates ARRIVAL. Flipping back to Solo therefore closed the door
      // while leaving every guest standing inside — the party dissolved around them and they
      // kept playing in someone else's private world. Closing means closing: tell each guest
      // to go home (their client knows its own world and dials it), then drop anyone still
      // here. The grace is for the switch to happen cleanly, not for them to keep playing.
      if (mode === 'private') closeToGuests('owner_went_solo');
      return 'ok';
    },
    // A guest world with no host is nobody's world. Called when a player leaves; acts only if
    // that player was the owner.
    wrongWorldForCharacter: (accountKey: string, charId: string): boolean => {
      // Only gateway-spawned character worlds have the suffix contract; standalone servers,
      // the public world, and GUESTS (who bring their own characters into a host's world by
      // design) are all exempt. The owner's own character must match the world made for it.
      if (!process.env.OMW_WORLD_ID || worldModeAtBoot === 'public') return false;
      if (accountKey !== worldOwner) return false;
      const m = /-([0-9a-f]{8})$/.exec(worldId);
      return m !== null && !charId.endsWith(m[1]!);
    },
    // Scrollback on arrival: the server-wide conversation, plus this player's own party.
    // Ordinary ChatMessage events in the order they were said, so the client needs no new
    // handling — history is the same messages, earlier.
    // A player who reconnects while still in a party belongs WITH the party, not alone in
    // their own world — the panel saying "in a party" while they stand in solo is two true
    // statements that cannot both be right.
    routeJoinerToParty: (player): void => {
      socialRef?.routeJoinerToParty(player, worldId ?? 'default');
    },
    replayChat: (player): void => {
      const lines = [
        ...socialStore.recentChat('', CHAT_HISTORY_REPLAY),
        ...(socialRef?.partyIdOf(player.accountKey)
          ? socialStore.recentChat(socialRef.partyIdOf(player.accountKey)!, CHAT_HISTORY_REPLAY)
          : []),
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
      if (worldModeAtBoot === 'public' || worldMode !== 'party') return;
      // The owner closing their tab used to leave the party standing in a world that no
      // longer had a host: nothing watched for it, so they kept playing somewhere that would
      // never come back, and the party outlived the world it existed to share.
      log('info', 'world.owner_left', { world: worldId, owner: worldOwner });
      worldMode = 'private';
      for (const conn of connections) conn.player?.peer.sendEvent('WorldMode', { mode: 'private' });
      social.partyDisband(worldOwner);
      closeToGuests('owner_left');
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
    // Lobby rule only for the GATEWAY-managed shared world (OMW_WORLD_ID set), same
    // distinction chargenGate makes: a standalone single-world server defaults to 'public'
    // and IS the player's real game, so it must still save.
    lobbyWorld: !!process.env.OMW_WORLD_ID && worldModeAtBoot === 'public',
    chargenGate: !!process.env.OMW_WORLD_ID && worldModeAtBoot !== 'private',
    motd: () => motd,
  };

  // Phase 3.8 web dashboard. Bearer-gated and OFF unless a token is configured; it acts
  // on accounts without being in the world, so it gets its own rotatable credential
  // rather than piggybacking on someone's rank.
  const adminRoutes = adminDashboardRoutes({
    token: config.admin.dashboardToken,
    overview: () => ({
      world: { id: worldId, mode: worldMode },
      maxPlayers: config.server.maxPlayers,
      uptime: Math.round((Date.now() - startedAt) / 1000),
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
    requiresPassword: config.server.password !== '',
    allowsRegistration: config.login.allowRegistration && config.login.inviteCode === '',
    playerCount: roster.humansInWorld().length,
    connectedCount: roster.humanCount, // F3: keeps a world alive while a player is loading / at chargen
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
    saveRoutes({
      storage: lockerStorage, sessions: lockerSessions, dataDir: sharedDir,
      maxBytesPerAccount: config.locker.maxSaveBytesPerAccount,
    }),
    lockerRoutes({
      locker, sessions: lockerSessions,
      eraseSaves: (acct) => eraseSaves(sharedDir, acct, lockerStorage),
    }),
  )));
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
  const gameData = detectGameData(gameDataDir(sharedDir));
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
  if (!gameData.ok && opts.requireGameData !== false) {
    throw new Error(`no usable game data at ${gameDataDir(sharedDir)} — ${gameData.reason}. `
      + 'Drop your Morrowind Data Files (Morrowind.esm/.bsa, and Tribunal/Bloodmoon if you own '
      + 'them) there: the server simulates the world itself and needs its own copy.');
  }
  config.simPeer.binary = findPeerBinary(config.simPeer.binary);
  if (!config.simPeer.binary && opts.requireGameData !== false) {
    throw new Error('no sim-peer binary: set [simPeer].binary, or install the headless openmw '
      + 'build at one of the conventional paths. The server cannot simulate NPCs without it.');
  }
  // The peer is not a user and has no SSO identity, so the shared server password is its only
  // credential — and an empty one now refuses every system connection (see checkAuthGate).
  if (config.server.password === '' && opts.requireGameData !== false) {
    throw new Error('[server].password is empty — set one so the sim peer can authenticate. '
      + 'It is the peer\'s only credential, and an unset password refuses all peers.');
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
    // Resources ship beside the binary (…/bin/openmw -> …/share/openmw/resources); override
    // via OMW_SIMPEER_RESOURCES if a build lays them out differently.
    const resources = process.env.OMW_SIMPEER_RESOURCES
      || join(dirname(config.simPeer.binary), '..', 'share', 'openmw', 'resources');
    writeFileSync(join(cfgDir, 'openmw.cfg'), buildPeerCfg(gameData, resources));
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
  // ONE PEER, MANY ANCHORS. A peer can only simulate around a point — vanilla keeps one grid
  // of active cells centred on the player and unloads the rest — so covering players spread
  // across the world used to mean one ~450 MB engine process per occupied cell. At 200 players
  // in 40 places that is 40 processes and ~18 GB, which is not a tuning problem, it is a wall.
  //
  // The engine now takes a LIST of anchors (mwmp setSimAnchors -> Scene::setSimAnchors): every
  // anchor keeps its own grid of cells loaded, and an actor stops processing only when it is
  // far from ALL of them. The marginal cost of a region becomes that region's cells — meshes,
  // collision, navmesh — instead of a whole second engine, because the ESM store and every
  // subsystem are shared. Same 40 regions land in one process at ~1-3 GB.
  //
  // ponytail: one anchor per occupied CELL, deduped. Not clustered any smarter than that,
  // because anchors are cheap now — the expensive thing was processes, and there is one.
  // Empty regions cost nothing: the engine already unloads cells no anchor covers.
  const WORLD_KEY = 'world';
  let lastUncovered = ''; // throttle for simpeer.cells_unsimulated: one line per change
  const peerAnchorSig = new Map<string, string>(); // peer key -> last SimAnchors payload sent
  const claimedBy = new Map<string, Set<string>>(); // peer key -> cells it holds
  let lastAnchors = '';
  // Cells the peer currently holds because they are anchored, so the set can be diffed rather
  // than re-entered every tick (re-entering bumps the epoch and forces a full re-sync).
  const claimed = new Set<string>();
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
    // handed control BEFORE anything held authority over where they stood. They would walk,
    // the peer would arrive, take the cell and assert its own view of their position — the
    // rubber-banding on first join — and every actor there would be puppeted mid-stride.
    // Booting it against the loading client spends that startup on time the player is
    // already waiting through.
    if (roster.humanCount === 0) {
      simPeers.markIdle(WORLD_KEY);
      simPeers.sweep();
      return;
    }
    if (humans.length === 0) {
      // Someone is here but nobody has landed in a cell yet: get the process up, and leave
      // the anchor set alone — there is nothing legitimate to anchor to yet, and claiming
      // cells for a player still in chargen is precisely what must not happen.
      simPeers.ensure(WORLD_KEY, undefined);
      return;
    }

    // EVERY occupied cell is covered, interior or exterior, by ONE peer. Exteriors anchor by
    // grid coordinate; interiors anchor by NAME, because an interior has no coordinate. Both
    // are held without the peer standing in them, so 200 players spread across the map are all
    // simulated from a single process.
    //
    // This is what makes authority the peer's, always. Before interiors could be anchored, a
    // player indoors was in a cell nothing simulated — the peer could only cover the one room
    // it stood in — so an indoor quest simply never advanced. Chargen is entirely indoors,
    // which is why it stalled at the census office every time.
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
    // keeps running its own local AI, which is exactly what the opening needs. This mirrors
    // the sanctuary objects.lua already applies to world state in the same cells.
    // Same rule as WorldState.authorityEnter, applied when building the anchor list so the
    // peer does not even LOAD a cell it must not simulate: named chargen rooms, plus any cell
    // holding a player who has not finished creation (the walk between those rooms is
    // ordinary exterior and cannot be recognised by name).
    const inChargenCells = new Set(humans.filter((p) => p.inChargen === true).map((p) => p.cellKey!));
    const cells = [...new Set(humans.map((p) => p.cellKey!))].sort()
      .filter((c) => !isChargenCell(c) && !inChargenCells.has(c));
    const anchors: { x: number; y: number }[] = [];
    const interiors: string[] = [];
    for (const cell of cells) {
      const e = parseExterior(cell);
      if (e) anchors.push({ x: e.x, y: e.y });
      else interiors.push(cell);
    }

    // WHERE THE PEER STANDS MATTERS. This comment used to say it did not -- that anchoring a
    // cell was enough -- and that was wrong in the expensive direction. Anchoring makes the
    // engine LOAD a cell; it does not make it tick the actors in it. OpenMW hard-clamps
    // [Game] actors processing range to 7168 units against an 8192-wide cell (see
    // core/movement.ts), so a peer only simulates near its own feet. Standing in the wrong
    // place produced cells with a healthy holder and no actor frames at all: monsters that
    // never attacked and melee that never landed, for every player except whoever happened to
    // share the peer's cell. Prefer an exterior so a cold start lands somewhere sensible.
    //
    // NEVER a cell the sanctuary protects. This picked from the unfiltered human list, so a
    // lone player creating their character got the peer spawned ON TOP of them — the log read
    // `simpeer.spawned cell="imperial prison ship"`. It cannot claim that cell (authorityEnter
    // refuses), but standing there is still wrong: it loads and ticks the chargen actors in
    // its own world, and it is one accident away from holding them. `cells` is already the
    // sanctuary-filtered set; fall back to nowhere rather than to a protected cell, and the
    // peer boots at [simPeer].startCell instead.
    // ONE PEER PER OCCUPIED CELL. Anchoring makes an engine LOAD a cell; only standing in it
    // makes the engine TICK its actors, because OpenMW clamps actors processing range to 7168
    // units against an 8192-wide cell (core/movement.ts). A single peer therefore simulates
    // exactly one cell no matter how many it anchors -- which on a multiplayer server means
    // every player outside the peer's own cell watches frozen NPCs and swings through them.
    //
    // The supervisor was always built for this (`ensure()` takes a key AND a place to stand,
    // `keys()` exists so callers can idle the clusters nobody occupies); it was only ever
    // called with one global key. Now the key IS the cell.
    const placeByCell = new Map<string, { cellKey: string; x: number; y: number; z: number }>();
    for (const p of humans) {
      const ck = p.cellKey;
      if (!ck || !cells.includes(ck) || placeByCell.has(ck)) continue;
      // A real player's position, so the peer lands on ground that exists rather than a
      // computed cell centre that could be inside terrain.
      placeByCell.set(ck, { cellKey: ck, x: p.pose?.x ?? 0, y: p.pose?.y ?? 0, z: p.pose?.z ?? 0 });
    }

    // Nearest-first so that when there are more occupied cells than [simPeer].maxPeers, the cap
    // falls on the same cells each pass instead of flapping between them every 5s.
    for (const ck of [...placeByCell.keys()].sort()) simPeers.ensure(ck, placeByCell.get(ck)!);

    // Cells nobody occupies any more: idle rather than kill, so a player stepping back in does
    // not pay a cold start (retail data takes tens of seconds to load).
    for (const k of simPeers.keys()) if (!placeByCell.has(k)) simPeers.markIdle(k);
    simPeers.sweep();

    // Each peer is told about ITS OWN cell only, and holds only that. Handing a peer anchors it
    // cannot simulate is what produced healthy-looking holders over frozen regions.
    const seenKeys = new Set<string>();
    for (const peerPlayer of roster.inWorld().filter((p) => p.system === true)) {
      const key = simPeers.keyOfAccount(peerPlayer.name);
      if (key === undefined) continue; // a peer we did not start; leave it alone
      seenKeys.add(key);
      const place = placeByCell.get(key);
      if (!place) continue; // its cell emptied; the idle sweep above will retire it
      const e = parseExterior(key);
      const mine = { anchors: e ? [{ x: e.x, y: e.y }] : [], interiors: e ? [] : [key] };
      const sig = JSON.stringify([key, mine, place]);
      if (peerAnchorSig.get(key) !== sig) {
        peerAnchorSig.set(key, sig);
        peerPlayer.peer.sendEvent('SimAnchors', { ...mine, place });
      }
      // AUTHORITY FOLLOWS THE PEER THAT CAN ACTUALLY SIMULATE. Claiming a cell a peer does not
      // stand in is the opposite error: a healthy holder over a region nothing ticks, which
      // cannot be detected from outside.
      const held = claimedBy.get(key) ?? new Set<string>();
      for (const gone of [...held].filter((c) => c !== key)) {
        world.authorityLeave(peerPlayer.id, gone, true);
        held.delete(gone);
      }
      if (!held.has(key)) {
        world.authorityEnter(peerPlayer, key);
        held.add(key);
      }
      claimedBy.set(key, held);
    }

    // Forget bookkeeping for peers that are gone, so these maps cannot grow without bound.
    for (const k of [...peerAnchorSig.keys()]) if (!seenKeys.has(k)) peerAnchorSig.delete(k);
    for (const k of [...claimedBy.keys()]) if (!seenKeys.has(k)) claimedBy.delete(k);

    // Coverage shortfall is a real condition, not an anomaly to infer from silence: more
    // occupied cells than the cap allows means somebody IS watching frozen NPCs right now.
    const uncovered = [...placeByCell.keys()].filter((c) => !seenKeys.has(c));
    if (uncovered.length > 0 && uncovered.join(',') !== lastUncovered) {
      lastUncovered = uncovered.join(',');
      log('warn', 'simpeer.cells_unsimulated', {
        unsimulated: uncovered.join(','), peers: seenKeys.size, cap: config.simPeer.maxPeers,
        note: 'raise [simPeer].maxPeers, at roughly 450MB per peer',
      });
    } else if (uncovered.length === 0 && lastUncovered !== '') {
      lastUncovered = '';
    }

    // worldId, and WHY each occupied cell was dropped: one container runs several worlds and
    // every one logs this, so without it a public world's anchors read exactly like a private
    // world's. `simulating` is now per-peer, which is the thing that actually determines
    // whether the NPCs in a cell move.
    const anchorLine = [...seenKeys].sort().join(',');
    if (anchorLine !== lastAnchors) {
      lastAnchors = anchorLine;
      log('info', 'simpeer.anchors', {
        world: worldId, exteriors: anchors.length, interiors: interiors.length,
        occupied: humans.map((p) => `${p.name}@${p.cellKey}${p.inChargen === true ? ' [chargen]' : ''}`),
        anchored: cells, simulating: anchorLine,
      });
    }
  };
  const simPeerTick = setInterval(simPeerPass, 5_000);
  // Loot rolls: sweep() is what settles a roll whose voter disconnected — without a caller,
  // a dropped party member pinned the item forever and every retry leaked another open roll.
  const lootSweep = setInterval(() => partyRules.sweep(), 5_000);
  lootSweep.unref();
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
      // Disconnect rules: a leader gone past the grace disbands the party, a member gone past it
      // is removed. The grace is what separates a WORLD SWITCH — which is a disconnect from the
      // world you left — from actually quitting.
      social.sweepDisconnected(PARTY_DISCONNECT_GRACE_MS);
      // Expired friend requests and party invites. Swept here rather than on their own timer:
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
      isPublic: worldModeAtBoot === 'public',
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
      clearInterval(simPeerTick);
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
