#!/bin/sh
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# Content-version the built engine so a CDN can NEVER serve a mismatched mix of two builds' files.
#
# The engine is three files loaded as one set: openmw.js (loader) + openmw.wasm (code) + openmw.data
# (preload). They have stable names, so Cloudflare caches each independently — and across redeploys a
# browser could get openmw.js from build A but openmw.wasm from build B. A mismatched loader/wasm pair
# wires up function pointers that don't exist → "RuntimeError: null function" at boot.
#
# Fix: hash openmw.wasm, move openmw.{js,wasm,data}(+.br) into <play>/e/<hash>/, and stamp that hash
# into <play>/index.html (replacing the __ENGINE_VERSION__ placeholder; index.html then loads the
# loader from e/<hash>/ and Module.locateFile resolves the wasm/data from the same dir). Every build's
# files live at a UNIQUE path, so a mismatch is physically impossible. index.html is served no-cache,
# so it always points at the current version.
#
# Run AFTER link + make_br. Idempotent on a fresh build tree. Usage: PLAY=/srv sh version-engine.sh
set -eu
PLAY="${PLAY:-${1:-play}}"
cd "$PLAY"
[ -f openmw.wasm ] || { echo "version-engine: openmw.wasm not found in $PLAY" >&2; exit 1; }

# 12 hex chars of sha256 over EVERY file that gets the immutable cache header — changes iff any of
# them changes. streamfs.js must be in the hash, not just openmw.wasm: it is served from the same
# `*.js` glob (Cache-Control: immutable, 30-day Cloudflare edge TTL), so if it were versioned by the
# wasm's hash alone, a streamfs-only change would reuse the existing e/<hash>/ path and returning
# visitors would be pinned to the stale copy for up to a year — immutable means the browser does not
# even revalidate. sha256sum (Linux/alpine busybox) or shasum -a 256 (macOS) — whichever exists.
# EVERY file that moves into e/<hash>/ must be IN the hash. openmw.js and openmw.data were not,
# and openmw.data is where the multiplayer client lives: fsroot/resources/vfs/scripts/mp/*.lua is
# packed into it. A Lua-only change therefore left openmw.wasm byte-identical (the compile is
# deterministic on purpose), produced the SAME hash, and republished the new openmw.data over the
# existing e/<hash>/ path -- a path served Cache-Control: immutable, max-age=31536000. Immutable
# means the browser does not even revalidate, so a returning player keeps the old client scripts
# for up to a year while the server runs the new code. A whole class of client fix could ship,
# pass its deploy gate, and reach nobody who had played before.
#
# openmw.js has the same problem for a different reason: it carries the preload manifest, whose
# byte offsets shift whenever openmw.data changes.
VER=$( { cat openmw.wasm openmw.js openmw.data streamfs.js 2>/dev/null || true; } | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12 )
[ -n "$VER" ] || { echo "version-engine: could not hash engine files" >&2; exit 1; }

DIR="e/$VER"
mkdir -p "$DIR"
for f in openmw.js openmw.wasm openmw.data openmw.js.br openmw.wasm.br openmw.data.br streamfs.js; do
  [ -f "$f" ] && mv -f "$f" "$DIR/$f" || true
done

# Stamp index.html in place (temp-file form is portable across GNU + BSD + busybox sed).
# Two substitutions: the engine version placeholder, and streamfs.js's <script src> so it loads from
# the same content-addressed dir. Unstamped (local dev) index.html keeps the plain relative path.
sed -e "s/__ENGINE_VERSION__/$VER/g" -e "s|src=\"streamfs.js\"|src=\"$DIR/streamfs.js\"|g" \
  index.html > index.html.tmp && mv index.html.tmp index.html
# PUBLISH THE HASH. The world server has to pin the SAME engine it is serving, and until now
# the only record of which one that is was this log line and a directory name. A pin typed into
# config.toml by hand is a constant that must be edited in lockstep with every deploy, and in
# "refuse" mode a stale pin rejects EVERY client -- an outage caused by the security control.
#
# Writing it where the deploy can read it makes the pin follow the engine automatically. See
# OMW_ENGINE_PIN in server/src/config.ts.
printf "%s" "$VER" > "$PLAY/engine-version.txt"
echo "version-engine: engine -> $PLAY/$DIR ; index.html stamped ($VER) ; hash -> $PLAY/engine-version.txt"
