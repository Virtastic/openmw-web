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
  login: { allowRegistration: boolean; inviteCode: string; resumeWindowSec: number };
  content: { enforce: 'strict' | 'names' | 'off' };
  sharing: {
    journal: boolean;
    questVars: boolean;
    factions: boolean;
    crime: boolean;
    map: boolean;
    regressAllowlist: string[];
  };
  rules: {
    respawnCellKey: string;
    respawnX: number;
    respawnY: number;
    respawnZ: number;
    deathPenalty: 'none';
    pvp: boolean;
    difficulty: number;
  };
  engine: { enforce: 'warn' | 'refuse' | 'off' };
  // M7 world state.
  time: { scale: number };
  gui: { timeoutSec: number };
  cellReset: { cells: string[]; intervalSec: number };
  // M8 ops.
  admin: { owners: string[]; allowConsole: boolean };
  moderation: { chatLog: boolean; retentionDays: number; contextLines: number };
  limits: {
    msgsPerSec: number;
    moveMsgsPerSec: number;
    bytesPerSec: number;
    maxConnsPerIp: number;
    maxMsgBytes: number;
    helloTimeoutMs: number;
    loginPerMinPerIp: number;
    maxHitDamage: number;
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

function reqBool(t: Tree, sec: string, key: string): boolean {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'boolean' ? v : fail(`[${sec}].${key}`, 'a boolean');
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
  return { enabled, clientId: s('clientId'), clientSecret: s('clientSecret'), redirectUri: s('redirectUri'), issuer: s('issuer'), scope: s('scope') };
}

function validateAuth(t: Tree): AuthConfig {
  const auth = subtable(t, 'auth');
  const allowPasswordLogin =
    typeof auth['allowPasswordLogin'] === 'boolean'
      ? (auth['allowPasswordLogin'] as boolean)
      : fail('[auth].allowPasswordLogin', 'a boolean');
  const returnUrl = typeof auth['returnUrl'] === 'string' ? (auth['returnUrl'] as string) : fail('[auth].returnUrl', 'a string');
  const cfg: AuthConfig = {
    allowPasswordLogin,
    returnUrl,
    discord: provider(auth, 'discord'),
    google: provider(auth, 'google'),
    microsoft: provider(auth, 'microsoft'),
    custom: provider(auth, 'custom'),
  };
  const anyEnabled = [cfg.discord, cfg.google, cfg.microsoft, cfg.custom].some((p) => p.enabled);
  // Fail boot rather than redirect a player into a dead end: with no return URL the
  // callback has nowhere to hand the login ticket.
  if (anyEnabled && returnUrl === '') fail('[auth].returnUrl', 'set when any provider is enabled');
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
  if (!allowPasswordLogin && !anyEnabled) fail('[auth].allowPasswordLogin', 'true unless an SSO provider is enabled');
  return cfg;
}

function validate(t: Tree): Config {
  const plugins = t['plugins'];
  if (!Array.isArray(plugins) || plugins.some((p) => typeof p !== 'string')) fail('plugins', 'an array of strings');
  return {
    server: {
      name: reqStr(t, 'server', 'name'),
      motd: reqStr(t, 'server', 'motd'),
      maxPlayers: reqNum(t, 'server', 'maxPlayers'),
      password: reqStr(t, 'server', 'password'),
    },
    login: {
      allowRegistration: reqBool(t, 'login', 'allowRegistration'),
      inviteCode: reqStr(t, 'login', 'inviteCode'),
      resumeWindowSec: reqNum(t, 'login', 'resumeWindowSec'),
    },
    content: { enforce: reqEnum(t, 'content', 'enforce', ['strict', 'names', 'off'] as const) },
    sharing: {
      journal: reqBool(t, 'sharing', 'journal'),
      questVars: reqBool(t, 'sharing', 'questVars'),
      factions: reqBool(t, 'sharing', 'factions'),
      crime: reqBool(t, 'sharing', 'crime'),
      map: reqBool(t, 'sharing', 'map'),
      regressAllowlist: reqStrArray(t, 'sharing', 'regressAllowlist'),
    },
    rules: {
      respawnCellKey: reqStr(t, 'rules', 'respawnCellKey'),
      respawnX: reqSignedNum(t, 'rules', 'respawnX'),
      respawnY: reqSignedNum(t, 'rules', 'respawnY'),
      respawnZ: reqSignedNum(t, 'rules', 'respawnZ'),
      deathPenalty: reqEnum(t, 'rules', 'deathPenalty', ['none'] as const),
      pvp: reqBool(t, 'rules', 'pvp'),
      difficulty: reqSignedNum(t, 'rules', 'difficulty'),
    },
    engine: { enforce: reqEnum(t, 'engine', 'enforce', ['warn', 'refuse', 'off'] as const) },
    time: { scale: reqNum(t, 'time', 'scale') },
    gui: { timeoutSec: reqNum(t, 'gui', 'timeoutSec') },
    cellReset: {
      cells: reqStrArray(t, 'cellReset', 'cells'),
      intervalSec: reqNum(t, 'cellReset', 'intervalSec'),
    },
    admin: {
      owners: reqStrArray(t, 'admin', 'owners'),
      allowConsole: reqBool(t, 'admin', 'allowConsole'),
    },
    moderation: {
      chatLog: reqBool(t, 'moderation', 'chatLog'),
      retentionDays: reqNum(t, 'moderation', 'retentionDays'),
      contextLines: reqNum(t, 'moderation', 'contextLines'),
    },
    limits: {
      msgsPerSec: reqNum(t, 'limits', 'msgsPerSec'),
      moveMsgsPerSec: reqNum(t, 'limits', 'moveMsgsPerSec'),
      bytesPerSec: reqNum(t, 'limits', 'bytesPerSec'),
      maxConnsPerIp: reqNum(t, 'limits', 'maxConnsPerIp'),
      maxMsgBytes: reqNum(t, 'limits', 'maxMsgBytes'),
      helloTimeoutMs: reqNum(t, 'limits', 'helloTimeoutMs'),
      loginPerMinPerIp: reqNum(t, 'limits', 'loginPerMinPerIp'),
      maxHitDamage: reqNum(t, 'limits', 'maxHitDamage'),
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

export function loadConfig(dataDir: string, override?: DeepPartial<Config>): Config {
  let tree = parse(readFileSync(DEFAULTS_URL, 'utf8')) as Tree;
  const operatorPath = join(dataDir, 'config.toml');
  if (existsSync(operatorPath)) {
    tree = deepMerge(tree, parse(readFileSync(operatorPath, 'utf8')) as Tree);
  }
  if (override) tree = deepMerge(tree, override as Tree);
  return validate(tree);
}
