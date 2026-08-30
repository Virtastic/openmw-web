// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Per-field help for the settings UI.
//
// Voice matches config.default.toml's own comments: say what it does AND why the default is
// what it is, in a sentence or two. An operator who has never read this codebase should be
// able to decide from the tooltip alone; one who has should not find it insulting.
//
// A field with no entry still renders and still saves — help is additive, never a gate.

export interface FieldHelp {
  text: string;
  /** Flip this carelessly and something breaks or opens up. Rendered with a warning. */
  danger?: string;
}

export const SECTION_HELP: Record<string, string> = {
  server: 'Identity and size of this world: what players see in the browser and how many fit.',
  login: 'Who may create an account and what they must provide before they can play.',
  auth: 'Single sign-on providers. Players can use these instead of (or alongside) a password.',
  content: 'How strictly everyone\'s game files must match each other.',
  rules: 'Gameplay rules the server enforces: respawn, PvP, chat, difficulty.',
  economy: 'Loot and item-ownership rules, mostly relevant to public worlds where strangers meet.',
  sharing: 'Which parts of world progress are shared between players versus kept per-character.',
  time: 'How fast the in-game clock runs.',
  gui: 'Server-driven dialog behaviour.',
  cellReset: 'Scheduled wipes of cell contents, so looted areas eventually restock.',
  limits: 'Anti-cheat and anti-flood budgets. Mostly safe to leave alone.',
  moderation: 'Chat logging, the report inbox, and how long both are kept.',
  admin: 'Who owns this server and what the admin surfaces can do.',
  authority: 'How the server decides which peer simulates a cell. Diagnostics, rarely tuned.',
  locker: 'Per-player cloud storage for game data and saves, backed by disk or S3.',
  metrics: 'Prometheus endpoint for external monitoring.',
  integrations: 'Optional third-party hooks. Off unless you configure them.',
  dev: 'Development and testing aids. Should be off on anything real.',
  simPeer: 'The headless OpenMW the server runs itself to simulate NPCs.',
  gateway: 'Multi-world platform hosting. A single self-hosted world does not need this.',
  worlds: 'Multi-world capacity planning. Only read when running in gateway mode.',
};

export const HELP: Record<string, FieldHelp> = {
  // --- server ---------------------------------------------------------------------------
  'server.name': { text: 'Shown in the world browser and on the join screen.' },
  'server.motd': { text: 'Message of the day, shown in chat when a player joins.' },
  'server.maxPlayers': { text: 'Hard cap on simultaneous players. Each one costs memory, so raise it only as far as your box can carry.' },
  'server.password': {
    text: 'Optional join password. Empty means anyone who can reach the server may try to log in.',
  },

  // --- login ----------------------------------------------------------------------------
  'login.allowRegistration': { text: 'Off means nobody new can sign up; existing accounts still work. Use with an invite code for a closed group.' },
  'login.inviteCode': { text: 'When set, registration also requires this code. A simple way to run a friends-only server without managing accounts by hand.' },
  'login.requireProfile': { text: 'Require an email and public username before a player can enter the world.' },
  'login.resumeWindowSec': { text: 'How long a dropped player may silently resume their session before they have to log in again.' },
  'login.allowHarnessAuth': {
    text: 'Test-only fixed-password login used by the automated browser harness.',
    danger: 'NEVER enable this on a server reachable from the internet. It is a login bypass — it exists so tests can skip authentication, and it will let anyone in.',
  },

  // --- content --------------------------------------------------------------------------
  'content.enforce': {
    text: 'Do all players have to be running the same game files? "names" (default) compares file names, sizes and load order. "strict" also compares checksums, catching a file that was edited in place — but refuses anyone whose client cannot report hashes. "off" disables the check entirely. This is a consistency check so everyone sees the same world, not an anti-cheat measure, and it is unrelated to content-table.json.',
  },

  // --- rules / economy ------------------------------------------------------------------
  'economy.noDrop': { text: 'Named and unique NPCs drop nothing when killed. Intended for public worlds, where otherwise the first player to reach a unique item takes it from everyone forever.' },
  'economy.refuseUnownedDrops': { text: 'Refuse an attempt to drop an item the server does not believe the player is holding. Off by default while the item-tracking path matures — expect occasional false refusals if you turn it on.' },

  // --- sharing --------------------------------------------------------------------------
  'sharing.journal': { text: 'Share quest journal progress between players. Off gives everyone their own private journal.' },
  'sharing.questVars': { text: 'Share the script variables that drive quests. Off means each player advances quests independently.' },
  'sharing.factions': { text: 'Share faction rank and reputation.' },
  'sharing.crime': { text: 'Share bounties and crime state, so one player\'s theft is everyone\'s problem.' },
  'sharing.map': { text: 'Share explored map territory.' },
  'sharing.regressAllowlist': { text: 'Quest ids allowed to move BACKWARDS. Most quests only ever advance, so a lower stage arriving is normally a bug and is ignored; list the exceptions here.' },
  'sharing.worldGlobals': { text: 'Quest globals that belong to the world rather than to each character. Everything not listed here is kept per-character.' },

  // --- time / gui / cellReset -----------------------------------------------------------
  'time.scale': { text: 'Game seconds per real second. 30 is Morrowind\'s own default; 0 freezes the clock so time only moves when someone rests.' },
  'gui.timeoutSec': { text: 'How long a server-sent dialog waits for an answer before giving up on it.' },
  'cellReset.cells': { text: 'Cells wiped on a schedule — containers restocked, doors and objects reset. Empty means nothing is ever reset.' },
  'cellReset.intervalSec': { text: 'How often the cells listed above are reset. Default is three days.' },
  'cellReset.litterSweepSec': { text: 'Shared-lobby housekeeping: how often cells full of strangers\' leftover changes get swept. Players standing in a cell are skipped. 0 disables it.' },

  // --- limits ---------------------------------------------------------------------------
  'limits.maxConnsPerIp': { text: 'Simultaneous connections allowed from one address. Raise it if several people play from one household and get refused.' },
  'limits.loginPerMinPerIp': { text: 'Login and registration attempts allowed per address per minute. This is your brute-force budget — lower is safer, too low locks out a household sharing an address.' },
  'limits.trustCloudflareIp': {
    text: 'Believe Cloudflare\'s CF-Connecting-IP header when identifying a client.',
    danger: 'Only enable this if traffic genuinely reaches you through Cloudflare. If it does not, anyone can forge that header and hand themselves a fresh rate-limit budget on demand.',
  },
  'limits.msgsPerSec': { text: 'General per-player message budget. Anti-flood tuning; the default is measured, not guessed.' },
  'limits.moveMsgsPerSec': { text: 'Movement-update budget per player. Lowering it makes other players look choppy.' },
  'limits.farTravelPerMin': { text: 'How often a player may jump between non-adjacent outdoor cells before it is treated as teleport cheating.' },
  'limits.maxMsgBytes': { text: 'Largest single message accepted from a client.' },
  'limits.helloTimeoutMs': { text: 'How long a freshly connected client has to identify itself before being dropped.' },

  // --- moderation -----------------------------------------------------------------------
  'moderation.chatLog': { text: 'Keep a durable chat log and a report inbox on disk. Needed for the chat-history tool in the console; check your local privacy obligations before enabling it on a public server.' },
  'moderation.retentionDays': { text: 'How many days of chat logs and reports to keep. 0 keeps only today.' },
  'moderation.contextLines': { text: 'How many recent chat lines get attached to a player report, so a moderator can see what led up to it.' },

  // --- admin ----------------------------------------------------------------------------
  'admin.owners': { text: 'Accounts promoted to in-game owner (rank 3) on every boot. This is separate from dashboard access, which is set per account under Accounts.' },
  'admin.allowConsole': {
    text: 'Allow the /console command, which runs script on a player\'s machine.',
    danger: 'This is the most powerful thing on the server. It is owner-only and every use is logged, but if you do not need it, turning it off removes the capability entirely.',
  },
  'admin.dashboardToken': {
    text: 'Shared bearer token for scripted access to the admin API. Anyone holding it has full owner rights without an account, so treat it as a password and rotate it if it leaks. Leave it empty unless you are automating something.',
    danger: 'A non-empty value here is a permanent full-access credential that bypasses accounts, roles and two-factor. Prefer a real account with a role.',
  },

  // --- authority ------------------------------------------------------------------------
  'authority.rttProbeSec': { text: 'How often the server pings whoever holds a cell, to notice when they go quiet.' },
  'authority.reviewSec': { text: 'How often held cells are re-checked for liveness.' },
  'authority.actorSilenceSec': { text: 'How long a cell may hold NPCs without sending any movement before it is reported as stalled.' },

  // --- locker ---------------------------------------------------------------------------
  'locker.endpoint': { text: 'S3-compatible endpoint (Cloudflare R2, AWS, Backblaze, MinIO). Leave empty to store uploads on this server\'s own disk instead.' },
  'locker.bucket': { text: 'Bucket name for S3 storage.' },
  'locker.region': { text: 'Bucket region. Cloudflare R2 uses "auto".' },
  'locker.maxBytesPerAccount': { text: 'Storage budget per player for game data. Morrowind plus both expansions is roughly 1.5 GB, so the default leaves room for mods.' },
  'locker.maxSaveBytesPerAccount': { text: 'Separate budget per player for savegames.' },
  'locker.acceptByNameAndSize': { text: 'Accept an uploaded file whose checksum is unknown when its name and size match a known retail file. Turning this off requires an exact checksum match, which rejects legitimately different regional releases.' },
  'locker.publicBase': { text: 'Public URL players\' browsers should use to reach files stored on this server\'s disk. Only needed when not using S3.' },

  // --- metrics / integrations / dev ------------------------------------------------------
  'metrics.enabled': { text: 'Expose /metrics in Prometheus format for external monitoring. The dashboard\'s own metrics page does not need this — it reads the same counters directly.' },
  'metrics.token': { text: 'Bearer token required to read /metrics. While empty, the endpoint answers 404 rather than 401, so its existence is not advertised.' },
  'integrations.attioApiKey': { text: 'Attio CRM key. Empty means nothing is ever sent anywhere.' },
  'integrations.attioBaseUrl': { text: 'Attio API base URL. Change only for a self-hosted or regional endpoint.' },
  'dev.bots': {
    text: 'Spawn fake players for load testing.',
    danger: 'Leave this off on a real server — bots consume player slots and appear to everyone as real players.',
  },

  // --- simPeer / gateway / worlds --------------------------------------------------------
  'simPeer.binary': { text: 'Path to the headless OpenMW binary the server runs to simulate NPCs. Without a working sim peer, NPCs are simulated by a player\'s browser instead.' },
  'simPeer.startCell': { text: 'Cell the sim peer loads into first.' },
  'simPeer.maxPeers': { text: 'Most sim peers to run at once. Each is a full OpenMW process, so this is a memory ceiling as much as a count.' },
  'simPeer.idleReapMs': { text: 'Shut down a sim peer whose area has had no players for this long.' },
  'gateway.url': { text: 'Where clients of this world can find the world directory. Empty means no gateway — a single self-hosted world is a complete setup and does not need one.' },
  'gateway.serverToken': {
    text: 'Shared secret proving a world process belongs to this platform. Generated automatically; you should not normally set it by hand.',
    danger: 'Changing this breaks the trust between the gateway and every world it runs until they all agree again.',
  },
  'worlds.maxWorlds': { text: 'Gateway mode only: hard ceiling on simultaneously running worlds.' },
  'worlds.publicEnabled': { text: 'Gateway mode only: offer the shared public world. Off by default — it is the most experimental surface here and a deployment should opt in.' },
  'worlds.memBudgetMb': { text: 'Gateway mode only: total memory the supervisor may commit to worlds and their sim peers. 0 disables the memory governor.' },
};

export function helpFor(section: string, key: string): FieldHelp | undefined {
  return HELP[`${section}.${key}`];
}
