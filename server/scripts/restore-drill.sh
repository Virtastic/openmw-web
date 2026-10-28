#!/usr/bin/env bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# Restore drill: proves the documented backup procedure (README.md "Backups") actually
# round-trips. Configuring a backup and KNOWING it restores are two different exercises —
# this is the second one, and it is the only evidence that the cron in README.md is worth
# anything.
#
# What it does, end to end:
#   1. boots a server on an ephemeral port with a scratch data dir
#   2. drives a real omw-mp/1 client to create an account + a known character/world state
#   3. SIGUSR1 (flush), then tools/backup-sqlite.mjs EXACTLY as the documented hourly cron does
#   4. deletes the data dir completely
#   5. restores from the archive, boots again, and ASSERTS the state came back:
#      the account logs in, and the character doc (appearance + cell + coords) is intact
#
# OT3-66 --from <archive>: drill a REAL backup instead (fetch last hour's archive from off-box
# storage first, with the same tool that shipped it). Steps 1-4 are skipped; the archive is
# restored into a scratch dir, the server must boot on it, and the seeded character is checked
# when the archive carries the drill canary account (seed it once on that server).
#
# Exit 0 = the backup procedure works. Any nonzero exit means it does not — this is
# designed to be a CI gate, so it never prints "probably fine".
#
# Usage: server/scripts/restore-drill.sh [--keep] [--from <sqlite-*.tar.gz>]

set -euo pipefail

cd "$(dirname "$0")/.."   # server/

KEEP=0
FROM=""
while (( $# )); do
  case "$1" in
    --keep) KEEP=1 ;;
    --from) FROM="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift ;;
  esac
  shift
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/openmw-mp-drill.XXXXXX")"
DATA="$WORK/data"
BACKUPS="$WORK/backups"
LOG1="$WORK/server-1.log"
LOG2="$WORK/server-2.log"
PORT=""
PID=""

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'restore-drill FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  local rc=$?
  [[ -n "$PID" ]] && kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  if (( KEEP )); then
    printf '\n(scratch kept: %s)\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
  exit $rc
}
trap cleanup EXIT

# Ephemeral port: ask the kernel for a free one rather than guessing, so concurrent drills
# (and a busy CI box) cannot collide.
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

boot() { # boot <logfile>
  PORT="$(free_port)"
  npx tsx src/main.ts --data "$DATA" --port "$PORT" >"$1" 2>&1 &
  PID=$!
  for _ in $(seq 1 100); do
    if ! kill -0 "$PID" 2>/dev/null; then
      cat "$1" >&2
      fail "server exited during boot"
    fi
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
      printf 'server up on port %s (pid %s)\n' "$PORT" "$PID"
      return 0
    fi
    sleep 0.2
  done
  cat "$1" >&2
  fail "server did not answer /healthz within 20s"
}

stop() {
  [[ -z "$PID" ]] && return 0
  kill -TERM "$PID" 2>/dev/null || true
  # SIGTERM broadcasts SessionDisconnect SHUTDOWN and flushes; give it the same grace the
  # production compose does (stop_grace_period: 45s).
  for _ in $(seq 1 225); do
    kill -0 "$PID" 2>/dev/null || { PID=""; return 0; }
    sleep 0.2
  done
  fail "server did not exit within 45s of SIGTERM"
}

mkdir -p "$DATA" "$BACKUPS"

# Is the drill account in this data dir's accounts.db? (usernames are stored lowercase)
has_canary() {
  node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]+"/accounts.db",{readOnly:true});process.exit(d.prepare("SELECT 1 FROM usernames WHERE username=?").get(process.argv[2])?0:1)' "$1" restoredrill 2>/dev/null
}

if [[ -n "$FROM" ]]; then
  step "restore $FROM into a scratch data dir and boot"
  [[ -s "$FROM" ]] || fail "no such archive: $FROM"
  tar xzf "$FROM" -C "$DATA"
  boot "$LOG2"
  if has_canary "$DATA"; then
    npx tsx scripts/drill-bot.ts verify "$PORT" || fail "restored server does not have the canary character"
  else
    printf 'no drill canary in this archive: boot-only check\n'
  fi
  stop
  printf '\nrestore-drill PASS: %s restores and boots\n' "$FROM"
  exit 0
fi

# ---------------------------------------------------------------- 1. seed
step "1/6 boot a server on a scratch data dir"
boot "$LOG1"

step "2/6 create known state (account + character + cell + chat line)"
npx tsx scripts/drill-bot.ts seed "$PORT" || fail "seeding failed"

# ---------------------------------------------------------------- 2. back up
step "3/6 flush (SIGUSR1) + back up exactly as the documented cron does"
kill -USR1 "$PID"
sleep 2   # same 2s the cron allows the flush; if that is too short, the drill must fail
node tools/backup-sqlite.mjs --data "$DATA" --out "$BACKUPS" || fail "backup-sqlite failed"
TARBALL="$(ls -t "$BACKUPS"/sqlite-*.tar.gz | head -1)"
[[ -s "$TARBALL" ]] || fail "backup archive is empty"

step "4/6 stop the server and DESTROY the data dir"
stop
rm -rf "$DATA"
[[ -e "$DATA" ]] && fail "data dir still exists after wipe"
printf 'data dir wiped: %s\n' "$DATA"

# ---------------------------------------------------------------- 3. restore
step "5/6 restore from the tarball and boot again"
mkdir -p "$DATA"
tar xzf "$TARBALL" -C "$DATA"
[[ -d "$DATA" ]] || fail "restore did not recreate the data dir"
has_canary "$DATA" || fail "restored accounts.db has no drill account"
boot "$LOG2"

step "6/6 ASSERT the known state came back"
npx tsx scripts/drill-bot.ts verify "$PORT" || fail "restored server does not have the seeded state"

# The A4 moderation trail is part of the backup too: a restore that loses the chat log
# loses the evidence an operator restored the server to look at.
CHATLOG="$DATA/logs/chat-$(date -u +%F).jsonl"
[[ -f "$CHATLOG" ]] || fail "chat log missing after restore ($CHATLOG)"
grep -q 'restore-drill marker line' "$CHATLOG" || fail "chat log survived but the seeded line did not"
printf 'chat log restored with the seeded line\n'

stop
printf '\nrestore-drill PASS: backup -> wipe -> restore round-trips with state intact\n'
