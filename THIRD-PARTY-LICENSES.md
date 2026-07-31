# Third-party licenses

openmw-web is licensed under the GNU GPL v3 (see [`LICENSE`](LICENSE)). It builds
on a number of third-party projects, each of which keeps its own license. This
file is an informational summary; the authoritative terms for each component are
in that project's own source tree / license file. License names below are the
ones each project commonly ships under and may vary by version or build
configuration.

## Engine

| Component | Commonly licensed under | Source |
|-----------|-------------------------|--------|
| OpenMW (the engine this project is based on) | GPL-3.0-or-later | https://github.com/OpenMW/openmw |

The `openmw/` tree, the WASM build changes, and everything else in this
repository (`play/`, `wasm-build/`, `fsroot/` config, scripts) are GPLv3.

## Bundled / linked dependencies

These are cross-compiled into the WebAssembly build (statically linked) or
provided by Emscripten at link time. None of their source is redistributed in
this repo; they are fetched/built locally (see the README).

| Dependency | Commonly licensed under | Source |
|------------|-------------------------|--------|
| OpenSceneGraph (OSG) 3.6.5 | OSGPL (LGPL-2.1-based, with wxWidgets-style exceptions) | https://github.com/openscenegraph/OpenSceneGraph |
| Bullet Physics | zlib | https://github.com/bulletphysics/bullet3 |
| MyGUI | MIT | https://github.com/MyGUI/mygui |
| FFmpeg 5 (bink/binkaudio decoders) | LGPL-2.1-or-later (as configured) | https://ffmpeg.org/ |
| Boost (program_options, iostreams) | Boost Software License 1.0 | https://www.boost.org/ |
| Lua 5.4 | MIT | https://www.lua.org/ |
| LZ4 | BSD-2-Clause | https://github.com/lz4/lz4 |
| RecastNavigation | zlib | https://github.com/recastnavigation/recastnavigation |
| SDL2 | zlib | https://www.libsdl.org/ |
| FreeType | FTL or GPL-2.0 (dual) | https://freetype.org/ |
| HarfBuzz | MIT (Old MIT) | https://github.com/harfbuzz/harfbuzz |
| libpng | libpng (PNG Reference Library License) | http://www.libpng.org/ |
| libjpeg | IJG | https://www.ijg.org/ |
| zlib | zlib | https://zlib.net/ |
| libogg / libvorbis | BSD-3-Clause (Xiph.Org) | https://xiph.org/ |
| mpg123 | LGPL-2.1 | https://www.mpg123.de/ |
| ICU | Unicode License (ICU) | https://icu.unicode.org/ |
| OpenAL (Emscripten's Web Audio implementation) | Part of Emscripten (MIT / University of Illinois NCSA) | https://emscripten.org/ |
| Emscripten ports & runtime | MIT / University of Illinois NCSA | https://emscripten.org/ |

## Performance asset pack

`moddata/openmw-web-assets.bsa` bundles two community mods that optimise the
game's meshes and textures. Both are used with credit, as their authors ask.
They are **not** part of the GPLv3 engine — they carry their own terms, listed
below — and they do nothing unless you supply your own copy of Morrowind.

| Mod | Authors | Source |
|---|---|---|
| Morrowind Optimization Patch | Axeljk, Borok, Daemacht, Endoran, Greatness7, Half11, Hemaris, Lamb Shark, Melchior Dahrk, Nich, Remiros, Revenorror, Sophie, Stele, Vegetto | https://www.nexusmods.com/morrowind/mods/45384 |
| Project Atlas | Melchior Dahrk and the Project Atlas team | https://www.nexusmods.com/morrowind/mods/45399 |

The archive contains only the modules needed for the optimisation: MOP's `00
Core`, and Project Atlas's `00 Core` plus its vanilla-resolution atlases.
Rebuild it from the upstream downloads with
[`wasm-build/build-assetpack.py`](wasm-build/build-assetpack.py).

## Game data

No Morrowind game data is included or distributed here — the asset pack above
replaces meshes in a copy of the game you already own, and is useless without
it. *The Elder Scrolls* and *Morrowind* are trademarks of ZeniMax Media /
Bethesda Softworks; this project is not affiliated with or endorsed by them.
See [`LICENSE`](LICENSE) and the README for details.
