// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3 — the world supervisor: the world PROCESS, with the directory in front of it.
//
// v2 runs ONE public world (vvardenfell, OT3-28). main.ts ensures it at boot and nothing
// reaps it for being empty; the private/party worlds, their owners, the idle reaper and the
// memory governor are gone. What stays is the process lifecycle: start, crash backoff, stop,
// the rolling restart, and reaping a dead gateway's orphans.
//
// WHY A PROCESS AND NOT IN-PROCESS. `core/authority.ts` keeps its tuning in a module-level
// singleton that `configureAuthority()` MUTATES, and `metrics` is a module singleton too, so
// the world lives in its own process with its own SimPeerSupervisor (ONE peer for the whole
// world), and stopping the world stops the peer.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log';
import { metrics } from '../metrics';

/** The one public world (OT3-28). */
export const WORLD_ID = 'vvardenfell';

// The pid of the process last started for this world, so a NEW gateway can reap the children
// of a dead one. See reapOrphanWorlds.
const PID_FILE = '.pid';
// Ceiling on the crash-bookkeeping maps. Far above any plausible number of worlds in flight,
// so it only ever trims history nobody is going to consult.
const MAX_TRACKED_WORLDS = 4096;

export interface WorldSettings {
  worldsDir: string; // per-world data dirs live under here
  gatewayPort: number; // where spawned worlds reach the directory (--gateway)
  serverEntry: string; // path to the world server entry (dist/server.mjs)
  nodeBin: string;
  basePort: number;
  maxWorlds: number; // hard cap on world processes
  startTimeoutMs: number;
  restartBackoffMs: number;
  // One identity across every world: accounts, SSO identities, friends/party/presence and
  // bans live here, NOT in each world's data dir. Without it a player could not log into
  // their own private session with the account they made on this stack, friends would
  // not span worlds, and a ban would apply only where it was issued.
  sharedDir: string;
}

/** One row of a game's roster, as its /status reports it. */
interface WorldPlayer { id: number; name: string; cellKey: string | null; level?: number; charId?: string }

export interface WorldInfo {
  id: string;
  port: number;
  playerCount: number;
  maxPlayers: number;
  name: string;
  up: boolean;
  // Played, and now empty — an abandoned session waiting to be reaped. Distinct from a world
  // that was just created and has not been joined YET, which is still someone's live intent.
  abandoned: boolean;
  // WHO IS PLAYING, not just how many. A game's /status has always carried its roster (the
  // same list the launcher shows); the poller kept only the counts, so the one question the
  // multiplayer server's dashboard exists to answer — who is in whose game — had its answer
  // thrown away five seconds before it was asked. INTERNAL: directory.ts projects it out of
  // the public listing, which anyone who knows a game's id can read.
  players: WorldPlayer[];
  // The rest is what the supervisor already knows about a process, surfaced for the
  // dashboard's health strip. All in memory; none of it costs a syscall.
  pid?: number;
  startedAt: number;
  idleSince?: number;
  connectedCount: number;
  peerCount: number;
  everConnected: boolean;
  blockedUntil?: number;
  fastCrashes: number;
}

interface World {
  id: string;
  port: number;
  child: ChildProcess;
  startedAt: number;
  idleSince?: number;
  /** When this world last stopped answering /status, or undefined while it answers. NOT the
   *  same as idle: an idle world is healthy and empty, this one is not answering at all. */
  downSince?: number;
  stopping: boolean;
  // True once at least one player has ever connected. A world that has NEVER been reached gets a
  // longer startup grace (a first-play client can spend minutes downloading its data before it
  // connects); after someone has joined, the shorter idle-reap applies once they leave.
  everConnected?: boolean;
  lastStatus?: { playerCount: number; connectedCount: number; peerCount: number; maxPlayers: number; name: string; players?: WorldPlayer[] };
}

export interface WorldDeps {
  settings: WorldSettings;
  spawner?: (id: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  // peerCount is OPTIONAL here and required on World.lastStatus: a world from an older build --
  // or a test fake that predates peers being per-cell -- simply does not report it, and poll()
  // normalises the absence to 1 rather than making every caller restate the default.
  fetchStatus?: (port: number) => Promise<{ playerCount: number; connectedCount: number; peerCount?: number; maxPlayers: number; name: string; players?: WorldPlayer[] } | null>;
  now?: () => number;
}

export class WorldSupervisor {
  private worlds = new Map<string, World>();
  private blockedUntil = new Map<string, number>();
  private usedPorts = new Set<number>();
  /** Consecutive immediate deaths per world; see the exit handler. */
  private fastCrashes = new Map<string, number>();
  private pollTimer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly deps: WorldDeps) {
    this.now = deps.now ?? Date.now;
  }

  get running(): number {
    return this.worlds.size;
  }

  /** Sim peers across every supervised world, as each reports on /status. */
  get peersRunning(): number {
    let n = 0;
    for (const w of this.worlds.values()) n += w.lastStatus?.peerCount ?? 1;
    return n;
  }

  /** The count cap, in the shape /healthz and the (frozen) dashboard read. The memory
   *  governor that used to bind here priced many private worlds; one world needs none. */
  capacity(): { cap: number; reason: 'count' } {
    return { cap: this.deps.settings.maxWorlds, reason: 'count' };
  }

  list(): WorldInfo[] {
    return [...this.worlds.values()].map((w) => {
      const blocked = this.blockedUntil.get(w.id);
      return {
        id: w.id,
        port: w.port,
        playerCount: w.lastStatus?.playerCount ?? 0,
        maxPlayers: w.lastStatus?.maxPlayers ?? 0,
        name: w.lastStatus?.name ?? w.id,
        up: w.lastStatus !== undefined,
        abandoned: w.everConnected === true && w.idleSince !== undefined,
        players: w.lastStatus?.players ?? [],
        ...(w.child.pid !== undefined ? { pid: w.child.pid } : {}),
        startedAt: w.startedAt,
        ...(w.idleSince !== undefined ? { idleSince: w.idleSince } : {}),
        connectedCount: w.lastStatus?.connectedCount ?? 0,
        peerCount: w.lastStatus?.peerCount ?? 0,
        everConnected: w.everConnected === true,
        ...(blocked !== undefined && this.now() < blocked ? { blockedUntil: blocked } : {}),
        fastCrashes: this.fastCrashes.get(w.id) ?? 0,
      };
    });
  }

  get(id: string): WorldInfo | undefined {
    return this.list().find((w) => w.id === id);
  }

  /** True while the world is draining after SIGTERM: ensure() refuses it, but that refusal is
   *  "come back in seconds", not "the box is full" -- the directory tells them apart (278). */
  isStopping(id: string): boolean {
    return this.worlds.get(id)?.stopping === true;
  }

  // Idempotent. Returns the world (existing or new), or null if it could not be started —
  // callers must handle null rather than assume a world exists.
  ensure(id: string): WorldInfo | null {
    const existing = this.worlds.get(id);
    if (existing) {
      // A world that has been SIGTERMed is not a world you can join: it stays in the map
      // until `exit` (up to the full stop grace), `lastStatus` is up to a poll stale, so the
      // directory would splice a player's socket into a process that is draining and dies
      // underneath them. Refuse now -- the entry disappears on exit and the caller's retry
      // gets a fresh one. (Cancelling the reap instead would race the delivered signal.)
      if (existing.stopping) return null;
      existing.idleSince = undefined;
      return this.get(id)!;
    }
    const { cap, reason } = this.capacity();
    if (this.worlds.size >= cap) {
      log('warn', 'world.at_cap', { id, running: this.worlds.size, cap, reason });
      metrics.worldRefused.inc({ reason });
      return null;
    }
    const blocked = this.blockedUntil.get(id);
    if (blocked !== undefined && this.now() < blocked) {
      log('warn', 'world.backoff', { id });
      return null;
    }
    return this.start(id);
  }

  /** Drop least-recently-inserted keys until the map is within `cap`. */
  private forgetOldest(m: Map<string, number>, cap: number): void {
    while (m.size > cap) {
      const oldest = m.keys().next();
      if (oldest.done) return;
      m.delete(oldest.value);
    }
  }

  private allocPort(): number | null {
    const { basePort, maxWorlds } = this.deps.settings;
    for (let p = basePort; p < basePort + maxWorlds * 4; p++) {
      if (!this.usedPorts.has(p)) return p;
    }
    return null;
  }

  private start(id: string): WorldInfo | null {
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
    // Tell the world where its gateway is. Without this the world browser is off and no
    // client can ever discover — or switch to — another world.
    const args = [s.serverEntry, '--data', dataDir, '--shared', s.sharedDir, '--port', String(port),
      '--gateway', `http://127.0.0.1:${this.deps.settings.gatewayPort}`];
    let child: ChildProcess;
    try {
      // 'inherit': a world's logs flow through the gateway's stdout so `docker logs` shows every
      // world (auth, joins, errors) in one place. Without it a world failure is invisible.
      // detached: the world leads its own process group, and its sim peers (spawned
      // non-detached by simpeer.ts) join it. That is what lets a SIGKILL escalation below
      // take the peers with the world: a peer that outlived a SIGKILLed world redialled
      // forever (~360 MB each) and counted against the peer cap until the box was restarted.
      const spawner = this.deps.spawner
        ?? ((_id, a, env) => spawn(s.nodeBin, a, { env, stdio: 'inherit', detached: process.platform !== 'win32' }));
      child = spawner(id, args, { ...process.env, OMW_WORLD_ID: id });
    } catch (err) {
      log('error', 'world.spawn_failed', { id, error: String(err) });
      return null;
    }
    this.usedPorts.add(port);
    // Record the pid so a NEW gateway can find the children of a dead one. Worlds are spawned
    // in their own process group and without PDEATHSIG, so a gateway that dies takes nothing with it: the
    // orphans keep their ports, and the new gateway's allocPort — which only knows its own
    // freshly-empty usedPorts — hands out the same port, the world dies EADDRINUSE, backs off,
    // and retries forever. A healthy-looking gateway with zero joinable worlds.
    try {
      if (child.pid !== undefined) writeFileSync(join(dataDir, PID_FILE), String(child.pid), 'utf8');
    } catch (err) {
      log('warn', 'world.pid_write_failed', { id, error: String(err) });
    }
    const world: World = { id, port, child, startedAt: this.now(), stopping: false };
    this.worlds.set(id, world);
    log('info', 'world.started', { id, port, pid: child.pid ?? -1 });

    child.on('exit', (code, signal) => {
      if (this.worlds.get(id) !== world) return; // a stale exit must not evict its successor
      this.worlds.delete(id);
      this.usedPorts.delete(port);
      if (world.stopping) {
        log('info', 'world.stopped', { id });
        return;
      }
      // A CLEAN EXIT IS NOT A CRASH. A world that ran past the startup window and exited 0 shut
      // down on purpose (SIGTERM from an operator or a deploy: it disconnected everyone with
      // the transient SHUTDOWN code and flushed). Backing that off refused every player's
      // reconnect for restartBackoffMs, which is exactly the window their clients spend
      // retrying, and logged a crash nobody had. The next dial revives it at once. A clean exit
      // on startup, or any non-zero one, still backs off: that is the spin this guards.
      if (code === 0 && this.now() - world.startedAt >= 5_000) {
        log('info', 'world.exited', { id, lifeMs: this.now() - world.startedAt });
        return;
      }
      this.blockedUntil.set(id, this.now() + s.restartBackoffMs);
      // Bounded: a dialled id that is not a world can still land here.
      this.forgetOldest(this.blockedUntil, MAX_TRACKED_WORLDS);
      this.forgetOldest(this.fastCrashes, MAX_TRACKED_WORLDS);
      // A world that dies INSTANTLY, every time, is misconfigured — not unlucky. The harness
      // hit exactly this: the entry point rejected a flag the gateway passes, so every world
      // exited on startup, backed off and started again, forever. The world list stayed empty,
      // the gateway stayed "healthy", and nothing said why — which is what made it expensive.
      // The backoff already stops it spinning; this makes it SPEAK. Any world that survives
      // the startup window clears the counter.
      const lifeMs = this.now() - world.startedAt;
      const fast = lifeMs < 5_000;
      const n = fast ? (this.fastCrashes.get(id) ?? 0) + 1 : 0;
      if (fast) this.fastCrashes.set(id, n); else this.fastCrashes.delete(id);
      log('error', 'world.crashed', { id, code: code ?? -1, signal: signal ?? '', lifeMs });
      if (n === 3) {
        log('error', 'world.dies_on_startup', {
          id, crashes: n,
          hint: 'this world exits immediately on every attempt — check the --server-entry'
            + ' binary and the flags the gateway passes it: --data, --shared, --port, --gateway',
        });
      }
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
        w.lastStatus = { ...st, peerCount: st.peerCount ?? 1 };
        // Idle = nobody CONNECTED (loading / at chargen counts), not merely nobody in a cell.
        if (st.connectedCount > 0) { w.idleSince = undefined; w.everConnected = true; }
        else if (w.idleSince === undefined) w.idleSince = this.now();
        w.downSince = undefined; // answering again
      } else {
        w.lastStatus = undefined; // down: reported as up:false, not omitted
        // A WEDGED WORLD. Timed generously -- minutes of total silence, not one missed probe --
        // and then stopped by sweep(), so the next dial or the boot ensure starts it fresh.
        if (w.downSince === undefined) w.downSince = this.now();
      }
    }));
    this.sweep();
  }

  /** How long a world gets to drain after SIGTERM before it is killed outright. */
  private static readonly STOP_GRACE_MS = 20_000;
  /** Unanswered for this long and the world is gone, not merely down. Long enough that no
   *  ordinary stall — a GC pause, a slow cell load, a busy box — comes close; anything still
   *  silent after it is not serving the players holding sockets to it either. */
  private static readonly DOWN_REAP_MS = 5 * 60_000;

  sweep(): void {
    const now = this.now();
    for (const w of [...this.worlds.values()]) {
      // Alive as a process, but answering nothing.
      if (w.downSince !== undefined && now - w.downSince >= WorldSupervisor.DOWN_REAP_MS) {
        log('warn', 'world.reaped_unreachable', { id: w.id, downMs: now - w.downSince });
        this.stop(w.id);
      }
    }
  }

  startPolling(intervalMs = 5_000): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
    this.pollTimer.unref();
  }

  // How long an OPERATOR's stop holds against revival. The players' clients are still connected
  // when the operator stops the world; its reconnect backoff redials within a second and
  // the front door revives the world on dial -- measured: stopped at :17.9, started again at
  // :18.3. A stop that lasts 400 ms is not a stop. Long enough for the operator to act (a
  // ban, a config change), short enough that a game stopped by mistake comes back on its own.
  static readonly OPERATOR_STOP_HOLD_MS = 5 * 60_000;

  // `hold`: an OPERATOR's stop is held against revival; the reaper's, the rolling restart's
  // and shutdown's are not -- a reaped world MUST come back on the next dial.
  stop(id: string, hold = false): void {
    const w = this.worlds.get(id);
    if (!w) return;
    w.stopping = true;
    if (hold) this.blockedUntil.set(id, this.now() + WorldSupervisor.OPERATOR_STOP_HOLD_MS);
    // SIGTERM so the world drains and flushes its stores; main.ts already handles it.
    w.child.kill('SIGTERM');
    // ESCALATE. A world that hangs in its own async shutdown never fires 'exit', and 'exit' is
    // the ONLY thing that removes it from this.worlds or frees its port — so one stuck world
    // holds a slot and a port for the life of the gateway, and a handful of them make the box
    // answer "no capacity" with nothing actually running. The grace is longer than the drain
    // main.ts asks for, so a healthy world is never killed mid-flush.
    const kill = setTimeout(() => {
      if (this.worlds.get(id) !== w) return; // it exited; nothing to escalate to
      log('warn', 'world.sigkill_escalated', { id, pid: w.child.pid ?? -1 });
      killGroup(w.child, this.deps.spawner === undefined);
    }, WorldSupervisor.STOP_GRACE_MS);
    kill.unref();
  }

  /** Relay a signal to every running world: SIGUSR1 = "flush now" (README backup cron). */
  signalAll(signal: NodeJS.Signals): void {
    for (const w of this.worlds.values()) {
      try { w.child.kill(signal); } catch { /* exited between the map read and the kill */ }
    }
  }

  /** Resolves once every world has exited, or after STOP_GRACE_MS plus the SIGKILL margin —
   *  stop() escalates on its own timer, so this is bounded either way. */
  allExited(): Promise<void> {
    const alive = [...this.worlds.values()].filter((w) => w.child.exitCode === null && w.child.signalCode === null);
    if (alive.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let left = alive.length;
      const done = (): void => { if (--left === 0) { clearTimeout(t); resolve(); } };
      const t = setTimeout(resolve, WorldSupervisor.STOP_GRACE_MS + 5_000);
      t.unref();
      for (const w of alive) w.child.once('exit', done);
    });
  }

  /** Stop a game and remove its data, BY ID: the dashboard's "discard this game", where an
   *  operator names the game rather than the character it was made for. True when anything
   *  was there to remove. `why` is folded into the audit line. */
  async discard(id: string, why: Record<string, unknown> = {}): Promise<boolean> {
    let gone = false;
    const running = this.worlds.get(id);
    if (running) {
      this.stop(id);
      gone = true;
      // Bounded: stop() already escalates to SIGKILL on its own timer, so this resolves.
      await new Promise<void>((resolve) => {
        if (running.child.exitCode !== null || running.child.signalCode !== null) return resolve();
        const done = (): void => { clearTimeout(t); resolve(); };
        const t = setTimeout(done, WorldSupervisor.STOP_GRACE_MS + 5_000);
        t.unref?.();
        running.child.once('exit', done);
      });
    }
    // Remove the data dir whether or not a process was running: a world nobody rejoined after
    // a restart has a directory but no entry here, so stopping alone would leave it forever.
    const dir = join(this.deps.settings.worldsDir, id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      gone = true;
    }
    if (gone) log('info', 'world.discarded', { ...why, world: id });
    return gone;
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
      .map((w) => ({ id: w.id }));
    const restarted: string[] = [];
    const failed: string[] = [];

    for (const w of order) {
      log('info', 'world.rolling_restart', { id: w.id });
      const old = this.worlds.get(w.id);
      this.stop(w.id);
      // Wait for the old process to actually exit before starting its replacement, or the
      // two briefly share a data dir. Bounded by ATTEMPTS rather than by comparing the
      // injected clock against real sleeps — mixing the two hangs forever whenever now()
      // is frozen, which is exactly what a test does.
      //
      // THE OLD PROCESS, not the id. Its players redial the moment it says SHUTDOWN, and a dial
      // that lands between the exit and the next 100 ms check starts a fresh process under the
      // same id -- which read as "still there" until the timeout: 300 s, then "stuck", then the
      // rollout halted (s175, first attempt on a cold box, 2026-10-16/17). A successor started
      // by a dial IS the restart; ensure() below returns it and the readiness wait applies.
      const goneTries = Math.max(1, Math.ceil(readyTimeoutMs / 100));
      for (let i = 0; i < goneTries && old !== undefined && this.worlds.get(w.id) === old; i++) await delay(100);
      if (old !== undefined && this.worlds.get(w.id) === old) {
        failed.push(w.id);
        log('error', 'world.rolling_restart_stuck', { id: w.id });
        continue; // leave it alone rather than starting a second copy
      }
      // A crash backoff from the stop would block the restart; this is a deliberate
      // operator action, so clear it.
      this.blockedUntil.delete(w.id);
      if (!this.ensure(w.id)) {
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

// SIGKILL the world's whole process group (the world plus the sim peers it spawned). Windows
// has no process groups and the world is spawned attached there, so it falls back to the
// child alone; so does a spawner that did not detach (a test fake) -- checked, not assumed: a
// fake child's pid is a number that may name a REAL process group on the box (in the image's
// test run it named the test runner's own, and node:test reported the file as cancelled).
function killGroup(child: ChildProcess, ownGroup: boolean): void {
  if (ownGroup && process.platform !== 'win32' && child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* not a group leader, or gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

async function defaultFetchStatus(port: number): Promise<{ playerCount: number; connectedCount: number; peerCount: number; maxPlayers: number; name: string; players: WorldPlayer[] } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const j = await r.json() as { playerCount?: number; connectedCount?: number; peerCount?: number; maxPlayers?: number; name?: string; players?: unknown };
    // The roster, kept this time. Shape-checked row by row: a game from an older build sends
    // no list at all, and a row missing a name is not a player.
    const players: WorldPlayer[] = Array.isArray(j.players)
      ? j.players.flatMap((p: unknown) => {
        const row = (p ?? {}) as { id?: unknown; name?: unknown; cellKey?: unknown; level?: unknown; charId?: unknown };
        if (typeof row.name !== 'string') return [];
        return [{
          id: typeof row.id === 'number' ? row.id : 0,
          name: row.name,
          cellKey: typeof row.cellKey === 'string' ? row.cellKey : null,
          ...(typeof row.level === 'number' ? { level: row.level } : {}),
          ...(typeof row.charId === 'string' ? { charId: row.charId } : {}),
        }];
      })
      : [];
    return {
      players,
      playerCount: typeof j.playerCount === 'number' ? j.playerCount : 0,
      connectedCount: typeof j.connectedCount === 'number' ? j.connectedCount : (typeof j.playerCount === 'number' ? j.playerCount : 0),
      // A world that predates this field runs the one peer every world runs.
      peerCount: typeof j.peerCount === 'number' ? j.peerCount : 1,
      maxPlayers: typeof j.maxPlayers === 'number' ? j.maxPlayers : 0,
      name: typeof j.name === 'string' ? j.name : `world:${port}`,
    };
  } catch {
    return null; // not up yet, or wedged — either way it is not joinable
  }
}

// ORPHANS FROM A PREVIOUS GATEWAY. Worlds are spawned in their own process group, without PDEATHSIG, so a
// gateway that dies (or is SIGKILLed) leaves every world process running and holding its port.
// The replacement gateway starts with an empty usedPorts, hands out a port an orphan still
// owns, and that world dies EADDRINUSE -> backoff -> retry, forever: the gateway looks healthy
// and nothing is joinable. Run this before serving any world.
//
// Kill by the recorded pid, and ONLY if that pid is still a live process. A pid file outlives
// its process and pids are reused, so this is a best-effort reap: SIGTERM is a request, and a
// pid that now belongs to something else is not ours to kill — which is why nothing escalates
// to SIGKILL here.
export async function reapOrphanWorlds(worldsDir: string): Promise<number> {
  let reaped = 0;
  const signalled: number[] = [];
  let ids: string[];
  try {
    ids = readdirSync(worldsDir);
  } catch {
    return 0; // no worlds dir yet: first boot
  }
  for (const id of ids) {
    const pidPath = join(worldsDir, id, PID_FILE);
    let pid: number;
    try {
      pid = Number(readFileSync(pidPath, 'utf8').trim());
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try {
      process.kill(pid, 0); // liveness probe; throws ESRCH when the pid is gone
    } catch {
      rmSync(pidPath, { force: true });
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      reaped++;
      signalled.push(pid);
      log('warn', 'world.orphan_reaped', { id, pid });
    } catch (err) {
      log('warn', 'world.orphan_reap_failed', { id, pid, error: String(err) });
    }
    rmSync(pidPath, { force: true });
  }
  // WAIT FOR THEM TO ACTUALLY GO. SIGTERM only starts a drain; the port stays bound until the
  // process exits, and this function exists precisely so allocPort does not hand out a port an
  // orphan still owns. Without the wait the new world binds, dies EADDRINUSE, backs off and
  // retries -- the failure this reap was written to prevent. Bounded: a wedged orphan poisons
  // its port either way, and the log says which pid to look at.
  const deadline = Date.now() + 10_000;
  while (signalled.length > 0 && Date.now() < deadline) {
    const alive = signalled.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (alive.length === 0) break;
    if (Date.now() + 250 >= deadline) {
      log('warn', 'world.orphans_still_alive', { pids: alive,
        note: 'their ports may still be bound; a world spawned on one will fail EADDRINUSE' });
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return reaped;
}
