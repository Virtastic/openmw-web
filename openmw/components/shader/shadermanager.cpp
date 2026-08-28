// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "shadermanager.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <algorithm>
#include <cassert>
#include <chrono>
#include <filesystem>
#include <format>
#include <fstream>
#include <regex>
#include <set>
#include <sstream>
#include <system_error>
#include <unordered_map>

#include <osg/Program>
#include <osgViewer/Viewer>

#include <components/debug/debuglog.hpp>
#include <components/files/conversion.hpp>
#include <components/misc/pathhelpers.hpp>
#include <components/misc/strings/algorithm.hpp>
#include <components/misc/strings/conversion.hpp>
#include <components/settings/settings.hpp>

namespace
{
    osg::Shader::Type getShaderType(const std::string& templateName)
    {
        std::string_view ext = Misc::getFileExtension(templateName);

        if (ext == "vert")
            return osg::Shader::VERTEX;
        if (ext == "frag")
            return osg::Shader::FRAGMENT;
        if (ext == "geom")
            return osg::Shader::GEOMETRY;
        if (ext == "comp")
            return osg::Shader::COMPUTE;
        if (ext == "tese")
            return osg::Shader::TESSEVALUATION;
        if (ext == "tesc")
            return osg::Shader::TESSCONTROL;

        throw std::runtime_error("unrecognized shader template name: " + templateName);
    }

#ifdef __EMSCRIPTEN__
    // Merging OpenMW's $link'd shaders into one (WebGL allows one shader per stage) duplicates
    // any #include shared by the merged units, causing "redefinition"/"already has a body".
    // Remove duplicate top-level definitions by name, keeping the first occurrence. Operates on
    // the define-resolved merged GLSL, so it is immune to conditional-include subtleties.
    void dedupeTopLevelDefinitions(std::string& source)
    {
        // After include-guarding the lib shaders, the GLSL preprocessor dedups same-file
        // includes; the only remaining cross-file duplicates from merging $link'd shaders are
        // uniforms declared in more than one file (e.g. screenRes). Drop duplicate top-level
        // uniform declarations by name (they are single-line in OpenMW's shaders).
        auto isIdent = [](char c) {
            return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
        };
        std::set<std::string> seenUniforms;
        std::istringstream in(source);
        std::string out;
        out.reserve(source.size());
        std::string line;
        // Track preprocessor blocks: #ifndef guards are safe to dedupe across (they only
        // include their body once), but #if/#ifdef/#else/#elif select mutually-exclusive
        // branches where the SAME uniform may legitimately be declared in each (e.g. `sun`
        // in clustered vs legacy lighting). Never dedupe inside a conditional branch.
        std::vector<bool> condStack;
        auto inConditional = [&] {
            for (bool b : condStack)
                if (b)
                    return true;
            return false;
        };
        while (std::getline(in, line))
        {
            std::size_t a = line.find_first_not_of(" \t");
            if (a != std::string::npos && line[a] == '#')
            {
                std::string_view d(line);
                d.remove_prefix(a + 1);
                std::size_t ws = d.find_first_not_of(" \t");
                if (ws != std::string_view::npos)
                    d.remove_prefix(ws);
                if (d.rfind("ifndef", 0) == 0)
                    condStack.push_back(false);
                else if (d.rfind("ifdef", 0) == 0 || d.rfind("if", 0) == 0)
                    condStack.push_back(true);
                else if ((d.rfind("else", 0) == 0 || d.rfind("elif", 0) == 0) && !condStack.empty())
                    condStack.back() = true;
                else if (d.rfind("endif", 0) == 0 && !condStack.empty())
                    condStack.pop_back();
                out += line;
                out += '\n';
                continue;
            }
            bool dropped = false;
            if (a != std::string::npos && line.compare(a, 7, "uniform") == 0
                && line.find('{') == std::string::npos)
            {
                std::size_t semi = line.find(';');
                if (semi != std::string::npos)
                {
                    std::string decl = line.substr(0, semi);
                    std::size_t cut = decl.find_first_of("=[");
                    if (cut != std::string::npos)
                        decl = decl.substr(0, cut);
                    std::size_t q = decl.size();
                    while (q > 0 && !isIdent(decl[q - 1]))
                        --q;
                    std::size_t pp = q;
                    while (pp > 0 && isIdent(decl[pp - 1]))
                        --pp;
                    std::string name = decl.substr(pp, q - pp);
                    if (!name.empty())
                    {
                        if (!inConditional())
                        {
                            // Unconditional declaration: always active. Any duplicate — even one
                            // inside a later #if branch — is a guaranteed redefinition; drop dups.
                            if (!seenUniforms.insert(name).second)
                                dropped = true;
                        }
                        else if (seenUniforms.count(name))
                        {
                            // Inside a conditional, only drop when an ALWAYS-ACTIVE (unconditional)
                            // declaration of the same name exists (e.g. `sun` in water.frag vs the
                            // linked lighting bindings' #if branch). Purely-conditional duplicates
                            // across mutually-exclusive branches must be kept.
                            dropped = true;
                        }
                    }
                }
            }
            if (!dropped)
                out += line;
            out += '\n';
        }
        source.swap(out);
    }

    // OpenMW's "compatibility" shaders target desktop GLSL 1.20. WebGL2 only accepts
    // GLSL ES 3.00, which OpenMW's shaders require (centroid, non-constant loop bounds).
    // Retarget the version directive and convert legacy keywords/built-ins to ES 3.00.
    // Remaining fixed-function vertex built-ins (gl_Vertex, gl_*Matrix) are rewritten by
    // OSG's convertVertexShaderSourceToOsgBuiltIns (vertex-attribute aliasing), which uses
    // the `in` qualifier for #version >= 130.
    void adjustSourceForGLES(std::string& source, osg::Shader::Type type)
    {
        constexpr const char* marker = "//__GLES_PRELUDE__\n";
        std::string header = "#version 300 es\nprecision highp float;\nprecision highp int;\n";
        if (type == osg::Shader::FRAGMENT)
            header += "precision highp sampler2D;\nprecision highp sampler2DShadow;\nprecision highp sampler2DArray;\n";
        header += marker;
        std::size_t vpos = source.find("#version");
        if (vpos != std::string::npos)
        {
            std::size_t eol = source.find('\n', vpos);
            if (eol == std::string::npos)
                eol = source.size();
            // Replace from the START of the source (not just from #version) through the version line,
            // so anything preceding #version is removed. GLSL requires #version to be the very first
            // line; the Fx post-process header (components/fx/pass.cpp) begins with a blank line, which
            // would push #version to line 2 and make the compiler silently fall back to ES 1.00
            // ('in'/'out' unsupported, samplers reserved, no default float precision).
            source.replace(0, eol + 1, header);
        }
        else
            source = header + source;

        // Declarations to inject at the prelude marker.
        std::string prelude;
        auto convert = [&](const std::string& glName, const std::string& osgName, const std::string& decl) {
            if (std::regex_search(source, std::regex("\\b" + glName + "\\b")))
            {
                prelude += decl + "\n";
                source = std::regex_replace(source, std::regex("\\b" + glName + "\\b"), osgName);
            }
        };

        // ftransform() only works with fixed-function built-ins; expand it first.
        source = std::regex_replace(
            source, std::regex("\\bftransform\\s*\\(\\s*\\)"), "(gl_ModelViewProjectionMatrix * gl_Vertex)");

        // gl_ModelViewMatrixInverse isn't converted by OSG; derive it (gl_ModelViewMatrix is).
        source = std::regex_replace(
            source, std::regex("\\bgl_ModelViewMatrixInverse\\b"), "inverse(gl_ModelViewMatrix)");

        // Fixed-function matrices -> uniforms (OSG only converts these in vertex shaders, and
        // not at all once we've renamed everything ourselves; do it here for both stages so
        // OSG just feeds the uniforms by name). Order: longest names first via word boundaries.
        convert("gl_ModelViewProjectionMatrix", "osg_ModelViewProjectionMatrix",
            "uniform mat4 osg_ModelViewProjectionMatrix;");
        convert("gl_ModelViewMatrix", "osg_ModelViewMatrix", "uniform mat4 osg_ModelViewMatrix;");
        convert("gl_ProjectionMatrix", "osg_ProjectionMatrix", "uniform mat4 osg_ProjectionMatrix;");
        convert("gl_NormalMatrix", "osg_NormalMatrix", "uniform mat3 osg_NormalMatrix;");

        // Fixed-function texture matrix: OpenMW only uses it as identity here.
        source = std::regex_replace(source, std::regex("gl_TextureMatrix\\[[0-9]+\\]"), "mat4(1.0)");

        // Legacy texture lookup functions -> ES 3.00 overloads.
        source = std::regex_replace(source, std::regex("\\btexture2DLod\\b"), "textureLod");
        source = std::regex_replace(source, std::regex("\\btexture2DProjLod\\b"), "textureProjLod");
        source = std::regex_replace(source, std::regex("\\btexture2DProj\\b"), "textureProj");
        source = std::regex_replace(source, std::regex("\\btexture2DArray\\b"), "texture");
        source = std::regex_replace(source, std::regex("\\btexture2D\\b"), "texture");
        source = std::regex_replace(source, std::regex("\\btextureCubeLod\\b"), "textureLod");
        source = std::regex_replace(source, std::regex("\\btextureCube\\b"), "texture");
        // textureSize2D (EXT_gpu_shader4) -> ES 3.00 textureSize; shaders assign the result to
        // a vec2, so wrap the ivec2 return in a vec2() conversion (ES has no implicit int->float).
        if (source.find("textureSize2D") != std::string::npos)
        {
            source = std::regex_replace(source, std::regex("\\btextureSize2D\\b"), "omw_textureSize2D");
            prelude += "vec2 omw_textureSize2D(highp sampler2D s, int lod) { return "
                       "vec2(textureSize(s, lod)); }\n";
        }

        // Desktop GLSL shadow2D*() return vec4 (shaders do `.r` on the result); the ES 3.00
        // equivalents textureProj/texture on a sampler2DShadow return a plain float, so a
        // direct rename breaks compilation ("field selection on float"). Wrap instead.
        if (source.find("shadow2DProj") != std::string::npos)
        {
            source = std::regex_replace(source, std::regex("\\bshadow2DProj\\b"), "omw_shadow2DProj");
            prelude += "vec4 omw_shadow2DProj(highp sampler2DShadow s, highp vec4 c) { return "
                       "vec4(textureProj(s, c)); }\n";
        }
        if (std::regex_search(source, std::regex("\\bshadow2D\\b")))
        {
            source = std::regex_replace(source, std::regex("\\bshadow2D\\b"), "omw_shadow2D");
            prelude += "vec4 omw_shadow2D(highp sampler2DShadow s, highp vec3 c) { return "
                       "vec4(texture(s, c)); }\n";
        }

        // Line-based fixups (std::regex on large merged sources risks catastrophic backtracking):
        // - ES disallows uniform initializers ("uniform float x = 1.0;" -> "uniform float x;")
        // - desktop #extension directives (e.g. GL_EXT_gpu_shader4) are invalid in WebGL2 and,
        //   after merging, land mid-source where they would be illegal anyway.
        {
            std::string fixed;
            fixed.reserve(source.size());
            std::size_t pos = 0;
            while (pos < source.size())
            {
                std::size_t eol = source.find('\n', pos);
                std::string_view line(source.data() + pos, (eol == std::string::npos ? source.size() : eol) - pos);
                std::size_t firstNonWs = line.find_first_not_of(" \t");
                bool drop = false;
                if (firstNonWs != std::string_view::npos && line.substr(firstNonWs).starts_with("#extension"))
                    drop = true;
                std::string out(line);
                if (!drop && firstNonWs != std::string_view::npos && line.substr(firstNonWs).starts_with("uniform"))
                {
                    std::size_t eq = out.find('=');
                    std::size_t semi = out.find(';');
                    if (eq != std::string::npos && (semi == std::string::npos || eq < semi))
                        out = out.substr(0, eq) + ";";
                }
                if (!drop)
                {
                    fixed += out;
                    fixed += '\n';
                }
                if (eol == std::string::npos)
                    break;
                pos = eol + 1;
            }
            source.swap(fixed);
        }

        // Fixed-function material state -> uniforms (no fixed-function in GLES). Use FLAT (non-struct)
        // uniforms, not a struct: struct-MEMBER uniforms (osg_FrontMaterial.diffuse …) do NOT reliably
        // apply on WebGL2/ANGLE — they silently read as 0 (black). That is what turned the sky black
        // (fixed in skyutil.cpp) and what makes SrcIgnore/unlit particles (chimney/hearth smoke) source
        // a black material RGB -> "grey where thin, black where dense" plumes. Expanding each member
        // access to a plain uniform sidesteps the struct-apply bug for every shader at once.
        if (source.find("gl_FrontMaterial") != std::string::npos)
        {
            prelude += "uniform vec4 osg_FrontMaterial_emission;\nuniform vec4 osg_FrontMaterial_ambient;\n"
                       "uniform vec4 osg_FrontMaterial_diffuse;\nuniform vec4 osg_FrontMaterial_specular;\n"
                       "uniform float osg_FrontMaterial_shininess;\n";
            for (const char* m : { "emission", "ambient", "diffuse", "specular", "shininess" })
                source = std::regex_replace(source,
                    std::regex(std::string("\\bgl_FrontMaterial\\s*\\.\\s*") + m + "\\b"),
                    std::string("osg_FrontMaterial_") + m);
        }
        if (source.find("gl_Fog") != std::string::npos)
        {
            // Same struct-member-uniform ANGLE bug as gl_FrontMaterial above: osg_Fog.<member>
            // silently reads 0, so fog stayed disabled (grey haze / no distance fog). Flatten each
            // member to a plain uniform, fed per-frame by SceneUtil::StateUpdater on emscripten.
            prelude += "uniform vec4 osg_Fog_color;\nuniform float osg_Fog_start;\nuniform float osg_Fog_end;\n"
                       "uniform float osg_Fog_scale;\nuniform float osg_Fog_density;\n";
            for (const char* m : { "color", "start", "end", "scale", "density" })
                source = std::regex_replace(source,
                    std::regex(std::string("\\bgl_Fog\\s*\\.\\s*") + m + "\\b"), std::string("osg_Fog_") + m);
        }

        if (type == osg::Shader::VERTEX)
        {
            // Fixed-function vertex attributes -> generic attributes. OSG binds these names to
            // the right locations (Program: getUseVertexAttributeAliasing) regardless of source.
            convert("gl_Vertex", "osg_Vertex", "in vec4 osg_Vertex;");
            convert("gl_Normal", "osg_Normal", "in vec3 osg_Normal;");
            convert("gl_Color", "osg_Color", "in vec4 osg_Color;");
            for (int i = 0; i < 8; ++i)
            {
                const std::string n = std::to_string(i);
                convert("gl_MultiTexCoord" + n, "osg_MultiTexCoord" + n, "in vec4 osg_MultiTexCoord" + n + ";");
            }
            // gl_ClipVertex was removed in ES 3.00; route writes to a dummy (clipping disabled).
            convert("gl_ClipVertex", "osg_ClipVertex", "vec4 osg_ClipVertex;");

            source = std::regex_replace(source, std::regex("\\battribute\\b"), "in");
            source = std::regex_replace(source, std::regex("\\bvarying\\b"), "out");
        }
        else if (type == osg::Shader::FRAGMENT)
        {
            source = std::regex_replace(source, std::regex("\\bvarying\\b"), "in");

            for (int i = 0; i < 4; ++i)
            {
                const std::string idx = "gl_FragData[" + std::to_string(i) + "]";
                if (source.find(idx) == std::string::npos)
                    continue;
                const std::string name = "_fragData" + std::to_string(i);
                prelude += "layout(location=" + std::to_string(i) + ") out vec4 " + name + ";\n";
                for (std::size_t p = source.find(idx); p != std::string::npos; p = source.find(idx))
                    source.replace(p, idx.size(), name);
            }
            if (source.find("gl_FragColor") != std::string::npos)
            {
                prelude += "layout(location=0) out vec4 _fragColor;\n";
                source = std::regex_replace(source, std::regex("\\bgl_FragColor\\b"), "_fragColor");
            }
        }

        // Inject all generated declarations at the marker (after the precision header).
        std::size_t mpos = source.find(marker);
        if (mpos != std::string::npos)
            source.replace(mpos, std::strlen(marker), prelude);
    }
#endif

    std::string_view getRootPrefix(std::string_view path)
    {
        if (path.starts_with("lib"))
            return "lib";
        else if (path.starts_with("compatibility"))
            return "compatibility";
        else if (path.starts_with("core"))
            return "core";
        return {};
    }

    int getLineNumber(std::string_view source, std::size_t foundPos, int lineNumber, int offset)
    {
        constexpr std::string_view tag = "#line";
        std::size_t lineDirectivePosition = source.rfind(tag, foundPos);
        if (lineDirectivePosition != std::string_view::npos)
        {
            std::size_t lineNumberStart = lineDirectivePosition + tag.size() + 1;
            std::size_t lineNumberEnd = source.find_first_not_of("0123456789", lineNumberStart);
            std::string_view lineNumberString = source.substr(lineNumberStart, lineNumberEnd - lineNumberStart);
            lineNumber = Misc::StringUtils::toNumeric<int>(lineNumberString, 2) + offset;
        }
        else
        {
            lineDirectivePosition = 0;
        }
        lineNumber
            += static_cast<int>(std::count(source.begin() + lineDirectivePosition, source.begin() + foundPos, '\n'));
        return lineNumber;
    }

    bool addLineDirectivesAfterConditionalBlocks(std::string& source)
    {
        for (size_t position = 0; position < source.length();)
        {
            size_t foundPos = source.find("#endif", position);
            foundPos = std::min(foundPos, source.find("#elif", position));
            foundPos = std::min(foundPos, source.find("#else", position));

            if (foundPos == std::string::npos)
                break;

            foundPos = source.find_first_of("\n\r", foundPos);
            foundPos = source.find_first_not_of("\n\r", foundPos);

            if (foundPos == std::string::npos)
                break;

            int lineNumber = getLineNumber(source, foundPos, 1, -1);

            source.replace(foundPos, 0, std::format("#line {}\n", lineNumber));

            position = foundPos;
        }

        return true;
    }

    // Recursively replaces include statements with the actual source of the included files.
    // Adjusts #line statements accordingly and detects cyclic includes.
    // cycleIncludeChecker is the set of files that include this file directly or indirectly, and is intentionally not a
    // reference to allow automatic cleanup.
    bool parseIncludes(const std::filesystem::path& shaderPath, std::string& source, const std::string& fileName,
        int& fileNumber, std::set<std::filesystem::path> cycleIncludeChecker,
        std::set<std::filesystem::path>& includedFiles, bool dedupe = false)
    {
        includedFiles.insert(shaderPath / fileName);
        // An include is cyclic if it is being included by itself
        if (cycleIncludeChecker.insert(shaderPath / fileName).second == false)
        {
            Log(Debug::Error) << "Shader " << fileName << " error: Detected cyclic #includes";
            return false;
        }

        Misc::StringUtils::replaceAll(source, "\r\n", "\n");

        size_t foundPos = 0;
        while ((foundPos = source.find("#include")) != std::string::npos)
        {
            size_t start = source.find('"', foundPos);
            if (start == std::string::npos || start == source.size() - 1)
            {
                Log(Debug::Error) << "Shader " << fileName << " error: Invalid #include";
                return false;
            }
            size_t end = source.find('"', start + 1);
            if (end == std::string::npos)
            {
                Log(Debug::Error) << "Shader " << fileName << " error: Invalid #include";
                return false;
            }
            std::string includeFilename = source.substr(start + 1, end - (start + 1));

            // Check if this include is a relative path
            // TODO: We shouldn't be relying on soft-coded root prefixes, just check if the path exists and fallback to
            // searching root if it doesn't
            if (getRootPrefix(includeFilename).empty())
                includeFilename
                    = Files::pathToUnicodeString(std::filesystem::path(fileName).parent_path() / includeFilename);

            std::filesystem::path includePath = shaderPath / includeFilename;

            // In dedupe mode (merging $link'd shaders into one for WebGL), skip a file that has
            // already been included anywhere in the merged unit to avoid redefinition errors.
            if (dedupe && includedFiles.count(includePath))
            {
                source.replace(foundPos, (end - foundPos + 1), "");
                continue;
            }

            // Determine the line number that will be used for the #line directive following the included source
            int lineNumber = getLineNumber(source, foundPos, 0, -1);

            // Include the file recursively
            std::ifstream includeFstream;
            includeFstream.open(includePath);
            if (includeFstream.fail())
            {
                Log(Debug::Error) << "Shader " << fileName << " error: Failed to open include " << includePath << ": "
                                  << std::generic_category().message(errno);
                return false;
            }
            int includedFileNumber = fileNumber++;

            std::stringstream buffer;
            buffer << includeFstream.rdbuf();
            std::string stringRepresentation = buffer.str();
            if (!addLineDirectivesAfterConditionalBlocks(stringRepresentation)
                || !parseIncludes(shaderPath, stringRepresentation, includeFilename, fileNumber,
                    cycleIncludeChecker, includedFiles, dedupe))
            {
                Log(Debug::Error) << "In file included from " << fileName << "." << lineNumber;
                return false;
            }

            std::stringstream toInsert;
            toInsert << "#line 0 " << includedFileNumber << "\n"
                     << stringRepresentation << "\n#line " << lineNumber << " 0\n";

            source.replace(foundPos, (end - foundPos + 1), toInsert.str());
        }
        return true;
    }
}

namespace Shader
{
    struct HotReloadManager
    {
        using KeysHolder = std::set<ShaderManager::MapKey>;

        std::unordered_map<std::string, KeysHolder> mShaderFiles;
        std::unordered_map<std::string, std::set<std::filesystem::path>> templateIncludedFiles;
        std::filesystem::file_time_type mLastAutoRecompileTime;
        bool mHotReloadEnabled;
        bool mTriggerReload;

        HotReloadManager()
        {
            mTriggerReload = false;
            mHotReloadEnabled = false;
            mLastAutoRecompileTime = std::filesystem::file_time_type::clock::now();
        }

        void addShaderFiles(const std::string& templateName, const ShaderManager::DefineMap& defines)
        {
            const std::set<std::filesystem::path>& shaderFiles = templateIncludedFiles[templateName];
            for (const std::filesystem::path& file : shaderFiles)
            {
                mShaderFiles[Files::pathToUnicodeString(file)].insert(std::make_pair(templateName, defines));
            }
        }

        void update(ShaderManager& manager, osgViewer::Viewer& viewer)
        {
            auto timeSinceLastCheckMillis = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::filesystem::file_time_type::clock::now() - mLastAutoRecompileTime);
            if ((mHotReloadEnabled && timeSinceLastCheckMillis.count() > 200) || mTriggerReload == true)
            {
                reloadTouchedShaders(manager, viewer);
            }
            mTriggerReload = false;
        }

        void reloadTouchedShaders(ShaderManager& manager, osgViewer::Viewer& viewer)
        {
            bool threadsRunningToStop = false;
            for (auto& [pathShaderToTest, shaderKeys] : mShaderFiles)
            {
                const std::filesystem::file_time_type writeTime = std::filesystem::last_write_time(pathShaderToTest);
                if (writeTime.time_since_epoch() > mLastAutoRecompileTime.time_since_epoch())
                {
                    if (!threadsRunningToStop)
                    {
                        threadsRunningToStop = viewer.areThreadsRunning();
                        if (threadsRunningToStop)
                            viewer.stopThreading();
                    }

                    for (const auto& [templateName, shaderDefines] : shaderKeys)
                    {
                        ShaderManager::ShaderMap::iterator shaderIt
                            = manager.mShaders.find(std::make_pair(templateName, shaderDefines));
                        if (shaderIt == manager.mShaders.end())
                        {
                            Log(Debug::Error) << "Failed to find shader " << templateName;
                            continue;
                        }

                        ShaderManager::TemplateMap::iterator templateIt = manager.mShaderTemplates.find(
                            templateName); // Can't be Null, if we're here it means the template was added
                        assert(templateIt != manager.mShaderTemplates.end());
                        std::string& shaderSource = templateIt->second;
                        std::set<std::filesystem::path> insertedPaths;
                        std::filesystem::path path = (std::filesystem::path(manager.mPath) / templateName);
                        std::ifstream stream;
                        stream.open(path);
                        if (stream.fail())
                        {
                            Log(Debug::Error)
                                << "Failed to open " << path << ": " << std::generic_category().message(errno);
                            continue;
                        }
                        std::stringstream buffer;
                        buffer << stream.rdbuf();

                        // parse includes
                        int fileNumber = 1;
                        std::string source = buffer.str();
                        if (!addLineDirectivesAfterConditionalBlocks(source)
                            || !parseIncludes(std::filesystem::path(manager.mPath), source, templateName, fileNumber,
                                {}, insertedPaths))
                        {
                            break;
                        }
                        shaderSource = std::move(source);

                        std::vector<std::string> linkedShaderNames;
                        if (!manager.createSourceFromTemplate(
                                shaderSource, linkedShaderNames, templateName, shaderDefines))
                        {
                            break;
                        }
                        shaderIt->second->setShaderSource(shaderSource);
                    }
                }
            }
            if (threadsRunningToStop)
                viewer.startThreading();
            mLastAutoRecompileTime = std::filesystem::file_time_type::clock::now();
        }
    };

    ShaderManager::ShaderManager()
    {
        mHotReloadManager = std::make_unique<HotReloadManager>();
    }

    ShaderManager::~ShaderManager() = default;

    void ShaderManager::setShaderPath(const std::filesystem::path& path)
    {
        mPath = path;
    }

    bool parseForeachDirective(std::string& source, const std::string& templateName, size_t foundPos)
    {
        constexpr std::string_view directiveStart = "$foreach";
        size_t iterNameStart = foundPos + directiveStart.size() + 1;
        size_t iterNameEnd = source.find_first_of(" \n\r()[].;,", iterNameStart);
        if (iterNameEnd == std::string::npos)
        {
            Log(Debug::Error) << "Shader " << templateName << " error: Unexpected EOF";
            return false;
        }
        std::string iteratorName = "$" + source.substr(iterNameStart, iterNameEnd - iterNameStart);

        size_t listStart = iterNameEnd + 1;
        size_t listEnd = source.find_first_of("\n\r", listStart);
        if (listEnd == std::string::npos)
        {
            Log(Debug::Error) << "Shader " << templateName << " error: Unexpected EOF";
            return false;
        }
        std::string_view list = std::string_view(source).substr(listStart, listEnd - listStart);
        std::vector<std::string> listElements;
        if (!list.empty())
            Misc::StringUtils::split(list, listElements, ",");

        size_t contentStart = source.find_first_not_of("\n\r", listEnd);
        constexpr std::string_view directiveEnd = "$endforeach";
        size_t contentEnd = source.find(directiveEnd, contentStart);
        if (contentEnd == std::string::npos)
        {
            Log(Debug::Error) << "Shader " << templateName << " error: Unexpected EOF";
            return false;
        }
        std::string_view content = std::string_view(source).substr(contentStart, contentEnd - contentStart);

        size_t overallEnd = contentEnd + directiveEnd.size();

        int lineNumber = getLineNumber(source, overallEnd, 2, 0);

        std::string replacement;
        for (const std::string& element : listElements)
        {
            std::string contentInstance(content);
            size_t foundIterator;
            while ((foundIterator = contentInstance.find(iteratorName)) != std::string::npos)
                contentInstance.replace(foundIterator, iteratorName.length(), element);
            replacement += contentInstance;
        }
        replacement += "\n#line " + std::to_string(lineNumber);
        source.replace(foundPos, overallEnd - foundPos, replacement);
        return true;
    }

    bool parseLinkDirective(
        std::string& source, std::string& linkTarget, const std::string& templateName, size_t foundPos)
    {
        size_t endPos = foundPos + 5;
        size_t lineEnd = source.find_first_of('\n', endPos);
        // If lineEnd = npos, this is the last line, so no need to check
        std::string linkStatement = source.substr(endPos, lineEnd - endPos);
        std::regex linkRegex(R"r(\s*"([^"]+)"\s*)r" // Find any quoted string as the link name -> match[1]
                             R"r((if\s+)r" // Begin optional condition -> match[2]
                             R"r((!)?\s*)r" // Optional ! -> match[3]
                             R"r(([_a-zA-Z0-9]+)?)r" // The condition -> match[4]
                             R"r()?\s*)r" // End optional condition -> match[2]
        );
        std::smatch linkMatch;
        bool hasCondition = false;
        std::string linkConditionExpression;
        if (std::regex_match(linkStatement, linkMatch, linkRegex))
        {
            linkTarget = linkMatch[1].str();
            hasCondition = !linkMatch[2].str().empty();
            linkConditionExpression = linkMatch[4].str();
        }
        else
        {
            Log(Debug::Error) << "Shader " << templateName << " error: Expected a shader filename to link";
            return false;
        }
        if (linkTarget.empty())
        {
            Log(Debug::Error) << "Shader " << templateName << " error: Empty link name";
            return false;
        }

        if (hasCondition)
        {
            bool condition = !(linkConditionExpression.empty() || linkConditionExpression == "0");
            if (linkMatch[3].str() == "!")
                condition = !condition;

            if (!condition)
                linkTarget.clear();
        }

        source.replace(foundPos, lineEnd - foundPos, "");
        return true;
    }

    bool parseDirectives(std::string& source, std::vector<std::string>& linkedShaderTemplateNames,
        const ShaderManager::DefineMap& defines, const ShaderManager::DefineMap& globalDefines,
        const std::string& templateName)
    {
        const char escapeCharacter = '$';
        size_t foundPos = 0;

        while ((foundPos = source.find(escapeCharacter, foundPos)) != std::string::npos)
        {
            size_t endPos = source.find_first_of(" \n\r()[].;,", foundPos);
            if (endPos == std::string::npos)
            {
                Log(Debug::Error) << "Shader " << templateName << " error: Unexpected EOF";
                return false;
            }
            std::string_view directive = std::string_view(source).substr(foundPos + 1, endPos - (foundPos + 1));
            if (directive == "foreach")
            {
                if (!parseForeachDirective(source, templateName, foundPos))
                    return false;
            }
            else if (directive == "link")
            {
                std::string linkTarget;
                if (!parseLinkDirective(source, linkTarget, templateName, foundPos))
                    return false;
                if (!linkTarget.empty() && linkTarget != templateName)
                    linkedShaderTemplateNames.push_back(std::move(linkTarget));
            }
            else
            {
                Log(Debug::Error) << "Shader " << templateName << " error: Unknown shader directive: $" << directive;
                return false;
            }
        }

        return true;
    }

    bool parseDefines(std::string& source, const ShaderManager::DefineMap& defines,
        const ShaderManager::DefineMap& globalDefines, const std::string& templateName)
    {
        const char escapeCharacter = '@';
        size_t foundPos = 0;
        std::vector<std::string> forIterators;
        while ((foundPos = source.find(escapeCharacter)) != std::string::npos)
        {
            size_t endPos = source.find_first_of(" \n\r()[].;,", foundPos);
            if (endPos == std::string::npos)
            {
                Log(Debug::Error) << "Shader " << templateName << " error: Unexpected EOF";
                return false;
            }
            std::string define = source.substr(foundPos + 1, endPos - (foundPos + 1));
            ShaderManager::DefineMap::const_iterator defineFound = defines.find(define);
            ShaderManager::DefineMap::const_iterator globalDefineFound = globalDefines.find(define);
            if (define == "foreach")
            {
                source.replace(foundPos, 1, "$");
                size_t iterNameStart = endPos + 1;
                size_t iterNameEnd = source.find_first_of(" \n\r()[].;,", iterNameStart);
                if (iterNameEnd == std::string::npos)
                {
                    Log(Debug::Error) << "Shader " << templateName << " error: Unexpected EOF";
                    return false;
                }
                forIterators.push_back(source.substr(iterNameStart, iterNameEnd - iterNameStart));
            }
            else if (define == "endforeach")
            {
                source.replace(foundPos, 1, "$");
                if (forIterators.empty())
                {
                    Log(Debug::Error) << "Shader " << templateName << " error: endforeach without foreach";
                    return false;
                }
                else
                    forIterators.pop_back();
            }
            else if (define == "link")
            {
                source.replace(foundPos, 1, "$");
            }
            else if (std::find(forIterators.begin(), forIterators.end(), define) != forIterators.end())
            {
                source.replace(foundPos, 1, "$");
            }
            else if (defineFound != defines.end())
            {
                source.replace(foundPos, endPos - foundPos, defineFound->second);
            }
            else if (globalDefineFound != globalDefines.end())
            {
                source.replace(foundPos, endPos - foundPos, globalDefineFound->second);
            }
            else
            {
                Log(Debug::Error) << "Shader " << templateName << " error: Undefined " << define;
                return false;
            }
        }
        return true;
    }

#ifdef __EMSCRIPTEN__
    void ShaderManager::mergeLinkedShadersForGLES(std::string& shaderSource,
        std::vector<std::string>& linkedShaderNames, const DefineMap& defines, osg::Shader::Type type)
    {
        // WebGL permits only one shader per pipeline stage, so OpenMW's $link'd shader
        // objects can't be linked separately (modelToClip()/pointLighting() would be
        // undefined). Inline their processed source so the stage is a single unit.
        for (const auto& linkedName : linkedShaderNames)
        {
            auto lit = mShaderTemplates.find(linkedName);
            if (lit == mShaderTemplates.end())
            {
                std::ifstream lstream(mPath / linkedName);
                if (lstream.fail())
                    continue;
                std::stringstream lbuf;
                lbuf << lstream.rdbuf();
                std::string lsrc = lbuf.str();
                int fn = 1;
                std::set<std::filesystem::path> lpaths;
                if (!addLineDirectivesAfterConditionalBlocks(lsrc)
                    || !parseIncludes(mPath, lsrc, linkedName, fn, {}, lpaths))
                    continue;
                lit = mShaderTemplates.insert(std::make_pair(linkedName, lsrc)).first;
            }
            std::string linkedSource = lit->second;
            std::vector<std::string> nested;
            if (!createSourceFromTemplate(linkedSource, nested, linkedName, defines))
                continue;
            std::size_t v = linkedSource.find("#version");
            if (v != std::string::npos)
            {
                std::size_t e = linkedSource.find('\n', v);
                linkedSource.erase(v, (e == std::string::npos ? linkedSource.size() : e + 1) - v);
            }
            shaderSource += "\n" + linkedSource;
        }
        linkedShaderNames.clear();
        // The merged units share #includes; drop the resulting duplicate definitions.
        dedupeTopLevelDefinitions(shaderSource);
        adjustSourceForGLES(shaderSource, type);
    }
#endif

    osg::ref_ptr<osg::Shader> ShaderManager::getShader(
        std::string templateName, const ShaderManager::DefineMap& defines, std::optional<osg::Shader::Type> type)
    {
        std::unique_lock<std::mutex> lock(mMutex);

        // TODO: Implement mechanism to switch to core or compatibility profile shaders.
        // This logic is temporary until core support is supported.
        if (getRootPrefix(templateName).empty())
            templateName = "compatibility/" + templateName;

        // read the template if we haven't already
        TemplateMap::iterator templateIt = mShaderTemplates.find(templateName);
        std::set<std::filesystem::path> insertedPaths;

        if (templateIt == mShaderTemplates.end())
        {
            std::filesystem::path path = mPath / templateName;
            std::ifstream stream;
            stream.open(path);
            if (stream.fail())
            {
                Log(Debug::Error) << "Failed to open shader " << path << ": " << std::generic_category().message(errno);
                return nullptr;
            }
            std::stringstream buffer;
            buffer << stream.rdbuf();

            // parse includes
            int fileNumber = 1;
            std::string source = buffer.str();
            if (!addLineDirectivesAfterConditionalBlocks(source)
                || !parseIncludes(mPath, source, templateName, fileNumber, {}, insertedPaths))
                return nullptr;
            mHotReloadManager->templateIncludedFiles[templateName] = std::move(insertedPaths);
            templateIt = mShaderTemplates.insert(std::make_pair(templateName, source)).first;
        }

        ShaderMap::iterator shaderIt = mShaders.find(std::make_pair(templateName, defines));
        if (shaderIt == mShaders.end())
        {
#ifdef __EMSCRIPTEN__
            // F14 measurement, and the prerequisite for the bake itself.
            //
            // A cache MISS here is a permutation being built for the first time: the $link inlining
            // pass, dedupeTopLevelDefinitions, and adjustSourceForGLES with its ~22 inline
            // std::regex constructions plus per-member regexes in loops -- all over the full merged
            // source, in wasm, on the main thread, at the moment a new material first appears.
            //
            // Baking that offline needs one thing first: knowing WHICH permutations the game
            // actually asks for. The define space is large and partly data-driven, so it cannot be
            // enumerated from the source -- it has to be recorded from a real playthrough. This is
            // that recorder. Count misses, and publish the keys so a build step can consume them.
            //
            // Zero cost on the hit path: this block is only reached when the permutation is new.
            {
                static int sMisses = 0;
                ++sMisses;
                std::string key = templateName;
                for (const auto& [k, v] : defines)
                    key += "|" + k + "=" + v;
                // clang-format off
                EM_ASM({
                    var list = window.__omwShaderKeys || [];
                    list.push(UTF8ToString($0));
                    window.__omwShaderKeys = list;
                    window.__omwShaderMisses = $1;
                }, key.c_str(), sMisses);
                // clang-format on
            }
#endif
            std::string shaderSource = templateIt->second;
            std::vector<std::string> linkedShaderNames;
            if (!createSourceFromTemplate(shaderSource, linkedShaderNames, templateName, defines))
            {
                // Add to the cache anyway to avoid logging the same error over and over.
                mShaders.insert(std::make_pair(std::make_pair(templateName, defines), nullptr));
                return nullptr;
            }

            osg::Shader::Type shaderType = type ? *type : getShaderType(templateName);
#ifdef __EMSCRIPTEN__
            mergeLinkedShadersForGLES(shaderSource, linkedShaderNames, defines, shaderType);
#endif
            osg::ref_ptr<osg::Shader> shader(new osg::Shader(shaderType));
            shader->setShaderSource(shaderSource);
            // Assign a unique prefix to allow the SharedStateManager to compare shaders efficiently.
            // Append shader source filename for debugging.
            static unsigned int counter = 0;
            shader->setName(std::format("{} {}", counter++, templateName));

            mHotReloadManager->addShaderFiles(templateName, defines);

            lock.unlock();
            getLinkedShaders(shader, linkedShaderNames, defines);
            lock.lock();

            shaderIt = mShaders.insert(std::make_pair(std::make_pair(templateName, defines), shader)).first;
        }
        return shaderIt->second;
    }

    osg::ref_ptr<osg::Program> ShaderManager::getProgram(
        const std::string& templateName, const DefineMap& defines, const osg::Program* programTemplate)
    {
        auto vert = getShader(templateName + ".vert", defines);
        auto frag = getShader(templateName + ".frag", defines);

        if (!vert || !frag)
            throw std::runtime_error("failed initializing shader: " + templateName);

        return getProgram(std::move(vert), std::move(frag), programTemplate);
    }

    osg::ref_ptr<osg::Uniform> ShaderManager::getSamplerUniform(const std::string& name, int unit)
    {
        std::lock_guard<std::mutex> lock(mMutex);
        auto& uniform = mSamplerUniforms[{ unit, name }];
        if (!uniform)
            uniform = new osg::Uniform(name.c_str(), unit);
        return uniform;

    }
    osg::ref_ptr<osg::Program> ShaderManager::getProgram(osg::ref_ptr<osg::Shader> vertexShader,
        osg::ref_ptr<osg::Shader> fragmentShader, const osg::Program* programTemplate)
    {
        std::lock_guard<std::mutex> lock(mMutex);
        ProgramMap::iterator found = mPrograms.find(std::make_pair(vertexShader, fragmentShader));
        if (found == mPrograms.end())
        {
            if (!programTemplate)
                programTemplate = mProgramTemplate;
            osg::ref_ptr<osg::Program> program
                = programTemplate ? cloneProgram(programTemplate) : osg::ref_ptr<osg::Program>(new osg::Program);
            program->addShader(vertexShader);
            program->addShader(fragmentShader);
            addLinkedShaders(vertexShader, program);
            addLinkedShaders(fragmentShader, program);

            found = mPrograms.insert(std::make_pair(std::make_pair(vertexShader, fragmentShader), program)).first;
        }
        return found->second;
    }

    osg::ref_ptr<osg::Program> ShaderManager::cloneProgram(const osg::Program* src)
    {
        osg::ref_ptr<osg::Program> program = static_cast<osg::Program*>(src->clone(osg::CopyOp::SHALLOW_COPY));
        for (auto& [name, idx] : src->getUniformBlockBindingList())
            program->addBindUniformBlock(name, idx);
        return program;
    }

    ShaderManager::DefineMap ShaderManager::getGlobalDefines()
    {
        return DefineMap(mGlobalDefines);
    }

    void ShaderManager::setGlobalDefines(DefineMap& globalDefines)
    {
        mGlobalDefines = globalDefines;
        // clear out linked dependencies - changing defines may make them obsolete
        for (const auto& [pair, program] : mPrograms)
        {
            for (unsigned int i = 0; i < program->getNumShaders();)
            {
                if (program->getShader(i) != pair.first && program->getShader(i) != pair.second)
                    program->removeShader(program->getShader(i));
                else
                    ++i;
            }
        }
        for (const auto& [key, shader] : mShaders)
        {
            std::string templateId = key.first;
            ShaderManager::DefineMap defines = key.second;
            if (shader == nullptr)
                // I'm not sure how to handle a shader that was already broken as there's no way to get a potential
                // replacement to the nodes that need it.
                continue;
            std::string shaderSource = mShaderTemplates[templateId];
            std::vector<std::string> linkedShaderNames;
            if (!createSourceFromTemplate(shaderSource, linkedShaderNames, templateId, defines))
                // We just broke the shader and there's no way to force existing objects back to fixed-function mode as
                // we would when creating the shader. If we put a nullptr in the shader map, we just lose the ability to
                // put a working one in later.
                continue;
#ifdef __EMSCRIPTEN__
            // Same single-shader-per-stage merge as getShader(): inline $link'd shaders so this
            // reprocessing path doesn't recreate the separate (unlinkable in WebGL) shader objects.
            mergeLinkedShadersForGLES(shaderSource, linkedShaderNames, defines, shader->getType());
#endif
            shader->setShaderSource(shaderSource);

            getLinkedShaders(shader, linkedShaderNames, defines);
        }
        for (const auto& [pair, program] : mPrograms)
        {
            addLinkedShaders(pair.first, program);
            addLinkedShaders(pair.second, program);
        }
    }

    void ShaderManager::releaseGLObjects(osg::State* state)
    {
        std::lock_guard<std::mutex> lock(mMutex);
        for (const auto& [_, shader] : mShaders)
        {
            if (shader != nullptr)
                shader->releaseGLObjects(state);
        }
        for (const auto& [_, program] : mPrograms)
            program->releaseGLObjects(state);
    }

    bool ShaderManager::createSourceFromTemplate(std::string& source,
        std::vector<std::string>& linkedShaderTemplateNames, const std::string& templateName,
        const ShaderManager::DefineMap& defines)
    {
        if (!parseDefines(source, defines, mGlobalDefines, templateName))
            return false;
        if (!parseDirectives(source, linkedShaderTemplateNames, defines, mGlobalDefines, templateName))
            return false;
        return true;
    }

    void ShaderManager::getLinkedShaders(
        osg::ref_ptr<osg::Shader> shader, const std::vector<std::string>& linkedShaderNames, const DefineMap& defines)
    {
        mLinkedShaders.erase(shader);
        if (linkedShaderNames.empty())
            return;

        for (auto& linkedShaderName : linkedShaderNames)
        {
            auto linkedShader = getShader(linkedShaderName, defines, shader->getType());
            if (linkedShader)
                mLinkedShaders[shader].emplace_back(linkedShader);
        }
    }

    void ShaderManager::addLinkedShaders(osg::ref_ptr<osg::Shader> shader, osg::ref_ptr<osg::Program> program)
    {
        auto linkedIt = mLinkedShaders.find(shader);
        if (linkedIt != mLinkedShaders.end())
            for (const auto& linkedShader : linkedIt->second)
                program->addShader(linkedShader);
    }

    int ShaderManager::reserveGlobalTextureUnits(Slot slot, int count)
    {
        // TODO: Reuse units when count increase forces reallocation
        // TODO: Warn if trampling on the ~8 units needed by model textures
        auto unit = mReservedTextureUnitsBySlot[static_cast<int>(slot)];
        if (unit.index >= 0 && unit.count >= count)
            return unit.index;

        if (getAvailableTextureUnits() < count + 1)
            throw std::runtime_error("Can't reserve texture unit; no available units");
        mReservedTextureUnits += count;

        unit.index = mMaxTextureUnits - mReservedTextureUnits;
        unit.count = count;

        mReservedTextureUnitsBySlot[static_cast<int>(slot)] = unit;

        std::string_view slotDescr;
        switch (slot)
        {
            case Slot::OpaqueDepthTexture:
                slotDescr = "opaque depth texture";
                break;
            case Slot::SkyTexture:
                slotDescr = "sky RTT";
                break;
            case Slot::ShadowMaps:
                slotDescr = "shadow maps";
                break;
            default:
                slotDescr = "UNKNOWN";
        }
        if (unit.count == 1)
            Log(Debug::Info) << "Reserving texture unit for " << slotDescr << ": " << unit.index;
        else
            Log(Debug::Info) << "Reserving texture units for " << slotDescr << ": " << unit.index << ".."
                             << (unit.index + count - 1);

        return unit.index;
    }

    void ShaderManager::update(osgViewer::Viewer& viewer)
    {
        mHotReloadManager->update(*this, viewer);
    }

    void ShaderManager::setHotReloadEnabled(bool value)
    {
        mHotReloadManager->mHotReloadEnabled = value;
    }

    void ShaderManager::triggerShaderReload()
    {
        mHotReloadManager->mTriggerReload = true;
    }

    ShaderManager::DefineMap getDefaultDefines()
    {
        return {
            { "forcePPL", "0" },
            { "clamp", "1" },
            { "preLightEnv", "0" },
            { "radialFog", "0" },
            { "exponentialFog", "0" },
            { "reverseZ", "0" },
            { "waterRefraction", "0" },
            { "classicFalloff", "1" },
            { "skyBlending", "0" },
            { "disableNormals", "1" },
            { "useGPUShader4", "0" },
            { "useOVR_multiview", "0" },
            { "distorionRTRatio", "0" },
            { "numViews", "1" },
            { "particle", "0" },
            { "particlePointLighting", "1" },
            { "useGLES", "0" },
        };
    }
}
