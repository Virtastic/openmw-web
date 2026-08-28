# Why there is no gamecontrollerdb.txt here

SDL only applies a mapping whose `platform:` field matches `SDL_GetPlatform()`
(`SDL_GameControllerAddMappingsFromRW`, SDL 2.32.10 `src/joystick/SDL_gamecontroller.c:1555`:
`SDL_strncasecmp(line_platform, platform, platform_len) == 0 && SDL_GameControllerAddMapping(line)`).

On this build `SDL_GetPlatform()` returns **"Emscripten"** (`src/SDL.c:588`). The upstream database
carries 844 `Windows`, 695 `Linux`, 307 `Mac OS X`, 296 `Android` and 40 `iOS` entries, and **zero**
`Emscripten` entries -- so every one of its 2194 mappings was rejected at load. The file was
downloaded, preloaded into MEMFS and parsed on every visit purely to be thrown away: 586 KB of
`openmw.data` for nothing.

Gamepads still work. SDL's Emscripten joystick backend maps through the browser Gamepad API's
standard mapping, which does not consult this database at all.

`engine.cpp` handles absence explicitly -- "else if it doesn't exist, pass in an empty path" -- so
nothing needs a fallback here.

If a device ever does need a hand-written mapping on the web, add a small file with
`platform:Emscripten` entries rather than restoring the upstream 586 KB dump.

Note this is a **web-only** removal: the native sim peer (`server/Dockerfile.simpeer`) builds from
`openmw/` and gets its own copy through the normal CMake install rules, unaffected.
