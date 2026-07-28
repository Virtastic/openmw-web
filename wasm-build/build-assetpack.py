#!/usr/bin/env python3
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# build-assetpack.py — pack the optional performance asset pack into a single TES3 BSA.
#
# WHY A BSA, AND NOT LOOSE FILES:
#   The pack is ~3300 small meshes. Shipping them loose would (a) add ~3300 entries to
#   mountLocalMorrowind()'s boot walk in play/index.html, which does an `await getFile()` per file
#   and blocks boot, and (b) thrash streamfs.js's 2MB-chunk / 48-slot LRU, since a 40KB .nif would
#   cost a whole 2MB slice. One BSA is a single StreamFS.mount() and packs the meshes contiguously,
#   so one chunk serves many of them.
#
# WHY NOT bsatool:
#   The engine's own bsatool CAN write TES3 archives, but `addFile` (components/bsa/bsafile.cpp)
#   relocates every file whose offset falls inside the growing header, copying it to the end — so
#   adding N files is O(N^2) data movement, plus one process spawn per file. This writes the whole
#   archive in one pass instead. `bsatool list` is still the right way to VERIFY the output.
#
# FORMAT (TES3 / version 0x100, uncompressed) — mirrors components/bsa/bsafile.cpp writeHeader():
#   u32 version(0x100), u32 hashOffset, u32 fileCount
#   fileCount x (u32 size, u32 offset)     # offset relative to the data block start
#   fileCount x u32 nameOffset             # into the name block
#   name block                             # null-terminated, lowercase, backslash-separated
#   fileCount x (u32 hashLow, u32 hashHigh)
#   data
#   where dataStart == 12 + hashOffset + 8*fileCount, and records are sorted by (hashLow, hashHigh).
#
# The hash is a port of Bsa::getHash and is verified byte-exact against retail Morrowind.bsa
# (11078/11078 entries) — see --selftest.
#
# Usage:
#   build-assetpack.py --out play/moddata/openmw-web-assets.bsa --src DIR [--src DIR ...]
#   Later --src wins on conflicting paths (Project Atlas must come after MOP: its meshes are
#   re-authored for atlas UVs and must not be overwritten by MOP's copies of the same files).
import argparse
import os
import struct
import sys


def tes3_hash(name: bytes):
    """Port of Bsa::getHash (components/bsa/bsafile.cpp). `name` is the stored byte string."""
    half = len(name) >> 1
    acc = off = 0
    for i in range(half):
        acc = (acc ^ ((name[i] << (off & 0x1F)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        off += 8
    low = acc
    acc = off = 0
    for i in range(half, len(name)):
        temp = (name[i] << (off & 0x1F)) & 0xFFFFFFFF
        acc ^= temp
        n = temp & 0x1F
        if n:  # rotate right by n; n==0 would be a 32-bit shift (UB in C, no-op intended)
            acc = ((acc << (32 - n)) | (acc >> n)) & 0xFFFFFFFF
        acc &= 0xFFFFFFFF
        off += 8
    return low, acc


def collect(srcs):
    """Walk each source dir in order; later sources override earlier ones on the same path."""
    files = {}   # normalized name -> absolute path on disk
    origin = {}  # normalized name -> which source dir won
    for src in srcs:
        root = os.path.abspath(src)
        if not os.path.isdir(root):
            sys.exit(f"build-assetpack: not a directory: {src}")
        for dirpath, _, names in os.walk(root):
            for n in names:
                if n.startswith("."):
                    continue  # .DS_Store and friends
                full = os.path.join(dirpath, n)
                rel = os.path.relpath(full, root)
                key = rel.replace(os.sep, "\\").lower()
                files[key] = full
                origin[key] = root
    return files, origin


def build(out_path, srcs):
    files, origin = collect(srcs)
    if not files:
        sys.exit("build-assetpack: no input files found")

    entries = []
    for name, path in files.items():
        raw = name.encode("latin1")
        lo, hi = tes3_hash(raw)
        entries.append({"raw": raw, "path": path, "size": os.path.getsize(path), "lo": lo, "hi": hi})
    # The format stores records sorted by hash (writeHeader sorts the same way).
    entries.sort(key=lambda e: (e["lo"], e["hi"]))

    count = len(entries)
    name_block = bytearray()
    for e in entries:
        e["name_off"] = len(name_block)
        name_block += e["raw"] + b"\x00"

    hash_offset = 12 * count + len(name_block)
    data_start = 12 + hash_offset + 8 * count

    off = 0
    for e in entries:
        e["data_off"] = off
        off += e["size"]

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(struct.pack("<III", 0x100, hash_offset, count))
        for e in entries:
            f.write(struct.pack("<II", e["size"], e["data_off"]))
        for e in entries:
            f.write(struct.pack("<I", e["name_off"]))
        f.write(name_block)
        for e in entries:
            f.write(struct.pack("<II", e["lo"], e["hi"]))
        assert f.tell() == data_start, (f.tell(), data_start)
        for e in entries:
            with open(e["path"], "rb") as src:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)

    total = os.path.getsize(out_path)
    per_src = {}
    for name in files:
        per_src[origin[name]] = per_src.get(origin[name], 0) + 1
    print(f"build-assetpack: wrote {out_path}")
    print(f"  files      : {count}")
    print(f"  size       : {total / 1048576:.1f} MB")
    for root, n in per_src.items():
        print(f"  from       : {n:>5} files won by {os.path.basename(root)}")
    return out_path


def verify(path):
    """Read the archive back with an independent parser and check every record resolves."""
    with open(path, "rb") as f:
        ver, hash_offset, count = struct.unpack("<III", f.read(12))
        if ver != 0x100:
            sys.exit(f"verify: bad version 0x{ver:x}")
        recs = f.read(8 * count)
        name_offs = struct.unpack(f"<{count}I", f.read(4 * count))
        name_block = f.read(hash_offset - 12 * count)
        hashes = f.read(8 * count)
        data_start = 12 + hash_offset + 8 * count
        total = os.path.getsize(path)

        bad = 0
        prev = None
        for i in range(count):
            size, rel = struct.unpack_from("<II", recs, i * 8)
            end = name_block.find(b"\x00", name_offs[i])
            raw = name_block[name_offs[i]:end]
            lo, hi = struct.unpack_from("<II", hashes, i * 8)
            if tes3_hash(raw) != (lo, hi):
                bad += 1
            if data_start + rel + size > total:
                bad += 1
            if prev is not None and (lo, hi) < prev:
                bad += 1
            prev = (lo, hi)
        print(f"verify: {count} records, hashes+extents+sort {'OK' if bad == 0 else f'{bad} PROBLEMS'}")
        return bad == 0


def selftest(reference_bsa):
    """Prove the hash matches the engine by re-hashing every name in a real Morrowind.bsa."""
    with open(reference_bsa, "rb") as f:
        ver, hash_offset, count = struct.unpack("<III", f.read(12))
        f.read(8 * count)
        name_offs = struct.unpack(f"<{count}I", f.read(4 * count))
        name_block = f.read(hash_offset - 12 * count)
        hashes = f.read(8 * count)
    ok = 0
    for i in range(count):
        end = name_block.find(b"\x00", name_offs[i])
        raw = name_block[name_offs[i]:end]
        if tes3_hash(raw) == struct.unpack_from("<II", hashes, i * 8):
            ok += 1
    print(f"selftest: hash matches {ok}/{count} entries in {reference_bsa}")
    return ok == count


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Pack directories into a TES3 BSA.")
    ap.add_argument("--out")
    ap.add_argument("--src", action="append", default=[], help="source dir; later wins on conflicts")
    ap.add_argument("--selftest", metavar="MORROWIND_BSA", help="verify the hash against a real BSA")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(0 if selftest(args.selftest) else 1)
    if not args.out or not args.src:
        ap.error("--out and at least one --src are required")
    build(args.out, args.src)
    sys.exit(0 if verify(args.out) else 1)
