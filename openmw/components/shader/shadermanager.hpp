// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#ifndef OPENMW_COMPONENTS_SHADERMANAGER_H
#define OPENMW_COMPONENTS_SHADERMANAGER_H

#include <array>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include <osg/Program>
#include <osg/Shader>
#include <osg/Uniform>
#include <osg/ref_ptr>

namespace osgViewer
{
    class Viewer;
}

namespace Shader
{
    struct HotReloadManager;
    /// @brief Reads shader template files and turns them into a concrete shader, based on a list of define's.
    /// @par Shader templates can get the value of a define with the syntax @define.
    class ShaderManager
    {
    public:
        friend HotReloadManager;
        ShaderManager();
        ~ShaderManager();

        void setShaderPath(const std::filesystem::path& path);

        typedef std::map<std::string, std::string> DefineMap;

        /// Create or retrieve a shader instance.
        /// @param templateName The path of the shader template.
        /// @param defines Define values that can be retrieved by the shader template.
        /// @param shaderType The type of shader (usually vertex or fragment shader).
        /// @note May return nullptr on failure.
        /// @note Thread safe.
        osg::ref_ptr<osg::Shader> getShader(std::string templateName, const DefineMap& defines = {},
            std::optional<osg::Shader::Type> type = std::nullopt);

        osg::ref_ptr<osg::Program> getProgram(const std::string& templateName, const DefineMap& defines = {},
            const osg::Program* programTemplate = nullptr);

        osg::ref_ptr<osg::Program> getProgram(osg::ref_ptr<osg::Shader> vertexShader,
            osg::ref_ptr<osg::Shader> fragmentShader, const osg::Program* programTemplate = nullptr);

        /// Interned sampler uniform: one shared osg::Uniform per (name, unit).
        ///
        /// osg::Program::PerContextProgram::apply dedups uniform uploads by POINTER IDENTITY
        /// (`lastAppliedUniform != &uniform` -> re-upload). ShaderVisitor used to allocate a fresh
        /// `new osg::Uniform(name, unit)` on every stateset, so consecutive draws sharing a program
        /// always saw a different pointer and re-sent glUniform1iv with a byte-identical value.
        /// Measured in Balmora: uniform1iv was 6.4% of all GL calls (26,783 in 5s).
        ///
        /// Safe to share unconditionally because the key IS the value -- a "diffuseMap"->unit-0
        /// uniform carries no other state, and these are never set() after construction.
        osg::ref_ptr<osg::Uniform> getSamplerUniform(const std::string& name, int unit);

        const osg::Program* getProgramTemplate() const { return mProgramTemplate; }
        void setProgramTemplate(const osg::Program* program) { mProgramTemplate = program; }

        /// Clone an osg::Program including bindUniformBlocks that osg::Program::clone does not copy for some reason.
        static osg::ref_ptr<osg::Program> cloneProgram(const osg::Program*);

        /// Get (a copy of) the DefineMap used to construct all shaders
        DefineMap getGlobalDefines();

        /// Set the DefineMap used to construct all shaders
        /// @param defines The DefineMap to use
        /// @note This will change the source code for any shaders already created, potentially causing problems if
        /// they're being used to render a frame. It is recommended that any associated Viewers have their threading
        /// stopped while this function is running if any shaders are in use.
        void setGlobalDefines(DefineMap& globalDefines);

        void releaseGLObjects(osg::State* state);

        bool createSourceFromTemplate(std::string& source, std::vector<std::string>& linkedShaderTemplateNames,
            const std::string& templateName, const ShaderManager::DefineMap& defines);

        void setMaxTextureUnits(int maxTextureUnits) { mMaxTextureUnits = maxTextureUnits; }
        int getMaxTextureUnits() const { return mMaxTextureUnits; }
        int getAvailableTextureUnits() const { return mMaxTextureUnits - mReservedTextureUnits; }

        enum class Slot
        {
            OpaqueDepthTexture,
            SkyTexture,
            ShadowMaps,
            SLOT_COUNT
        };

        int reserveGlobalTextureUnits(Slot slot, int count = 1);

        void update(osgViewer::Viewer& viewer);
        void setHotReloadEnabled(bool value);
        void triggerShaderReload();

    private:
        void getLinkedShaders(osg::ref_ptr<osg::Shader> shader, const std::vector<std::string>& linkedShaderNames,
            const DefineMap& defines);
        void addLinkedShaders(osg::ref_ptr<osg::Shader> shader, osg::ref_ptr<osg::Program> program);

#ifdef __EMSCRIPTEN__
        /// WebGL permits only one shader object per pipeline stage, so OpenMW's $link'd shader
        /// objects can't be linked separately. Inline their processed source into shaderSource
        /// (clearing linkedShaderNames), dedupe the shared declarations, and run the GLES
        /// source transform. Used by both getShader() and the setGlobalDefines() reprocess path.
        void mergeLinkedShadersForGLES(std::string& shaderSource, std::vector<std::string>& linkedShaderNames,
            const DefineMap& defines, osg::Shader::Type type);
#endif

        std::filesystem::path mPath;

        DefineMap mGlobalDefines;

        // <name, code>
        typedef std::map<std::string, std::string> TemplateMap;
        TemplateMap mShaderTemplates;

        typedef std::pair<std::string, DefineMap> MapKey;
        typedef std::map<MapKey, osg::ref_ptr<osg::Shader>> ShaderMap;
        ShaderMap mShaders;

        typedef std::map<std::pair<osg::ref_ptr<osg::Shader>, osg::ref_ptr<osg::Shader>>, osg::ref_ptr<osg::Program>>
            ProgramMap;
        ProgramMap mPrograms;

        typedef std::vector<osg::ref_ptr<osg::Shader>> ShaderList;
        typedef std::map<osg::ref_ptr<osg::Shader>, ShaderList> LinkedShadersMap;
        LinkedShadersMap mLinkedShaders;

        // Keyed on (unit, name): the same sampler name can legitimately land on different units
        // in different materials, and those must stay distinct uniforms.
        std::map<std::pair<int, std::string>, osg::ref_ptr<osg::Uniform>> mSamplerUniforms;

        std::mutex mMutex;

        osg::ref_ptr<const osg::Program> mProgramTemplate;

        int mMaxTextureUnits = 0;
        int mReservedTextureUnits = 0;
        std::unique_ptr<HotReloadManager> mHotReloadManager;
        struct ReservedTextureUnits
        {
            int index = -1;
            int count = 0;
        };
        std::array<ReservedTextureUnits, static_cast<int>(Slot::SLOT_COUNT)> mReservedTextureUnitsBySlot = {};
    };

    bool parseForeachDirective(std::string& source, const std::string& templateName, size_t foundPos);
    bool parseLinkDirective(
        std::string& source, std::string& linkTarget, const std::string& templateName, size_t foundPos);

    bool parseDefines(std::string& source, const ShaderManager::DefineMap& defines,
        const ShaderManager::DefineMap& globalDefines, const std::string& templateName);

    bool parseDirectives(std::string& source, std::vector<std::string>& linkedShaderTemplateNames,
        const ShaderManager::DefineMap& defines, const ShaderManager::DefineMap& globalDefines,
        const std::string& templateName);

    ShaderManager::DefineMap getDefaultDefines();
}

#endif
