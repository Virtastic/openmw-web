// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#version 120
#ifndef OMW_VGUARD_LIB_CORE_VERTEX_GLSL
#define OMW_VGUARD_LIB_CORE_VERTEX_GLSL

#include "lib/core/vertex.h.glsl"

uniform vec2 screenRes;
uniform mat4 projectionMatrix;

vec4 modelToClip(vec4 pos)
{
    return projectionMatrix * modelToView(pos);
}

vec4 modelToView(vec4 pos)
{
    return gl_ModelViewMatrix * pos;
}

vec4 viewToClip(vec4 pos)
{
    return projectionMatrix * pos;
}

vec2 clipToScreen(vec4 pos)
{
    return ((pos.xy / pos.w) * 0.5 + 0.5) * screenRes;
}
#endif
