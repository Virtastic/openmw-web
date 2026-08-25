// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// Force-included into every OpenMW translation unit by configure-openmw.sh and
// link-openmw.sh (-include). It existed only inside the maintainer's gitignored
// deps/wasm/include, so a clean checkout could not compile at all: every source file died on
// "'gl_compat.h' file not found" before any real work started. A build INPUT is not a build
// artifact — it belongs in the repo, which is why it now lives here.
//
// Reconstructed 2026-08-24. Keep it minimal: OSG is configured GLES2-only
// (OSG_GL1/GL2/GL3_AVAILABLE=OFF, OPENGL_PROFILE=GLES2) while the engine targets WebGL2, so
// this exists to bridge desktop-GL spellings that survive in shared code paths. Add to it only
// when a real compile error demands it, and say which one.
#pragma once

// --- GL_EXT_texture_sRGB: sRGB S3TC/DXT compressed formats -----------------------------------
// components/sceneutil/util.cpp switches over these while classifying compressed textures. They
// are desktop/EXT enums and are absent from the GLES2 headers OSG is configured against, so the
// switch does not compile. The VALUES are fixed by the extension spec, so declaring them is
// safe regardless of whether the running WebGL2 context advertises the extension — this is a
// compile-time vocabulary gap, not a capability claim.
#ifndef GL_COMPRESSED_SRGB_S3TC_DXT1_EXT
#define GL_COMPRESSED_SRGB_S3TC_DXT1_EXT       0x8C4C
#endif
#ifndef GL_COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT
#define GL_COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT 0x8C4D
#endif
#ifndef GL_COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT
#define GL_COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT 0x8C4E
#endif
#ifndef GL_COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT
#define GL_COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT 0x8C4F
#endif

// --- Desktop-GL scalar types the GLES headers omit --------------------------------------------
// SDL2's SDL_opengl_glext.h declares desktop entry points using GLdouble / GLclampd. GLES has no
// double-precision GL types, so those declarations fail to parse even though nothing in this
// build ever CALLS them. Typedef the two so the header compiles; the functions remain unused and
// unlinked.
#ifndef GL_COMPAT_HAS_GLDOUBLE
#define GL_COMPAT_HAS_GLDOUBLE 1
typedef double GLdouble;
typedef double GLclampd;
#endif

// --- Fixed-function enums referenced as OSG StateAttribute MODES ------------------------------
// mwrender/sky.cpp passes these to setMode()/setTextureMode(). OSG is built here with
// OSG_GL_FIXED_FUNCTION_AVAILABLE=OFF and GLES has no fixed-function pipeline, so the enums are
// gone — but the call sites remain, and OSG treats an unsupported mode as a no-op at runtime.
// Declaring the spec values keeps those lines compiling without turning anything on.
#ifndef GL_CLIP_PLANE0
#define GL_CLIP_PLANE0 0x3000
#endif
#ifndef GL_FOG
#define GL_FOG 0x0B60
#endif

// --- The rest of the fixed-function vocabulary ------------------------------------------------
// Added as a BLOCK rather than one enum per compile error, deliberately: this header is
// force-included into every translation unit, so each edit invalidates all ~890 objects and
// costs a full rebuild. Discovering these one at a time is hours of rebuilds to learn something
// the OpenGL spec already fixes.
//
// All values are from the OpenGL 1.x/2.x spec and cannot drift. OSG's headers (osg/Fog,
// osg/LightModel, osg/TexGen, ...) name them unconditionally even in a GLES build; the modes
// they feed are no-ops at runtime, so declaring them changes nothing about behaviour.
#ifndef GL_EXP
#define GL_EXP  0x0800
#endif
#ifndef GL_EXP2
#define GL_EXP2 0x0801
#endif
#ifndef GL_FOG_DENSITY
#define GL_FOG_DENSITY 0x0B62
#define GL_FOG_START   0x0B63
#define GL_FOG_END     0x0B64
#define GL_FOG_MODE    0x0B65
#define GL_FOG_COLOR   0x0B66
#endif
#ifndef GL_CLIP_PLANE1
#define GL_CLIP_PLANE1 0x3001
#define GL_CLIP_PLANE2 0x3002
#define GL_CLIP_PLANE3 0x3003
#define GL_CLIP_PLANE4 0x3004
#define GL_CLIP_PLANE5 0x3005
#endif
#ifndef GL_LIGHTING
#define GL_LIGHTING 0x0B50
#define GL_LIGHT0   0x4000
#define GL_LIGHT1   0x4001
#define GL_LIGHT2   0x4002
#define GL_LIGHT3   0x4003
#define GL_LIGHT4   0x4004
#define GL_LIGHT5   0x4005
#define GL_LIGHT6   0x4006
#define GL_LIGHT7   0x4007
#endif
#ifndef GL_COLOR_MATERIAL
#define GL_COLOR_MATERIAL 0x0B57
#endif
#ifndef GL_NORMALIZE
#define GL_NORMALIZE 0x0BA1
#endif
#ifndef GL_RESCALE_NORMAL
#define GL_RESCALE_NORMAL 0x803A
#endif
#ifndef GL_ALPHA_TEST
#define GL_ALPHA_TEST 0x0BC0
#endif
#ifndef GL_POINT_SMOOTH
#define GL_POINT_SMOOTH   0x0B10
#define GL_LINE_SMOOTH    0x0B20
#define GL_POLYGON_SMOOTH 0x0B41
#endif
#ifndef GL_TEXTURE_GEN_S
#define GL_TEXTURE_GEN_S 0x0C60
#define GL_TEXTURE_GEN_T 0x0C61
#define GL_TEXTURE_GEN_R 0x0C62
#define GL_TEXTURE_GEN_Q 0x0C63
#endif
#ifndef GL_QUADS
#define GL_QUADS      0x0007
#define GL_QUAD_STRIP 0x0008
#define GL_POLYGON    0x0009
#endif
#ifndef GL_LUMINANCE
#define GL_LUMINANCE       0x1909
#define GL_LUMINANCE_ALPHA 0x190A
#endif
#ifndef GL_INTENSITY
#define GL_INTENSITY 0x8049
#endif
#ifndef GL_CLAMP
#define GL_CLAMP 0x2900
#endif
#ifndef GL_TEXTURE_1D
#define GL_TEXTURE_1D 0x0DE0
#endif

// --- OpenAL: AL_APIENTRY -----------------------------------------------------------------------
// Emscripten's AL/al.h defines neither AL_API nor AL_APIENTRY (upstream OpenAL defines both,
// AL_APIENTRY as empty on every platform that is not Win32). OpenMW's mwsound/efx.h writes its
// EFX entry points as `typedef void(AL_APIENTRY* LPALEFFECTI)(...)`, so with the macro missing
// the token is an unknown IDENTIFIER and every one of those lines fails to parse — reported as
// "expected ')'" plus a cascade of bogus "typedef redefinition with different types", which
// points at OpenMW's header rather than at the missing macro.
//
// Defined here rather than in efx.h: this is a property of the toolchain's AL headers, and the
// same gap would hit any other file that declares an AL entry point.
#ifndef AL_APIENTRY
#define AL_APIENTRY
#endif
// ...and its ALC counterpart, used 22 times in OpenMW's alext.h for the context-extension entry
// points. Missing it produces the same cascade one level down: every ALC typedef reported as
// redefining the FIRST one in the file, so the diagnostic names whichever entry point happened
// to come first (alcMakeContextCurrent) rather than the macro that is actually absent.
#ifndef ALC_APIENTRY
#define ALC_APIENTRY
#endif
