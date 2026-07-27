// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase H4 — on-demand headless simulation peers.
//
// A sim peer is a real OpenMW with rendering disabled (OPENMW_HEADLESS=1) that connects to
// this server like any other client, declares `system` + `simulatesActors`, and wins cell
// authority through the ordinary election. The effect is that NPCs are simulated on the
// operator's machine rather than in whichever player's browser happened to win — which is
// what makes a forged ActorMoveBatch pointless (see worldstate.handleActorMoveBatch).
//
// THE REAPER IS THE POINT, NOT THE SPAWNER. Measured cost is ~360 MB RSS and ~9% of a core
// per peer, so an unreaped peer per abandoned session is how a box runs out of memory. Every
// spawn path here is guarded by a cap, and every peer has an idle deadline.
//
// Deliberately NOT a general process manager: it supervises peers for THIS server's world.
// Multi-world orchestration (F3) does not exist yet, and pretending otherwise would build a
// dependency on something unbuilt.

import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../log';
import { metrics } from '../metrics';

export interface SimPeerSettings {
  enabled: boolean;
  binary: string;
  configDir: string;
  userDataDir: string;
  startCell: string;
  maxPeers: number;
  idleReapMs: number;
  startTimeoutMs: number;
  restartBackoffMs: number;
}

// Injected so tests can drive the supervisor without launching a real engine.
export interface Spawner {
  (key: string, env: NodeJS.ProcessEnv, args: string[]): ChildProcess;
}

interface Peer {
  key: string;
  child: ChildProcess;
  startedAt: number;
  // When the world went empty of humans. undefined = humans present, so not reapable.
  idleSince?: number;
  stopping: boolean;
}

export interface SimPeerDeps {
  settings: SimPeerSettings;
  // Lazy: the OS-assigned port (port 0 in tests, and any deployment that lets the OS pick)
  // is not known when the supervisor is constructed, so this is resolved at spawn time.
  wsUrl: () => string;
  password: string; // server password, if one is set
  spawner?: Spawner; // tests
  now?: () => number;
}

export class SimPeerSupervisor {
  private peers = new Map<string, Peer>();
  private blockedUntil = new Map<string, number>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly deps: SimPeerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get running(): number {
    return this.peers.size;
  }

  has(key: string): boolean {
    return this.peers.has(key);
  }

  // Called when a human is present in `key`'s world. Idempotent: it either starts the peer,
  // or clears an existing peer's idle deadline so the reaper leaves it alone.
  ensure(key: string): void {
    if (!this.deps.settings.enabled) return;
    const existing = this.peers.get(key);
    if (existing) {
      existing.idleSince = undefined; // humans are back; cancel any pending reap
      return;
    }
    if (!this.deps.settings.binary) {
      log('warn', 'simpeer.no_binary', { key });
      return;
    }
    // The cap is checked HERE and nowhere else, so there is exactly one way to create a peer.
    if (this.peers.size >= this.deps.settings.maxPeers) {
      metrics.simPeerRefused.inc({ reason: 'at_cap' });
      log('warn', 'simpeer.at_cap', { key, running: this.peers.size, cap: this.deps.settings.maxPeers });
      return;
    }
    const blocked = this.blockedUntil.get(key);
    if (blocked !== undefined && this.now() < blocked) {
      metrics.simPeerRefused.inc({ reason: 'backoff' });
      return; // a recent crash; do not hot-loop the engine
    }
    this.start(key);
  }

  // Called when a world has no humans left. Does NOT kill immediately — a player reconnecting
  // within the idle window should find the world still simulated rather than pay a cold start
  // (retail data takes tens of seconds to load).
  markIdle(key: string): void {
    const peer = this.peers.get(key);
    if (peer && peer.idleSince === undefined) peer.idleSince = this.now();
  }

  private start(key: string): void {
    const s = this.deps.settings;
    const args = [
      '--config', s.configDir,
      '--replace', 'config',
      '--user-data', s.userDataDir,
      '--skip-menu', '--new-game',
      '--start', s.startCell,
      '--no-sound',
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENMW_HEADLESS: '1',
      OPENMW_MP_SYSTEM: '1', // keeps it out of the player list / count / maxPlayers
      OPENMW_MP_URL: this.deps.wsUrl(),
      OPENMW_MP_NAME: `simpeer-${key}`,
      OPENMW_MP_PASS: this.deps.password,
    };
    let child: ChildProcess;
    try {
      child = (this.deps.spawner ?? defaultSpawner(s.binary))(key, env, args);
    } catch (err) {
      metrics.simPeerRefused.inc({ reason: 'spawn_failed' });
      log('error', 'simpeer.spawn_failed', { key, error: String(err) });
      return;
    }
    const peer: Peer = { key, child, startedAt: this.now(), stopping: false };
    this.peers.set(key, peer);
    metrics.simPeerSpawned.inc({});
    log('info', 'simpeer.spawned', { key, pid: child.pid ?? -1 });

    child.on('exit', (code, signal) => {
      // Only act if this is still the CURRENT peer for the key: a stop() followed by a
      // restart must not have the old process's exit reap the new one.
      if (this.peers.get(key) !== peer) return;
      this.peers.delete(key);
      if (peer.stopping) {
        log('info', 'simpeer.stopped', { key });
        return;
      }
      // Unexpected exit: back off before the next ensure() may respawn, so a peer that
      // crashes on startup (bad data path, missing esm) cannot spin the CPU.
      metrics.simPeerCrashed.inc({});
      this.blockedUntil.set(key, this.now() + this.deps.settings.restartBackoffMs);
      log('error', 'simpeer.crashed', { key, code: code ?? -1, signal: signal ?? '' });
    });
    child.on('error', (err) => log('error', 'simpeer.child_error', { key, error: String(err) }));
  }

  // Reaps peers whose idle deadline has passed. Called on a timer by start(), and directly
  // by tests so reaping is assertable without waiting real seconds.
  sweep(): void {
    const cutoff = this.now() - this.deps.settings.idleReapMs;
    for (const peer of [...this.peers.values()]) {
      if (peer.idleSince !== undefined && peer.idleSince <= cutoff) {
        metrics.simPeerReaped.inc({});
        log('info', 'simpeer.reaped', { key: peer.key, idleMs: this.now() - peer.idleSince });
        this.stop(peer.key);
      }
    }
  }

  startSweeper(intervalMs = 15_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stop(key: string): void {
    const peer = this.peers.get(key);
    if (!peer) return;
    peer.stopping = true;
    // SIGTERM: the peer is a client, so a clean disconnect lets the server release its
    // authority through the ordinary leave path rather than waiting for liveness to notice.
    peer.child.kill('SIGTERM');
  }

  // Shutdown: stop everything and stop sweeping. Safe to call twice.
  stopAll(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const key of [...this.peers.keys()]) this.stop(key);
  }
}

function defaultSpawner(binary: string): Spawner {
  return (_key, env, args) => spawn(binary, args, { env, stdio: 'ignore', detached: false });
}
