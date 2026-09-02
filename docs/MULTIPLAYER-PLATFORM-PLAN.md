# openmw-web multiplayer platform — next phase

> **Historical planning document** from the multiplayer build-out. Kept for the reasoning;
> the shipped behaviour has moved on (there is an admin dashboard and a setup wizard now, and
> self-hosted sign-in is a choice rather than SSO-only). Do not read this as current usage
> documentation — that is [`../SELF_HOSTING.md`](../SELF_HOSTING.md).

Status of the current layer: **M0–M8 complete** on branch `multiplayer` (27 commits).
26/26 browser scenarios twice consecutively, 173/173 server tests (incl. 11 adversarial),
30-min 24-bot soak clean, singleplayer unaffected. Not deployed.

This document covers (0) what production readiness still requires, and (1–4) the platform
build: SSO, friends/presence, auto-hosted sessions, persistent worlds, in-game admin.

Research basis: a 5-angle web study with 3-vote adversarial verification (25 claims → 20
confirmed, 5 refuted). **It reached high confidence in only two areas — ops/production
readiness and auth architecture.** Friends/presence design, 32-player scaling, TES3MP
player-complaint data, and MyGUI admin prior art did NOT survive verification as more than
two thin GitHub issues. Those are marked UNVALIDATED below and must be de-risked by
experiment, not by planning confidence.

---

## Part 0 — Production readiness of what already exists

A passing suite covers none of the runtime-ops surface. These are gaps in *our* build,
verified against our own code, not hypotheticals.

| Gap | Evidence | Fix |
|---|---|---|
| **No metrics.** `/healthz` + a `/status` snapshot only. No error rates, disconnect-reason counters, per-family drop counts, latency histograms. | `server/src/net/http.ts` | Adopt an Agones-style baseline: session counts by state, join-latency histogram, retry counters, time-in-state. |
| **No SLO alerting.** | — | Multiwindow multi-burn-rate: page at 2%/1h and 5%/6h, ticket at 10%/3d, on connect-success, tick latency, desync rate. |
| **Client reconnect has no backoff/jitter.** | `scripts/mp/net.lua` reconnects on a fixed path | **Blocking for public launch.** Jitter + truncated exponential backoff. |
| **Crash window ≤45 s** of world state on hard kill (SIGTERM flushes correctly). | `persist/*` write-behind | Accept + document, or shorten for busy worlds. |
| **Redeploy disconnects everyone**; resume tickets are in-memory. | `core/resume.ts` | Fine for one server; unacceptable for 10 persistent worlds → needs drain + ticket persistence. |
| **Restore never rehearsed.** Backups are documented but untested. | `server/README.md` | Do a real restore drill — Google treats recovery-from-data-loss as a *separate* exercise from recovery-from-failures. |
| **Moderation is thin.** kick/ban/ipban exist and are audited; no report flow, no chat-log review. | `core/admin.ts` | Needed before open registration. |

**Cloudflare:** stay on the ordinary orange-cloud proxy. WSS on 443 already gets origin
masking, WS upgrade support, and L7 DDoS protection. **Do not plan on Spectrum** — custom
TCP/UDP apps are Enterprise-only with a paid add-on.

*Sources: agones.dev metrics guide; Google Cloud reliability pillar; SRE Workbook
"Alerting on SLOs" and "Managing Load" (the Pokémon GO retry-amplification case study —
synchronized client retries produced 20× peak RPS and halved GCLB capacity);
developers.cloudflare.com/spectrum.*

---

## Part 1 — Identity / SSO  (settled; build with confidence)

**Authorization Code + PKCE (S256), Backend-For-Frontend. Never implicit.**

- PKCE is a **MUST** for browser-based public clients (draft-ietf-oauth-browser-based-apps
  §6.3.2.1). Implicit is deprecated by RFC 9700 §2.1.2 — tokens land in the URL fragment,
  leak via history/Referer/logs, and can't be sender-constrained.
- The **existing Node/TS relay becomes the BFF**: it performs the code exchange
  server-side, and provider access/refresh tokens **never reach the browser**. Google
  forces this anyway — its web-application clients get a `client_secret` that cannot live
  in a browser, and it explicitly discourages client-side flows.
- **Key accounts on `(iss, sub)` — never email.** Email is mutable and re-assignable;
  `sub` is the only guaranteed-stable identifier, and only within one issuer.
- The WS game protocol keeps its **own opaque session token** (we already have this from
  M8). Provider tokens never enter the game protocol. This is a clean seam: SSO replaces
  only the `SessionRegister`/`SessionLoginRequest` step.
- Account linking (one human, Discord + Google + Microsoft) = an `identities` table keyed
  on `(iss, sub)` → one `account_id`. Link by proving control of a second provider while
  already authenticated, **not** by matching email.

This maps onto our existing auth ladder with modest disruption: `SessionResume` and the
opaque token stay exactly as they are.

---

## Part 2 — The parts the research did NOT settle  (de-risk before committing)

Honest position: I could not find verified evidence for these, so the plan below is
structured as **experiments that produce evidence**, not as a build schedule.

### 2a. 32 players per persistent world — the single biggest risk

What we actually know:
- Our soak validated **24 protocol-level bots** — no rendering, no game data, and
  deliberately spread across 4–6 cells.
- **TES3MP #701 (open)**: *"Non-cell authority often has broken gamestate"* — roughly half
  of player hits deal no damage and are invisible to the target, NPC hits fail to register,
  NPCs attack while stunned. **That is our architecture too.** We inherited per-cell
  authority; we have tested it with 2 clients, never with 20 in one cell.
- **TES3MP #698 (open)**: client crash in a cell-reset loop — cell reset is a stability
  surface, not just a loot-policy knob.

The hard problem isn't raw bandwidth, it's **cell-authority contention**: if 20 players
stand in one Balmora cell, a single client simulates every NPC there and broadcasts to
everyone, and every non-authority client is exposed to exactly the #701 failure mode.

**Experiment before committing to 32:** extend the soak to put N bots *in one cell* and
measure — authority-holder CPU, per-client bandwidth, and a correctness invariant (do all
clients agree on NPC positions/health?). Ramp 8 → 16 → 24 → 32 in a single cell. That
number, not a guess, sets the cap.

**Likely outcomes to plan for:** interest management (only sync actors near you), an
authority-holder election that prefers a low-latency client, and a per-cell soft cap that
overflow-shards or refuses entry. If 32-in-one-cell proves unworkable, 32-per-*world* with
a lower per-cell cap is still deliverable — and honest.

### 2b. Friends / presence / join-on-the-fly

No verified architecture evidence was found; treat the following as design, not research.

The consequential decision is **auto-hosting**. "Friends join your game on the fly, we host
it" changes the cost and ops model from one container to N sessions — you need an
orchestrator (create/route/reap), a session directory, and a cost ceiling. Our current
deploy is a single fixed container.

Minimal viable version, in order: presence (online/offline/in-world) → friends (request/
accept/block) → invite + join-by-session-id → auto-host. Each is independently useful, and
the first three don't require the orchestrator.

### 2c. MyGUI admin UI

No prior-art evidence surfaced. But we already have working in-game Lua UI (the M0 chat
window, M7 server-pushed message/input/list dialogs), and the whole M8 admin command set
exists server-side and is rank-gated and audited. So the admin UI is **a client for an API
we already built**, which is the cheap half.

Permission model already supported: rank on the account, `[admin] owners`, outranking
rules. "Host of my own game" = rank scoped to a session; "public-world admin" = rank
scoped to a world. That's one extra scope column, not a redesign.

---

## Part 3 — TES3MP pain points worth pre-empting

Evidence here is thin (two untriaged issues, n=1 each, no reproducers) — so these are
*targeted tests to write*, not established facts:

1. **Non-authority gamestate divergence** (#701) — write a scenario asserting a non-holder
   sees the same NPC health/position as the holder after combat. We already assert the
   mechanism for movement; extend to combat outcomes.
2. **Cell-reset stability** (#698) — we implemented cell reset in M7 with a persisted
   schedule; add a scenario that resets a cell with players inside it.
3. Our own M4 findings already pre-empted several classic co-op complaints: kill tallies
   that ignore non-player kills (stranded quests), cells frozen after handoff, dupe-proof
   container transactions.

**Validated prior art:** TES3MP keeps essential server logic — gameplay rules *and* state
persistence — in a user-modifiable Lua layer (CoreScripts), swappable per server. Our
plugin system already mirrors this. Keep rules as data/plugins, not compiled into the relay.

---

## Phasing

**Phase A — make what exists safe to expose (small, do first).**
Reconnect backoff+jitter (blocking), metrics + SLO alerts, restore drill, deploy drain +
persisted resume tickets, report/chat-log moderation. This is the difference between "tests
pass" and "safe to give strangers".

**Phase B — identity.** SSO via BFF+PKCE, `(iss, sub)` accounts, provider linking. Replaces
only the auth step; the rest of the protocol is untouched.

**Phase C — social.** Presence → friends → invites/join. No orchestrator needed yet.

**Phase D — scale experiment.** The single-cell ramp test. **Gate the 32-player promise on
its result** rather than announcing it first.

**Phase E — auto-hosted sessions + persistent worlds + admin UI**, sized by what D proves.

I'd deliberately *not* start at E, even though it's the most exciting part — its two
prerequisites (a scaling number we don't have, and identity) both live upstream of it.

---

## What I'd push back on

- **"Up to 32 players"** — don't publish that number until the Phase D experiment supports
  it. TES3MP's own open issue says non-authority clients get broken combat state, and that
  is the same design we use. Promising 32 and shipping a stuttery 12 is the fastest way to
  disappoint the exact players you want.
- **Auto-hosting every friend group** has an unbounded cost model. Worth a per-user session
  cap and an idle-reap policy from day one.
- **10 persistent worlds** multiplies the ops surface tenfold (backups, restores, resets,
  moderation, rollbacks) while the moderation tooling is currently kick/ban. Consider
  launching 1–2 and growing.
- The public `?nomw` demo **cannot show shared NPCs** — the clean Example Suite ships zero
  NPC placements. Persistent worlds need retail data, which every player must own.
