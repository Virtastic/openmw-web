#!/usr/bin/env bash
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# =============================================================================================
# fetch-deps.sh — populate deps/src/ from upstream so build-deps.sh has something to build.
#
# WHY THIS EXISTS. build-deps.sh says its sources are "expected under deps/src/ (already in the
# tree)" — but deps/ is gitignored, and NOTHING put them there. So a clean `git clone` could not
# build this project at all: restage-inputs.sh states it outright ("a git checkout ALONE cannot
# produce a buildable tree"), and the only way to get sources was to copy ~750MB out of band from
# a builder's ~/build-artifacts or somebody's existing tree.
#
# That gap has a cost beyond onboarding. The audio outage this fixed a version of was exactly
# this shape: build-deps.sh had the mp3/vorbis decoders enabled for months while the SHIPPED
# libavcodec.a predated the change, because the built artifact travelled out of band and the
# source fix did not. A dependency you cannot rebuild from a clone is one you will eventually
# ship stale without noticing.
#
# WHAT IS AND IS NOT PUBLISHABLE. The "not ours to publish" note on deps/ is correct for RETAIL
# game data — that stays out, and the bring-your-own-Morrowind path exists for it. It is not true
# of the dependency sources: OSG, Bullet, Recast, MyGUI, FFmpeg, Boost, Lua and LZ4 are all open
# source and freely fetchable. Downloading them needs no permission from anyone.
#
# USAGE
#   wasm-build/fetch-deps.sh              # fetch anything missing
#   wasm-build/fetch-deps.sh --force      # re-fetch even if present
#   wasm-build/fetch-deps.sh osg lua      # just these
#
# Then:
#   wasm-build/build-deps.sh              # compile them into deps/wasm/
#
# PINNED, NOT "LATEST". Every version below is the one this tree is known to build against; the
# git ones are pinned to a TAG rather than a branch. An unpinned dependency stack reproduces a
# different bug every time it is fetched.
# =============================================================================================
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="$ROOT/deps/src"
FORCE=0

args=()
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '4,32p' "$0"; exit 0 ;;
    *) args+=("$a") ;;
  esac
done

mkdir -p "$SRC"
log() { printf '\n=== %s\n' "$*"; }

# --- git checkouts, pinned to tags ------------------------------------------------------------
# name|url|tag|dir
GIT_DEPS=(
  "osg|https://github.com/openscenegraph/OpenSceneGraph.git|OpenSceneGraph-3.6.5|osg"
  "bullet|https://github.com/bulletphysics/bullet3.git|3.25|bullet3"
  "recast|https://github.com/recastnavigation/recastnavigation.git|v1.6.0|recast"
  "mygui|https://github.com/MyGUI/mygui.git|MyGUI3.4.3|mygui"
)

# --- release tarballs --------------------------------------------------------------------------
# name|url|dir (the directory the tarball unpacks to, which build-deps.sh expects by name)
TAR_DEPS=(
  "ffmpeg|https://ffmpeg.org/releases/ffmpeg-6.1.2.tar.xz|ffmpeg-6.1.2"
  "boost|https://archives.boost.io/release/1.85.0/source/boost_1_85_0.tar.bz2|boost_1_85_0"
  "lua|https://www.lua.org/ftp/lua-5.4.7.tar.gz|lua-5.4.7"
  "lz4|https://github.com/lz4/lz4/releases/download/v1.10.0/lz4-1.10.0.tar.gz|lz4-1.10.0"
)

want() { # want <name>: no filter => everything
  [ ${#args[@]} -eq 0 ] && return 0
  for a in "${args[@]}"; do [ "$a" = "$1" ] && return 0; done
  return 1
}

fetch_git() {
  local name="$1" url="$2" tag="$3" dir="$4" dest="$SRC/$4"
  want "$name" || return 0
  if [ -d "$dest/.git" ] && [ "$FORCE" -eq 0 ]; then
    echo "  $name: present ($(cd "$dest" && git describe --tags 2>/dev/null || echo unknown))"
    return 0
  fi
  log "$name <- $url @ $tag"
  [ "$FORCE" -eq 1 ] && rm -rf "$dest"
  # --depth 1 on the tag: these are large histories and none of the builds read them.
  git clone --depth 1 --branch "$tag" "$url" "$dest"
}

fetch_tar() {
  local name="$1" url="$2" dir="$3" dest="$SRC/$3"
  want "$name" || return 0
  if [ -d "$dest" ] && [ "$FORCE" -eq 0 ]; then echo "  $name: present"; return 0; fi
  log "$name <- $url"
  [ "$FORCE" -eq 1 ] && rm -rf "$dest"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/pkg"
  # Let tar sniff the compression (.xz/.bz2/.gz all appear above).
  tar -xf "$tmp/pkg" -C "$SRC"
  rm -rf "$tmp"
  [ -d "$dest" ] || { echo "!! $name unpacked but $dest is missing — the tarball layout changed" >&2; exit 1; }
}

for spec in "${GIT_DEPS[@]}"; do IFS='|' read -r n u t d <<<"$spec"; fetch_git "$n" "$u" "$t" "$d"; done
for spec in "${TAR_DEPS[@]}"; do IFS='|' read -r n u d <<<"$spec"; fetch_tar "$n" "$u" "$d"; done

# --- the OSG patch, which is not optional -------------------------------------------------------
# build-osg.sh's header is explicit: OSG must have wasm-build/patches/osg-emscripten.patch applied
# or the build produces a blank-RTT, no-S3TC, no-VAO engine. Applied here so "fetch then build"
# actually works. --check first so re-running is safe.
if want osg && [ -d "$SRC/osg/.git" ]; then
  log "osg: applying wasm-build/patches/osg-emscripten.patch"
  if git -C "$SRC/osg" apply --check "$ROOT/wasm-build/patches/osg-emscripten.patch" 2>/dev/null; then
    git -C "$SRC/osg" apply "$ROOT/wasm-build/patches/osg-emscripten.patch"
    echo "  applied"
  else
    echo "  already applied (or does not apply cleanly) — leaving the tree alone"
  fi
fi

log "done"
echo "deps/src now holds:"
ls -1 "$SRC"
echo
echo "Next: wasm-build/build-deps.sh    (compiles these into deps/wasm/)"
echo "Note: retail game data is NOT fetched here and never will be — that is the"
echo "      bring-your-own-Morrowind path, see README."
