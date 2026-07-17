// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#ifndef OMW_GUARD_LIB_LIGHT_BINDINGS_LEGACY_GLSL
#define OMW_GUARD_LIB_LIGHT_BINDINGS_LEGACY_GLSL
#include "lib/light/struct.glsl"

/* Layout:
--------------------------------------- -----------
|  pos_x  |  ambi_r  |  diff_r  |  spec_r         |
|  pos_y  |  ambi_g  |  diff_g  |  spec_g         |
|  pos_z  |  ambi_b  |  diff_b  |  spec_b         |
|  att_c  |  att_l   |  att_q   |  radius/spec_a  |
 --------------------------------------------------
*/
uniform mat4 LightBuffer[@maxLights];
uniform int PointLightCount;

float lcalcConstantAttenuation(int lightIndex)
{
    return LightBuffer[lightIndex][0].w;
}

float lcalcLinearAttenuation(int lightIndex)
{
    return LightBuffer[lightIndex][1].w;
}

float lcalcQuadraticAttenuation(int lightIndex)
{
    return LightBuffer[lightIndex][2].w;
}

float lcalcRadius(int lightIndex)
{
    return LightBuffer[lightIndex][3].w;
}

vec3 lcalcPosition(int lightIndex)
{
    return LightBuffer[lightIndex][0].xyz;
}

vec3 lcalcDiffuse(int lightIndex)
{
    return LightBuffer[lightIndex][2].xyz;
}

vec3 lcalcAmbient(int lightIndex)
{
    return LightBuffer[lightIndex][1].xyz;
}

vec4 lcalcSpecular(int lightIndex)
{
    return LightBuffer[lightIndex][3];
}

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
