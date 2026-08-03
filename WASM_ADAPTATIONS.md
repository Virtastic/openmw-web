# WASM Adaptations

How a desktop C++ game engine was made to run inside a browser tab.

OpenMW is a native, multi-threaded, OpenGL application built around the assumption that it owns
the machine: it blocks on a main loop, spawns threads freely, talks to a desktop GL driver, and
reads files off a real disk. A browser grants none of that. This document catalogues every place
the engine had to diverge for the WebAssembly/WebGL2 target, and — more importantly — *why*. Every
divergence is guarded by `#ifdef __EMSCRIPTEN__` (C++) or `#if @useGLES` (GLSL); the desktop code
path is left byte-for-byte intact.

Target: **desktop Chrome / Chromium** (WebGL2 via ANGLE, SharedArrayBuffer, cross-origin isolation).

---

## 1. Rendering — desktop GL → WebGL2 / GLES 3.0

WebGL2 is GLES 3.0. OpenMW's renderer (OpenSceneGraph) and its "compatibility" shaders assume
desktop OpenGL with a fixed-function pipeline. Bridging that gap was the largest single effort.

### The GLES shader port
OpenMW's shaders are GLSL 1.20 with fixed-function built-ins (`gl_Vertex`, `gl_ModelViewMatrix`,
`gl_FrontMaterial`, `gl_Fog`, `gl_TextureMatrix`, `gl_ClipVertex`, `gl_FragData`). None of those
exist in GLES 3.0. `components/shader/shadermanager.cpp` gained an `adjustSourceForGLES` transform
that rewrites each shader to `#version 300 es`: fixed-function attributes/uniforms become generic
(`osg_Vertex`, `osg_ModelViewProjectionMatrix`, …) using OSG's attribute aliasing
(`setUseVertexAttributeAliasing`/`setUseModelViewAndProjectionUniforms`, enabled in
`apps/openmw/engine.cpp`), `texture2D`→`texture`, `varying`→`in`/`out`, `gl_FragData[n]`→declared
`layout(location=n) out`, and precision qualifiers injected.

### One shader per stage (the merge)
WebGL permits exactly **one** vertex and one fragment shader object per program, but OpenMW composes
each stage from several `$link`ed sub-shaders (e.g. `objects.vert` + `lighting_vertex.glsl`). On the
web these are inlined into a single translation unit before compilation, then a GLSL-aware dedup
pass removes duplicate top-level declarations pulled in through shared includes.

### Fixed-function material, fog and lighting → flat uniforms
There is no fixed-function state to read on GLES, and — critically — **struct-member uniforms
(`osg_FrontMaterial.diffuse`) silently read as zero on ANGLE**. Material and fog state are therefore
flattened to plain uniforms (`osg_FrontMaterial_diffuse`, `osg_Fog_color`, …) and fed every frame:
material from `components/shader/shadervisitor.cpp`, fog from `components/sceneutil/stateupdater.cpp`,
and animated material controllers from `components/nifosg/controller.cpp`. Without this the sky,
smoke, and unlit geometry rendered black.

### Actor skinning (CPU) and vertex morphing
Actors are skinned on the CPU (`components/sceneutil/riggeometry.cpp`), which rewrites every vertex
each frame into a dedicated per-array VBO. This works correctly on WebGL2 and holds 60fps. (An
optional GPU vertex-shader skinning path was prototyped but **reverted** — it reshuffled the
post-processor/opaque-depth texture-unit reservation and regressed scene rendering; see the
"Revert GPU vertex-shader skinning" commit. `riggeometry.cpp` is back to the stock CPU path.)

Vertex **morphing** (`components/sceneutil/morphgeometry.cpp`, driven by a `NiGeomMorpherController`
— used by NPC/player heads for blink/talk facial animation) is **disabled** on the web
(`components/nifosg/nifloader.cpp`, `#ifdef __EMSCRIPTEN__`): the mesh renders as its static source
geometry instead of being wrapped in a `MorphGeometry`. `MorphGeometry` rewrites its vertex VBO every
frame across two double-buffered `osg::Geometry` copies, and under WebGL2/ANGLE with forced VAOs that
per-frame re-upload does not reach the GPU correctly — the head rendered as a collapsed cone even
though the CPU-side vertices were provably correct (unlike CPU skinning, `MorphGeometry` gives only
its position array a dedicated VBO). The morph targets are tiny eyelid/mouth deltas held at weight 0
most of the time, so the only visible cost is the loss of subtle facial blink/talk; the head shape is
correct.

### Water reflection/refraction clipping without clip planes
GLES has no `gl_ClipVertex` / user clip planes. The water reflection/refraction RTT cameras emulate
the clip plane with a world-space `clipPlane` uniform published from `apps/openmw/mwrender/water.cpp`
and a fragment `discard` in the scene shaders (`#if @useGLES`). The main camera pass must NOT clip —
but a GLSL uniform is not per-pass state: if the main pass left `clipPlane` unset it would keep the
stale value last written by a water RTT camera and discard all above-water geometry (only sky + water
+ the shoreline base draw). So a neutral `clipPlane = vec4(0)` is published on `mRootNode`
(`apps/openmw/mwrender/renderingmanager.cpp`, `#ifdef __EMSCRIPTEN__`): the main pass inherits it
(`dot()+w == 0` → nothing discarded) while the RTT cameras — descendants of `mRootNode` — override it
with their real per-frame plane, so reflection/refraction clipping still works.

### WebGL2-legal framebuffer & texture formats
WebGL2 is stricter than desktop GL about renderable formats. Several OSG defaults had to be made
sized/explicit:
- **Unsized `GL_RGB` is not color-renderable** → RTT color attachments use `GL_RGBA8`
  (`components/terrain/chunkmanager.cpp`, `components/sceneutil/color.cpp`).
- **Unsized depth is rejected** → depth/shadow buffers use `GL_DEPTH32F_STENCIL8` /
  `GL_DEPTH_COMPONENT32F` with explicit source format+type (`components/sceneutil/depth.cpp`,
  `components/sceneutil/mwshadowtechnique.cpp`).
- **`GL_BGRA` GUI textures** are not an accepted upload format → channels are swapped to RGB in
  `components/resource/imagemanager.cpp` (otherwise menus render black).
- **`glGenerateMipmap` on compressed (DXT/S3TC) textures raises `GL_INVALID_OPERATION`** → guarded on
  every path, including FBO attachments (`deps/src/osg/.../Texture.cpp`, `FrameBufferObject.cpp`).
- **No `GL_QUADS`** → water is emitted as triangles (`components/sceneutil/waterutil.cpp`).

### MyGUI without client-side arrays
GLES has no fixed-function vertex arrays or client-side vertex data. The MyGUI render backend
(`components/myguiplatform/myguirendermanager.cpp`) resolves OSG's attribute-alias locations at
runtime and feeds all GUI geometry through VBOs + `glVertexAttribPointer`.

### Stable shadows
The desktop shadow basis is derived from the view frustum and shimmers as the camera yaws. The web
build uses a fixed world-up basis with texel snapping (`components/sceneutil/mwshadowtechnique.cpp`)
— a small quality win that also sidesteps per-frame shadow instability.

### Capability detection & extension bridges
WebGL2 exposes many features that OSG probes for under desktop-GL extension-string names it never
finds. Rather than lose them, the OSG patch (`deps/src/osg/src/osg/GLExtensions.cpp`) force-enables
the core-in-WebGL2 capabilities and bridges the extension entry points via `EM_ASM`:
- **S3TC/DXT compression** — force-enabled so DXT textures upload *compressed*
  (`glCompressedTexImage2D`) instead of being CPU-decompressed to RGBA. ~4× less texture memory and
  bandwidth, and no per-texture decompress at load.
- **Depth-texture compare** (`sampler2DShadow`) — core in WebGL2 but exposes no `GL_ARB_shadow`
  string; force-enabled or every shadow lookup would be dropped.
- **VBOs + VAOs** — force-enabled together. A VAO replays a draw's attribute bindings in one call
  instead of N, cutting the JS↔wasm↔ANGLE round-trips that dominate WebGL per-draw CPU cost. (Both
  must be forced: a WebGL2 VAO can only reference buffer-backed attributes.)
- **Reverse-Z depth** — `EXT_clip_control` (Chrome 119+) is probed and its `clipControlEXT` entry
  point bridged, so the web build *does* run a reverse-Z depth buffer (better precision), confirmed
  by the boot log "Using reverse-z depth buffer".
- **Indexed draw buffers** (`glEnablei`/`glColorMaski`) — bridged from `OES_draw_buffers_indexed`
  for MRT per-attachment state.

### Odds and ends
`GL_QUADS` is gone in GLES, so the sky sun/moons draw as a `TRIANGLE_FAN`
(`apps/openmw/mwrender/skyutil.cpp`) and water as indexed triangles. Several per-frame
`glBlitFramebuffer` depth-copy dances (opaque-depth, first-person viewmodel) raise
`GL_INVALID_OPERATION` on ANGLE and are skipped (`apps/openmw/mwrender/transparentpass.cpp`,
`npcanimation.cpp`) — at worst the viewmodel can clip into very close geometry, far preferable to
per-frame GL errors.

---

## 2. Runtime — the browser owns the event loop

A native app calls `while (running) { frame(); }`. In a browser that would freeze the tab forever:
the page must return control to the event loop every frame.

- **Cooperative main loop.** `apps/openmw/engine.cpp` replaces the blocking loop with a
  `requestAnimationFrame`-paced pump (a `MessageChannel` driver + `emscripten_set_main_loop`). Frame
  pacing is handled there, so `components/misc/frameratelimiter.hpp` never calls `sleep_for` on the
  web (blocking the main thread trips the browser's "blocked main thread" warning and stalls audio).
- **The deliberately-leaked engine.** Emscripten's `simulate_infinite_loop` unwinds the C++ stack
  while the game keeps running from callbacks. `apps/openmw/main.cpp` therefore calls
  `engine.release()->go()` on the web so the `Engine` object outlives the unwind; its destructor
  would otherwise join worker threads on the main thread and deadlock. This is the correct pattern
  under Emscripten, not a leak in the usual sense — the runtime never exits (`EXIT_RUNTIME=0`).
- **Cooperative video.** Bink intro/menu videos can't run a nested blocking decode loop
  (`extern/osg-ffmpeg-videoplayer/`); frames are pumped from the main loop, and the GUI video widget
  (`apps/openmw/mwgui/videowidget.cpp`) re-binds its texture when the player swaps clips so a
  menu→intro transition doesn't leave a frozen first frame on screen.
- **Clean quit.** On quit the engine flushes `FS.syncfs`, notifies the JS harness
  (`window.__omwOnQuit`), and cancels the main loop (`apps/openmw/engine.cpp`).

---

## 3. Threading — one GL thread, careful partitioning

WebGL contexts have thread affinity, and OSG's default `DrawThreadPerContext` proxies GL calls to a
thread that doesn't exist under Emscripten, aborting at startup. The viewer is forced to
`SingleThreaded` (`apps/openmw/engine.cpp`), which makes the main thread the GL thread and dictates
everything else:

- **WorkQueue** (`components/sceneutil/workqueue.cpp`) runs a small pool of real worker threads that
  do **CPU-only** asset prep (NIF parsing, collision build). GL object compilation is handed to the
  main thread via OSG's `IncrementalCompileOperation`, whose budget is raised hard on the web
  (`apps/openmw/mwrender/renderingmanager.cpp`) so geometry entering the frustum on a camera turn
  compiles in-frame instead of popping in.
- **Lua** runs inline on the main thread (`apps/openmw/mwlua/worker.cpp`): with a single Lua thread
  the main thread would `condition_variable::wait` on the worker *every frame*, pure added latency in
  a main-thread-bound build.
- **Physics** uses one exclusive-locked async thread (`apps/openmw/mwphysics/mtphysics.cpp`); Bullet
  is built without `BT_THREADSAFE`, which is the right configuration at one worker.
- **Navmesh** uses the real DetourNavigator with a single background updater thread and the SQLite
  disk cache disabled (`apps/openmw/mwworld/worldimp.cpp`) — the cache's writer thread would proxy
  filesystem writes back to the main thread and starve it. The main thread never waits on navmesh
  generation.
- **Synchronous world load.** Cell data loads inline rather than via `std::async`
  (`apps/openmw/engine.cpp`); spinning on a future would deadlock against worker→main GL proxying.

The pthread pool (`PTHREAD_POOL_SIZE=8`) requires `SharedArrayBuffer`, which is why the page must be
cross-origin isolated (see §6).

---

## 4. Audio — OpenAL EFX over Web Audio

Emscripten's OpenAL is a Web Audio reimplementation with no `ALC_EXT_EFX` (environmental reverb and
filtering). `apps/openmw/mwsound/openaloutput.cpp` bridges the gap with an `EM_JS` shim that reaches
each source's Web Audio node graph directly and implements the effects natively: `AL_FILTER_LOWPASS`
→ `BiquadFilterNode` (the muffled/underwater sound), `AL_EFFECT_EAXREVERB` → `ConvolverNode` with a
synthesized impulse response from the reverb's RT60 decay. HRTF binaural panning is enabled by
default.

---

## 5. Filesystem, assets & persistence — ~800 MB with no disk

The engine reads game data as if from a local disk; the browser has none. Data is presented through
Emscripten's virtual filesystem and persisted in browser storage:

- **Engine resources** (shaders, ICU data, config) are preloaded into MEMFS in `openmw.data`.
- **Game data** (`.esm`, `.bsa`, audio/voice) is fetched on first run, cached in the **Cache API**,
  and mounted. The large BSA archives can be **lazily range-read** (`play/streamfs.js`) instead of
  copied into memory, keeping peak RAM bounded.
- **Bring your own Morrowind** — the launcher (`play/launcher.html`) can read a legally-owned
  `Data Files` folder straight off the user's disk via the **File System Access API**, streaming
  records on demand with no multi-gigabyte upload.
- **Settings, keybindings and (by default) saves** live in **IDBFS** (backed by IndexedDB) and survive
  reloads. Settings and Lua storage call `FS.syncfs` immediately on write
  (`components/settings/settings.cpp`, `apps/openmw/mwlua/luamanagerimp.cpp`) so a crash or tab close
  right after saving can't lose data — the periodic timer-based sync is only a backstop.
- **Bring-your-own saves go to disk.** When the player grants read-write access to their `Data Files`
  folder, `play/index.html` mirrors the save directory to an `openmw-web-saves` subfolder in that folder
  via the File System Access API, so saves are real files that survive clearing browser data (like
  desktop OpenMW). If the folder is read-only for the session it transparently falls back to IDBFS.

---

## 6. Build & toolchain

- **Emscripten 6.0.1**, WebGL2 forced (`MIN_WEBGL_VERSION=2 MAX_WEBGL_VERSION=2 FULL_ES3=1`).
- **Exceptions:** `-fwasm-exceptions` (legacy wasm EH) — OpenMW relies on exceptions crossing OSG
  frames. `-flto` is **not** used: it crashes/miscompiles the boot path in wasm-ld on this stack.
- **Threads:** `-pthread -sPTHREAD_POOL_SIZE=8` with `SharedArrayBuffer`, which requires the page to
  be **cross-origin isolated** (`Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp`; `play/server.py` sets these).
- **Memory:** `-sALLOW_MEMORY_GROWTH=1` over a tuned `INITIAL_MEMORY`, `-sMALLOC=mimalloc`.
- **The link is scripted out-of-band** (`wasm-build/link-openmw.sh`) because the final link needs
  runtime flags (preloaded FS, pthread pool, WebGL2) that break CMake's configure-time checks.
  `configure-openmw.sh` mirrors the memory/assertions flags only for CMake's own test executables.
- **Delivery:** artifacts are brotli-precompressed (`.br`); the ~42 MB wasm ships as ~11 MB on the
  wire. All hand-built dependencies are compiled `-pthread`; OSG's WebGL2 fixes live in
  `wasm-build/patches/osg-emscripten.patch`.

---

## 7. Known limitations

Honest boundaries of the port. None are correctness bugs; each is a documented trade-off.

- **Water reflections can't be hardware-antialiased.** The reflection render target is single-sampled:
  WebGL2 has no multisample *textures*, and the alpha-to-coverage MSAA-intermediate path only smooths
  alpha-test edges, not the opaque reflected geometry. So reflected shoreline/pillar edges alias into a
  faint stair-step. Mitigated with a small multi-tap blur on the reflection sample in `water.frag`
  (Emscripten-only). A true fix needs a bespoke multisample-renderbuffer resolve wired to the reflection
  camera like the main scene has.
- **Clustered lighting is unavailable** — it requires GLSL 430 SSBOs, which WebGL2 (GLSL ES 3.00) has no
  equivalent for. The engine detects this and falls back to the per-object-uniform shader light path, which
  is what the web build uses (per-pixel, unclamped falloff, up to `max lights` per object).
- **RTT color buffers are RGBA8** where desktop uses RGB (a few bytes/pixel more, no visual change) —
  WebGL2 rejects unsized RGB as a color-renderable FBO attachment.
- **Desktop Chrome / Chromium only.** Several workarounds are gated specifically to Chrome's ANGLE
  behavior; Firefox and Safari are untested. Mobile/touch is out of scope (no on-screen controls).

**Resolved since earlier drafts** (were limitations, now working):

- **Hardware MSAA works** (`?aa=N`, off by default). Two stacked OSG-on-GLES resolve bugs in
  `RenderStage.cpp` were patched — a compiled-out per-attachment resolve blit (COLOR_BUFFER0 folded into
  the main color-only blit; WebGL2 rejects MSAA depth resolve) and a null `ext->glBlitFramebuffer` (the raw
  WebGL2 symbol is called directly). Verified antialiased at `?aa=4`. SSAA (`?ss=N`) is also available.
- **Facial blink/talk animation is re-enabled.** `MorphGeometry`'s per-frame VBO rewrite was mis-uploading
  under ANGLE (heads rendered as a cone); the fix puts all morph arrays on one dedicated VBO like
  `RigGeometry`. Faces animate normally.
- **Post-processing works and ships on by default** (curated colour-grade + bloom-capable chain), with a
  working Options → Video → Gamma slider driving brightness.
- **Shadows are stable** — a single high-res (16384) cascade eliminated the cascade-transition "swim";
  world-locked texel grid, no crawl on movement.

---

## Modified upstream files (GPLv3 §5(a) manifest)

Files changed from upstream OpenMW base `bc1d9c97a3881bb961a0b74e6e49bbba772b86a1` as of 2026-07-13. Each carries a "Modified by Virtastic" notice.

New (non-upstream) additions, not listed below: `openmw/apps/openmw/mwmp/` (omw-mp/1
multiplayer client transport — WebSocket wrapper, NetManager, `openmw.mp` Lua package) and
`openmw/files/data/mp.omwscripts` + `openmw/files/data/scripts/mp/` (the multiplayer Lua
scripts; mirrored into `fsroot/resources/vfs/` for the web preload).

`mwmp/luabindings.cpp` calls into unmodified upstream engine interfaces where multiplayer
needs a surface vanilla Lua does not expose; no upstream file is patched for these:
`MechanicsManager::setPlayerRace/setPlayerClass/resurrect/countDeaths/setDeaths` (M2/M4),
`WindowManager::executeInConsole` (M8 `ConsoleCommand`) and
`WindowManager::addVisitedLocation` (M7 `WorldMapExplored`).

- `openmw/CMakeLists.txt`
- `openmw/apps/openmw/CMakeLists.txt` — add_openmw_dir(mwmp …)
- `openmw/apps/openmw/engine.cpp`
- `openmw/apps/openmw/main.cpp`
- `openmw/apps/openmw/mwgui/charactercreation.cpp`
- `openmw/apps/openmw/mwgui/mainmenu.cpp`
- `openmw/apps/openmw/mwgui/mainmenu.hpp`
- `openmw/apps/openmw/mwgui/settingswindow.cpp`
- `openmw/apps/openmw/mwgui/settingswindow.hpp`
- `openmw/apps/openmw/mwgui/videowidget.cpp`
- `openmw/apps/openmw/mwgui/videowidget.hpp`
- `openmw/apps/openmw/mwgui/windowmanagerimp.cpp`
- `openmw/apps/openmw/mwgui/windowmanagerimp.hpp`
- `openmw/apps/openmw/mwlua/luabindings.cpp` — register the `openmw.mp` package
- `openmw/apps/openmw/mwlua/luamanagerimp.cpp`
- `openmw/apps/openmw/mwlua/worker.cpp`
- `openmw/apps/openmw/mwmechanics/pathfinding.cpp`
- `openmw/apps/openmw/mwphysics/mtphysics.cpp`
- `openmw/apps/openmw/mwrender/animation.cpp`
- `openmw/apps/openmw/mwrender/camera.cpp`
- `openmw/apps/openmw/mwrender/characterpreview.cpp`
- `openmw/apps/openmw/mwrender/globalmap.cpp`
- `openmw/apps/openmw/mwrender/localmap.cpp`
- `openmw/apps/openmw/mwrender/npcanimation.cpp`
- `openmw/apps/openmw/mwrender/objects.cpp`
- `openmw/apps/openmw/mwrender/pingpongcanvas.cpp`
- `openmw/apps/openmw/mwrender/postprocessor.cpp`
- `openmw/apps/openmw/mwrender/postprocessor.hpp`
- `openmw/apps/openmw/mwrender/renderingmanager.cpp`
- `openmw/apps/openmw/mwrender/ripples.cpp`
- `openmw/apps/openmw/mwrender/screenshotmanager.cpp`
- `openmw/apps/openmw/mwrender/sky.cpp`
- `openmw/apps/openmw/mwrender/skyutil.cpp`
- `openmw/apps/openmw/mwrender/transparentpass.cpp`
- `openmw/apps/openmw/mwrender/water.cpp`
- `openmw/apps/openmw/mwsound/openaloutput.cpp`
- `openmw/apps/openmw/mwsound/soundmanagerimp.cpp`
- `openmw/apps/openmw/mwsound/soundmanagerimp.hpp`
- `openmw/apps/openmw/mwstate/statemanagerimp.cpp`
- `openmw/apps/openmw/mwworld/globals.cpp`
- `openmw/apps/openmw/mwworld/globals.hpp`
- `openmw/apps/openmw/mwworld/scene.cpp`
- `openmw/apps/openmw/mwworld/worldimp.cpp`
- `openmw/cmake/CheckBulletPrecision.cmake`
- `openmw/components/CMakeLists.txt`
- `openmw/components/crashcatcher/crashcatcher.hpp`
- `openmw/components/debug/debugging.cpp`
- `openmw/components/debug/debuglog.cpp`
- `openmw/components/detournavigator/asyncnavmeshupdater.cpp`
- `openmw/components/detournavigator/asyncnavmeshupdater.hpp`
- `openmw/components/detournavigator/navmeshmanager.cpp`
- `openmw/components/esm3/cellref.cpp`
- `openmw/components/files/configurationmanager.cpp`
- `openmw/components/files/fixedpath.hpp`
- `openmw/components/files/linuxpath.cpp`
- `openmw/components/files/linuxpath.hpp`
- `openmw/components/fx/pass.cpp`
- `openmw/components/fx/stateupdater.cpp`
- `openmw/components/fx/stateupdater.hpp`
- `openmw/components/fx/technique.cpp`
- `openmw/components/misc/frameratelimiter.hpp`
- `openmw/components/misc/thread.cpp`
- `openmw/components/myguiplatform/myguirendermanager.cpp`
- `openmw/components/myguiplatform/myguirendermanager.hpp`
- `openmw/components/nifosg/controller.cpp`
- `openmw/components/nifosg/nifloader.cpp`
- `openmw/components/resource/imagemanager.cpp`
- `openmw/components/sceneutil/color.cpp`
- `openmw/components/sceneutil/depth.cpp`
- `openmw/components/sceneutil/lightmanager.cpp`
- `openmw/components/sceneutil/morphgeometry.cpp`
- `openmw/components/sceneutil/mwshadowtechnique.cpp`
- `openmw/components/sceneutil/mwshadowtechnique.hpp`
- `openmw/components/sceneutil/screencapture.cpp`
- `openmw/components/sceneutil/shadow.cpp`
- `openmw/components/sceneutil/stateupdater.cpp`
- `openmw/components/sceneutil/waterutil.cpp`
- `openmw/components/sceneutil/workqueue.cpp`
- `openmw/components/sdlutil/sdlinputwrapper.cpp`
- `openmw/components/sdlutil/sdlvideowrapper.cpp`
- `openmw/components/settings/settings.cpp`
- `openmw/components/shader/shadermanager.cpp`
- `openmw/components/shader/shadermanager.hpp`
- `openmw/components/shader/shadervisitor.cpp`
- `openmw/components/shader/shadervisitor.hpp`
- `openmw/components/std140/ubo.hpp`
- `openmw/components/terrain/chunkmanager.cpp`
- `openmw/extern/osg-ffmpeg-videoplayer/audiodecoder.cpp`
- `openmw/extern/osg-ffmpeg-videoplayer/include/osg-ffmpeg-videoplayer/videostate.hpp`
- `openmw/extern/osg-ffmpeg-videoplayer/videoplayer.cpp`
- `openmw/extern/osg-ffmpeg-videoplayer/videostate.cpp`
- `openmw/files/data/CMakeLists.txt` — list the mp.omwscripts scripts
- `openmw/files/data/mygui/openmw_settings_window.layout`
- `openmw/files/data/shaders/adjustments.omwfx`
- `openmw/files/data/shaders/bloomlinear.omwfx`
- `openmw/files/shaders/compatibility/bs/default.frag`
- `openmw/files/shaders/compatibility/bs/default.vert`
- `openmw/files/shaders/compatibility/bs/nolighting.frag`
- `openmw/files/shaders/compatibility/bs/nolighting.vert`
- `openmw/files/shaders/compatibility/groundcover.frag`
- `openmw/files/shaders/compatibility/groundcover.vert`
- `openmw/files/shaders/compatibility/objects.frag`
- `openmw/files/shaders/compatibility/objects.vert`
- `openmw/files/shaders/compatibility/sky.frag`
- `openmw/files/shaders/compatibility/terrain.frag`
- `openmw/files/shaders/compatibility/terrain.vert`
- `openmw/files/shaders/compatibility/water.frag`
- `openmw/files/shaders/lib/core/fragment.glsl`
- `openmw/files/shaders/lib/core/fragment_multiview.glsl`
- `openmw/files/shaders/lib/core/lighting_fragment.glsl`
- `openmw/files/shaders/lib/core/lighting_fragment_impl.glsl`
- `openmw/files/shaders/lib/core/lighting_fragment_legacy.glsl`
- `openmw/files/shaders/lib/core/lighting_vertex.glsl`
- `openmw/files/shaders/lib/core/lighting_vertex_impl.glsl`
- `openmw/files/shaders/lib/core/lighting_vertex_legacy.glsl`
- `openmw/files/shaders/lib/core/vertex.glsl`
- `openmw/files/shaders/lib/core/vertex.h.glsl`
- `openmw/files/shaders/lib/core/vertex_multiview.glsl`
- `openmw/files/shaders/lib/light/bindings-legacy.glsl`
- `openmw/files/shaders/lib/light/bindings.glsl`
- `openmw/files/shaders/lib/light/clamp.glsl`
- `openmw/files/shaders/lib/light/util.glsl`
