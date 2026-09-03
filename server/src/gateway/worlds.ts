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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log';
import { metrics } from '../metrics';

// Written into a private/party world's data dir at creation so a later REVIVAL can authorise.
// A dotfile so it cannot collide with anything the world itself writes.
const OWNER_FILE = '.owner';
// The pid of the process last started for this world, so a NEW gateway can reap the children
// of a dead one. See reapOrphanWorlds.
const PID_FILE = '.pid';
// Ceiling on the crash-bookkeeping maps. Far above any plausible number of worlds in flight,
// so it only ever trims history nobody is going to consult.
const MAX_TRACKED_WORLDS = 4096;

export type WorldMode = 'private' | 'party';

export interface WorldSettings {
  worldsDir: string; // per-world data dirs live under here
  gatewayPort: number; // where spawned worlds reach the directory (--gateway)
  serverEntry: string; // path to the world server entry (dist/server.mjs)
  nodeBin: string;
  basePort: number;
  maxWorlds: number; // hard cap across ALL modes
  // THE MEMORY GOVERNOR. maxWorlds alone is a COUNT, and a count cannot see the thing that
  // actually runs out: every occupied world is a node process AND its own sim peer (each world
  // process runs its own SimPeerSupervisor), so worlds multiply the peer's cost rather than
  // sharing it. A cap derived from maxPlayers therefore let the supervisor spawn worlds until
  // the OOM killer took the container, while [simPeer].maxPeers — which is per-world — read as
  // satisfied the whole time. Budget in megabytes, spent against what the worlds have actually
  // committed — NOT converted to a fixed world count, which is what it used to do and what the
  // move to one peer per occupied cell invalidated. See capacity().
  //
  // OPTIONAL because a test (and an embedder driving fake spawners) wants a pure count cap and
  // has no memory to govern. main.ts — the real deployment path — always supplies these, and
  // logs at boot when it cannot, so "no budget" is a stated condition rather than a silent one.
  memBudgetMb?: number; // total RAM this gateway may spend on worlds + their peers (0/absent = no budget)
  worldCostMb?: number; // MEASURED cost of one occupied world: node process + its FIRST sim peer (~640)
  // MEASURED cost of each ADDITIONAL sim peer in a world beyond the first (~487).
  //
  // This exists because the premise under worldCostMb stopped being true. It was measured when
  // a world ran exactly one peer, so "one world = one peer = 640 MB" was a fair unit and the
  // governor could budget in whole worlds. A world now runs ONE PEER PER OCCUPIED CELL, so a
  // world with four occupied cells costs about 2100 MB, and a governor still counting it as 640
  // permits roughly three times the RAM the box has -- which is precisely the OOM this governor
  // was written to prevent, reintroduced underneath it by a change one layer down.
  //
  // Absent/0 keeps the old whole-world arithmetic, so an embedder that never multiplies peers
  // is unaffected and no existing deployment silently changes behaviour.
  peerCostMb?: number;
  gatewayReserveMb?: number; // held back for the gateway process itself
  idleReapMs: number; // a world with no players this long is stopped
  startTimeoutMs: number;
  restartBackoffMs: number;
  // One identity across every world: accounts, SSO identities, friends/party/presence and
  // bans live here, NOT in each world's data dir. Without it a player could not log into
  // their own private session with the account they made on this stack, friends would
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
  // Played, and now empty — an abandoned session waiting to be reaped. Distinct from a world
  // that was just created and has not been joined YET, which is still someone's live intent.
  abandoned: boolean;
}

interface World {
  id: string;
  mode: WorldMode;
  port: number;
  child: ChildProcess;
  startedAt: number;
  idleSince?: number;
  stopping: boolean;
  // True once at least one player has ever connected. A world that has NEVER been reached gets a
  // longer startup grace (a first-play client can spend minutes downloading its data before it
  // connects); after someone has joined, the shorter idle-reap applies once they leave.
  everConnected?: boolean;
  ownerAccount?: string;
  lastStatus?: { playerCount: number; connectedCount: number; peerCount: number; maxPlayers: number; name: string };
}

export interface WorldDeps {
  settings: WorldSettings;
  spawner?: (id: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  // peerCount is OPTIONAL here and required on World.lastStatus: a world from an older build --
  // or a test fake that predates peers being per-cell -- simply does not report it, and poll()
  // normalises the absence to 1 rather than making every caller restate the default.
  fetchStatus?: (port: number) => Promise<{ playerCount: number; connectedCount: number; peerCount?: number; maxPlayers: number; name: string } | null>;
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

  /** Sim peers across every supervised world. A world reports its own live count on /status;
   *  one that has not answered yet is counted as the single peer worldCostMb already assumes,
   *  matching how committedMb() prices it. */
  get peersRunning(): number {
    let n = 0;
    for (const w of this.worlds.values()) n += w.lastStatus?.peerCount ?? 1;
    return n;
  }

  /** What committedMb() computes, exposed so it can be graphed against the budget. Public
   *  because "how full is the box" is an operator's question, not an internal detail. */
  get committed(): number {
    return this.committedMb();
  }

  /** RAM the running worlds have actually committed, counting the peers they are really
   *  running rather than the one each was once assumed to have.
   *
   *  A world with no status yet is counted at full price. It is starting, crashed, or wedged,
   *  and in every one of those cases its memory is either already spent or about to be — an
   *  OOM guard that assumes the unknown is free is not a guard. */
  private committedMb(): number {
    const s = this.deps.settings;
    const worldCost = s.worldCostMb ?? 0;
    const peerCost = s.peerCostMb ?? 0;
    let total = 0;
    for (const w of this.worlds.values()) {
      // The first peer is already inside worldCostMb; only the extras are added, so a
      // single-peer world costs exactly what it always did.
      const extraPeers = Math.max(0, (w.lastStatus?.peerCount ?? 1) - 1);
      total += worldCost + peerCost * extraPeers;
    }
    return total;
  }

  /** How many worlds this gateway may run at once, and why. The memory budget and the hard
   *  count cap are BOTH ceilings; the lower one wins, and `reason` names it so an operator
   *  reading `world.at_cap` knows which number to change. A zero/absent budget means the
   *  operator has opted out and only the count cap applies.
   *
   *  The memory ceiling is computed from what is COMMITTED right now, not from a fixed
   *  per-world price. That distinction is the whole fix: worlds no longer cost a constant, so
   *  a ceiling derived once from `usable / worldCostMb` describes a deployment that stopped
   *  existing when peers went per-cell. The number this returns therefore MOVES as players
   *  spread across cells — and it must, because that is when the box actually fills up. */
  capacity(): { cap: number; reason: 'count' | 'memory'; fromMemory: number } {
    const s = this.deps.settings;
    const budget = s.memBudgetMb ?? 0;
    const cost = s.worldCostMb ?? 0;
    const usable = budget - (s.gatewayReserveMb ?? 0);
    let fromMemory = Number.POSITIVE_INFINITY;
    if (budget > 0 && cost > 0) {
      const running = this.worlds.size;
      // How many MORE worlds fit beside what is already committed. Floor, and never negative:
      // once the running worlds have overspent the budget the answer is "no more", which
      // pins the cap at the current count instead of going backwards and reading as a cap
      // that has already been breached.
      const free = Math.max(0, Math.floor((usable - this.committedMb()) / cost));
      // A budget too small for even one world is still one world: refusing to start anything
      // would make a misconfigured budget indistinguishable from a broken gateway, and the
      // operator sees the honest ceiling in gateway.capacity either way.
      fromMemory = Math.max(1, running + free);
    }
    return fromMemory < s.maxWorlds
      ? { cap: fromMemory, reason: 'memory', fromMemory }
      : { cap: s.maxWorlds, reason: 'count', fromMemory };
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
      abandoned: w.everConnected === true && w.idleSince !== undefined,
      ...(w.ownerAccount ? { ownerAccount: w.ownerAccount } : {}),
    }));
  }

  get(id: string): WorldInfo | undefined {
    return this.list().find((w) => w.id === id);
  }

  // Idempotent. Returns the world (existing or new), or null if it could not be started —
  // callers must handle null rather than assume a world exists.
  ensure(id: string, mode: WorldMode, ownerAccount?: string): WorldInfo | null {
    const existing = this.worlds.get(id);
    if (existing) {
      existing.idleSince = undefined;
      return this.get(id)!;
    }
    const { cap, reason } = this.capacity();
    if (this.worlds.size >= cap) {
      // `reason` is the whole point of the line: "at cap" with no attribution is what sent an
      // operator to raise maxWorlds when the binding constraint was RAM, which is how a box
      // gets OOM-killed by a setting that was changed to prevent exactly that.
      log('warn', 'world.at_cap', { id, running: this.worlds.size, cap, reason });
      metrics.worldRefused.inc({ reason });
      return null;
    }
    const blocked = this.blockedUntil.get(id);
    if (blocked !== undefined && this.now() < blocked) {
      log('warn', 'world.backoff', { id });
      return null;
    }
    return this.start(id, mode, ownerAccount);
  }

  /** The owner recorded on disk when the world was created, or undefined when the marker is
   *  missing — callers MUST treat that as "cannot authorise", never as "no owner needed". */
  ownerOnDisk(id: string): string | undefined {
    try {
      const v = readFileSync(join(this.deps.settings.worldsDir, id, OWNER_FILE), 'utf8').trim();
      return v.length > 0 ? v : undefined;
    } catch {
      return undefined;
    }
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
    // THE OWNER OUTLIVES THE PROCESS. A private world is idle-reaped after two minutes and
    // revived when its owner dials back in, so "reaped, on disk, revivable" is the normal
    // resting state of a solo world — and a revival that could not name the owner started it
    // with OMW_WORLD_OWNER='', which mayJoinWorld now fails CLOSED for a gateway world. Writing the
    // owner beside the world's data is what lets a revival be as authorised as a creation.
    if (ownerAccount) {
      try {
        writeFileSync(join(dataDir, OWNER_FILE), ownerAccount, 'utf8');
      } catch (err) {
        // Fail the start rather than run an unowned private world: an unwritable marker means
        // the next revival cannot authorise, and that is the hole this closes.
        log('error', 'world.owner_write_failed', { id, error: String(err) });
        return null;
      }
    }
    // Tell the world where its gateway is. Without this the world browser is off and no
    // client can ever discover — or switch to — another world.
    const args = [s.serverEntry, '--data', dataDir, '--shared', s.sharedDir, '--port', String(port),
      '--gateway', `http://127.0.0.1:${this.deps.settings.gatewayPort}`];
    let child: ChildProcess;
    try {
      // 'inherit': a world's logs flow through the gateway's stdout so `docker logs` shows every
      // world (auth, joins, errors) in one place. Without it a world failure is invisible.
      const spawner = this.deps.spawner
        ?? ((_id, a, env) => spawn(s.nodeBin, a, { env, stdio: 'inherit' }));
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
    // Record the pid so a NEW gateway can find the children of a dead one. Worlds are spawned
    // non-detached but without PDEATHSIG, so a gateway that dies takes nothing with it: the
    // orphans keep their ports, and the new gateway's allocPort — which only knows its own
    // freshly-empty usedPorts — hands out the same port, the world dies EADDRINUSE, backs off,
    // and retries forever. A healthy-looking gateway with zero joinable worlds.
    try {
      if (child.pid !== undefined) writeFileSync(join(dataDir, PID_FILE), String(child.pid), 'utf8');
    } catch (err) {
      log('warn', 'world.pid_write_failed', { id, error: String(err) });
    }
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
      // Bounded. World ids are per CHARACTER, so this key space grows with every character
      // anyone ever made, and entries were only removed on a rolling restart or a clean run.
      // Numbers, so it is a slow leak rather than a cliff — but a supervisor that runs for
      // months should not accumulate one entry per character ever created.
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
        // Normalised HERE so the rest of the supervisor reads a definite number. Absent means a
        // world that predates the field, which runs at least the one peer worldCostMb already
        // includes -- reading it as 0 would price such a world as free to the memory governor.
        w.lastStatus = { ...st, peerCount: st.peerCount ?? 1 };
        // Idle = nobody CONNECTED (loading / at chargen counts), not merely nobody in a cell.
        if (st.connectedCount > 0) { w.idleSince = undefined; w.everConnected = true; }
        else if (w.idleSince === undefined) w.idleSince = this.now();
      } else {
        w.lastStatus = undefined; // down: reported as up:false, not omitted
      }
    }));
    this.sweep();
  }

  // A fresh world nobody has reached yet gets this long before the reaper touches it. A first-play
  // client downloads its game data (hundreds of MB, minutes on a slow link) BEFORE it connects, so
  // the reaper must not kill the world out from under a browser that is still loading toward it.
  private static readonly STARTUP_GRACE_MS = 15 * 60_000;
  /** How long a world gets to drain after SIGTERM before it is killed outright. */
  private static readonly STOP_GRACE_MS = 20_000;

  sweep(): void {
    const now = this.now();
    const idleCutoff = now - this.deps.settings.idleReapMs;
    for (const w of [...this.worlds.values()]) {
      if (!w.everConnected) {
        // Never joined: keep it until the startup grace elapses, then reap a truly-stale spawn.
        if (now - w.startedAt > WorldSupervisor.STARTUP_GRACE_MS) {
          log('info', 'world.reaped', { id: w.id, reason: 'never_joined', ageMs: now - w.startedAt });
          this.stop(w.id);
        }
        continue;
      }
      if (w.idleSince !== undefined && w.idleSince <= idleCutoff) {
        log('info', 'world.reaped', { id: w.id, idleMs: now - w.idleSince });
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
    // ESCALATE. A world that hangs in its own async shutdown never fires 'exit', and 'exit' is
    // the ONLY thing that removes it from this.worlds or frees its port — so one stuck world
    // holds a slot and a port for the life of the gateway, and a handful of them make the box
    // answer "no capacity" with nothing actually running. The grace is longer than the drain
    // main.ts asks for, so a healthy world is never killed mid-flush.
    const kill = setTimeout(() => {
      if (this.worlds.get(id) !== w) return; // it exited; nothing to escalate to
      log('warn', 'world.sigkill_escalated', { id, pid: w.child.pid ?? -1 });
      w.child.kill('SIGKILL');
    }, WorldSupervisor.STOP_GRACE_MS);
    kill.unref();
  }

  // A deleted character's solo world is dead weight: nobody can ever reach it again, because
  // the id is derived from the character. Stop it and remove its data.
  //
  // The id is composed on the CLIENT (launcher.html) as priv-<username-slug>-<charId8>, so it
  // is rebuilt here rather than matched on the suffix alone. A suffix is not enough to delete
  // by: two accounts whose character ids share their last 8 characters would let one delete
  // the other's world. Exact id, or nothing happens.
  // ponytail: the real cure is the SERVER owning the world-id scheme; this mirrors it until
  // then, and the mirror is one line to update if the scheme moves.
  discardForCharacter(owner: { accountKey: string; username?: string }, charId: string): string[] {
    if (!owner.username) return []; // no username, no derivable id — leave it to the reaper
    const slug = owner.username.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 40);
    if (slug === '') return [];
    const id = `priv-${slug}-${charId.slice(-8)}`;
    const gone: string[] = [];
    if (this.worlds.has(id)) { this.stop(id); gone.push(id); }
    // Remove the data dir whether or not a process was running: a world nobody rejoined after
    // a restart has a directory but no entry here, so stopping alone would leave it forever.
    const dir = join(this.deps.settings.worldsDir, id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      if (!gone.includes(id)) gone.push(id);
    }
    if (gone.length > 0) log('info', 'world.discarded', { charId, world: id });
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

async function defaultFetchStatus(port: number): Promise<{ playerCount: number; connectedCount: number; peerCount: number; maxPlayers: number; name: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const j = await r.json() as { playerCount?: number; connectedCount?: number; peerCount?: number; maxPlayers?: number; name?: string };
    return {
      playerCount: typeof j.playerCount === 'number' ? j.playerCount : 0,
      connectedCount: typeof j.connectedCount === 'number' ? j.connectedCount : (typeof j.playerCount === 'number' ? j.playerCount : 0),
      // DEFAULTS TO 1, NOT 0. A world that predates this field, or one answering from an older
      // build during a rolling restart, is running at least the peer it was always assumed to
      // run -- and worldCostMb already includes exactly one. Defaulting to 0 would make such a
      // world look FREE to the governor, which is the failure this field exists to stop.
      peerCount: typeof j.peerCount === 'number' ? j.peerCount : 1,
      maxPlayers: typeof j.maxPlayers === 'number' ? j.maxPlayers : 0,
      name: typeof j.name === 'string' ? j.name : `world:${port}`,
    };
  } catch {
    return null; // not up yet, or wedged — either way it is not joinable
  }
}

// ORPHANS FROM A PREVIOUS GATEWAY. Worlds are spawned non-detached but without PDEATHSIG, so a
// gateway that dies (or is SIGKILLed) leaves every world process running and holding its port.
// The replacement gateway starts with an empty usedPorts, hands out a port an orphan still
// owns, and that world dies EADDRINUSE -> backoff -> retry, forever: the gateway looks healthy
// and nothing is joinable. Run this before serving any world.
//
// Kill by the recorded pid, and ONLY if that pid is still a live process. A pid file outlives
// its process and pids are reused, so this is a best-effort reap: SIGTERM is a request, and a
// pid that now belongs to something else is not ours to kill — which is why nothing escalates
// to SIGKILL here.
export function reapOrphanWorlds(worldsDir: string): number {
  let reaped = 0;
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
      log('warn', 'world.orphan_reaped', { id, pid });
    } catch (err) {
      log('warn', 'world.orphan_reap_failed', { id, pid, error: String(err) });
    }
    rmSync(pidPath, { force: true });
  }
  return reaped;
}
