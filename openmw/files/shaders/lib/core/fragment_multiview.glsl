// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#version 330
#ifndef OMW_VGUARD_LIB_CORE_FRAGMENT_MULTIVIEW_GLSL
#define OMW_VGUARD_LIB_CORE_FRAGMENT_MULTIVIEW_GLSL

#extension GL_OVR_multiview : require
#extension GL_OVR_multiview2 : require
#extension GL_EXT_texture_array : require

#include "lib/core/fragment.h.glsl"

uniform sampler2DArray reflectionMap;

vec4 sampleReflectionMap(vec2 uv)
{
    return texture(reflectionMap, vec3((uv), gl_ViewID_OVR));
}

#if @waterRefraction

uniform sampler2DArray refractionMap;
uniform sampler2DArray refractionDepthMap;

vec4 sampleRefractionMap(vec2 uv)
{
    return texture(refractionMap, vec3((uv), gl_ViewID_OVR));
}

float sampleRefractionDepthMap(vec2 uv)
{
    return texture(refractionDepthMap, vec3((uv), gl_ViewID_OVR)).x;
}

#endif

uniform sampler2DArray lastShader;

vec4 samplerLastShader(vec2 uv)
{
    return texture(lastShader, vec3((uv), gl_ViewID_OVR));
}

#if @skyBlending
uniform sampler2DArray sky;

vec3 sampleSkyColor(vec2 uv)
{
    return texture(sky, vec3((uv), gl_ViewID_OVR)).xyz;
}
#endif

uniform sampler2DArray opaqueDepthTex;

vec4 sampleOpaqueDepthTex(vec2 uv)
{
    return texture(opaqueDepthTex, vec3((uv), gl_ViewID_OVR));
}
#endif
