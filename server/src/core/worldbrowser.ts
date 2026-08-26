// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3 client side — the in-game world browser, served through the world the player is
// already in.
//
// WHY THE WORLD PROXIES THE DIRECTORY. The Lua client has no HTTP; it has one WebSocket to
// its world. So "show me the worlds" travels the connection the player already has, and the
// world asks the gateway on their behalf. That also keeps the gateway URL an operator
// setting rather than something baked into a client build.
//
// The player's ACCOUNT is taken from their authenticated session, never from the message.
// A client that could name its own account would be able to list — and create sessions
// under — somebody else's identity.

import type { Player } from './players';
import { log } from '../log';

export interface WorldEntry {
  id: string;
  mode: string;
  name: string;
  host: string;
  port: number;
  // Path to dial on the GATEWAY origin instead of the world's own port. Production publishes
  // no world ports at all (the edge reaches only :8080), so this is how a world is reachable.
  wsPath?: string;
  playerCount: number;
  maxPlayers: number;
  up: boolean;
  ownerAccount?: string;
}

export interface WorldBrowserDeps {
  gatewayUrl: string; // '' = no gateway configured
  // This world's own port, so the client can tell which entry in the list is where it
  // already is. Resolved lazily because the listening port is not known at construction.
  ownPort?: () => number;
  // Injected for tests, and so a slow/wedged gateway can never hang a player's session.
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class WorldBrowser {
  constructor(private readonly deps: WorldBrowserDeps) {}

  get enabled(): boolean {
    return this.deps.gatewayUrl !== '';
  }

  get ownPort(): number {
    return this.deps.ownPort?.() ?? 0;
  }

  private async call(path: string, init?: RequestInit): Promise<unknown | null> {
    const f = this.deps.fetchImpl ?? fetch;
    try {
      const r = await f(`${this.deps.gatewayUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 3000),
      });
      if (!r.ok) {
        // 4xx from the gateway is a real answer (at cap, per-owner limit) and its body
        // explains why — pass it through rather than flattening to "unavailable".
        const body = await r.json().catch(() => null);
        return { __httpError: r.status, ...(body && typeof body === 'object' ? body : {}) };
      }
      return await r.json();
    } catch (err) {
      log('warn', 'worldbrowser.gateway_unreachable', { path, error: String(err) });
      return null;
    }
  }

  async list(player: Player): Promise<{ worlds: WorldEntry[]; error?: string }> {
    if (!this.enabled) return { worlds: [], error: 'no_gateway' };
    const r = await this.call(`/worlds?account=${encodeURIComponent(player.accountKey)}`);
    if (!r || typeof r !== 'object') return { worlds: [], error: 'unreachable' };
    if ('__httpError' in r) return { worlds: [], error: 'unreachable' };
    const worlds = (r as { worlds?: unknown }).worlds;
    return { worlds: Array.isArray(worlds) ? worlds as WorldEntry[] : [] };
  }

  // The world another ACCOUNT owns, if it is up. Used to join a friend who never left their
  // own world: this process cannot see into another world's roster, but the gateway knows
  // who owns what. Reuses the existing /worlds?account= filter rather than adding a
  // who-is-where endpoint — occupancy is not exposed, only "this account has a world".
  // Safe to answer because the DESTINATION still authorizes: mayJoinWorld admits the owner's
  // party and refuses everyone else, so knowing the address buys a stranger nothing. Callers
  // must have already established a relationship (joinFriend checks areFriends first).
  async ownerWorld(accountKey: string): Promise<WorldEntry | undefined> {
    if (!this.enabled) return undefined;
    const r = await this.call(`/worlds?account=${encodeURIComponent(accountKey)}`);
    if (!r || typeof r !== 'object' || '__httpError' in r) return undefined;
    const worlds = (r as { worlds?: unknown }).worlds;
    if (!Array.isArray(worlds)) return undefined;
    return (worlds as WorldEntry[]).find((w) => w.ownerAccount === accountKey && w.up);
  }

  async create(player: Player, id: string, mode: string): Promise<{ world?: WorldEntry; error?: string }> {
    if (!this.enabled) return { error: 'no_gateway' };
    if (mode !== 'private' && mode !== 'party') return { error: 'bad_mode' };
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) return { error: 'bad_id' };
    const r = await this.call('/worlds', {
      method: 'POST',
      // accountKey from the SESSION, never from the client's message.
      body: JSON.stringify({ id, mode, account: player.accountKey }),
    });
    if (!r || typeof r !== 'object') return { error: 'unreachable' };
    if ('__httpError' in r) {
      const status = (r as { __httpError: number }).__httpError;
      // LOG THE STATUS. Everything that is not 429 or 503 collapses into a single 'refused'
      // with the status discarded, so a 400, a 401 and a 404 are indistinguishable to the
      // player AND to whoever is reading the log -- s47 spent two runs as an opaque 30s
      // timeout for exactly this reason. The mapped strings stay as they are because the
      // client keys its human-readable messages off them.
      log('warn', 'worldbrowser.create_refused', {
        status, id, mode, account: player.accountKey || '(none)',
      });
      return { error: status === 429 ? 'too_many_sessions' : status === 503 ? 'platform_full' : 'refused' };
    }
    return { world: r as WorldEntry };
  }
}
