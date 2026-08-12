// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Config = config.default.toml (shipped next to the package) deep-merged with
// <dataDir>/config.toml, then a programmatic override (tests). Scalars/arrays replace,
// tables merge key-by-key. Validated into a strict shape; bad values fail boot loudly.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';

export interface Config {
  server: { name: string; motd: string; maxPlayers: number; password: string };
  // A headless OpenMW the server runs itself. It holds cell authority for every world, and
  // it is the ONLY thing permitted to simulate NPCs — a player's browser never does it for
  // anyone else. Mandatory: a server that cannot start one refuses to boot (see server.ts),
  // because the alternative is a world whose NPCs never move while it reports itself healthy.
  // F3: where this world's clients can find the world directory. Empty = no gateway, and
  // the in-game world browser simply reports that there is nothing to browse (a single
  // self-hosted world is a complete, valid setup).
  gateway: { url: string };
  simPeer: {
    /** Always true once boot succeeds; boot fails otherwise. Kept so call sites read clearly. */
    enabled: boolean;
    binary: string; // absolute path to the headless openmw
    configDir: string; // --config (its own isolated openmw.cfg + settings.cfg)
    userDataDir: string; // --user-data
    startCell: string;
    maxPeers: number; // hard cap; the reaper exists so this is rarely reached
    idleReapMs: number; // reap a peer whose world has had no humans this long
    startTimeoutMs: number;
    restartBackoffMs: number;
  };
  login: {
    allowRegistration: boolean;
    inviteCode: string;
    resumeWindowSec: number;
    requireProfile: boolean;
    // The shipped client can auto-register with a FIXED, publicly known password
    // (?mpauto=1, used by the browser harness). That is a test affordance, not a login
    // method: on a real server it would let anyone create — and then take over — accounts
    // by name. Off by default; the harness turns it on for its own servers.
    allowHarnessAuth: boolean;
  };
  // Onboarding CRM capture (plan 2.1a). Empty apiKey = feature off, completely inert.
  integrations: { attioApiKey: string; attioBaseUrl: string };
  content: { enforce: 'strict' | 'names' | 'off' };
  sharing: {
    journal: boolean;
    questVars: boolean;
    factions: boolean;
    crime: boolean;
    map: boolean;
    regressAllowlist: string[];
    // Phase 4: mwscript globals that are WORLD state rather than a character's quest
    // progress (added to the built-in conservative set); and whether co-present party
    // members earn credit for objectives they were present and eligible for.
    worldGlobals: string[];
    partyCredit: boolean;
  };
  // Phase 3 public sandbox economy. Enabled on the public realm only: it resets by
  // construction, so unique NPCs respawn — and a respawning unique that drops loot is an
  // infinite artifact faucet. Private/party campaigns keep vanilla rules.
  economy: { noDrop: boolean };
  // Phase 3.5 storage locker. S3 creds come from env (S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY);
  // endpoint/region/bucket are config. Empty endpoint = locker disabled, client falls back
  // to its own disk. maxBytesPerAccount caps one player's library.
  // acceptByNameAndSize (default true): also accept a known game file by name + plausible
  // size when its exact hash is unknown, so Steam/GOG/disc/localized copies from different
  // players all upload. Set false for a strict hash-only gate.
  // publicBase: the origin the browser reaches this server on, used to build blob URLs when
  // storage falls back to the filesystem (no S3 endpoint). Empty = localhost, which works
  // for a single-machine dev run and nothing else.
  // maxSaveBytesPerAccount caps server-side savegames, which are a separate budget from the
  // game-data library — a full library must not make the player unable to save.
  locker: {
    endpoint: string; region: string; bucket: string; maxBytesPerAccount: number;
    acceptByNameAndSize: boolean; publicBase: string; maxSaveBytesPerAccount: number;
  };
  rules: {
    respawnCellKey: string;
    respawnX: number;
    respawnY: number;
    respawnZ: number;
    deathPenalty: 'none';
    pvp: boolean;
    // Phase 3 PvP zoning. 'all' = anywhere pvp allows (M5 behaviour), 'wilderness' =
    // exteriors only, minus safeCells and never in interiors (shops, homes, guildhalls),
    // 'none' = nowhere. Party members are exempt everywhere: a group that cannot fight
    // its way through a dungeon without friendly fire is not a group.
    pvpZone: 'all' | 'wilderness' | 'none';
    safeCells: string[];
    // Phase 2.5 chat scope for plain 'say'. Default 'world'; a crowded public deployment
    // sets 'proximity'. '!' prefixes global and '@' party regardless of this.
    sayScope: 'world' | 'proximity';
    // Phase 2.5: who may rest/wait, since it advances the shared clock for everyone.
    // 'anyone' (M7 behaviour), 'party' (leader only, or a solo player in their own
    // world), 'off' (public worlds: time flows continuously).
    timeSkip: 'anyone' | 'party' | 'off';
    // Phase 4: scale hostile NPCs to the number of party members STANDING WITH YOU, and
    // enable the party loot rules. Default on for party campaigns; a solo player is never
    // affected because the rule keys on co-present members beyond the first.
    partyScaling: boolean;
    difficulty: number;
  };
  engine: { enforce: 'warn' | 'refuse' | 'off' };
  // M7 world state.
  time: { scale: number };
  gui: { timeoutSec: number };
  cellReset: { cells: string[]; intervalSec: number };
  // M8 ops.
  // dashboardToken: bearer for the web admin dashboard (/admin). Empty = the whole
  // dashboard is off, which is the right default for a self-hoster who only wants the
  // in-game panel.
  admin: { owners: string[]; allowConsole: boolean; dashboardToken: string };
  /** DEV/TEST ONLY, and OFF unless deliberately switched on. Fake players that accept friend
   *  requests and party invites, for exercising the social flows without a second human. They
   *  occupy real roster slots and real friend/party rows, so a public server running them is
   *  handing strangers accounts nobody controls — hence `count: 0` by default and a loud warn
   *  at boot when it is not. Also settable as OMW_DEV_BOTS for a throwaway run. */
  dev: {
    bots: number;
    /** The handles the bots wear. Real-looking names, because "Bot1" standing in town reads
     *  as scaffolding on camera and in a screenshot. Consumed in order; if there are more
     *  bots than names the rest fall back to `<botPrefix><n>`. Each must be a valid public
     *  handle (letters and digits, 3-20) or it is skipped with a warning. */
    botNames: string[];
    botPrefix: string;
    /** Appearance the bots wear. Empty = social-only: they hold accounts, characters and a
     *  position, but broadcast no appearance so no puppet is spawned for them. These are
     *  CONTENT record ids, so there is no safe universal default — a wrong one produces a
     *  broken puppet, which is worse than none. Set them to ids that exist in the data this
     *  server actually loads. */
    /** Per-bot "race|head|hair|class" entries; overrides botRace/botHead/botHair/botClass. */
    botLooks: string[];
    botRace: string; botHead: string; botHair: string; botClass: string;
  };
  moderation: { chatLog: boolean; retentionDays: number; contextLines: number };
  limits: {
    msgsPerSec: number;
    moveMsgsPerSec: number;
    actorMoveMsgsPerSec: number;
    bytesPerSec: number;
    bytesBurst: number;
    maxBufferedBytes: number;
    maxBufferedBytesHard: number;
    maxConnsPerIp: number;
    /** Trust CF-Connecting-IP from a private (proxy) peer. Only meaningful when Cloudflare is
     *  genuinely in front AND the edge deletes any client-supplied copy — see net/http.ts. Off
     *  by default: a header nobody sets is pure attack surface, and believing it lets a client
     *  reset its own login limit, evade an IP ban and evade maxConnsPerIp. */
    trustCloudflareIp: boolean;
    maxMsgBytes: number;
    helloTimeoutMs: number;
    loginPerMinPerIp: number;
    maxHitDamage: number;
    // M9 interest management + LOD. Tunable, not constants: a crowded public world and a
    // 4-player co-op session want very different answers and neither should need a rebuild.
    interestRadius: number; // 0 disables culling (LOD still applies)
    interestHysteresis: number;
    interestMinPeers: number;
    lodNearRadius: number;
    lodMidRadius: number;
    lodNearHz: number;
    lodMidHz: number;
    lodFarHz: number;
    // Relayed to clients in SessionWelcome: how hard the client degrades distant AVATARS.
    // "full" is the pre-G2 behaviour and exists as the measurement control.
    renderLod: 'full' | 'tiered';
    // Hard ceiling on fully-simulated avatars per client. 0 = no cap (radius alone).
    lodNearMaxAvatars: number;
  };
  // Cell actor authority (see core/authority.ts). The sim peer is the only eligible holder,
  // so what remains is the RTT probe cadence and a liveness check on the peer itself.
  authority: {
    rttProbeSec: number;
    reviewSec: number;
    actorSilenceSec: number;
  };
  metrics: { enabled: boolean; token: string };
  // Phase B SSO. Password login stays on by default, so a self-hoster who never touches
  // this section sees no change at all.
  auth: AuthConfig;
  plugins: string[];
}

export interface AuthProviderConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string; // BFF: the exchange happens server-side, so this never ships to a browser
  redirectUri: string; // must match the one registered with the provider, byte for byte
  issuer: string; // "" = the provider's well-known issuer; required for `custom`
  scope: string; // "" = the provider default (never includes an email scope)
}

export interface AuthConfig {
  // Product default for the hosted multiplayer service is SSO-ONLY: a persistent character
  // that follows you across worlds needs a durable identity, and passwords on a browser
  // game are the weakest possible one. When true, SessionRegister and password
  // SessionLoginRequest are refused — only the SSO ticket path is accepted. Self-hosters
  // may set it false; the shipped launcher only ever does SSO.
  requireSso: boolean;
  allowPasswordLogin: boolean;
  returnUrl: string; // the game page the callback sends the browser back to
  discord: AuthProviderConfig;
  google: AuthProviderConfig;
  microsoft: AuthProviderConfig;
  custom: AuthProviderConfig;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

type Tree = { [key: string]: unknown };

function isTree(v: unknown): v is Tree {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isTree(v) && isTree(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function fail(path: string, want: string): never {
  throw new Error(`config: ${path} must be ${want}`);
}

function reqStr(t: Tree, sec: string, key: string): string {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'string' ? v : fail(`[${sec}].${key}`, 'a string');
}

function reqNum(t: Tree, sec: string, key: string): number {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail(`[${sec}].${key}`, 'a non-negative number');
}

// Rates that become a divisor: zero would make the derived send interval infinite, i.e. a
// silently muted tier rather than a slow one.
function reqPosNum(t: Tree, sec: string, key: string): number {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fail(`[${sec}].${key}`, 'a positive number');
}

// World coordinates may legitimately be negative, unlike limits/counts.
function reqSignedNum(t: Tree, sec: string, key: string): number {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fail(`[${sec}].${key}`, 'a finite number');
}

function reqStrArray(t: Tree, sec: string, key: string): string[] {
  const v = (t[sec] as Tree | undefined)?.[key];
  if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) fail(`[${sec}].${key}`, 'an array of strings');
  return v as string[];
}

function optStrArray(t: Tree, sec: string, key: string, dflt: string[]): string[] {
  const v = (t[sec] as Tree | undefined)?.[key];
  if (v === undefined) return dflt;
  if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) fail(`[${sec}].${key}`, 'an array of strings');
  return v as string[];
}

function reqBool(t: Tree, sec: string, key: string): boolean {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'boolean' ? v : fail(`[${sec}].${key}`, 'a boolean');
}

function optBool(t: Tree, sec: string, key: string, dflt: boolean): boolean {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'boolean' ? v : dflt;
}

function optStr(t: Tree, sec: string, key: string, dflt: string): string {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'string' ? v : dflt;
}

function optNum(t: Tree, sec: string, key: string, dflt: number): number {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function reqEnum<T extends string>(t: Tree, sec: string, key: string, allowed: readonly T[]): T {
  const v = (t[sec] as Tree | undefined)?.[key];
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  return fail(`[${sec}].${key}`, `one of ${allowed.join('|')}`);
}

function subtable(t: Tree, path: string): Tree {
  const v = t[path.split('.').pop()!];
  return isTree(v) ? v : fail(path, 'a table');
}

function provider(auth: Tree, id: string): AuthProviderConfig {
  const p = subtable(auth, `auth.${id}`);
  const s = (key: string): string => {
    const v = p[key];
    return typeof v === 'string' ? v : fail(`[auth.${id}].${key}`, 'a string');
  };
  const enabled = typeof p['enabled'] === 'boolean' ? (p['enabled'] as boolean) : fail(`[auth.${id}].enabled`, 'a boolean');
  // The client secret may come from the env instead of the file, matching the rule the
  // locker already follows ("credentials come from the env so they stay out of config
  // files"). Without this an operator has to put a live OAuth secret in config.toml and
  // then ship that file around. Env wins when set; the TOML value stays the fallback so
  // existing configs keep working. Provider id is upper-cased: OMW_OIDC_GOOGLE_SECRET.
  const envSecret = process.env[`OMW_OIDC_${id.toUpperCase()}_SECRET`];
  const clientSecret = envSecret !== undefined && envSecret !== '' ? envSecret : s('clientSecret');
  return { enabled, clientId: s('clientId'), clientSecret, redirectUri: s('redirectUri'), issuer: s('issuer'), scope: s('scope') };
}

function validateAuth(t: Tree): AuthConfig {
  const auth = subtable(t, 'auth');
  const allowPasswordLogin =
    typeof auth['allowPasswordLogin'] === 'boolean'
      ? (auth['allowPasswordLogin'] as boolean)
      : fail('[auth].allowPasswordLogin', 'a boolean');
  const returnUrl = typeof auth['returnUrl'] === 'string' ? (auth['returnUrl'] as string) : fail('[auth].returnUrl', 'a string');
  const requireSso = auth['requireSso'] === true;
  const cfg: AuthConfig = {
    requireSso,
    allowPasswordLogin: requireSso ? false : allowPasswordLogin, // SSO-only forces password off
    returnUrl,
    discord: provider(auth, 'discord'),
    google: provider(auth, 'google'),
    microsoft: provider(auth, 'microsoft'),
    custom: provider(auth, 'custom'),
  };
  const anyEnabled = [cfg.discord, cfg.google, cfg.microsoft, cfg.custom].some((p) => p.enabled);
  // Empty is now the RECOMMENDED setting: the callback derives its return target from the
  // origin the browser actually used, so one build serves any hostname. Setting it pins the
  // permitted origin — useful when several names front one deployment, and a liability
  // otherwise, because a stale value silently redirects every sign-in to somebody else's
  // machine and is invisible from the client.
  if (anyEnabled && returnUrl !== '') {
    let pinned: URL | null = null;
    try { pinned = new URL(returnUrl); } catch { pinned = null; }
    // A loopback pin on a real deployment is the exact failure that shipped once: sign-in
    // from the public site redirected to 127.0.0.1. Refuse to boot rather than repeat it.
    if (pinned && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(pinned.hostname)) {
      fail('[auth].returnUrl',
        'a non-loopback origin, or empty to derive it from the request. It currently pins '
        + `${pinned.origin}, so EVERY sign-in would be redirected there regardless of which `
        + 'host the player came from.');
    }
    if (pinned && (pinned.search !== '' || pinned.hash !== '')) {
      fail('[auth].returnUrl',
        'an origin and path only — no query string or fragment. The launcher builds the game '
        + 'URL itself, and the login ticket is appended as a fragment.');
    }
  }
  if (returnUrl !== '') {
    let parsed: URL;
    try {
      parsed = new URL(returnUrl);
    } catch {
      return fail('[auth].returnUrl', 'an absolute http(s) URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') fail('[auth].returnUrl', 'an absolute http(s) URL');
  }
  // An operator who turns every login path off has locked themselves out; say so now.
  if (!cfg.allowPasswordLogin && !anyEnabled) {
    fail(requireSso ? '[auth].requireSso' : '[auth].allowPasswordLogin',
      requireSso ? 'false unless an SSO provider is enabled (SSO-only with no provider locks everyone out)'
                 : 'true unless an SSO provider is enabled');
  }
  return cfg;
}

function validate(t: Tree): Config {
  const plugins = t['plugins'];
  if (!Array.isArray(plugins) || plugins.some((p) => typeof p !== 'string')) fail('plugins', 'an array of strings');
  // Soft above hard would drop every lossy frame and then never disconnect: the shed would
  // look like a working backpressure valve while nothing ever recovers.
  if (reqNum(t, 'limits', 'maxBufferedBytesHard') < reqNum(t, 'limits', 'maxBufferedBytes'))
    fail('[limits].maxBufferedBytesHard', '>= [limits].maxBufferedBytes');
  // A mid radius inside the near radius makes the mid tier unreachable — the far tier would
  // then start where near ends, silently halving the update rate of everyone nearby.
  if (reqNum(t, 'limits', 'lodMidRadius') < reqNum(t, 'limits', 'lodNearRadius'))
    fail('[limits].lodMidRadius', '>= [limits].lodNearRadius');
  // Culling inside the LOD ladder would delete peers the tiers are still budgeting for.
  const interestRadius = reqNum(t, 'limits', 'interestRadius');
  if (interestRadius > 0 && interestRadius < reqNum(t, 'limits', 'lodMidRadius'))
    fail('[limits].interestRadius', '0 or >= [limits].lodMidRadius');
  // A ratio above 1 would let a WORSE candidate pass the "clearly better" gate, i.e. turn
  // the damping into a handoff generator. Refuse it at boot rather than flap in production.
  return {
    server: {
      name: reqStr(t, 'server', 'name'),
      motd: reqStr(t, 'server', 'motd'),
      maxPlayers: reqNum(t, 'server', 'maxPlayers'),
      password: reqStr(t, 'server', 'password'),
    },
    gateway: { url: reqStr(t, 'gateway', 'url') },
    simPeer: {
      // Resolved in startServer once the game data has been inspected; the raw config cannot
      // know whether a peer is actually runnable.
      enabled: false,
      binary: reqStr(t, 'simPeer', 'binary'),
      configDir: reqStr(t, 'simPeer', 'configDir'),
      userDataDir: reqStr(t, 'simPeer', 'userDataDir'),
      startCell: reqStr(t, 'simPeer', 'startCell'),
      maxPeers: reqNum(t, 'simPeer', 'maxPeers'),
      idleReapMs: reqNum(t, 'simPeer', 'idleReapMs'),
      startTimeoutMs: reqNum(t, 'simPeer', 'startTimeoutMs'),
      restartBackoffMs: reqNum(t, 'simPeer', 'restartBackoffMs'),
    },
    login: {
      allowRegistration: reqBool(t, 'login', 'allowRegistration'),
      inviteCode: reqStr(t, 'login', 'inviteCode'),
      resumeWindowSec: reqNum(t, 'login', 'resumeWindowSec'),
      requireProfile: reqBool(t, 'login', 'requireProfile'),
      allowHarnessAuth: reqBool(t, 'login', 'allowHarnessAuth'),
    },
    integrations: {
      attioApiKey: reqStr(t, 'integrations', 'attioApiKey'),
      attioBaseUrl: reqStr(t, 'integrations', 'attioBaseUrl'),
    },
    content: { enforce: reqEnum(t, 'content', 'enforce', ['strict', 'names', 'off'] as const) },
    sharing: {
      journal: reqBool(t, 'sharing', 'journal'),
      questVars: reqBool(t, 'sharing', 'questVars'),
      factions: reqBool(t, 'sharing', 'factions'),
      crime: reqBool(t, 'sharing', 'crime'),
      map: reqBool(t, 'sharing', 'map'),
      regressAllowlist: reqStrArray(t, 'sharing', 'regressAllowlist'),
      worldGlobals: reqStrArray(t, 'sharing', 'worldGlobals'),
      partyCredit: reqBool(t, 'sharing', 'partyCredit'),
    },
    economy: { noDrop: reqBool(t, 'economy', 'noDrop') },
    locker: {
      endpoint: reqStr(t, 'locker', 'endpoint'),
      region: reqStr(t, 'locker', 'region'),
      bucket: reqStr(t, 'locker', 'bucket'),
      maxBytesPerAccount: reqNum(t, 'locker', 'maxBytesPerAccount'),
      acceptByNameAndSize: optBool(t, 'locker', 'acceptByNameAndSize', true),
      publicBase: optStr(t, 'locker', 'publicBase', ''),
      maxSaveBytesPerAccount: optNum(t, 'locker', 'maxSaveBytesPerAccount', 536870912),
    },
    rules: {
      respawnCellKey: reqStr(t, 'rules', 'respawnCellKey'),
      respawnX: reqSignedNum(t, 'rules', 'respawnX'),
      respawnY: reqSignedNum(t, 'rules', 'respawnY'),
      respawnZ: reqSignedNum(t, 'rules', 'respawnZ'),
      deathPenalty: reqEnum(t, 'rules', 'deathPenalty', ['none'] as const),
      pvp: reqBool(t, 'rules', 'pvp'),
      pvpZone: reqEnum(t, 'rules', 'pvpZone', ['all', 'wilderness', 'none'] as const),
      safeCells: reqStrArray(t, 'rules', 'safeCells'),
      sayScope: reqEnum(t, 'rules', 'sayScope', ['world', 'proximity'] as const),
      timeSkip: reqEnum(t, 'rules', 'timeSkip', ['anyone', 'party', 'off'] as const),
      partyScaling: reqBool(t, 'rules', 'partyScaling'),
      difficulty: reqSignedNum(t, 'rules', 'difficulty'),
    },
    engine: { enforce: reqEnum(t, 'engine', 'enforce', ['warn', 'refuse', 'off'] as const) },
    time: { scale: reqNum(t, 'time', 'scale') },
    gui: { timeoutSec: reqNum(t, 'gui', 'timeoutSec') },
    cellReset: {
      cells: reqStrArray(t, 'cellReset', 'cells'),
      intervalSec: reqNum(t, 'cellReset', 'intervalSec'),
    },
    dev: {
      // Env wins so a one-off `OMW_DEV_BOTS=3` run needs no config edit and leaves no file
      // behind that could ship enabled.
      bots: Math.max(0, Math.trunc(Number(process.env.OMW_DEV_BOTS ?? optNum(t, 'dev', 'bots', 0))) || 0),
      botNames: optStrArray(t, 'dev', 'botNames',
        ['Kestrel', 'Talvyn', 'Sable', 'Ferrun', 'Nyra', 'Orin', 'Vesk', 'Draleth']),
      botPrefix: optStr(t, 'dev', 'botPrefix', 'Bot'),
      botLooks: optStrArray(t, 'dev', 'botLooks', []),
      botRace: optStr(t, 'dev', 'botRace', ''),
      botHead: optStr(t, 'dev', 'botHead', ''),
      botHair: optStr(t, 'dev', 'botHair', ''),
      botClass: optStr(t, 'dev', 'botClass', ''),
    },
    admin: {
      owners: reqStrArray(t, 'admin', 'owners'),
      allowConsole: reqBool(t, 'admin', 'allowConsole'),
      dashboardToken: reqStr(t, 'admin', 'dashboardToken'),
    },
    moderation: {
      chatLog: reqBool(t, 'moderation', 'chatLog'),
      retentionDays: reqNum(t, 'moderation', 'retentionDays'),
      contextLines: reqNum(t, 'moderation', 'contextLines'),
    },
    limits: {
      msgsPerSec: reqNum(t, 'limits', 'msgsPerSec'),
      moveMsgsPerSec: reqNum(t, 'limits', 'moveMsgsPerSec'),
      actorMoveMsgsPerSec: reqNum(t, 'limits', 'actorMoveMsgsPerSec'),
      bytesPerSec: reqNum(t, 'limits', 'bytesPerSec'),
      // Optional: absorbs a legitimate spike (entering a dense cell) without raising the
      // sustained cap. Defaults to 4x the rate so configs written before it keep working.
      bytesBurst: optNum(t, 'limits', 'bytesBurst', reqNum(t, 'limits', 'bytesPerSec') * 4),
      maxBufferedBytes: reqNum(t, 'limits', 'maxBufferedBytes'),
      maxBufferedBytesHard: reqNum(t, 'limits', 'maxBufferedBytesHard'),
      maxConnsPerIp: reqNum(t, 'limits', 'maxConnsPerIp'),
      trustCloudflareIp: optBool(t, 'limits', 'trustCloudflareIp', false),
      maxMsgBytes: reqNum(t, 'limits', 'maxMsgBytes'),
      helloTimeoutMs: reqNum(t, 'limits', 'helloTimeoutMs'),
      loginPerMinPerIp: reqNum(t, 'limits', 'loginPerMinPerIp'),
      maxHitDamage: reqNum(t, 'limits', 'maxHitDamage'),
      interestRadius: reqNum(t, 'limits', 'interestRadius'),
      interestHysteresis: reqNum(t, 'limits', 'interestHysteresis'),
      interestMinPeers: reqNum(t, 'limits', 'interestMinPeers'),
      lodNearRadius: reqNum(t, 'limits', 'lodNearRadius'),
      lodMidRadius: reqNum(t, 'limits', 'lodMidRadius'),
      lodNearHz: reqPosNum(t, 'limits', 'lodNearHz'),
      lodMidHz: reqPosNum(t, 'limits', 'lodMidHz'),
      lodFarHz: reqPosNum(t, 'limits', 'lodFarHz'),
      renderLod: reqEnum(t, 'limits', 'renderLod', ['full', 'tiered'] as const),
      lodNearMaxAvatars: reqNum(t, 'limits', 'lodNearMaxAvatars'),
    },
    authority: {
      rttProbeSec: reqNum(t, 'authority', 'rttProbeSec'),
      reviewSec: reqNum(t, 'authority', 'reviewSec'),
      actorSilenceSec: reqNum(t, 'authority', 'actorSilenceSec'),
    },
    metrics: {
      enabled: reqBool(t, 'metrics', 'enabled'),
      token: reqStr(t, 'metrics', 'token'),
    },
    auth: validateAuth(t),
    plugins: plugins as string[],
  };
}

// Resolves both from src/ (tsx) and dist/ (bundle): ../config.default.toml.
const DEFAULTS_URL = new URL('../config.default.toml', import.meta.url);

export function loadConfig(dataDir: string, override?: DeepPartial<Config>, sharedDir?: string): Config {
  let tree = parse(readFileSync(DEFAULTS_URL, 'utf8')) as Tree;
  // F3: one config.toml in the SHARED dir drives the gateway AND every world it spawns (worlds
  // get empty data dirs). Merged first, so a world may still override with its own config.toml.
  if (sharedDir && sharedDir !== dataDir) {
    const sharedPath = join(sharedDir, 'config.toml');
    if (existsSync(sharedPath)) tree = deepMerge(tree, parse(readFileSync(sharedPath, 'utf8')) as Tree);
  }
  const operatorPath = join(dataDir, 'config.toml');
  if (existsSync(operatorPath)) {
    tree = deepMerge(tree, parse(readFileSync(operatorPath, 'utf8')) as Tree);
  }
  if (override) tree = deepMerge(tree, override as Tree);
  // Worlds spawned by the gateway have no config.toml of their own, so the one flag the
  // browser harness must be able to set on them travels in the environment it already
  // controls. Deliberately env-only and single-purpose: production sets neither.
  if (process.env.OMW_ALLOW_HARNESS_AUTH === '1') {
    tree = deepMerge(tree, { login: { allowHarnessAuth: true } } as Tree);
  }
  return validate(tree);
}
