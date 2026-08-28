#!/usr/bin/env python3
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# trim-icu-data.py -- cut the ICU data package down to what OpenMW actually reads.
#
# WHY. fsroot/icu/icudt68l.dat is the FULL upstream ICU package: 28.4 MB of the 32 MB
# openmw.data, downloaded, decompressed and then held resident in MEMFS for the life of the tab.
# The engine's entire use of ICU is MessageFormat and its Locale/Calendar plumbing in
# components/l10n, plus icu::Locale::getDisplayLanguage() for the language list in
# mwgui/settingswindow.cpp. The VFS ships six locales (de, en, fr, pl, ru, sv). Everything else in
# that package is downloaded so it can be ignored.
#
# WHY NOT ICU_DATA_FILTER_FILE. That is the upstream way, and it means rebuilding the ICU data
# from source with ICU's own data tooling -- a native ICU build the wasm dep stack does not
# otherwise need. The .dat is a flat TOC archive (udata "CmnD" format), so filtering the built
# package directly is both smaller and reproducible from what the emsdk cache already ships.
#
# FORMAT (little-endian, verified against icudt68l.dat):
#   u16 headerSize | u8 0xda | u8 0x27 | UDataInfo(20B: dataFormat="CmnD") | pad to headerSize
#   then, at headerSize:  u32 count | count x (u32 nameOffset, u32 dataOffset) | names | data
#   Both offsets are relative to headerSize. Data is 16-byte aligned.
#
# Usage:
#   trim-icu-data.py IN.dat OUT.dat [--keep de,en,fr,pl,ru,sv] [--keep-group coll,zone]
#   trim-icu-data.py --selftest
#
# The kept-locale list must match the directories under fsroot/resources/vfs/l10n/. If a locale is
# added there and not here, ICU silently falls back to root and that language's UI reads English --
# so --verify-l10n cross-checks the two and fails rather than shipping a quiet regression.
import argparse
import os
import re
import struct
import sys

MAGIC = b"\xda\x27"
FORMAT = b"CmnD"

# Groups OpenMW never reads. Each is a subdirectory prefix inside the package.
#   coll     locale-aware collation -- the engine sorts with its own comparators
#   brkitr   break iteration (word/line boundaries) -- MyGUI does its own wrapping
#   zone     timezone rules -- Morrowind has no wall clock
#   curr     currency formatting -- gold is an integer
#   unit     measurement unit formatting
#   region   region display names (we show LANGUAGE names, which live under lang/)
#   translit transliteration
#   rbnf     rule-based number formatting (spellout: "twenty-three")
DROP_GROUPS_DEFAULT = ["coll", "brkitr", "zone", "curr", "unit", "region", "translit", "rbnf"]

# A locale-shaped resource stem: ll, ll_RR, ll_Ssss, ll_Ssss_RR, plus the 3-letter forms.
LOCALE_STEM = re.compile(r"^[a-z]{2,3}(_[A-Z][a-z]{3})?(_([A-Z]{2}|\d{3}))?$")


def parse(data):
    """-> (header_bytes, [(name, offset, size)]) with offsets relative to end of header."""
    if data[2:4] != MAGIC:
        raise SystemExit("not an ICU .dat: bad magic %r" % data[2:4])
    hdr_size = struct.unpack_from("<H", data, 0)[0]
    if data[12:16] != FORMAT:
        raise SystemExit("not a packaged ICU archive: dataFormat=%r" % data[12:16])
    body = data[hdr_size:]
    count = struct.unpack_from("<I", body, 0)[0]
    toc = []
    for i in range(count):
        n_off, d_off = struct.unpack_from("<II", body, 4 + i * 8)
        end = body.index(b"\0", n_off)
        toc.append((body[n_off:end].decode("ascii"), d_off))
    # Sizes come from the gap to the next entry in DATA order, not TOC order.
    by_off = sorted(toc, key=lambda e: e[1])
    size = {}
    for i, (name, off) in enumerate(by_off):
        nxt = by_off[i + 1][1] if i + 1 < len(by_off) else len(body)
        size[name] = nxt - off
    return data[:hdr_size], [(n, o, size[n]) for n, o in toc], body


def wanted(name, keep_locales, drop_groups):
    """name looks like 'icudt68l/de.res' or 'icudt68l/coll/de.res'."""
    parts = name.split("/")
    if len(parts) >= 3:
        group = parts[1]
        if group in drop_groups:
            return False
        stem = os.path.splitext(parts[-1])[0]
        # Inside a kept group (e.g. lang/), keep only our locales plus root.
        return stem in keep_locales or stem == "root"
    # Legacy charset converters (EBCDIC, GB18030, EUC-TW, Shift-JIS variants...). These are the
    # single largest remaining block after the locale trees, and nothing reaches them: the engine
    # calls no ucnv_* API anywhere, and Morrowind's Windows-1252/cp437 ESM text is decoded by
    # OpenMW's own tables in esm3/esmreader, not by ICU.
    if name.endswith(".cnv"):
        return False

    stem = os.path.splitext(parts[-1])[0]
    if LOCALE_STEM.match(stem):
        return stem in keep_locales or stem == "root"
    # Not locale-shaped: shared machinery (supplementalData, plurals, numberingSystems,
    # likelySubtags, pnames/uprops/ucase/unames, the .nrm normalisation tables...). Keep all of
    # it -- it is small relative to the locale trees and getting it wrong is a null-data crash.
    return True


def build(header, entries, body):
    """entries: [(name, old_off, size)] -> new package bytes."""
    names = b"".join(n.encode("ascii") + b"\0" for n, _, _ in entries)
    toc_size = 4 + len(entries) * 8
    names_start = toc_size
    data_start = (names_start + len(names) + 15) & ~15
    out = bytearray()
    out += struct.pack("<I", len(entries))
    blobs = bytearray()
    n_off = names_start
    offs = []
    for name, old_off, size in entries:
        d_off = data_start + len(blobs)
        offs.append((n_off, d_off))
        n_off += len(name) + 1
        blobs += body[old_off:old_off + size]
        while len(blobs) % 16:            # keep 16-byte alignment between items
            blobs += b"\0"
    for n_o, d_o in offs:
        out += struct.pack("<II", n_o, d_o)
    out += names
    while len(out) < data_start:
        out += b"\0"
    out += blobs
    return bytes(header) + bytes(out)


def selftest():
    """Round-trip the parser against a synthetic package: build one, parse it, compare."""
    header = struct.pack("<H", 32) + MAGIC + struct.pack("<H", 20) + b"\0" * 2 \
        + b"\0\0\0\0" + FORMAT + bytes([1, 0, 0, 0]) + b"\0" * 4
    header += b"\0" * (32 - len(header))
    items = [("icudt68l/en.res", b"ENGLISH-DATA"), ("icudt68l/coll/en.res", b"COLL"),
             ("icudt68l/supplementalData.res", b"SUPP")]
    body_blobs = bytearray(); ents = []
    for n, blob in items:
        ents.append((n, len(body_blobs), len(blob)))
        body_blobs += blob
        while len(body_blobs) % 16:
            body_blobs += b"\0"
    pkg = build(header, ents, bytes(body_blobs))
    _, toc, body = parse(pkg)
    got = {n: body[o:o + s].rstrip(b"\0") for n, o, s in toc}
    assert got["icudt68l/en.res"] == b"ENGLISH-DATA", got
    assert got["icudt68l/supplementalData.res"] == b"SUPP", got
    keep = {"en"}
    assert wanted("icudt68l/en.res", keep, DROP_GROUPS_DEFAULT)
    assert not wanted("icudt68l/de.res", keep, DROP_GROUPS_DEFAULT)
    assert not wanted("icudt68l/coll/en.res", keep, DROP_GROUPS_DEFAULT)   # dropped group
    assert wanted("icudt68l/lang/en.res", keep, ["coll"])                  # kept group, kept locale
    assert not wanted("icudt68l/lang/zh.res", keep, ["coll"])              # kept group, other locale
    assert wanted("icudt68l/supplementalData.res", keep, DROP_GROUPS_DEFAULT)  # shared: always
    assert wanted("icudt68l/pnames.icu", keep, DROP_GROUPS_DEFAULT)            # shared: always
    assert not wanted("icudt68l/gb18030.cnv", keep, DROP_GROUPS_DEFAULT)       # converter: unused
    assert wanted("icudt68l/root.res", keep, DROP_GROUPS_DEFAULT)              # fallback: always
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?")
    ap.add_argument("dst", nargs="?")
    ap.add_argument("--keep", default="de,en,fr,pl,ru,sv")
    ap.add_argument("--keep-group", default="", help="comma list of groups NOT to drop")
    ap.add_argument("--verify-l10n", metavar="DIR",
                    help="fail unless --keep covers every locale under this l10n dir")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.src or not a.dst:
        ap.error("need SRC and DST")

    keep = set(x for x in a.keep.split(",") if x)
    drop = [g for g in DROP_GROUPS_DEFAULT if g not in set(a.keep_group.split(","))]

    if a.verify_l10n:
        shipped = set()
        for root, _dirs, files in os.walk(a.verify_l10n):
            for f in files:
                if f.endswith((".yaml", ".yml")):
                    shipped.add(os.path.splitext(f)[0])
        missing = {s for s in shipped if s not in keep and s != "gmst"}
        if missing:
            raise SystemExit(
                "ICU trim would drop locales the VFS actually ships: %s\n"
                "Add them to --keep, or that language's UI silently falls back to English."
                % ", ".join(sorted(missing)))

    data = open(a.src, "rb").read()
    header, toc, body = parse(data)
    kept = [(n, o, s) for n, o, s in toc if wanted(n, keep, drop)]
    out = build(header, kept, body)
    open(a.dst, "wb").write(out)

    before, after = len(data), len(out)
    print("icu trim: %d -> %d entries, %.1f MB -> %.1f MB (%.0f%% smaller)"
          % (len(toc), len(kept), before / 1e6, after / 1e6, 100 * (1 - after / before)))
    # Re-parse what we wrote: a package ICU cannot read is a null-data crash in SettingsWindow,
    # which is exactly the failure this data caused once before.
    h2, toc2, _ = parse(open(a.dst, "rb").read())
    assert len(toc2) == len(kept), "re-parse found %d entries, wrote %d" % (len(toc2), len(kept))
    assert h2 == header, "header changed"
    print("icu trim: output re-parses cleanly (%d entries)" % len(toc2))


if __name__ == "__main__":
    main()
