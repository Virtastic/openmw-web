// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3 — the world supervisor: many world PROCESSES, one directory in front of them.
//
// WHY PROCESSES AND NOT ONE PROCESS WITH MANY WORLDS. Not only because Node is
// single-threaded (that is the performance half). `core/authority.ts` keeps its tuning in a
// module-level singleton that `configureAuthority()` MUTATES, and `metrics` is a module
// singleton too. Two worlds sharing a process would share both: the last world to boot
// would silently retune every other world's authority election, and no metric could be
// attributed to a world. Process-per-world is a correctness boundary, not a preference.
//
// This is also what makes a sim peer PER SESSION real: each world process runs its own
// SimPeerSupervisor (H4), so a private session that spawns a world gets a headless peer with
// it, and reaping the world reaps the peer.
//
// The lifecycle mirrors core/simpeer.ts deliberately — cap, idle reap, crash backoff — for
// the same reason: a world per party is how a box runs out of memory if nothing reaps.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log';

export type WorldMode = 'public' | 'private' | 'party';

export interface WorldSettings {
  worldsDir: string; // per-world data dirs live under here
  serverEntry: string; // path to the world server entry (dist/server.mjs)
  nodeBin: string;
  basePort: number;
  maxWorlds: number; // hard cap across ALL modes
  idleReapMs: number; // a non-public world with no players this long is stopped
  startTimeoutMs: number;
  restartBackoffMs: number;
  publicWorlds: string[]; // always-on world ids, started at boot and never reaped
  // One identity across every world: accounts, SSO identities, friends/party/presence and
  // bans live here, NOT in each world's data dir. Without it a player could not log into
  // their own private session with the account they made in the public world, friends would
  // not span worlds, and a ban would apply only where it was issued.
  sharedDir: string;
}

export interface WorldInfo {
  id: string;
  mode: WorldMode;
  port: number;
  playerCount: number;
  maxPlayers: number;
  name: string;
  up: boolean;
  ownerAccount?: string; // private/party: who created it
}

interface World {
  id: string;
  mode: WorldMode;
  port: number;
  child: ChildProcess;
  startedAt: number;
  idleSince?: number;
  stopping: boolean;
  ownerAccount?: string;
  lastStatus?: { playerCount: number; connectedCount: number; maxPlayers: number; name: string };
}

export interface WorldDeps {
  settings: WorldSettings;
  spawner?: (id: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  fetchStatus?: (port: number) => Promise<{ playerCount: number; connectedCount: number; maxPlayers: number; name: string } | null>;
  now?: () => number;
}

export class WorldSupervisor {
  private worlds = new Map<string, World>();
  private blockedUntil = new Map<string, number>();
  private usedPorts = new Set<number>();
  private pollTimer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly deps: WorldDeps) {
    this.now = deps.now ?? Date.now;
  }

  get running(): number {
    return this.worlds.size;
  }

  list(): WorldInfo[] {
    return [...this.worlds.values()].map((w) => ({
      id: w.id,
      mode: w.mode,
      port: w.port,
      playerCount: w.lastStatus?.playerCount ?? 0,
      maxPlayers: w.lastStatus?.maxPlayers ?? 0,
      name: w.lastStatus?.name ?? w.id,
      up: w.lastStatus !== undefined,
      ...(w.ownerAccount ? { ownerAccount: w.ownerAccount } : {}),
    }));
  }

  get(id: string): WorldInfo | undefined {
    return this.list().find((w) => w.id === id);
  }

  // Start the always-on worlds. Public worlds are never reaped: an empty public world must
  // still be joinable, which is the whole point of it being public.
  startPublic(): void {
    for (const id of this.deps.settings.publicWorlds) this.ensure(id, 'public');
  }

  // Idempotent. Returns the world (existing or new), or null if it could not be started —
  // callers must handle null rather than assume a world exists.
  ensure(id: string, mode: WorldMode, ownerAccount?: string): WorldInfo | null {
    const existing = this.worlds.get(id);
    if (existing) {
      existing.idleSince = undefined;
      return this.get(id)!;
    }
    if (this.worlds.size >= this.deps.settings.maxWorlds) {
      log('warn', 'world.at_cap', { id, running: this.worlds.size, cap: this.deps.settings.maxWorlds });
      return null;
    }
    const blocked = this.blockedUntil.get(id);
    if (blocked !== undefined && this.now() < blocked) {
      log('warn', 'world.backoff', { id });
      return null;
    }
    return this.start(id, mode, ownerAccount);
  }

  private allocPort(): number | null {
    const { basePort, maxWorlds } = this.deps.settings;
    for (let p = basePort; p < basePort + maxWorlds * 4; p++) {
      if (!this.usedPorts.has(p)) return p;
    }
    return null;
  }

  private start(id: string, mode: WorldMode, ownerAccount?: string): WorldInfo | null {
    const s = this.deps.settings;
    const port = this.allocPort();
    if (port === null) {
      log('error', 'world.no_port', { id });
      return null;
    }
    const dataDir = join(s.worldsDir, id);
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      log('error', 'world.mkdir_failed', { id, error: String(err) });
      return null;
    }
    const args = [s.serverEntry, '--data', dataDir, '--shared', s.sharedDir, '--port', String(port)];
    let child: ChildProcess;
    try {
      const spawner = this.deps.spawner
        ?? ((_id, a, env) => spawn(s.nodeBin, a, { env, stdio: 'ignore' }));
      child = spawner(id, args, {
        ...process.env,
        OMW_WORLD_ID: id,
        OMW_WORLD_MODE: mode,
        // Access control: the world itself refuses accounts that do not belong (private =
        // owner only; party = owner or current party members). The directory's listing
        // filter is visibility, never authorization — this is the authorization.
        OMW_WORLD_OWNER: ownerAccount ?? '',
      });
    } catch (err) {
      log('error', 'world.spawn_failed', { id, error: String(err) });
      return null;
    }
    this.usedPorts.add(port);
    const world: World = { id, mode, port, child, startedAt: this.now(), stopping: false, ownerAccount };
    this.worlds.set(id, world);
    log('info', 'world.started', { id, mode, port, pid: child.pid ?? -1 });

    child.on('exit', (code, signal) => {
      if (this.worlds.get(id) !== world) return; // a stale exit must not evict its successor
      this.worlds.delete(id);
      this.usedPorts.delete(port);
      if (world.stopping) {
        log('info', 'world.stopped', { id });
        return;
      }
      this.blockedUntil.set(id, this.now() + s.restartBackoffMs);
      log('error', 'world.crashed', { id, code: code ?? -1, signal: signal ?? '' });
    });
    child.on('error', (err) => log('error', 'world.child_error', { id, error: String(err) }));
    return this.get(id)!;
  }

  // Poll every world's /status: it is the same endpoint the lobby uses, so the directory
  // reports exactly what a player would see, and a world that stops answering is marked
  // down rather than silently listed as healthy.
  async poll(): Promise<void> {
    const fetchStatus = this.deps.fetchStatus ?? defaultFetchStatus;
    await Promise.all([...this.worlds.values()].map(async (w) => {
      const st = await fetchStatus(w.port);
      if (st) {
        w.lastStatus = st;
        // Public worlds are never idle-reaped; see startPublic. This is guarded HERE (never
        // start the idle clock) and again in sweep() (never act on it). That redundancy is
        // DELIBERATE and verified: removing either guard alone keeps the property, removing
        // both breaks it. Do not delete one as dead code — a public world quietly vanishing
        // is players failing to join the world the lobby is advertising.
        if (w.mode !== 'public') {
          // Idle = nobody CONNECTED (loading / at chargen counts), not merely nobody in a cell.
          if (st.connectedCount > 0) w.idleSince = undefined;
          else if (w.idleSince === undefined) w.idleSince = this.now();
        }
      } else {
        w.lastStatus = undefined; // down: reported as up:false, not omitted
      }
    }));
    this.sweep();
  }

  sweep(): void {
    const cutoff = this.now() - this.deps.settings.idleReapMs;
    for (const w of [...this.worlds.values()]) {
      if (w.mode === 'public') continue; // second half of the deliberate guard; see poll()
      if (w.idleSince !== undefined && w.idleSince <= cutoff) {
        log('info', 'world.reaped', { id: w.id, idleMs: this.now() - w.idleSince });
        this.stop(w.id);
      }
    }
  }

  startPolling(intervalMs = 5_000): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
    this.pollTimer.unref();
  }

  stop(id: string): void {
    const w = this.worlds.get(id);
    if (!w) return;
    w.stopping = true;
    // SIGTERM so the world drains and flushes its stores; main.ts already handles it.
    w.child.kill('SIGTERM');
  }

  // F4: restart worlds ONE AT A TIME so a deploy never takes the whole platform down.
  // Each world drains gracefully (main.ts handles SIGTERM: SessionDisconnect SHUTDOWN then
  // flush), and the next is not touched until the previous one is back and answering
  // /status — otherwise "rolling" would just be a slower simultaneous outage.
  //
  // Empty worlds first, busiest last: the same total disruption, but the players least
  // likely to notice absorb the early risk, and if the operator aborts midway the worlds
  // still up are the populated ones.
  async rollingRestart(opts: { readyTimeoutMs?: number } = {}): Promise<{ restarted: string[]; failed: string[] }> {
    const readyTimeoutMs = opts.readyTimeoutMs ?? this.deps.settings.startTimeoutMs;
    const order = [...this.worlds.values()]
      .sort((a, b) => (a.lastStatus?.playerCount ?? 0) - (b.lastStatus?.playerCount ?? 0))
      .map((w) => ({ id: w.id, mode: w.mode, owner: w.ownerAccount }));
    const restarted: string[] = [];
    const failed: string[] = [];

    for (const w of order) {
      log('info', 'world.rolling_restart', { id: w.id });
      this.stop(w.id);
      // Wait for the old process to actually exit before starting its replacement, or the
      // two briefly share a data dir. Bounded by ATTEMPTS rather than by comparing the
      // injected clock against real sleeps — mixing the two hangs forever whenever now()
      // is frozen, which is exactly what a test does.
      const goneTries = Math.max(1, Math.ceil(readyTimeoutMs / 100));
      for (let i = 0; i < goneTries && this.worlds.has(w.id); i++) await delay(100);
      if (this.worlds.has(w.id)) {
        failed.push(w.id);
        log('error', 'world.rolling_restart_stuck', { id: w.id });
        continue; // leave it alone rather than starting a second copy
      }
      // A crash backoff from the stop would block the restart; this is a deliberate
      // operator action, so clear it.
      this.blockedUntil.delete(w.id);
      if (!this.ensure(w.id, w.mode, w.owner)) {
        failed.push(w.id);
        continue;
      }
      const readyTries = Math.max(1, Math.ceil(readyTimeoutMs / 250));
      let ready = false;
      for (let i = 0; i < readyTries; i++) {
        await this.poll();
        if (this.get(w.id)?.up) { ready = true; break; }
        await delay(250);
      }
      if (ready) restarted.push(w.id);
      else {
        failed.push(w.id);
        // STOP the rollout: if one world will not come back, restarting the rest turns a
        // single failure into a full outage. The operator decides what to do next.
        log('error', 'world.rolling_restart_halted', { id: w.id, restarted: restarted.length });
        break;
      }
    }
    return { restarted, failed };
  }

  stopAll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const id of [...this.worlds.keys()]) this.stop(id);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function defaultFetchStatus(port: number): Promise<{ playerCount: number; connectedCount: number; maxPlayers: number; name: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const j = await r.json() as { playerCount?: number; connectedCount?: number; maxPlayers?: number; name?: string };
    return {
      playerCount: typeof j.playerCount === 'number' ? j.playerCount : 0,
      connectedCount: typeof j.connectedCount === 'number' ? j.connectedCount : (typeof j.playerCount === 'number' ? j.playerCount : 0),
      maxPlayers: typeof j.maxPlayers === 'number' ? j.maxPlayers : 0,
      name: typeof j.name === 'string' ? j.name : `world:${port}`,
    };
  } catch {
    return null; // not up yet, or wedged — either way it is not joinable
  }
}
