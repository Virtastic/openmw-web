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
import { createHttpServer, type HttpRoute } from './net/http';
import { OidcService } from './auth/oidc';
import { IdentityStore, LoginTicketStore, SessionIndex } from './auth/identities';
import { createAuthRoutes } from './auth/routes';
import { Locker, loadVanillaManifest } from './data/locker';
import { s3FromEnv } from './data/s3';
import { lockerRoutes } from './data/locker-routes';
import { LockerSessionStore } from './auth/identities';
import { IpConnTracker, IpRateLimiter } from './net/ratelimit';
import { disconnectMsg } from './proto/session';
import { log } from './log';
import { metrics } from './metrics';
import { SimPeerSupervisor } from './core/simpeer';
import { WorldBrowser } from './core/worldbrowser';
import { detectGameData, findPeerBinary, gameDataDir, buildPeerCfg } from './core/gamedata';

export const VERSION = '0.1.0';

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
  const worldOwner = (opts.worldOwner ?? process.env.OMW_WORLD_OWNER ?? '').toLowerCase();
  const playerStore = new PlayerStore(sharedDir, worldId);
  // Onboarding CRM capture. Env var wins over toml so the key can stay out of config files
  // in deployments; empty = inert.
  const attio = new AttioHook({
    apiKey: process.env.ATTIO_API_KEY ?? config.integrations.attioApiKey,
    baseUrl: config.integrations.attioBaseUrl,
    dataDir: sharedDir,
  });
  const cellStore = new CellStore(opts.dataDir);
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
  const world = new WorldState(roster, cellStore, interest, config.auth.requireSso);
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
    // Mutes are enforced at DELIVERY (chat.ts), not in the client: a mute a modified
    // client can ignore is not a mute.
    isMuted: (listener, speaker) => socialRef?.isMuted(listener, speaker) ?? false,
    partyOf: (accountKey) => socialRef?.partyMembersOf(accountKey) ?? [],
    // Opt-in per deployment: a crowded public world wants proximity say, a co-op session
    // very much does not (friends spread across the map must still be able to talk).
    sayProximity: config.rules.sayScope === 'proximity',
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

  world.setInventoryOracle((player, recordId) => {
    const inv = playerStore.getCached(player.charId)?.inventory;
    if (!inv) return undefined;
    return inv.find((i) => i.id === recordId)?.n ?? 0;
  });
  world.setModerationNote((accountKey, kind) => moderation.noteAnomaly(accountKey, kind));

  const stateCtx: StateCtx = {
    roster,
    store: playerStore,
    // Chargen named the character: put that name on the slot, replacing the placeholder the
    // slot was auto-created with. Only ever an upgrade — a slot the player already named is
    // left alone.
    // Same sink the movement envelope feeds: anomalies are what moderation acts on.
    noteAnomaly: (accountKey, kind) => moderation.noteAnomaly(accountKey, kind),
    onCharacterNamed: (player, name) => {
      void accounts.get(player.accountKey).then((account) => {
        if (account) accounts.nameCharacter(account, player.charId, name);
      });
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
  const lockerStorage = s3FromEnv({
    endpoint: config.locker.endpoint,
    region: config.locker.region,
    bucket: config.locker.bucket,
  });
  const locker = new Locker({
    dataDir: sharedDir,
    maxBytesPerAccount: config.locker.maxBytesPerAccount,
    ...(lockerStorage ? { storage: lockerStorage } : {}),
  });
  // The files the locker will accept: retail Morrowind by sha256 (operator-provided) plus
  // the always-on asset pack is a BSA served by us, not uploaded, so it is not in this set.
  // Empty vanilla manifest = uploads refused until the operator generates one (tools/).
  locker.configureAccepted(await loadVanillaManifest(sharedDir), [], {
    acceptByNameAndSize: config.locker.acceptByNameAndSize,
  });
  const lockerSessions = new LockerSessionStore();
  let socialRef: Social | undefined; // read by quest party-credit (built above)
  const socialStore = new SocialStore(sharedDir);
  const social = new Social({
    store: socialStore,
    roster,
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
    setWorldMode: (accountKey: string, rank: number, mode: string): 'ok' | 'not_owner' | 'bad_mode' | 'not_flippable' => {
      if (worldModeAtBoot === 'public') return 'not_flippable';
      if (rank < 1 && accountKey !== worldOwner) return 'not_owner';
      if (mode !== 'private' && mode !== 'party') return 'bad_mode';
      worldMode = mode;
      log('info', 'world.mode_flip', { world: worldId, owner: worldOwner, mode });
      // mayJoinWorld only gates ARRIVAL. Flipping back to Solo therefore closed the door
      // while leaving every guest standing inside — the party dissolved around them and they
      // kept playing in someone else's private world. Closing means closing: tell each guest
      // to go home (their client knows its own world and dials it), then drop anyone still
      // here. The grace is for the switch to happen cleanly, not for them to keep playing.
      if (mode === 'private') {
        for (const conn of [...connections]) {
          const p = conn.player;
          if (!p || p.accountKey === worldOwner || p.rank >= 1) continue;
          // The owner's CHARACTER name, off the live roster — never the account display
          // name, which carries the signed-in person's real name.
          p.peer.sendEvent('WorldClosed',
            { reason: 'owner_went_solo', by: roster.activeForAccount(worldOwner)?.name ?? '' });
          const t = setTimeout(() => {
            if (connections.has(conn)) conn.disconnect('KICKED', 'this world is no longer open to your party');
          }, 5000);
          t.unref();
        }
      }
      return 'ok';
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
  }, chainRoutes(adminRoutes, lockerRoutes({ locker, sessions: lockerSessions }))));
  // Derived at scrape time from the roster, so no teardown path can strand the gauge.
  const unhookGauge = metrics.sessionsInWorld.addCollector(() => roster.inWorld().length);

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

  // A multiplayer (SSO) server is authoritative over persistent state using its OWN copy of the
  // game files — there is no "run without the files" mode. Refuse to boot without them: a server
  // that cannot author the world it hosts is a broken deployment, not a degraded one. (Non-SSO
  // test/dev servers are unaffected; the requirement is the multiplayer contract.)
  if (config.auth.requireSso && !gameData.ok) {
    throw new Error(`multiplayer server requires game data at ${gameDataDir(opts.dataDir)} — ${gameData.reason}. `
      + 'Drop your Morrowind Data Files (Morrowind.esm/.bsa, and optionally Tribunal/Bloodmoon) there.');
  }

  // Resolve simPeer.mode against reality. The config alone cannot know whether a peer can
  // actually run, so 'auto' is decided here and the outcome is ALWAYS logged — a server that
  // quietly falls back to client-simulated NPCs is how "why are the NPCs frozen" becomes a
  // three-week mystery.
  config.simPeer.binary = findPeerBinary(config.simPeer.binary);
  const peerBlocker = !gameData.ok
    ? `no usable game data (${gameData.reason})`
    : !config.simPeer.binary
      ? 'no [simPeer] binary configured and none found at the conventional paths'
      : undefined;
  if (config.simPeer.mode === 'on' && peerBlocker) {
    // The operator asked for server-side simulation explicitly. Refusing to boot is kinder
    // than starting a world that silently is not what they asked for.
    throw new Error(`[simPeer] mode = "on" but a peer cannot run: ${peerBlocker}`);
  }
  // A PRIVATE world is one player alone in their own instance. The sim peer exists so a
  // modified client cannot author NPC state in a world OTHER PEOPLE share — there is nobody
  // to cheat in your solo world, so a second engine there is pure cost and pure risk: it
  // holds cell authority over the very NPCs you are talking to (the census sequence during
  // character creation is where that first bites). Party/public worlds still get one.
  const soloWorld = worldModeAtBoot === 'private';
  config.simPeer.enabled = config.simPeer.mode !== 'off' && peerBlocker === undefined && !soloWorld;
  // A sim peer on an SSO-only server authenticates with the shared server password (it is not
  // a user and has no SSO identity). Without [server].password set, the peer could not log in
  // AND the SSO-bypass for system peers would be unguarded — so refuse to boot, loudly.
  if (config.simPeer.enabled && config.auth.requireSso && config.server.password === '') {
    throw new Error('[simPeer] is enabled on an SSO-only server but [server].password is empty — '
      + 'set a server password so the sim peer can authenticate (it is the peer\'s only credential)');
  }
  log('info', 'simpeer.tier', {
    mode: config.simPeer.mode,
    enabled: config.simPeer.enabled,
    reason: config.simPeer.enabled
      ? 'NPCs will be simulated by the server'
      : `${peerBlocker ?? (soloWorld ? 'solo (private) world — no peer needed' : 'mode is off')}`
        + ' — NPCs will be simulated by player clients',
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
