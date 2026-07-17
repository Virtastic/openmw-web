// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#ifndef OMW_GUARD_LIB_LIGHT_CLAMP_GLSL
#define OMW_GUARD_LIB_LIGHT_CLAMP_GLSL
void clampLighting(inout vec3 lighting)
{
#if @clamp
    lighting = clamp(lighting, vec3(0.0), vec3(1.0));
#else
    lighting = max(lighting, 0.0);
#endif
}
#endif
