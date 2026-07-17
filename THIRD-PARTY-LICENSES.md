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

## Game data

No Morrowind game data is included or distributed here. *The Elder Scrolls* and
*Morrowind* are trademarks of ZeniMax Media / Bethesda Softworks; this project is
not affiliated with or endorsed by them. See [`LICENSE`](LICENSE) and the README
for details.
