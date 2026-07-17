// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "pass.hpp"

#include <sstream>
#include <string>
#include <unordered_set>

#include <osg/BindImageTexture>
#include <osg/FrameBufferObject>
#include <osg/Program>
#include <osg/Shader>
#include <osg/State>
#include <osg/StateSet>

#include <components/resource/scenemanager.hpp>
#include <components/sceneutil/lightmanager.hpp>
#include <components/settings/values.hpp>
#include <components/stereo/multiview.hpp>
#include <components/version/version.hpp>

#include "stateupdater.hpp"
#include "technique.hpp"

namespace
{
    constexpr char s_DefaultVertex[] = R"GLSL(
#if OMW_USE_BINDINGS
    omw_In vec2 omw_Vertex;
#endif
omw_Out vec2 omw_TexCoord;

void main()
{
    omw_Position = vec4(omw_Vertex.xy, 0.0, 1.0);
    omw_TexCoord = omw_Position.xy * 0.5 + 0.5;
})GLSL";

    constexpr char s_DefaultVertexMultiview[] = R"GLSL(
layout(num_views = 2) in;
#if OMW_USE_BINDINGS
    omw_In vec2 omw_Vertex;
#endif
omw_Out vec2 omw_TexCoord;

void main()
{
    omw_Position = vec4(omw_Vertex.xy, 0.0, 1.0);
    omw_TexCoord = omw_Position.xy * 0.5 + 0.5;
})GLSL";

}

namespace Fx
{
    Pass::Pass(Pass::Type type, Pass::Order order, bool ubo)
        : mCompiled(false)
        , mType(type)
        , mOrder(order)
        , mLegacyGLSL(true)
        , mUBO(ubo)
    {
    }

    std::string Pass::getPassHeader(Technique& technique, std::string_view preamble, bool fragOut)
    {
        std::string header = R"GLSL(
#version @version @profile
@extensions

@uboStruct

#define OMW_API_VERSION @apiVersion
#define OMW_REVERSE_Z @reverseZ
#define OMW_RADIAL_FOG @radialFog
#define OMW_EXPONENTIAL_FOG @exponentialFog
#define OMW_HDR @hdr
#define OMW_NORMALS @normals
#define OMW_USE_BINDINGS @useBindings
#define OMW_MULTIVIEW @multiview
#define OMW_FRAGMENT_STAGE @fragmentStage
#define omw_In @in
#define omw_Out @out
#define omw_Position @position
#define omw_Texture1D @texture1D
#define omw_Texture2D @texture2D
#define omw_Texture2DArray @texture2DArray
#define omw_Texture3D @texture3D
#define omw_Vertex @vertex
#define omw_FragColor @fragColor

@fragBinding

// Samplers, point-light uniforms, the data struct and all texture-sampling helpers are only
// needed by the fragment stage. Emitting them into the VERTEX shader put texture() calls in the
// vertex stage, which hangs ANGLE's shader translator (used by every Chrome GL backend) on WebGL2.
#if OMW_FRAGMENT_STAGE
uniform @builtinSampler omw_SamplerLastShader;
uniform @builtinSampler omw_SamplerLastPass;
uniform @builtinSampler omw_SamplerDepth;
uniform @builtinSampler omw_SamplerNormals;
uniform @builtinSampler omw_SamplerDistortion;

uniform vec4 omw_PointLights[@pointLightCount];
uniform int omw_PointLightsCount;

#if OMW_MULTIVIEW
uniform mat4 projectionMatrixMultiView[2];
uniform mat4 invProjectionMatrixMultiView[2];
#endif

int omw_GetPointLightCount()
{
    return omw_PointLightsCount;
}

vec3 omw_GetPointLightWorldPos(int index)
{
    return omw_PointLights[(index * 3)].xyz;
}

vec3 omw_GetPointLightDiffuse(int index)
{
    return omw_PointLights[(index * 3) + 1].xyz;
}

vec3 omw_GetPointLightAttenuation(int index)
{
    return omw_PointLights[(index * 3) + 2].xyz;
}

float omw_GetPointLightRadius(int index)
{
    return omw_PointLights[(index * 3) + 2].w;
}

#if @ubo
    layout(std140) uniform _data { _omw_data omw; };
#else
    @structUniform
#endif


mat4 omw_ProjectionMatrix()
{
#if OMW_MULTIVIEW
    return projectionMatrixMultiView[gl_ViewID_OVR];
#else
    return omw.projectionMatrix;
#endif
}

mat4 omw_InvProjectionMatrix()
{
#if OMW_MULTIVIEW
    return invProjectionMatrixMultiView[gl_ViewID_OVR];
#else
    return omw.invProjectionMatrix;
#endif
}

    float omw_GetDepth(vec2 uv)
    {
#if OMW_MULTIVIEW
        float depth = omw_Texture2DArray(omw_SamplerDepth, vec3(uv, gl_ViewID_OVR)).r;
#else
        float depth = omw_Texture2D(omw_SamplerDepth, uv).r;
#endif
#if OMW_REVERSE_Z
        return 1.0 - depth;
#else
        return depth;
#endif
    }

    vec4 omw_GetDistortion(vec2 uv)
    {
#if OMW_MULTIVIEW
        return omw_Texture2DArray(omw_SamplerDistortion, vec3(uv, gl_ViewID_OVR));
#else
        return omw_Texture2D(omw_SamplerDistortion, uv);
#endif
    }

    vec4 omw_GetLastShader(vec2 uv)
    {
#if OMW_MULTIVIEW
        return omw_Texture2DArray(omw_SamplerLastShader, vec3(uv, gl_ViewID_OVR));
#else
        return omw_Texture2D(omw_SamplerLastShader, uv);
#endif
    }

    vec4 omw_GetLastPass(vec2 uv)
    {
#if OMW_MULTIVIEW
        return omw_Texture2DArray(omw_SamplerLastPass, vec3(uv, gl_ViewID_OVR));
#else
        return omw_Texture2D(omw_SamplerLastPass, uv);
#endif
    }

    vec3 omw_GetNormals(vec2 uv)
    {
#if OMW_MULTIVIEW
        return omw_Texture2DArray(omw_SamplerNormals, vec3(uv, gl_ViewID_OVR)).rgb * 2.0 - 1.0;
#else
        return omw_Texture2D(omw_SamplerNormals, uv).rgb * 2.0 - 1.0;
#endif
    }

    vec3 omw_GetNormalsWorldSpace(vec2 uv)
    {
        return (vec4(omw_GetNormals(uv), 0.0) * omw.viewMatrix).rgb;
    }

    vec3 omw_GetWorldPosFromUV(vec2 uv)
    {
        float depth = omw_GetDepth(uv);
#if (OMW_REVERSE_Z == 1)
        float flippedDepth = 1.0 - depth;
#else
        float flippedDepth = depth * 2.0 - 1.0;
#endif
        vec4 clip_space = vec4(uv * 2.0 - 1.0, flippedDepth, 1.0);
        vec4 world_space = omw.invViewMatrix * (omw.invProjectionMatrix * clip_space);
        return world_space.xyz / world_space.w;
    }

    float omw_GetLinearDepth(vec2 uv)
    {
#if (OMW_REVERSE_Z == 1)
        float depth = omw_GetDepth(uv);
        float dist = omw.near * omw.far / (omw.far + depth * (omw.near - omw.far));
#else
        float depth = omw_GetDepth(uv) * 2.0 - 1.0;
        float dist = 2.0 * omw.near * omw.far / (omw.far + omw.near - depth * (omw.far - omw.near));
#endif

        return dist;
    }

float omw_EstimateFogCoverageFromUV(vec2 uv)
    {
#if OMW_RADIAL_FOG
        vec3 uvPos = omw_GetWorldPosFromUV(uv);
        float dist = length(uvPos - omw.eyePos.xyz);
#else
        float dist = omw_GetLinearDepth(uv);
#endif
#if OMW_EXPONENTIAL_FOG
        float fogValue = 1.0 - exp(-2.0 * max(0.0, dist - omw.fogNear/2.0) / (omw.fogFar - omw.fogNear/2.0));
#else
        float fogValue = clamp((dist - omw.fogNear) / (omw.fogFar - omw.fogNear), 0.0, 1.0);
#endif

        return fogValue;
    }

#if OMW_HDR
    uniform sampler2D omw_EyeAdaptation;
#endif

    float omw_GetEyeAdaptation()
    {
#if OMW_HDR
        return omw_Texture2D(omw_EyeAdaptation, vec2(0.5, 0.5)).r;
#else
        return 1.0;
#endif
    }
#endif // OMW_FRAGMENT_STAGE
)GLSL";

        std::stringstream extBlock;
        for (const auto& extension : technique.getGLSLExtensions())
            extBlock << "#ifdef " << extension << '\n'
                     << "\t#extension " << extension << ": enable" << '\n'
                     << "#endif" << '\n';

#ifdef __EMSCRIPTEN__
        // WebGL2 is GLES 3.00. Emit "#version 300 es" and use the modern (non-legacy) in/out/texture
        // path (mLegacyGLSL is forced false in compile()) so Fx post-process shaders compile natively
        // instead of as unsupported "#version 120". Precision qualifiers are injected below.
        const std::string glslVersion = "300";
        const std::string glslProfile = "es";
#else
        const std::string glslVersion = std::to_string(technique.getGLSLVersion());
        const std::string glslProfile = technique.getGLSLProfile();
#endif
        const std::vector<std::pair<std::string, std::string>> defines
            = { { "@pointLightCount", std::to_string(SceneUtil::PPLightBuffer::sMaxPPLightsArraySize) },
                  { "@apiVersion", std::to_string(Version::getPostprocessingApiRevision()) },
                  { "@version", glslVersion },
                  { "@multiview", Stereo::getMultiview() ? "1" : "0" },
                  { "@fragmentStage", fragOut ? "1" : "0" },
                  { "@builtinSampler", Stereo::getMultiview() ? "sampler2DArray" : "sampler2D" },
                  { "@profile", glslProfile }, { "@extensions", extBlock.str() },
#ifdef __EMSCRIPTEN__
                  // ANGLE/WebGL2 reads struct-member uniforms as 0, so declare the data as flat
                  // `uniform <type> omw_<name>;` instead of a `_omw_data` struct + struct uniform.
                  // The `omw.<member>` reads in the helpers/user shader are rewritten to `omw_<member>`
                  // below, and StateUpdater feeds the matching flat uniform names.
                  { "@uboStruct", StateUpdater::getFlatDefinition() }, { "@structUniform", "" },
#else
                  { "@uboStruct", StateUpdater::getStructDefinition() }, { "@structUniform", "uniform _omw_data omw;" },
#endif
                  { "@ubo", mUBO ? "1" : "0" },
                  { "@normals", technique.getNormals() ? "1" : "0" },
                  { "@reverseZ", SceneUtil::AutoDepth::isReversed() ? "1" : "0" },
                  { "@radialFog", Settings::fog().mRadialFog ? "1" : "0" },
                  { "@exponentialFog", Settings::fog().mExponentialFog ? "1" : "0" },
                  { "@hdr", technique.getHDR() ? "1" : "0" }, { "@in", mLegacyGLSL ? "varying" : "in" },
                  { "@out", mLegacyGLSL ? "varying" : "out" }, { "@position", "gl_Position" },
                  { "@texture1D", mLegacyGLSL ? "texture1D" : "texture" },
                  // Note, @texture2DArray must be defined before @texture2D since @texture2D is a perfect prefix of
                  // texture2DArray
                  { "@texture2DArray", mLegacyGLSL ? "texture2DArray" : "texture" },
                  { "@texture2D", mLegacyGLSL ? "texture2D" : "texture" },
                  { "@texture3D", mLegacyGLSL ? "texture3D" : "texture" },
                  { "@vertex", mLegacyGLSL ? "gl_Vertex" : "_omw_Vertex" },
                  { "@fragColor", mLegacyGLSL ? "gl_FragColor" : "_omw_FragColor" },
                  { "@useBindings", mLegacyGLSL ? "0" : "1" },
                  { "@fragBinding", mLegacyGLSL ? "" : "out vec4 omw_FragColor;" } };

        for (const auto& [define, value] : defines)
            for (size_t pos = header.find(define); pos != std::string::npos; pos = header.find(define))
                header.replace(pos, define.size(), value);

        // Render-target samplers are a fragment-stage concern; keep them (and any texture use) out
        // of the vertex shader (fragOut == false) — vertex-stage samplers hang ANGLE's translator.
        // Also never emit `uniform sampler2D ;` for an empty target name: malformed GLSL that ANGLE
        // hangs on rather than erroring.
        if (fragOut)
            for (const auto& target : mRenderTargets)
                if (!target.empty())
                    header.append("uniform sampler2D " + target + ";");

        for (auto& uniform : technique.getUniformMap())
            if (auto glsl = uniform->getGLSL())
                header.append(glsl.value());

        header.append(preamble);

#ifdef __EMSCRIPTEN__
        // GLSL ES requires: (1) #version to be the very first line — the header template starts with a
        // blank line, which would push #version to line 2 and silently fall back to ES 1.00; and
        // (2) an explicit default float precision (fragment shaders have none). Strip anything before
        // #version, then inject precision right after the version line.
        {
            std::size_t v = header.find("#version");
            if (v != std::string::npos && v > 0)
                header.erase(0, v);
            std::size_t eol = header.find('\n');
            if (eol != std::string::npos)
            {
                std::string precision = "precision highp float;\nprecision highp int;\n";
                if (fragOut)
                    precision += "precision highp sampler2D;\nprecision highp sampler2DShadow;\n"
                                 "precision highp sampler2DArray;\n";
                header.insert(eol + 1, precision);
            }
        }
#endif

        return header;
    }

    void Pass::prepareStateSet(osg::StateSet* stateSet, const std::string& name) const
    {
        osg::ref_ptr<osg::Program> program = new osg::Program;
        if (mType == Type::Pixel)
        {
            program->addShader(new osg::Shader(*mVertex));
            program->addShader(new osg::Shader(*mFragment));
        }
        else if (mType == Type::Compute)
        {
            program->addShader(new osg::Shader(*mCompute));
        }

        if (mUBO)
            program->addBindUniformBlock("_data", static_cast<int>(Resource::SceneManager::UBOBinding::PostProcessor));

        program->setName(name);

        if (!mLegacyGLSL)
        {
#ifndef __EMSCRIPTEN__
            // glBindFragDataLocation is desktop-GL only — it does not exist in WebGL2/GLES3, where a
            // shader's sole fragment output defaults to location 0. Calling it via OSG on emscripten
            // wedges glLinkProgram (reproduced with trivial shaders on every GL backend). Skip it.
            program->addBindFragDataLocation("_omw_FragColor", 0);
#endif
            program->addBindAttribLocation("_omw_Vertex", 0);
        }

        stateSet->setAttribute(program);

        if (mBlendSource && mBlendDest)
            stateSet->setAttributeAndModes(new osg::BlendFunc(mBlendSource.value(), mBlendDest.value()));

        if (mBlendEq)
            stateSet->setAttributeAndModes(new osg::BlendEquation(mBlendEq.value()));
    }

    void Pass::dirty()
    {
        mVertex = nullptr;
        mFragment = nullptr;
        mCompute = nullptr;
        mCompiled = false;
    }

    void Pass::compile(Technique& technique, std::string_view preamble)
    {
        if (mCompiled)
            return;

#ifdef __EMSCRIPTEN__
        // WebGL2/GLES3: always use the modern in/out/texture/_omw_* path (never legacy
        // varying/texture2D/gl_FragColor, which are invalid in GLES 3.00). getPassHeader() emits
        // "#version 300 es" + precision to match.
        mLegacyGLSL = false;
#else
        mLegacyGLSL = technique.getGLSLVersion() < 330;
#endif

        // On emscripten the data uniforms are declared flat (`omw_<member>`) instead of via a struct
        // uniform, so rewrite every `omw.<member>` access in the assembled source to `omw_<member>`.
        // (`omw_`-prefixed identifiers like omw_SamplerDepth / omw_TexCoord have no dot and are
        // untouched.) No-op on desktop.
        const auto finalizeSource = [](std::string src) -> std::string {
#ifdef __EMSCRIPTEN__
            for (std::size_t pos = src.find("omw."); pos != std::string::npos; pos = src.find("omw.", pos + 4))
                src[pos + 3] = '_';
#endif
            return src;
        };

        if (mType == Type::Pixel)
        {
            if (!mVertex)
                mVertex = new osg::Shader(
                    osg::Shader::VERTEX, Stereo::getMultiview() ? s_DefaultVertexMultiview : s_DefaultVertex);

            mVertex->setShaderSource(
                finalizeSource(getPassHeader(technique, preamble).append(mVertex->getShaderSource())));
            mFragment->setShaderSource(
                finalizeSource(getPassHeader(technique, preamble, true).append(mFragment->getShaderSource())));

            mVertex->setName(mName);
            mFragment->setName(mName);
        }
        else if (mType == Type::Compute)
        {
            mCompute->setShaderSource(
                finalizeSource(getPassHeader(technique, preamble).append(mCompute->getShaderSource())));
            mCompute->setName(mName);
        }

        mCompiled = true;
    }

}
