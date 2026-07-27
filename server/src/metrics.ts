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

function renderLabels(labels: Labels, extra?: [string, string]): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k]!)}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
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
    if (this.series.size === 0 && this.labelNames.length === 0) out.push(`${this.name} 0`);
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
    out.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${total}`);
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
  sessionsInWorld: reg(new Gauge('omwmp_sessions_in_world', 'Sessions currently in world (read from the roster).')),
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
