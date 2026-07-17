// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#ifndef OMW_GUARD_LIB_LIGHT_BINDINGS_GLSL
#define OMW_GUARD_LIB_LIGHT_BINDINGS_GLSL
#include "lib/light/struct.glsl"

struct LightGrid {
    uint offset;
    uint count;
};

struct Cluster {
    vec4 minPoint;
    vec4 maxPoint;
};

layout(std430, binding = 1) restrict buffer clusterSSBO {
    Cluster clusters[];
};

layout(std430, binding = 2) restrict buffer pointLightSSBO {
    PointLight pointLight[];
};

layout(std430, binding = 3) restrict buffer lightGridSSBO {
    LightGrid lightGrid[];
};

layout(std430, binding = 4) restrict buffer lightIndexListSSBO {
    uint lightIndexList[];
};

layout(std430, binding = 5) restrict buffer lightIndexCounterSSBO {
    uint globalLightIndexCount;
};

#if @useGLES
// Guard: the linked-shader merge can pull this block in more than once per compiled unit.
#ifndef OMW_SUN_UNIFORMS
#define OMW_SUN_UNIFORMS
uniform vec4 sun_position;
uniform vec4 sun_diffuse;
uniform vec4 sun_ambient;
uniform vec4 sun_specular;
#define sun DirectionalLight(sun_position, sun_diffuse, sun_ambient, sun_specular)
#endif
#else
uniform DirectionalLight sun;
#endif
#endif
