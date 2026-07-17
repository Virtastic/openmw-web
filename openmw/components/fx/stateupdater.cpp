// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "stateupdater.hpp"

#include <osg/BufferIndexBinding>
#include <osg/BufferObject>

#include <components/resource/scenemanager.hpp>

namespace Fx
{
    std::string StateUpdater::sDefinition = UniformData::getDefinition("_omw_data");
    std::string StateUpdater::sFlatDefinition = UniformData::getFlatDefinition("omw_");

    // On ANGLE/WebGL2 the fx shaders declare flat `omw_<name>` uniforms (struct-member uniforms read
    // as 0 there), so the StateUpdater must set matching flat names. Desktop keeps the `omw.<name>`
    // struct-member uniforms.
#ifdef __EMSCRIPTEN__
    static constexpr std::string_view sOmwUniformPrefix = "omw_";
#else
    static constexpr std::string_view sOmwUniformPrefix = "omw.";
#endif

    StateUpdater::StateUpdater(bool useUBO)
        : mUseUBO(useUBO)
    {
    }

    void StateUpdater::setDefaults(osg::StateSet* stateset)
    {
        if (mUseUBO)
        {
            osg::ref_ptr<osg::UniformBufferObject> ubo = new osg::UniformBufferObject;

            osg::ref_ptr<osg::BufferTemplate<UniformData::BufferType>> data
                = new osg::BufferTemplate<UniformData::BufferType>();
            data->setBufferObject(ubo);

            osg::ref_ptr<osg::UniformBufferBinding> ubb = new osg::UniformBufferBinding(
                static_cast<int>(Resource::SceneManager::UBOBinding::PostProcessor), data, 0, mData.getGPUSize());

            stateset->setAttributeAndModes(ubb, osg::StateAttribute::ON);
        }
        else
        {
            const auto createUniform = [&](const auto& v) {
                using T = std::decay_t<decltype(v)>;
                std::string name = std::string(sOmwUniformPrefix) + std::string(T::sName);
                stateset->addUniform(new osg::Uniform(name.c_str(), mData.get<T>()));
            };

            std::apply([&](const auto&... v) { (createUniform(v), ...); }, mData.getData());
        }
    }

    void StateUpdater::apply(osg::StateSet* stateset, osg::NodeVisitor* nv)
    {
        if (mUseUBO)
        {
            osg::UniformBufferBinding* ubb = dynamic_cast<osg::UniformBufferBinding*>(
                stateset->getAttribute(osg::StateAttribute::UNIFORMBUFFERBINDING,
                    static_cast<int>(Resource::SceneManager::UBOBinding::PostProcessor)));
            if (!ubb)
                throw std::runtime_error("StateUpdater::apply: failed to get an UniformBufferBinding!");

            auto& dest = static_cast<osg::BufferTemplate<UniformData::BufferType>*>(ubb->getBufferData())->getData();
            mData.copyTo(dest);

            ubb->getBufferData()->dirty();
        }
        else
        {
            const auto setUniform = [&](const auto& v) {
                using T = std::decay_t<decltype(v)>;
                std::string name = std::string(sOmwUniformPrefix) + std::string(T::sName);
                stateset->getUniform(name)->set(mData.get<T>());
            };

            std::apply([&](const auto&... v) { (setUniform(v), ...); }, mData.getData());
        }

        if (mPointLightBuffer)
            mPointLightBuffer->applyUniforms(nv->getTraversalNumber(), stateset);
    }
}
