# WebGPU: spike (WG1, OT3-243) and decision (WG2, OT3-244)

Status: written 2026-11-02 on branch `ot3-webgpu`. This is a desk spike. No route was built or
booted, so the "reaches the main menu" acceptance item is replaced by the written blockers
below. That is deliberate: per CLAUDE.md, image builds are hours long, and the case for WebGPU
fails before any build is needed (see WG2).

## WG1: what we render today

Measured from the tree:

| item | value | where |
|---|---|---|
| GL target | WebGL2 only (`-sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=2 -sFULL_ES3=1`) | `wasm-build/link-openmw.sh:209` |
| OSG profile | GLES2+GLES3, fixed-function off | `wasm-build/build-osg.sh` |
| OSG patch for the web | 746 lines (State, GLExtensions, FBO, Texture, Texture2D, RenderStage) | `wasm-build/patches/osg-emscripten.patch` |
| `__EMSCRIPTEN__` sites in renderer code | 88 (mwrender, sceneutil, shader, fx, resource, terrain) | grep |
| scene shaders | 76 files | `openmw/files/shaders` |
| post shaders | 4 `.omwfx` | `fsroot/resources/vfs/shaders` |
| JS-side GL hooks | getContext wrapper (anisotropy ext, GPU name logging), context-loss handling | `play/index.html` ~375-440, ~1238 |
| frame telemetry | `[telemetry] fps= worstFrameMs= pumps= frameMs=` once a second; `frameMs` is engine CPU ms per pump | `play/index.html` ~795-810 |

What the repo does **not** have: a draw-call or state-change counter, or a GPU timer query.
The telemetry splits CPU-bound (high `frameMs`) from GPU/compositor-bound (low `frameMs`, low
fps), but no stored log in the tree records that split for a real scene. The cost of a draw call
under WebGL2 is therefore not known for our scenes. This is the first unknown below.

## WG1: what WebGPU would buy us

| promised gain | does it apply to us? |
|---|---|
| Lower CPU cost per draw (no per-call GL validation, pre-baked pipelines, bind groups) | Only if we are CPU-bound in draw submission. That is unmeasured (see above). Typical public claims of 2-10x lower submission cost come from engines written for the API (render bundles, persistent bind groups). OSG issues draws one StateSet at a time, so a backend under OSG keeps most of the per-draw state churn. The likely gain is small without restructuring the cull/draw. |
| Compute shaders (GPU particles, water ripples, culling) | Real but optional. Water ripples (WG8) already run as a fragment ping-pong on WebGL2. |
| MSAA under post-processing | WebGL2 already has multisampled renderbuffers plus `blitFramebuffer`. The current limit is in our FBO path, not in WebGL2. It can be fixed without WebGPU. |
| Fewer WebGL2 workarounds | Route A keeps them all. Route B swaps them for a new set: WGSL, bind-group layouts, pipeline caching, and readback via mapAsync. |
| Better multithreading (OffscreenCanvas on a worker) | WebGL2 on OffscreenCanvas already works in all three engines. This is not unique to WebGPU. |

Net: none of the gains is proven for our workload, and the biggest one (CPU per draw) is
unmeasured and mostly blocked by OSG's architecture.

## WG1: the routes

### A. ANGLE's WebGPU backend under the unchanged OSG GLES path

- Status: experimental. `EGL_ANGLE_platform_angle_webgpu` is still a draft (last revision May
  2025). WebKit added a build flag for the backend in Sept 2026. It ships as a default in no
  browser.
- Cost: ANGLE has never been built as a wasm64 library calling emdawnwebgpu, and nobody
  publishes such a build. Estimate 6-10 engineer-weeks to get there, plus ongoing upkeep while
  the backend is in flux.
- Payload: ANGLE (translator plus renderer) adds several MB of wasm. Our own GL-to-GLSL
  translator stack would then be translated twice: GLSL ES to WGSL in wasm, then WGSL to the
  native API in the browser.
- Gain: close to none. Each GL call still validates in ANGLE, now in wasm and without the
  browser's native fast paths. Expect frame time equal to or worse than WebGL2.
- Risk: high. Reach is limited to WebGPU browsers.
- Blocker for a boot spike: no buildable wasm64 ANGLE+wgpu configuration exists to start from.

### B. Our own WebGPU renderer for OSG against emdawnwebgpu

- Toolchain: `--use-port=emdawnwebgpu` replaces the deprecated `-sUSE_WEBGPU`. emdawnwebgpu
  lists MEMORY64 among the settings it handles, and emscripten has a `browser64` WebGPU test.
  Pthreads with `-fwasm-exceptions` has no published confirmation. Unconfirmed until built
  (this would be WG3).
- Work: replace the GL parts of osg::State/FBO/Texture/RenderStage with a recording backend
  (VSG's `State`/`RecordTraversal` is the model), pipeline caching keyed on StateSet, uniforms to
  UBO bind groups, and readback (WG12). Shaders: 76+4 GLSL ES 3.00 files with OpenMW's
  `@define` permutations go to WGSL. An offline glslang to SPIR-V to Tint/naga bake of every
  permutation is the only sane option. A runtime translator in wasm costs several MB. Note
  that OpenMW builds shader permutations from settings at runtime, so the bake has to list
  them all.
- Estimate (one engineer, from the WG tickets): WG3 build 1-2 wk, WG4 device 1-2, WG5 shaders
  4-6, WG6 core scene 6-10, WG7 sky 2, WG8 water 2-3, WG9 shadows 2-3, WG10 post 2-3, WG11
  GUI/maps 2-3, WG12 readback 1-2, WG13 selection 1-2, WG14 harness 1-2, WG15 measure 1,
  WG16 rollout 1. **Total about 27-42 weeks**, plus keeping two renderers in step with every
  later engine change.
- Risk: high (the largest diff on the branch, and an OSG fork that diverges further).
  Medium-high reach.

### C. Stay on WebGL2

- Cost: 0. Optional: 1-2 weeks to instrument draw calls and GPU time (see unknowns), and to fix
  MSAA under post on WebGL2 directly.
- Reach: every browser we support today, including Linux Chrome/Firefox and Firefox Android,
  where WebGPU is still partial.

### Browser reach for WebGPU (late 2026, from public status pages)

| browser | WebGPU |
|---|---|
| Chrome/Edge/Brave desktop | Windows, macOS, ChromeOS yes; Linux only on some Intel/NVIDIA setups |
| Chrome Android | Android 12+ with Qualcomm/ARM GPUs |
| Firefox | Windows (141+), Apple Silicon macOS (145+); Linux/Android/Intel Mac behind flags or Nightly |
| Safari | macOS/iOS/iPadOS 26 |

We did not verify optional-feature coverage per browser. `texture-compression-bc` is
desktop-only (mobile has ETC2/ASTC; our DDS assets are BC). `float32-filterable`,
`clip-distances` and `depth32float-stencil8` are each optional. A WebGPU route needs either all
of them or a fallback for each. The BC gap alone means mobile WebGPU needs CPU decompression
or a second texture set.

### Unknowns

1. Is a real scene (Balmora, Vivec, a TR city) CPU-bound in GL submission? This needs
   draw-call and state-change counters per frame plus `EXT_disjoint_timer_query_webgl2`
   where available. This one unknown decides whether B could pay off at all.
2. Does emdawnwebgpu work with MEMORY64 + pthreads + wasm EH together? A one-day hello-triangle
   in `emscripten/emsdk:6.0.1` would answer it.
3. The size of the full shader permutation set after a WGSL bake.
4. How ANGLE's wgpu backend matures. Watch for it becoming non-experimental.

## WG2: decision

**Recommendation: Route C, stay on WebGL2. Close the WebGPU module for now. WebGL2 stays the
only renderer.**

Why:
- The gains are unproven for us. The headline gain (CPU per draw) is unmeasured, and under
  OSG's per-StateSet draw model it would mostly not materialise without a scene-graph rewrite.
- Route A gives no performance win and depends on an experimental backend with no wasm64 build.
- Route B costs about 27-42 engineer-weeks plus a permanent second renderer. Its reach is
  narrower than what we ship today, because WebGL2 must remain the fallback anyway.
- MSAA under post and the cheaper effects can be done on WebGL2.

Rejected: A (no gain, experimental, large payload); B (cost and upkeep far above any
demonstrated benefit).

The acceptance fields for wasm size delta, boot time delta and frame time delta are **not
measured**, because no route was built. The decision does not depend on them: A cannot be
faster than native WebGL2, and B's cost dominates unless unknown 1 shows a large CPU-bound
share.

What would change it (the triggers for reopening):
1. Instrumented frames show more than about 40% of frame time in GL submission/validation on
   target hardware, in common scenes, after cheap WebGL2 fixes (batching, fewer state changes).
   That reopens B, scoped first to WG3-WG6.
2. ANGLE's WebGPU backend leaves experimental status and a wasm64 build exists upstream. That
   makes A a cheap compatibility path, though still not a performance one.
3. A browser we must support deprecates or caps WebGL2 (none has announced this).
4. A feature we want can only be done with compute (for example GPU-driven culling for TR-scale
   cells) and has no acceptable WebGL2 approximation.

Owner sign-off is still needed. This document is the input, not the sign-off.

## What this means for WG3..WG16

| ticket | disposition |
|---|---|
| WG3 Build: emdawnwebgpu on wasm64 | Defer. Keep only the one-day hello-triangle probe (unknown 2) as an optional spike. |
| WG4 Device bring-up | Defer (until trigger 1 or 4). |
| WG5 Shaders GLSL to WGSL | Defer. |
| WG6 Core scene | Defer. |
| WG7 Sky and weather | Defer. |
| WG8 Water (compute ripples) | Defer. |
| WG9 Shadows | Defer. |
| WG10 Post / MSAA under post | Cancel as WebGPU work. Refile "MSAA under post-processing" as a WebGL2 ticket. |
| WG11 GUI and maps | Defer. |
| WG12 Readback | Defer. |
| WG13 Renderer selection | Defer. Only meaningful once a second renderer exists. |
| WG14 Harness and CI modes | Defer. |
| WG15 Measure WebGPU vs WebGL2 | Repurpose now as "measure WebGL2 frame cost": draw-call/state counters plus GPU timer in telemetry. This produces trigger 1's evidence. |
| WG16 Rollout | Cancel. Recreate if the module is reopened. |

Sources: Emscripten WebGPU bindings README and `browser64` tests; Dawn `src/emdawnwebgpu`;
ANGLE `extensions/EGL_ANGLE_platform_angle_webgpu.txt`; WebKit bug 325140; web.dev "WebGPU is
now supported in major browsers"; gpuweb Implementation Status wiki.
