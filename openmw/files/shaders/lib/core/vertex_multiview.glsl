// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#version 330 compatibility
#ifndef OMW_VGUARD_LIB_CORE_VERTEX_MULTIVIEW_GLSL
#define OMW_VGUARD_LIB_CORE_VERTEX_MULTIVIEW_GLSL
// Note: compatibility profile required to access gl_ModelViewMatrix 

#extension GL_OVR_multiview : require
#extension GL_OVR_multiview2 : require

layout(num_views = @numViews) in;

#include "lib/core/vertex.h.glsl"

uniform mat4 projectionMatrixMultiView[@numViews];

vec4 modelToClip(vec4 pos)
{
    return viewToClip(modelToView(pos));
}

vec4 modelToView(vec4 pos)
{
    return gl_ModelViewMatrix * pos;
}

vec4 viewToClip(vec4 pos)
{
    return projectionMatrixMultiView[gl_ViewID_OVR] * pos;
}
#endif
