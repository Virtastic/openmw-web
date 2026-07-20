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
  engine: { enforce: 'warn' | 'refuse' | 'off' };
  limits: {
    msgsPerSec: number;
    moveMsgsPerSec: number;
    bytesPerSec: number;
    maxConnsPerIp: number;
    maxMsgBytes: number;
    helloTimeoutMs: number;
    loginPerMinPerIp: number;
  };
  plugins: string[];
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

function reqBool(t: Tree, sec: string, key: string): boolean {
  const v = (t[sec] as Tree | undefined)?.[key];
  return typeof v === 'boolean' ? v : fail(`[${sec}].${key}`, 'a boolean');
}

function reqEnum<T extends string>(t: Tree, sec: string, key: string, allowed: readonly T[]): T {
  const v = (t[sec] as Tree | undefined)?.[key];
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  return fail(`[${sec}].${key}`, `one of ${allowed.join('|')}`);
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
    engine: { enforce: reqEnum(t, 'engine', 'enforce', ['warn', 'refuse', 'off'] as const) },
    limits: {
      msgsPerSec: reqNum(t, 'limits', 'msgsPerSec'),
      moveMsgsPerSec: reqNum(t, 'limits', 'moveMsgsPerSec'),
      bytesPerSec: reqNum(t, 'limits', 'bytesPerSec'),
      maxConnsPerIp: reqNum(t, 'limits', 'maxConnsPerIp'),
      maxMsgBytes: reqNum(t, 'limits', 'maxMsgBytes'),
      helloTimeoutMs: reqNum(t, 'limits', 'helloTimeoutMs'),
      loginPerMinPerIp: reqNum(t, 'limits', 'loginPerMinPerIp'),
    },
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
