<!-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
     SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web -->
# Persistence consolidation: JSON stores → SQLite

## Why

The server persists through **two mechanisms**, which is non-standard and was flagged as
confusing on sight:

| Store | Backing | Lines |
|---|---|---|
| `core/socialstore.ts` — friends, blocks, parties, presence, mutes | **SQLite** (`node:sqlite`) | 327 |
| `core/accounts.ts` — accounts, characters, usernames | JSON per account | 325 |
| `data/locker.ts` — per-account file list + attestation | JSON per account | 507 |
| `auth/identities.ts` — (iss,sub) → account, login tickets | JSON per identity/ticket | 304 |
| `persist/playerstore.ts` — per-character docs (stats, journal, inventory) | JSON per character | 245 |
| `persist/cellstore.ts` — per-cell world deltas | JSON per cell | 279 |
| `core/moderation.ts` — chat log, reports, audit | JSON | 268 |
| `persist/banstore.ts` | JSON | 97 |
| `persist/recordstore.ts` | JSON | 102 |

History: the project began all-JSON; SQLite was introduced *only* for the friends graph
(socialstore.ts:5-15 documents the reasoning — a graph wants a database) with an explicit
"don't rewrite what already works" note. That was a fine incremental call and produced an
inconsistent result.

**Costs today:** two backup/restore procedures, two migration stories, no cross-store
transaction (deleting a character touches the account JSON *and* the player doc with no
atomicity), and the cognitive overhead of "which one is this?".

**Goal:** one SQLite database per data scope. Small, mechanical, well-covered by tests.

## Constraints that must survive

1. **Single-process assumption.** `socialstore.ts:12-15`: node:sqlite is only correct because
   a world is single-process. The gateway runs one process *per world* plus a front door,
   and they SHARE `<sharedDir>` (accounts, identities, locker, players). So the shared-scope
   DB is opened by multiple processes concurrently — **this is the one real design question**
   (see "Sharding the DBs" below). Do not paper over it.
2. **Zero dedup in the locker** (docs/LEGAL.md): per-account rows only, never a shared
   content-addressed table. A schema that joins accounts by file hash is legally wrong.
3. **The attestation stays a readable artifact.** It is the DMCA evidence trail; keep writing
   `<account>.attest.json` (or a table plus an export) so "show me exactly what they attested"
   stays a `cat`.
4. **Atomicity that already exists must not regress.** `writeJsonAtomic` (tmp→fsync→rename)
   never yields a torn read; SQLite gives this via transactions, but every multi-write path
   must actually be wrapped in one.
5. **Write-behind behaviour.** `playerstore` batches dirty docs and flushes on cell change /
   level-up / logout / SIGTERM / 45 s sweep. Keep that shape; do not turn every stat tick
   into a synchronous DB write.

## Sharding the DBs (decide FIRST)

- `<sharedDir>/shared.db` — accounts, characters, identities, tickets, locker, social
  (already `social.db`), bans. **Opened by every world process + the front door.**
- `<worldDataDir>/world.db` — cells, records, moderation. Single-writer per world.

For `shared.db`, enable WAL (`PRAGMA journal_mode=WAL`) and a `busy_timeout`; multi-process
readers/writers on one file is exactly what WAL is for. Verify with a test that opens two
connections and writes concurrently. If that proves flaky, the fallback is to keep the front
door as the only writer of shared data and have worlds go through it — a bigger change, so
prove WAL first.

## Progress

- [x] **1. `persist/sqlite.ts`** — DONE. `openDb(path, migrations)` (WAL + busy_timeout +
      synchronous=NORMAL + foreign_keys), a `schema_migrations` table, one transaction per
      migration, and `tx()` for multi-row writes. 484/484 green.
- [x] **2. `banstore.ts`** — DONE, now `bans.db`. Boot-time one-shot import from `bans.json`
      when the table is empty; the JSON is left on disk until a release proves the DB.
      **Caught a real bug:** `erase.ts` scrubbed `bans.json` only, so an account erasure would
      have left the ban row — and for an IP ban, the only IP address this server persists —
      behind. Erasure now DELETEs the row and still scrubs the legacy JSON.
- [x] **3. `recordstore.ts`** — DONE, now `world/records.db`. The row and the bumped `nextId`
      commit in ONE transaction: a crash between them would reissue or skip a recordNetId, and
      that id is what clients hold onto. Boot-time import from `world/records.json`.
- [x] **4. `moderation.ts`** — DONE, now `moderation.db` (`chat_lines` + `reports`). Boot-time
      one-shot import of `logs/chat-*.jsonl`; the files are left on disk for operators already
      shipping them. `erase.ts` gained a DELETE pass over both tables — the same gap the bans
      migration found, and it would have left an erased account's own words and every report
      naming them behind.
      **Semantics preserved deliberately:** retention is still counted in whole UTC DAYS, not
      exact milliseconds. The day-file prune compared date strings, so a line from exactly
      retentionDays ago survived its whole day; a naive `tsMs < now - days` silently tightened
      the documented policy and the test caught it at the boundary.
- [x] **8. `playerstore.ts`** — DONE, now `players.db`. The doc is stored WHOLE: the game reads
      and writes a character snapshot as a unit, and splitting inventory/journal into tables
      would buy nothing but join cost on the hottest write path. Write-behind semantics (cell
      change / level-up / logout / SIGTERM / 45 s sweep) are unchanged. `adoptLegacy` still
      reads a JSON file on purpose — it is the pre-slot account-keyed migration, not this one.
      `erase.ts` gained a row DELETE: a character doc is the bulk of what the server knows
      about a person, so missing it is a failed erasure, not a partial one.
- [x] **6. `accounts.ts`** — DONE, `accounts.db` (+ a `usernames` table whose PRIMARY KEY is
      the real uniqueness constraint). This is also where the account key stops being a
      FILENAME, which for an SSO account is the person's real name.
- [x] **7. `locker.ts`** — DONE, `locker.db`. ONE ROW PER ACCOUNT, deliberately NOT content
      addressed by hash: docs/LEGAL.md requires per-account copies with zero dedup. The
      ATTESTATION stays a readable file — it is the DMCA evidence trail and "show me what this
      user attested to" should stay a `cat`.
- [x] **10.** `atomicjson.ts` is still used by the legacy import paths and by adoptLegacy, so
      it stays until the JSON fallbacks are removed.

**All nine stores are now SQLite.** Remaining cleanup (safe once a release has proven the DB):
delete the legacy JSON/JSONL left on disk, and drop the import paths that read it.

### Note on step 4 (moderation)

The chat log was moved too, by explicit decision, after flagging the trade-off below. The cost
is real and is accepted: `logs/chat-*.jsonl` was greppable and tail-able with ordinary tooling,
and querying the table now needs sqlite3. The legacy files are retained on disk (never deleted)
so an existing evidence pipeline keeps working.

Original concern, left here as the record of the trade:

- **Chat log — was argued to stay JSONL.** It is an append-only stream rotated by UTC day
  (`logs/chat-YYYY-MM-DD.jsonl`), and its whole purpose is operator-facing abuse evidence:
  greppable, tail-able, rotatable by ordinary tooling, and tolerant of a truncated tail after a
  crash. SQLite would cost all of that to make `readRecent` a query it already answers fine.
- **Report inbox — MOVE.** One JSON file per report, listed by sorting filenames and parsing
  every file; a table is genuinely better (query by target/reporter, prune by timestamp, and
  atomicity with the moderation action that follows).

Cost note for whoever picks this up: `test/moderation.test.ts` asserts directly on the on-disk
layout (readdir, report filename pattern, file contents), so the reports migration includes
rewriting those assertions to query the DB. That is the bulk of the work, not the store itself.

**Finding that changes step 6.** `accountKey` is `account.name.toLowerCase()` — for an SSO
account that is the person's REAL NAME, and it is used as a FILENAME
(`accounts/michael stavridis.json`, and it seeded world ids until that was fixed). 264
references across 23 files, so renaming the key in the JSON layout is a wide, risky change.
Moving accounts into SQLite dissolves it instead: rows have no filenames, so the account can
key on the user-chosen `username` (or an opaque id) with the display name as an ordinary
column. Do the key change AS PART OF step 6 rather than as a separate migration.

## Order of work (one store per commit, `npm test` green each time)

1. ~~**`persist/sqlite.ts` (new)**~~ — DONE.
2. ~~**`banstore.ts`** (97 lines) — smallest, no dependents. Proves the helper.~~ DONE.
3. **`recordstore.ts`** (102).
4. **`moderation.ts`** (268) — append-heavy; a real table is a straight win over a JSON ring.
5. **`identities.ts`** (304) — note `LoginTicketStore` is deliberately FILE-backed so tickets
   cross processes (frontdoor mints, world claims). A shared DB makes this cleaner, not worse.
6. **`accounts.ts`** (325) — accounts, `characters[]` → its own table, `usernames/` index dir
   → a UNIQUE column. Kills the "file presence IS uniqueness" trick, which is the point.
7. **`locker.ts`** (507) — per-account file rows. Keep attestation as a file per (3).
8. **`playerstore.ts`** (245) — do this one LAST: hottest path, write-behind semantics matter.
9. **`cellstore.ts`** (279) — world-scoped DB.
10. **Delete `persist/atomicjson.ts`** when nothing imports it.

## Migration

One-shot importer `server/tools/import-json-to-sqlite.mjs`: read the existing trees
(`accounts/`, `players/`, `locker/`, `identities/`, world `cells/`) and insert. Run it on
boot when the DB is empty and JSON exists, logging counts — a deployment must not need a
manual step. Keep the JSON on disk (do not delete) until a release has proven the DB.

Live data is tiny (~150 KB, single-digit file counts), so this is fast and low-risk.

## Verification

- `npm test` (483 tests) green after **every** store. The suite already covers accounts,
  locker, characters, persistence, social — it is the safety net that makes this mechanical.
- New tests: multi-process WAL write (two connections), importer round-trip (JSON tree →
  DB → identical reads), crash-safety (kill between two writes in one transaction).
- `wasm-build/mp-harness.mjs s01 s21 s45 s53` — login, rejoin-in-place, social, character
  slots: the scenarios that actually exercise persistence end-to-end.
- Deploy check: `docker cp` the built dist, restart, confirm `/healthz` and that an existing
  account still logs in with its characters intact.

## Out of scope

Sharding worlds across machines. If that ever happens, shared data moves to a service and
this decision is revisited wholesale (socialstore.ts:12-15 already says so).
