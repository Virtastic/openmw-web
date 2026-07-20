// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// JSON session tier (text frames) per PROTOCOL.md: parse+validate client messages,
// build server messages. One JSON object per frame, discriminated by "t".

export class SessionParseError extends Error {
  constructor(message: string) {
    super(`session: ${message}`);
    this.name = 'SessionParseError';
  }
}

export interface ManifestEntry {
  name: string;
  size: number;
  idx: number;
  sha256?: string;
}

export interface SessionHello {
  t: 'SessionHello';
  proto: number;
  engineHash: string;
  lserVersion: number;
  manifest: ManifestEntry[];
  resumeToken?: string;
}
export interface SessionRegister {
  t: 'SessionRegister';
  account: string;
  password: string;
  serverPassword?: string;
  inviteCode?: string; // not in PROTOCOL.md yet; required when [login].inviteCode is set
}
export interface SessionLoginRequest {
  t: 'SessionLoginRequest';
  account: string;
  password: string;
  serverPassword?: string;
}
export interface SessionReady {
  t: 'SessionReady';
}
export interface SessionPing {
  t: 'SessionPing';
  clientTime: number;
}
export type ClientSessionMsg =
  | SessionHello
  | SessionRegister
  | SessionLoginRequest
  | SessionReady
  | SessionPing;

export type DisconnectCode =
  | 'BAD_PROTO'
  | 'BAD_ENGINE'
  | 'BAD_CONTENT'
  | 'AUTH_FAILED'
  | 'BANNED'
  | 'SUPERSEDED'
  | 'KICKED'
  | 'RATE'
  | 'SERVER_FULL'
  | 'SHUTDOWN';

type Json = { [key: string]: unknown };

function str(o: Json, key: string, opt = false): string {
  const v = o[key];
  if (v === undefined && opt) return '';
  if (typeof v !== 'string') throw new SessionParseError(`"${key}" must be a string`);
  return v;
}

function num(o: Json, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SessionParseError(`"${key}" must be a number`);
  return v;
}

function parseManifest(o: Json): ManifestEntry[] {
  const raw = o['manifest'];
  if (!Array.isArray(raw)) throw new SessionParseError('"manifest" must be an array');
  if (raw.length > 1024) throw new SessionParseError('manifest too long');
  return raw.map((e, i) => {
    if (typeof e !== 'object' || e === null) throw new SessionParseError(`manifest[${i}] must be an object`);
    const entry = e as Json;
    const m: ManifestEntry = {
      name: str(entry, 'name'),
      size: num(entry, 'size'),
      idx: num(entry, 'idx'),
    };
    if (m.name.length === 0 || m.name.length > 256) throw new SessionParseError(`manifest[${i}].name bad length`);
    if (typeof entry['sha256'] === 'string') m.sha256 = entry['sha256'];
    return m;
  });
}

// Returns null for well-formed JSON objects with an unknown "t" (ignored for forward
// compatibility inside M0); throws SessionParseError on anything malformed.
export function parseSessionMessage(text: string): ClientSessionMsg | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SessionParseError('text frame is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new SessionParseError('text frame must be a JSON object');
  const o = raw as Json;
  const t = o['t'];
  if (typeof t !== 'string') throw new SessionParseError('missing "t" discriminant');
  switch (t) {
    case 'SessionHello':
      return {
        t,
        proto: num(o, 'proto'),
        engineHash: str(o, 'engineHash', true),
        lserVersion: num(o, 'lserVersion'),
        manifest: parseManifest(o),
        ...(typeof o['resumeToken'] === 'string' ? { resumeToken: o['resumeToken'] } : {}),
      };
    case 'SessionRegister':
      return {
        t,
        account: str(o, 'account'),
        password: str(o, 'password'),
        ...(typeof o['serverPassword'] === 'string' ? { serverPassword: o['serverPassword'] } : {}),
        ...(typeof o['inviteCode'] === 'string' ? { inviteCode: o['inviteCode'] } : {}),
      };
    case 'SessionLoginRequest':
      return {
        t,
        account: str(o, 'account'),
        password: str(o, 'password'),
        ...(typeof o['serverPassword'] === 'string' ? { serverPassword: o['serverPassword'] } : {}),
      };
    case 'SessionReady':
      return { t };
    case 'SessionPing':
      return { t, clientTime: num(o, 'clientTime') };
    default:
      return null;
  }
}

// -------------------------------------------------------- server -> client

export function helloOk(serverName: string, contentPolicy: 'names' | 'strict' | 'off'): string {
  return JSON.stringify({ t: 'SessionHelloOk', serverName, contentPolicy });
}

export function welcome(
  playerId: number,
  sessionToken: string,
  motd: string,
  serverSeq: number,
  playerRecord: unknown = null, // M2: stored snapshot doc, or null for fresh chargen
): string {
  return JSON.stringify({
    t: 'SessionWelcome',
    playerId,
    sessionToken,
    motd,
    flags: {},
    playerRecord: playerRecord ?? null,
    serverSeq,
  });
}

export function pong(clientTime: number, serverTime: number): string {
  return JSON.stringify({ t: 'SessionPong', clientTime, serverTime });
}

export function disconnectMsg(code: DisconnectCode, detail: string): string {
  return JSON.stringify({ t: 'SessionDisconnect', code, detail });
}
