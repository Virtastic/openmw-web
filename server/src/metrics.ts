// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// In-process metric registry + Prometheus text renderer. No dep, by design (the server
// ships only ws/argon2/smol-toml). Process-global like log.ts: subsystems import the
// counters directly instead of threading a registry through every constructor.
//
// Cardinality is the only real hazard here, so every label value is drawn from a closed
// set defined in this file — never from client input.

import { log } from './log';

export type Labels = Record<string, string>;

interface Series {
  labels: Labels;
  value: number;
}

// Prometheus escaping for label VALUES only; names are code-supplied constants.
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// F4: every series from this process carries world="<id>" when the gateway started it
// (OMW_WORLD_ID). Applied HERE, at the single formatting chokepoint, rather than at each
// call site — a metric that silently lacks the label would be indistinguishable from
// another world's in an aggregated scrape, which is precisely the mistake this prevents.
// Empty for a standalone world, so a single-server scrape is byte-identical to before.
// Read at RENDER time, not module load: scrapes are infrequent so the cost is nil, and it
// removes a class of bug where the value is fixed before the environment is fully set up
// (which also made it untestable without re-importing the module).
function worldId(): string {
  return process.env['OMW_WORLD_ID'] ?? '';
}

function renderLabels(labels: Labels, extra?: [string, string]): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k]!)}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  const w = worldId();
  if (w !== '') parts.push(`world="${escapeLabel(w)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}${labels[k]}`)
    .join('');
}

// A metric with the wrong label set is a coding bug, but this server has been bitten by
// silent failures often enough that it warns loudly and drops rather than throwing on a
// hot path (or, worse, minting a junk series).
function checkLabels(metric: string, labelNames: readonly string[], labels: Labels): boolean {
  const got = Object.keys(labels);
  if (got.length !== labelNames.length || got.some((k) => !labelNames.includes(k))) {
    log('warn', 'metrics.bad_labels', { metric, want: labelNames.join(','), got: got.join(',') });
    return false;
  }
  return true;
}

// Exported (with the concrete classes) so a metric can be built and rendered standalone:
// constructing one does NOT register it, so tests never pollute the process registry.
export abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {}
  abstract render(out: string[]): void;
  abstract reset(): void;

  // Convenience for standalone use; renderMetrics() batches into one array instead.
  toText(): string {
    const out: string[] = [];
    this.render(out);
    return out.join('\n') + '\n';
  }
}

export class Counter extends Metric {
  private series = new Map<string, Series>();

  inc(labels: Labels = {}, by = 1): void {
    if (!checkLabels(this.name, this.labelNames, labels)) return;
    if (!Number.isFinite(by) || by < 0) {
      log('warn', 'metrics.bad_value', { metric: this.name, value: String(by) });
      return;
    }
    const key = seriesKey(labels);
    const s = this.series.get(key);
    if (s) s.value += by;
    else this.series.set(key, { labels: { ...labels }, value: by });
  }

  // Test/introspection accessor; undefined = the series has never been touched.
  get(labels: Labels = {}): number | undefined {
    return this.series.get(seriesKey(labels))?.value;
  }

  render(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`);
    // An unlabelled counter still reports 0 so dashboards have a series from boot; a
    // labelled one cannot (the label space is only known once it is hit).
    if (this.series.size === 0 && this.labelNames.length === 0) out.push(`${this.name}${renderLabels({})} 0`);
    for (const s of this.series.values()) out.push(`${this.name}${renderLabels(s.labels)} ${s.value}`);
  }

  reset(): void {
    this.series.clear();
  }
}

interface HistSeries {
  labels: Labels;
  counts: number[]; // per-bucket (non-cumulative); rendered cumulatively
  sum: number;
  count: number;
}

export class Histogram extends Metric {
  private series = new Map<string, HistSeries>();

  constructor(name: string, help: string, labelNames: readonly string[], readonly buckets: readonly number[]) {
    super(name, help, labelNames);
  }

  observe(labels: Labels, value: number): void {
    if (!checkLabels(this.name, this.labelNames, labels)) return;
    if (!Number.isFinite(value) || value < 0) {
      log('warn', 'metrics.bad_value', { metric: this.name, value: String(value) });
      return;
    }
    const key = seriesKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels: { ...labels }, counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        s.counts[i]! += 1;
        break; // cumulative rendering folds the rest in
      }
    }
  }

  render(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`);
    for (const s of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += s.counts[i]!;
        out.push(`${this.name}_bucket${renderLabels(s.labels, ['le', String(this.buckets[i])])} ${cumulative}`);
      }
      out.push(`${this.name}_bucket${renderLabels(s.labels, ['le', '+Inf'])} ${s.count}`);
      out.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      out.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
  }

  reset(): void {
    this.series.clear();
  }
}

// Gauges are pulled at scrape time from live state (the roster), never counted up and
// down — an off-by-one in a teardown path must not be able to strand the value.
export class Gauge extends Metric {
  private collectors = new Set<() => number>();

  constructor(name: string, help: string) {
    super(name, help, []);
  }

  // Returns an unregister handle: a test (or an embedder) may run several servers in one
  // process, and each must stop contributing when it closes. Values sum across them.
  addCollector(fn: () => number): () => void {
    this.collectors.add(fn);
    return () => this.collectors.delete(fn);
  }

  render(out: string[]): void {
    let total = 0;
    for (const fn of this.collectors) {
      const v = fn();
      if (!Number.isFinite(v)) {
        log('warn', 'metrics.bad_value', { metric: this.name, value: String(v) });
        continue;
      }
      total += v;
    }
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name}${renderLabels({})} ${total}`);
  }

  reset(): void {
    // Collectors are live wiring, not accumulated counts: a metrics reset must not
    // silently unhook a running server's roster.
  }
}

const registry: Metric[] = [];

function reg<T extends Metric>(m: T): T {
  registry.push(m);
  return m;
}

// ------------------------------------------------------------------- metrics

const SECONDS_FAST = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5] as const;
const SECONDS_JOIN = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60] as const;

export const metrics = {
  connOpened: reg(new Counter('omwmp_connections_opened_total', 'WebSocket sessions accepted.', [])),
  // reason: ip_banned | ip_cap | no_subprotocol
  connRefused: reg(
    new Counter('omwmp_connections_refused_total', 'Sockets refused before the session state machine ran.', ['reason']),
  ),
  // code: a PROTOCOL.md DisconnectCode, or CLIENT_CLOSE when the socket simply went away
  // (alt-F4, tab close, network drop) — that path never calls disconnect().
  disconnects: reg(new Counter('omwmp_disconnects_total', 'Sessions closed, by disconnect code.', ['code'])),
  // Its own series rather than a disconnect code: terminate() also runs the CLIENT_CLOSE
  // path, and one dead socket must not be counted twice in the disconnect total.
  pongTimeouts: reg(new Counter('omwmp_pong_timeout_drops_total', 'Sockets reaped by the ping keepalive.', [])),
  // budget: msgs | bytes | login (these disconnect) | move_shed | actor_shed (these drop the
  // frame and keep the session — see Connection.onMessage).
  rateLimited: reg(new Counter('omwmp_rate_limited_total', 'Rate-limit trips, by which budget ran out.', ['budget'])),

  // Actor batches dropped on arrival. 'not_holder' is the anti-cheat surface: a client
  // authoring NPC state for a cell it does not hold. A steady non-zero rate from one
  // player is a modified client, not a race — the ordinary causes (a handoff in flight,
  // a frame already queued when authority moved) are bursty and self-limiting.
  // Phase H4 sim-peer lifecycle. simPeerRefused is the one to alert on: 'at_cap' means the
  // box is full and somebody's world is running without a peer (falling back to client
  // authority), which is a capacity signal rather than an error.
  simPeerRunning: reg(new Gauge('omwmp_simpeer_running', 'Headless simulation peers currently up.')),
  simPeerSpawned: reg(new Counter('omwmp_simpeer_spawned_total', 'Headless simulation peers started.', [])),
  simPeerReaped: reg(new Counter('omwmp_simpeer_reaped_total', 'Sim peers stopped after going idle.', [])),
  simPeerCrashed: reg(new Counter('omwmp_simpeer_crashed_total', 'Sim peers that exited unexpectedly.', [])),
  simPeerRefused: reg(
    new Counter('omwmp_simpeer_refused_total', 'Sim peer starts declined.', ['reason'])),

  // GATEWAY-ONLY (these render on the gateway process, which supervises worlds; a world
  // process leaves them at zero). worldRefused is the one to alert on: reason="memory" means
  // the box is full and a player was told to come back later, which is honest but is also the
  // signal to provision. Without it the only evidence of a full platform was a 503 the player
  // saw and nobody else did.
  worldsRunning: reg(new Gauge('omwmp_worlds_running', 'World processes currently supervised.')),
  worldsCapacity: reg(new Gauge('omwmp_worlds_capacity', 'Worlds this gateway may run at once (the binding ceiling).')),
  // THE TWO NUMBERS THE MEMORY CEILING IS ACTUALLY MADE OF. worlds_running is a count of
  // processes and no longer predicts memory on its own: a world runs one sim peer per OCCUPIED
  // CELL, so four players spread out cost roughly three times what four players in Balmora do
  // while both read as one world. Peers are what spend the RAM, and committed_mb is what the
  // governor is actually comparing against the budget -- graph that against the budget and the
  // box filling up is visible BEFORE a player is refused, which is the whole point.
  gatewayPeersRunning: reg(new Gauge('omwmp_gateway_peers_running', 'Sim peers across every supervised world (normally one per world).')),
  gatewayCommittedMb: reg(new Gauge('omwmp_gateway_committed_mb', 'RAM the supervised worlds and their peers have committed, as the governor prices it.')),
  worldRefused: reg(
    new Counter('omwmp_world_refused_total', 'World starts declined.', ['reason'])),

  // Move frames REFUSED (not merely counted) after sustained implausibility in the shared
  // lobby. Distinct from implausibleMoves, which counts the signal wherever it fires: this one
  // only rises where the server actually declined to move somebody.
  // Drops REFUSED for conservation, as opposed to unownedDrops which counts the signal
  // wherever it fires. Only rises where [economy] refuseUnownedDrops is on.
  unownedDropsRefused: reg(
    new Counter('omwmp_unowned_drops_refused_total', 'Object drops refused: the sender does not hold the item.', [])),

  // Non-adjacent exterior cell changes over [limits] farTravelPerMin. Rises where a client is
  // hopping the map faster than any spell or silt strider allows.
  farTravelRefused: reg(
    new Counter('omwmp_far_travel_refused_total', 'Cell changes refused: teleporting across the grid too often.', [])),

  movesRefused: reg(
    new Counter('omwmp_moves_refused_total', 'Player move frames refused for sustained implausible speed.', [])),

  // WHY THIS EXISTS: a dropped combat event is an attack that visibly did NOTHING. The
  // attacker's client has already cancelled its own damage (puppet.lua's onHit interceptor
  // returns false) before the server ever sees the hit, so a drop here costs the player the
  // whole swing — no damage, no miss, no sound — with nothing said to them. That is the
  // "my hits do not register" report, and until this counter existed an operator answering it
  // had only scattered warn lines to go on.
  // reason: cell has no authority holder | stale epoch | attacker not near the target cell |
  //         unknown target player | vetoed by a plugin | hit rate above any real client | ...
  // outcome: held | delivered | expired. A swing into a cell whose simulator is momentarily
  // absent is PARKED rather than discarded (the attacker's client already cancelled its own
  // damage, so a drop costs the whole attack). `held` rising with `delivered` is a peer
  // restarting and recovering; `held` rising with `expired` is a peer that is not coming back.
  combatHeld: reg(
    new Counter('omwmp_combat_held_total', 'Combat events parked while a cell had no simulator.', ['outcome'])),

  combatDropped: reg(
    new Counter('omwmp_combat_dropped_total', 'Combat events dropped, by reason. Each one is a swing the player lost.', ['reason'])),

  actorBatchRejected: reg(
    new Counter('omwmp_actor_batch_rejected_total', 'Inbound ActorMoveBatch frames dropped.', ['reason'])),
  // kind: move | actor. Outbound lossy frames dropped because the socket's send queue was
  // over [limits] maxBufferedBytes; a rising rate means a client is not keeping up.
  backpressureDropped: reg(
    new Counter('omwmp_backpressure_dropped_total', 'Lossy outbound frames dropped on a backed-up socket.', ['kind']),
  ),
  // kind: bad_lser | unknown_event | reserved_type | binary_before_in_world | internal_error
  protocolErrors: reg(new Counter('omwmp_protocol_errors_total', 'Malformed or out-of-state client frames.', ['kind'])),
  // op: register | login | resume; result: success | AUTH_FAILED | BANNED | RATE
  auth: reg(new Counter('omwmp_auth_total', 'Authentication attempts, by operation and outcome.', ['op', 'result'])),
  // Counted apart from omwmp_auth_total because it is the outcome of the OTHER session:
  // the incoming auth still succeeded. Mirrors omwmp_disconnects_total{code="SUPERSEDED"}.
  authSuperseded: reg(new Counter('omwmp_auth_superseded_total', 'Live sessions displaced by a re-login.', [])),
  // Phase 3.6 anti-cheat telemetry. Counted, never enforced: the client authors its own
  // position, so these are the signal moderation acts on, not a physics engine.
  implausibleMoves: reg(
    new Counter('omwmp_implausible_moves_total', 'Pose updates exceeding the plausible-speed envelope.', []),
  ),
  implausibleGains: reg(
    new Counter('omwmp_implausible_gains_total',
      'Character-state declarations whose jump exceeds the plausible envelope.', ['kind']),
  ),
  unownedDrops: reg(
    new Counter('omwmp_unowned_drops_total',
      'ObjectSpawnRequests placing more of an item than the sender is believed to hold.', []),
  ),
  containedActions: reg(
    new Counter('omwmp_contained_actions_total',
      'Actions refused in the shared world because the account is quarantined.', ['action']),
  ),
  resumeNoPose: reg(
    new Counter('omwmp_resume_no_pose_total', 'Resumes that fell back to the stored doc position (rubber-band risk).', []),
  ),
  // kind: grant (fresh claim of a dormant cell) | handoff (holder left, next inherits) |
  // dormant (last occupant left; snapshot folded into the doc)
  cellAuthority: reg(new Counter('omwmp_cell_authority_total', 'Cell actor-authority transitions.', ['kind'])),
  // store: players | cells | records | bans
  persistFlush: reg(
    new Histogram('omwmp_persist_flush_seconds', 'Duration of a persistence flush.', ['store'], SECONDS_FAST),
  ),
  persistFlushFailed: reg(new Counter('omwmp_persist_flush_failed_total', 'Persistence flushes that threw.', ['store'])),
  joinLatency: reg(
    new Histogram('omwmp_join_latency_seconds', 'Socket accept to IN_WORLD.', [], SECONDS_JOIN),
  ),
  sessionsInWorld: reg(new Gauge('omwmp_sessions_in_world', 'PLAYERS currently in world (the sim peer is infrastructure and is not counted).')),
  // Server-side memory held for clients that have not read it yet; the thing the shed above
  // is defending. Sampled from the live sockets at scrape time.
  outboundBuffered: reg(
    new Gauge('omwmp_outbound_buffered_bytes', 'Bytes queued for delivery across all live sockets.'),
  ),
};

// Times fn and files it under the store's histogram. Never swallows: the error is
// re-thrown after being tallied, so existing failure handling still runs.
export async function timeFlush<T>(store: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } catch (err) {
    metrics.persistFlushFailed.inc({ store });
    throw err;
  } finally {
    metrics.persistFlush.observe({ store }, (Date.now() - t0) / 1000);
  }
}

export function renderMetrics(): string {
  const out: string[] = [];
  for (const m of registry) m.render(out);
  return out.join('\n') + '\n';
}

// Tests only: the registry is process-global, so a test file that asserts absolute values
// must start from a known state.
export function resetMetrics(): void {
  for (const m of registry) m.reset();
}
