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
  // Does this client run a game engine that can SIMULATE a cell's actors? Cell authority is
  // otherwise elected on network fitness alone, and a client that cannot simulate — a
  // protocol bot, a headless tool — is a near-perfect candidate on RTT while producing
  // nothing, which freezes every NPC in the cell for everyone. Absent = false, so anything
  // that does not explicitly claim the capability is never handed the job.
  simulatesActors?: boolean;
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
// M8: rejoin-in-place with a token parked when the previous session dropped. Sent in
// HELLO_OK, i.e. AFTER Hello — a resume never bypasses the engine/content policy.
export interface SessionResume {
  t: 'SessionResume';
  token: string;
}
// Phase B SSO: the browser completed an OAuth round trip against /auth/:provider/* and
// came back holding a one-time ticket. Sent in HELLO_OK exactly where a login goes; it
// carries no provider token and no password. Single use, <=60 s.
export interface SessionLoginTicket {
  t: 'SessionLoginTicket';
  ticket: string;
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
  | SessionLoginTicket
  | SessionResume
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
        ...(o['simulatesActors'] === true ? { simulatesActors: true } : {}),
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
    case 'SessionLoginTicket':
      return {
        t,
        ticket: str(o, 'ticket'),
        ...(typeof o['serverPassword'] === 'string' ? { serverPassword: o['serverPassword'] } : {}),
      };
    case 'SessionResume':
      return { t, token: str(o, 'token') };
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

// M5: rule flags the client reflects locally (difficulty is applied client-side, in the
// victim's own combat pipeline — the server never computes damage).
export interface SessionFlags {
  pvp: boolean;
  difficulty: number;
  // G2 render LOD. The client degrades DISTANT avatars rather than hiding them, and it
  // tiers on the SAME radii the broadcaster uses to tier send rate — so a puppet updated at
  // 1 Hz is never also being asked to walk smoothly, which is what made distant avatars
  // both expensive and visibly wrong. Shipped as flags rather than client constants so a
  // crowded public world and a 4-player co-op session can be tuned without a client
  // rebuild; the client bakes its scripts into openmw.data, so a constant here would cost a
  // full relink to change.
  renderLod: 'full' | 'tiered'; // 'full' = pre-G2 behaviour (every puppet fully driven)
  lodNearRadius: number;
  lodMidRadius: number;
  lodNearMaxAvatars: number; // hard ceiling on fully-simulated avatars; 0 = radius only
}

export function welcome(
  playerId: number,
  sessionToken: string,
  motd: string,
  serverSeq: number,
  playerRecord: unknown = null, // M2: stored snapshot doc, or null for fresh chargen
  // Default mirrors config.default.toml's radii, with renderLod 'full' so a caller that
  // omits flags gets full fidelity rather than a silent degrade.
  flags: SessionFlags = {
    pvp: false, difficulty: 0, renderLod: 'full',
    lodNearRadius: 4096, lodMidRadius: 8192, lodNearMaxAvatars: 0,
  },
): string {
  return JSON.stringify({
    t: 'SessionWelcome',
    playerId,
    sessionToken,
    motd,
    flags,
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
