// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// In-process metric registry + Prometheus text renderer. No dep, by design (the server
// ships only ws/argon2/smol-toml). Process-global like log.ts: subsystems import the
// counters directly instead of threading a registry through every constructor.
//
// Cardinality is the only real hazard here, so every label value is drawn from a closed
// set defined in this file — never from client input.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { log } from './log';

type Labels = Record<string, string>;

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
abstract class Metric {
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

// A gauge whose series are labelled (per region). Collectors return the whole series list at
// scrape time, so a region that disappears simply stops being reported.
export class LabeledGauge extends Metric {
  private collectors = new Set<() => { labels: Labels; value: number }[]>();

  addCollector(fn: () => { labels: Labels; value: number }[]): () => void {
    this.collectors.add(fn);
    return () => this.collectors.delete(fn);
  }

  render(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`);
    for (const fn of this.collectors) {
      for (const s of fn()) {
        if (!Number.isFinite(s.value) || !checkLabels(this.name, this.labelNames, s.labels)) continue;
        out.push(`${this.name}${renderLabels(s.labels)} ${s.value}`);
      }
    }
  }

  reset(): void {
    // live wiring, like Gauge
  }
}

// OT3-189: the items gained most (by count) over the current and previous window, top N only,
// so the label set stays bounded whatever ids arrive. Ids are inventory record ids that passed
// the declaration checks (known records wherever the content table is loaded).
export class TopMovers extends Metric {
  private cur = new Map<string, number>();
  private prev = new Map<string, number>();
  private rolledAt?: number;

  constructor(name: string, help: string, readonly top = 10, readonly windowMs = 3_600_000) {
    super(name, help, ['item']);
  }

  private roll(now: number): void {
    this.rolledAt ??= now;
    if (now - this.rolledAt < this.windowMs) return;
    this.prev = now - this.rolledAt >= 2 * this.windowMs ? new Map() : this.cur;
    this.cur = new Map();
    this.rolledAt = now;
  }

  add(item: string, n: number, now = Date.now()): void {
    this.roll(now);
    this.cur.set(item, (this.cur.get(item) ?? 0) + n);
  }

  render(out: string[], now = Date.now()): void {
    this.roll(now);
    const sum = new Map(this.prev);
    for (const [k, v] of this.cur) sum.set(k, (sum.get(k) ?? 0) + v);
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`);
    for (const [item, n] of [...sum].sort((a, b) => b[1] - a[1]).slice(0, this.top)) {
      out.push(`${this.name}${renderLabels({ item })} ${n}`);
    }
  }

  reset(): void {
    this.cur.clear();
    this.prev.clear();
    this.rolledAt = undefined;
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
  avatarItemLayoutSkipped: reg(new Counter('omwmp_avatar_item_layout_skipped_total', 'Peer item-state buckets left out because the avatar held a different count than the doc (backlog 507).', [])),

  // Actor batches dropped on arrival. 'not_holder' is the anti-cheat surface: a client
  // authoring NPC state for a cell it does not hold. A steady non-zero rate from one
  // player is a modified client, not a race — the ordinary causes (a handoff in flight,
  // a frame already queued when authority moved) are bursty and self-limiting.
  // Phase H4 sim-peer lifecycle. simPeerRefused is the one to alert on: 'at_cap' means the
  // box is full and somebody's world is running without a peer (falling back to client
  // authority), which is a capacity signal rather than an error.
  // OT3-63: seconds since tools/backup-sqlite.mjs last wrote a good snapshot; -1 = never.
  backupAgeSec: reg(new Gauge('omwmp_backup_age_seconds', 'Seconds since the last good SQLite backup (-1 = none yet).')),
  simPeerRunning: reg(new Gauge('omwmp_simpeer_running', 'Headless simulation peers currently up.')),
  simPeerSpawned: reg(new Counter('omwmp_simpeer_spawned_total', 'Headless simulation peers started.', [])),
  simPeerReaped: reg(new Counter('omwmp_simpeer_reaped_total', 'Sim peers stopped after going idle.', [])),
  simPeerCrashed: reg(new Counter('omwmp_simpeer_crashed_total', 'Sim peers that exited unexpectedly.', [])),
  simPeerRefused: reg(
    new Counter('omwmp_simpeer_refused_total', 'Sim peer starts declined.', ['reason'])),

  // GATEWAY-ONLY (these render on the gateway process, which supervises worlds; a world
  // process leaves them at zero). worldRefused is the one to alert on: reason="memory" (the
  // static price), "mem" (measured RSS past the budget) or "cpu" (loadavg past the cores, #270)
  // means the box is full and a player was told to come back later, which is honest but is
  // also the signal to provision. Without it the only evidence of a full platform was a 503 the player
  // saw and nobody else did.
  // Peers are what spend the RAM (one per occupied cell, ~487 MB each); graph this against
  // the host's memory.
  gatewayPeersRunning: reg(new Gauge('omwmp_gateway_peers_running', 'Sim peers across every supervised world (normally one per world).')),
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
  // #361: same-cell jumps beyond a room with no cast/door/conversation/respawn to explain them.
  cellChangeRefused: reg(
    new Counter('omwmp_cell_change_refused_total', 'Same-cell teleports refused: nothing seen that explains the jump.', [])),

  // OT3-189 (core/economy.ts): gold into / out of player inventories by source (loot |
  // merchant | quest | trade | admin | other). A dupe is a spike, usually on 'other'.
  goldIn: reg(new Counter('omwmp_gold_in_total', 'Gold entering player inventories, by source.', ['source'])),
  goldOut: reg(new Counter('omwmp_gold_out_total', 'Gold leaving player inventories, by source.', ['source'])),
  itemMovers: reg(new TopMovers('omwmp_item_top_movers', 'Items gained most across players over the last 1-2 hours (top 10).')),

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
  avatarBatchRejected: reg(
    new Counter('omwmp_avatar_batch_rejected_total', 'Inbound AvatarMoveBatch frames dropped (only the world peer may author avatar poses).', ['reason'])),
  playerInputForwarded: reg(
    new Counter('omwmp_player_input_forwarded_total', 'PlayerInput frames forwarded to the world peer.', [])),
  playerInputDropped: reg(
    new Counter('omwmp_player_input_dropped_total', 'PlayerInput frames dropped.', ['reason'])),
  // kind: move | state | actor. Pending lossy frames superseded by a newer one before the
  // socket drained (connection.ts latest-state-wins); a rising rate means a client is not keeping up.
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
  recordsRefused: reg(
    new Counter('omwmp_records_refused_total',
      'Custom records (RecordCreate) refused for a field beyond the vanilla caps.', []),
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
  // OT3-70: p50 and max share the delay histogram with p99 below, so they are registered FIRST:
  // the p99 collector resets the histogram after reading, and these read before that.
  eventLoopP50: reg(
    new Gauge('omwmp_event_loop_delay_p50_seconds', 'Event-loop delay p50 since the last scrape.'),
  ),
  eventLoopMax: reg(
    new Gauge('omwmp_event_loop_delay_max_seconds', 'Event-loop delay max since the last scrape.'),
  ),
  // OT3-140: a page fires when this stays above 100 ms. p99 since the previous scrape.
  eventLoopP99: reg(
    new Gauge('omwmp_event_loop_delay_p99_seconds', 'Event-loop delay p99 since the last scrape.'),
  ),

  // ---- OT3-70/195: capacity series. Peer ones are measured on arrival (peers/peerload.ts).
  // Per region: the peer is one process per region, so each carries its own ceiling.
  sessionsInRegion: reg(new LabeledGauge('omwmp_sessions_in_region', 'PLAYERS in world, by the region owning their cell.', ['region'])),
  peerUp: reg(new LabeledGauge('omwmp_peer_up', '1 when the region has a connected sim peer.', ['region'])),
  peerFrameMs: reg(new LabeledGauge('omwmp_peer_frame_interval_ms',
    'Interval between the peer\'s simulation frames as seen on arrival (50 = on pace; over 50 slows sim time).', ['region', 'quantile'])),
  peerSimReal: reg(new LabeledGauge('omwmp_peer_sim_real_ratio', 'Sim time over real time for the region (1 = real time).', ['region'])),
  peerHeldCells: reg(new LabeledGauge('omwmp_peer_held_cells', 'Cells the region\'s peer holds authority for.', ['region'])),
  peerActiveActors: reg(new LabeledGauge('omwmp_peer_active_actors', 'Actors in the region\'s latest simulation frame.', ['region'])),
  opQueueDepth: reg(new Gauge('omwmp_op_queue_depth', 'World ops queued or running (the per-cell lanes plus the global lane).')),
  opQueueWait: reg(new Histogram('omwmp_op_queue_wait_seconds', 'Time a world op waited in its lane before it ran.', [], SECONDS_FAST)),
  displayCapped: reg(new Counter('omwmp_display_capped_total', 'Player-views withheld by the per-client display cap (limits.maxVisiblePlayers).', [])),
  relayChecks: reg(new Counter('omwmp_relay_checks_total', 'Sender-candidates examined by the movement relay (rate() = checks/s).', [])),
  bytesOut: reg(new Counter('omwmp_bytes_out_total', 'Bytes written to player sockets (divide rate() by omwmp_sessions_in_world for bytes/session).', [])),
  bytesIn: reg(new Counter('omwmp_bytes_in_total', 'Bytes read from player sockets.', [])),
  serverCrashes: reg(new Counter('omwmp_server_crashes_total', 'Process-level crashes caught by the last-gasp handler.', ['kind'])),
  accountsCreated: reg(new Counter('omwmp_accounts_created_total', 'Accounts created (password and SSO).', [])),
  clientErrors: reg(new Counter('omwmp_client_errors_total', 'Error-level lines the page and engine posted to /clientlog.', [])),
};

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
metrics.eventLoopP50.addCollector(() => (loopDelay.count > 0 ? loopDelay.percentile(50) / 1e9 : 0));
metrics.eventLoopMax.addCollector(() => (loopDelay.count > 0 ? loopDelay.max / 1e9 : 0));
metrics.eventLoopP99.addCollector(() => {
  const p99 = loopDelay.count > 0 ? loopDelay.percentile(99) / 1e9 : 0;
  loopDelay.reset();
  return p99;
});

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
