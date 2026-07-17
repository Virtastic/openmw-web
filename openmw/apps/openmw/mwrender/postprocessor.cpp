// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "postprocessor.hpp"

#include <SDL_opengl_glext.h>
#include <algorithm>
#include <chrono>
#include <thread>

#include <osg/Texture1D>
#include <osg/Texture2D>
#include <osg/Texture2DArray>
#include <osg/Texture2DMultisample>
#include <osg/Texture3D>

#include <components/files/conversion.hpp>
#include <components/misc/pathhelpers.hpp>
#include <components/misc/strings/algorithm.hpp>
#include <components/misc/strings/lower.hpp>
#include <components/resource/scenemanager.hpp>
#include <components/sceneutil/color.hpp>
#include <components/sceneutil/depth.hpp>
#include <components/sceneutil/nodecallback.hpp>
#include <components/settings/values.hpp>
#include <components/shader/shadermanager.hpp>
#include <components/stereo/multiview.hpp>
#include <components/stereo/stereomanager.hpp>
#include <components/vfs/manager.hpp>
#include <components/vfs/recursivedirectoryiterator.hpp>

#include "../mwbase/environment.hpp"
#include "../mwbase/windowmanager.hpp"

#include "../mwgui/postprocessorhud.hpp"

#include "distortion.hpp"
#include "pingpongcull.hpp"
#include "renderbin.hpp"
#include "renderingmanager.hpp"
#include "sky.hpp"
#include "transparentpass.hpp"
#include "vismask.hpp"

namespace
{
    struct ResizedCallback : osg::GraphicsContext::ResizedCallback
    {
        ResizedCallback(MWRender::PostProcessor* postProcessor)
            : mPostProcessor(postProcessor)
        {
        }

        void resizedImplementation(osg::GraphicsContext* gc, int x, int y, int width, int height) override
        {
            gc->resizedImplementation(x, y, width, height);

            mPostProcessor->setRenderTargetSize(width, height);
            mPostProcessor->resize();
        }

        MWRender::PostProcessor* mPostProcessor;
    };

    class HUDCullCallback : public SceneUtil::NodeCallback<HUDCullCallback, osg::Camera*, osgUtil::CullVisitor*>
    {
    public:
        void operator()(osg::Camera* camera, osgUtil::CullVisitor* cv)
        {
            osg::ref_ptr<osg::StateSet> stateset = new osg::StateSet;
            auto& sm = Stereo::Manager::instance();
            auto* fullViewport = camera->getViewport();
            if (sm.getEye(cv) == Stereo::Eye::Left)
                stateset->setAttributeAndModes(
                    new osg::Viewport(0, 0, fullViewport->width() / 2, fullViewport->height()));
            if (sm.getEye(cv) == Stereo::Eye::Right)
                stateset->setAttributeAndModes(
                    new osg::Viewport(fullViewport->width() / 2, 0, fullViewport->width() / 2, fullViewport->height()));

            cv->pushStateSet(stateset);
            traverse(camera, cv);
            cv->popStateSet();
        }
    };

    enum class Usage
    {
        RENDER_BUFFER,
        TEXTURE,
    };

    static osg::FrameBufferAttachment createFrameBufferAttachmentFromTemplate(
        Usage usage, int width, int height, osg::Texture* textureTemplate, int samples)
    {
        if (usage == Usage::RENDER_BUFFER && !Stereo::getMultiview())
        {
            osg::ref_ptr<osg::RenderBuffer> attachment
                = new osg::RenderBuffer(width, height, textureTemplate->getInternalFormat(), samples);
            return osg::FrameBufferAttachment(attachment);
        }

        auto texture = Stereo::createMultiviewCompatibleTexture(width, height, samples);
        texture->setSourceFormat(textureTemplate->getSourceFormat());
        texture->setSourceType(textureTemplate->getSourceType());
        texture->setInternalFormat(textureTemplate->getInternalFormat());
        texture->setFilter(osg::Texture2D::MIN_FILTER, textureTemplate->getFilter(osg::Texture2D::MIN_FILTER));
        texture->setFilter(osg::Texture2D::MAG_FILTER, textureTemplate->getFilter(osg::Texture2D::MAG_FILTER));
        texture->setWrap(osg::Texture::WRAP_S, textureTemplate->getWrap(osg::Texture2D::WRAP_S));
        texture->setWrap(osg::Texture::WRAP_T, textureTemplate->getWrap(osg::Texture2D::WRAP_T));

        return Stereo::createMultiviewCompatibleAttachment(texture);
    }

    constexpr float DistortionRatio = 0.25;
}

namespace MWRender
{
    PostProcessor::PostProcessor(
        RenderingManager& rendering, osgViewer::Viewer* viewer, osg::Group* rootNode, const VFS::Manager* vfs)
        : osg::Group()
        , mRootNode(rootNode)
        , mHUDCamera(new osg::Camera)
        , mRendering(rendering)
        , mViewer(viewer)
        , mVFS(vfs)
        , mUsePostProcessing(Settings::postProcessing().mEnabled)
        // MSAA real-GPU deep-dive: honor the [Video] antialiasing setting (set via ?aa=N) so
        // hardware MSAA can be validated on real hardware. Paired with the OSG RenderStage
        // color-only multisample-resolve fix + the __omwMsaa readback diagnostic.
        , mSamples(Settings::video().mAntialiasing)
        , mPingPongCull(new PingPongCull(this))
        , mDistortionCallback(new DistortionCallback)
    {
        auto& shaderManager = mRendering.getResourceSystem()->getSceneManager()->getShaderManager();

        std::shared_ptr<LuminanceCalculator> luminanceCalculator = std::make_shared<LuminanceCalculator>(shaderManager);

        for (auto& canvas : mCanvases)
            canvas = new PingPongCanvas(shaderManager, luminanceCalculator);

        mHUDCamera->setReferenceFrame(osg::Camera::ABSOLUTE_RF);
        mHUDCamera->setRenderOrder(osg::Camera::POST_RENDER);
        mHUDCamera->setClearColor(osg::Vec4(0.45f, 0.45f, 0.14f, 1.f));
        mHUDCamera->setClearMask(0);
        mHUDCamera->setProjectionMatrix(osg::Matrix::ortho2D(0, 1, 0, 1));
        mHUDCamera->setAllowEventFocus(false);
        mHUDCamera->setViewport(0, 0, mWidth, mHeight);
        mHUDCamera->setNodeMask(Mask_RenderToTexture);
        mHUDCamera->getOrCreateStateSet()->setMode(GL_DEPTH_TEST, osg::StateAttribute::OFF);
        mHUDCamera->addChild(mCanvases[0]);
        mHUDCamera->addChild(mCanvases[1]);
        mHUDCamera->setCullCallback(new HUDCullCallback);
        mViewer->getCamera()->addCullCallback(mPingPongCull);

        // resolves the multisampled depth buffer and optionally draws an additional depth postpass
        mTransparentDepthPostPass
            = new TransparentDepthBinCallback(mRendering.getResourceSystem()->getSceneManager()->getShaderManager(),
                Settings::postProcessing().mTransparentPostpass);
        osgUtil::RenderBin::getRenderBinPrototype("DepthSortedBin")->setDrawCallback(mTransparentDepthPostPass);

        osg::ref_ptr<osgUtil::RenderBin> distortionRenderBin
            = new osgUtil::RenderBin(osgUtil::RenderBin::SORT_BACK_TO_FRONT);
        // This is silly to have to do, but if nothing is drawn then the drawcallback is never called and the distortion
        // texture will never be cleared
        osg::ref_ptr<osg::Node> dummyNodeToClear = new osg::Node;
        dummyNodeToClear->setCullingActive(false);
        dummyNodeToClear->getOrCreateStateSet()->setRenderBinDetails(RenderBin_Distortion, "Distortion");
        rootNode->addChild(dummyNodeToClear);
        distortionRenderBin->setDrawCallback(mDistortionCallback);
        distortionRenderBin->getStateSet()->setDefine("DISTORTION", "1", osg::StateAttribute::ON);

        // Give the renderbin access to the opaque depth sampler so it can write its occlusion
        // Distorted geometry is drawn with ALWAYS depth function and depths writes disbled.
        const int unitSoftEffect
            = shaderManager.reserveGlobalTextureUnits(Shader::ShaderManager::Slot::OpaqueDepthTexture);
        distortionRenderBin->getStateSet()->addUniform(new osg::Uniform("opaqueDepthTex", unitSoftEffect));

        osgUtil::RenderBin::addRenderBinPrototype("Distortion", distortionRenderBin);

        auto defines = shaderManager.getGlobalDefines();
        defines["distorionRTRatio"] = std::to_string(DistortionRatio);
        shaderManager.setGlobalDefines(defines);

        osg::GraphicsContext* gc = viewer->getCamera()->getGraphicsContext();
        osg::GLExtensions* ext = gc->getState()->get<osg::GLExtensions>();

        // NOTE: mWidth/mHeight must be initialised from the real graphics-context size BEFORE the
        // first createObjectsForFrame() below. Those calls build FBO_Primary (SceneCam) and size its
        // Tex_Scene/Tex_Depth attachments via renderWidth()/renderHeight(). If they run while
        // mWidth/mHeight are still uninitialised, the very first RenderStage::runCameraSetUp() binds a
        // mis-sized/incomplete FBO and logs GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT (0x8cd6) — harmless on
        // desktop GL but a fatal-looking error on WebGL2. Setting the size here makes frame 1 complete.
        mWidth = gc->getTraits()->width;
        mHeight = gc->getTraits()->height;

        if (!ext->glDisablei && ext->glDisableIndexedEXT)
            ext->glDisablei = ext->glDisableIndexedEXT;

#if defined(ANDROID) || defined(__EMSCRIPTEN__)
        // GLES on Android: glEnablei/glDisablei (indexed draw-buffer color masks) are not
        // exposed, so the pass-normals MRT feature is unavailable. Disable it quietly.
        //
        // WebGL2/emscripten: OES_draw_buffers_indexed makes glDisablei/glColorMaski non-null,
        // so mNormalsSupported would latch true. But the pass-normals attachment (draw buffer 1)
        // is only actually attached when a loaded post-process technique requests normals — and
        // the default chain requests none, so FBO_Primary has ONLY color attachment 0. The
        // ShaderVisitor (shadervisitor.cpp) and SceneManager (scenemanager.cpp) nonetheless
        // decorate transparent/particle StateSets with ColorMaski(1,...) and Disablei(GL_BLEND,1),
        // gated on the *capability* flag, not the runtime attachment count. Desktop GL treats
        // indexed calls to an unattached buffer as harmless no-ops; WebGL2/ANGLE raises
        // GL_INVALID_VALUE and the intended masking/blend-disable fails to land — which knocks out
        // SRC_ALPHA blending for the transparent bin, so alpha-blended smoke/fire particles composite
        // OPAQUELY (a low-alpha dark texel written as a solid black quad — the classic "black square"
        // smoke bug). Force the feature off here so those decorations are never emitted and the
        // transparent bin blends correctly against the single attachment. Pass-normals PP effects
        // (e.g. SSAO-style normals techniques) are not in the default chain, matching Android.
        //
        // OMW_FORCE_NORMALS_RT (QA only): skip this guard to reproduce the pre-fix behaviour and
        // A/B the indexed-blend smoke bug. Never set in normal runs.
        if (getenv("OMW_FORCE_NORMALS_RT") == nullptr)
            ext->glDisablei = nullptr;
#endif

        if (ext->glDisablei)
            mNormalsSupported = true;
        else
            // Info, not Error: on Emscripten we deliberately null glDisablei above (the pass-normals
            // MRT feature is disabled to avoid the WebGL2 indexed-blend bug), so this is expected.
            Log(Debug::Info) << "'glDisablei' unsupported, pass normals will not be available to shaders.";

        mGLSLVersion = static_cast<int>(ext->glslLanguageVersion * 100);
        mUBO = ext->isUniformBufferObjectSupported && mGLSLVersion >= 330;
#ifdef __EMSCRIPTEN__
        // Protective: keep the fx uniform path off the std140 nested-struct UBO on WebGL2. WebGL2 is
        // GLSL ES 3.00 (mGLSLVersion==300) so this is already false, but pin it so a driver reporting
        // a higher glslLanguageVersion can't flip on the `layout(std140) uniform _data { _omw_data
        // omw; }` path (nested struct + bool members), which ANGLE's Metal backend handles poorly.
        // The non-UBO path uses a plain `uniform _omw_data omw;` filled by StateUpdater.
        mUBO = false;
#endif
        mStateUpdater = new Fx::StateUpdater(mUBO);

        createObjectsForFrame(0);
        createObjectsForFrame(1);

        populateTechniqueFiles();

        auto distortion = loadTechnique("internal_distortion");
        distortion->setInternal(true);
        distortion->setLocked(true);
        mInternalTechniques.push_back(std::move(distortion));

        addChild(mHUDCamera);
        addChild(mRootNode);

        mViewer->setSceneData(this);
        mViewer->getCamera()->setRenderTargetImplementation(osg::Camera::FRAME_BUFFER_OBJECT);
        mViewer->getCamera()->getGraphicsContext()->setResizedCallback(new ResizedCallback(this));
        mViewer->getCamera()->setUserData(this);

        setCullCallback(mStateUpdater);

        if (mUsePostProcessing)
            enable();
    }

    PostProcessor::~PostProcessor()
    {
        if (auto* bin = osgUtil::RenderBin::getRenderBinPrototype("DepthSortedBin"))
            bin->setDrawCallback(nullptr);
    }

    void PostProcessor::resize()
    {
        mHUDCamera->resize(mWidth, mHeight);
        mViewer->getCamera()->resize(mWidth, mHeight);
        if (Stereo::getStereo())
            Stereo::Manager::instance().screenResolutionChanged();

        size_t frameId = frame() % 2;

        createObjectsForFrame(frameId);

        mRendering.updateProjectionMatrix();
        mRendering.setScreenRes(renderWidth(), renderHeight());

        dirtyTechniques(true);

        mDirty = true;
        mDirtyFrameId = !frameId;
    }

    void PostProcessor::populateTechniqueFiles()
    {
        for (const auto& path : mVFS->getRecursiveDirectoryIterator(Fx::Technique::sSubdir))
        {
            std::string_view fileExt = Misc::getFileExtension(path);
            if (path.parent().parent().empty() && fileExt == Fx::Technique::sExt)
            {
                mTechniqueFiles.emplace(path);
            }
        }
    }

    void PostProcessor::enable()
    {
#ifdef __EMSCRIPTEN__
        // Post-processing on WebGL2/GLES. The historical hard-freeze was the multisample
        // depth->texture resolve (WebGL2 forbids resolving MSAA depth, which PP needs as a
        // sampleable depth texture) plus the HDR luminance float-target path. The GLES port
        // (createObjectsForFrame: PP scene forced single-sample on web; loadChain: HDR float
        // targets gated) makes the base + tonemap/bloom chain safe. The curated chain is now a
        // verified web default, so PP honors the [Post Processing] setting exactly like desktop
        // (the old OPENMW_ENABLE_PP opt-in gate has been removed). The Options-menu toggle works.
        Log(Debug::Info) << "Post-processing enabled (GLES path).";
#endif
        mReload = true;
        mUsePostProcessing = true;
    }

    void PostProcessor::disable()
    {
        mUsePostProcessing = false;
        mRendering.getSkyManager()->setSunglare(true);
    }

    void PostProcessor::traverse(osg::NodeVisitor& nv)
    {
        unsigned frameId = nv.getTraversalNumber() % 2;

        if (nv.getVisitorType() == osg::NodeVisitor::CULL_VISITOR)
            cull(frameId, static_cast<osgUtil::CullVisitor*>(&nv));
        else if (nv.getVisitorType() == osg::NodeVisitor::UPDATE_VISITOR)
            update(frameId);

        osg::Group::traverse(nv);
    }

    void PostProcessor::cull(unsigned frameId, osgUtil::CullVisitor* cv)
    {
        if (const auto& fbo = getFbo(FBO_Intercept, frameId))
        {
            osgUtil::RenderStage* rs = cv->getRenderStage();
            if (rs && rs->getMultisampleResolveFramebufferObject())
                rs->setMultisampleResolveFramebufferObject(fbo);
        }

        mCanvases[frameId]->setPostProcessing(mUsePostProcessing);
        mCanvases[frameId]->setTextureNormals(mNormals ? getTexture(Tex_Normal, frameId) : nullptr);
        mCanvases[frameId]->setMask(mUnderwater, mExteriorFlag);
        mCanvases[frameId]->setCalculateAvgLum(mHDR);

        mCanvases[frameId]->setTextureScene(getTexture(Tex_Scene, frameId));
        mCanvases[frameId]->setTextureDepth(getTexture(Tex_OpaqueDepth, frameId));
        mCanvases[frameId]->setTextureDistortion(getTexture(Tex_Distortion, frameId));

        mTransparentDepthPostPass->mFbo[frameId] = mFbos[frameId][FBO_Primary];
        mTransparentDepthPostPass->mMsaaFbo[frameId] = mFbos[frameId][FBO_Multisample];
        mTransparentDepthPostPass->mOpaqueFbo[frameId] = mFbos[frameId][FBO_OpaqueDepth];

        mDistortionCallback->setFBO(mFbos[frameId][FBO_Distortion], frameId);
        mDistortionCallback->setOriginalFBO(mFbos[frameId][FBO_Primary], frameId);

        size_t frame = cv->getTraversalNumber();

        mStateUpdater->setResolution(osg::Vec2f(
            static_cast<float>(cv->getViewport()->width()), static_cast<float>(cv->getViewport()->height())));

        // per-frame data
        if (frame != mLastFrameNumber)
        {
            mLastFrameNumber = frame;
            auto stamp = cv->getFrameStamp();

            mStateUpdater->setSimulationTime(static_cast<float>(stamp->getSimulationTime()));
            mStateUpdater->setDeltaSimulationTime(static_cast<float>(stamp->getSimulationTime() - mLastSimulationTime));
            // Use a signed int because 'uint' type is not supported in GLSL 120 without extensions
            mStateUpdater->setFrameNumber(static_cast<int>(stamp->getFrameNumber()));
            mLastSimulationTime = stamp->getSimulationTime();

            for (const auto& dispatchNode : mCanvases[frameId]->getPasses())
            {
                for (auto& uniform : dispatchNode.mHandle->getUniformMap())
                {
                    if (uniform->getType().has_value() && !uniform->mSamplerType)
                        if (auto* u = dispatchNode.mRootStateSet->getUniform(uniform->mName))
                            uniform->setUniform(u);
                }
            }
        }
    }

    void PostProcessor::updateLiveReload()
    {
        if (!mEnableLiveReload && !mTriggerShaderReload)
            return;

        mTriggerShaderReload = false; // Done only once

        for (auto& technique : mTechniques)
        {
            if (technique->getStatus() == Fx::Technique::Status::File_Not_exists)
                continue;

            const auto lastWriteTime = mVFS->getLastModified(technique->getFileName());
            const bool isDirty = technique->setLastModificationTime(lastWriteTime);

            if (!isDirty)
                continue;

            // TODO: Temporary workaround to avoid conflicts with external programs saving the file, especially
            // problematic on Windows.
            //       If we move to a file watcher using native APIs this should be removed.
            std::this_thread::sleep_for(std::chrono::milliseconds(5));

            if (technique->compile())
                Log(Debug::Info) << "Reloaded technique : " << technique->getFileName();

            mReload = technique->isValid();
        }
    }

    void PostProcessor::setSamples(int samples)
    {
        // Called from RenderingManager::processChangedSettings (Options apply) while a GL context
        // is current, so it's safe to query the sample-count ceiling. The scene renders into
        // FBO_Multisample (created by createObjectsForFrame when mSamples > 1), so changing the
        // sample count + rebuilding those FBOs re-applies MSAA live — no window/context recreation.
        if (samples < 0)
            samples = 0;
        if (samples > 1)
        {
#ifndef GL_MAX_SAMPLES
#define GL_MAX_SAMPLES 0x8D57
#endif
            GLint maxSamples = 0;
            glGetIntegerv(GL_MAX_SAMPLES, &maxSamples);
            if (maxSamples >= 1 && samples > maxSamples)
            {
                Log(Debug::Info) << "Antialiasing " << samples << "x exceeds GL_MAX_SAMPLES ("
                                 << maxSamples << "x); using " << maxSamples << "x.";
                samples = maxSamples;
            }
        }
        if (samples == mSamples)
            return;
        mSamples = samples;
        // Defer the FBO rebuild to update() (UPDATE traversal) — the safe point where resize()
        // already runs — rather than mutating FBOs from inside the settings-apply call.
        mSamplesDirty = true;
    }

    void PostProcessor::reloadIfRequired()
    {
        if (mSamplesDirty)
        {
            mSamplesDirty = false;
            // Rebuild both double-buffered frames' FBOs with the new mSamples. resize() rebuilds
            // the current frame and dirties the other; do both so MSAA changes take on the next
            // frame regardless of which buffer draws first.
            createObjectsForFrame(0);
            createObjectsForFrame(1);
            resize();
        }

        if (!mReload)
            return;

        mReload = false;

        loadChain();
        resize();
    }

    void PostProcessor::update(size_t frameId)
    {
        while (!mQueuedTemplates.empty())
        {
            mTemplates.push_back(std::move(mQueuedTemplates.back()));

            mQueuedTemplates.pop_back();
        }

        updateLiveReload();

        reloadIfRequired();

#ifdef __EMSCRIPTEN__
        // Web brightness control: SDL gamma ramps don't exist in a browser, so the Options
        // "Gamma" slider ([Video] gamma) is applied here instead, driving the always-available
        // 'adjustments' technique's uGamma. Re-applied every frame (a trivial CPU-side value
        // store) so it survives chain reloads and technique recompiles without extra plumbing.
        {
            const float gamma = std::max(0.1f, Settings::video().mGamma.get());
            for (auto& technique : mTechniques)
            {
                if (technique && technique->getName() == "adjustments")
                {
                    setUniform(technique, "uGamma", gamma);
                    break;
                }
            }
        }
#endif

        mCanvases[frameId]->setNodeMask(~0u);
        mCanvases[!frameId]->setNodeMask(0);

        if (mDirty && mDirtyFrameId == frameId)
        {
            createObjectsForFrame(frameId);

            mDirty = false;
            mCanvases[frameId]->setPasses(Fx::DispatchArray(mTemplateData));
        }

        if ((mNormalsSupported && mNormals != mPrevNormals) || (mPassLights != mPrevPassLights))
        {
            mPrevNormals = mNormals;
            mPrevPassLights = mPassLights;

            mViewer->stopThreading();

            if (mNormalsSupported)
            {
                auto& shaderManager
                    = MWBase::Environment::get().getResourceSystem()->getSceneManager()->getShaderManager();
                auto defines = shaderManager.getGlobalDefines();
                defines["disableNormals"] = mNormals ? "0" : "1";
                shaderManager.setGlobalDefines(defines);
            }

            mRendering.getLightRoot()->setCollectPPLights(mPassLights);
            mStateUpdater->bindPointLights(mPassLights ? mRendering.getLightRoot()->getPPLightsBuffer() : nullptr);
            mStateUpdater->reset();

            mViewer->startThreading();

            createObjectsForFrame(frameId);

            mDirty = true;
            mDirtyFrameId = !frameId;
        }
    }

    void PostProcessor::createObjectsForFrame(size_t frameId)
    {
        auto& textures = mTextures[frameId];

        int width = renderWidth();
        int height = renderHeight();

#ifdef __EMSCRIPTEN__
        // WebGL2 forbids resolving a multisampled DEPTH buffer into a texture, and PP needs a
        // sampleable depth texture (opaque depth, soft particles, distortion). Historically the
        // first PP render hung the main thread on exactly this resolve. Render the PP scene
        // SINGLE-SAMPLE so depth goes straight to a texture with no resolve; AA under PP is
        // provided by SSAA (?ss=N supersampling) instead of hardware MSAA.
        const int effectiveSamples = 1;
#else
        const int effectiveSamples = mSamples;
#endif

        for (osg::ref_ptr<osg::Texture>& texture : textures)
        {
            if (!texture)
            {
                if (Stereo::getMultiview())
                    texture = new osg::Texture2DArray;
                else
                    texture = new osg::Texture2D;
            }
            Stereo::setMultiviewCompatibleTextureSize(texture, width, height);
            texture->setSourceFormat(GL_RGBA);
            texture->setSourceType(GL_UNSIGNED_BYTE);
            texture->setInternalFormat(GL_RGBA);
            texture->setFilter(osg::Texture2D::MIN_FILTER, osg::Texture::LINEAR);
            texture->setFilter(osg::Texture2D::MAG_FILTER, osg::Texture::LINEAR);
            texture->setWrap(osg::Texture::WRAP_S, osg::Texture::CLAMP_TO_EDGE);
            texture->setWrap(osg::Texture::WRAP_T, osg::Texture::CLAMP_TO_EDGE);
            texture->setResizeNonPowerOfTwoHint(false);
            Stereo::setMultiviewCompatibleTextureSize(texture, width, height);
            texture->dirtyTextureObject();
        }

#ifdef __EMSCRIPTEN__
        // WebGL2: unsized GL_RGB/GL_RGBA color attachments can be incomplete (0x8cd6) —
        // notably Tex_Scene (FBO_Primary/SceneCam) failed the FIRST runCameraSetUp because the
        // image-less RTT is initially allocated via glTexImage2D with the unsized format. Force
        // SIZED GL_RGBA8 (color-renderable) on every color target so frame 1's FBO is complete.
        textures[Tex_Scene]->setInternalFormat(GL_RGBA8);

        textures[Tex_Normal]->setSourceFormat(GL_RGBA);
        textures[Tex_Normal]->setInternalFormat(GL_RGBA8);

        textures[Tex_Distortion]->setSourceFormat(GL_RGBA);
        textures[Tex_Distortion]->setInternalFormat(GL_RGBA8);
#else
        textures[Tex_Normal]->setSourceFormat(GL_RGB);
        textures[Tex_Normal]->setInternalFormat(GL_RGB);

        textures[Tex_Distortion]->setSourceFormat(GL_RGB);
        textures[Tex_Distortion]->setInternalFormat(GL_RGB);
#endif

        Stereo::setMultiviewCompatibleTextureSize(textures[Tex_Distortion], static_cast<int>(width * DistortionRatio),
            static_cast<int>(height * DistortionRatio));
        textures[Tex_Distortion]->dirtyTextureObject();

        auto setupDepth = [](osg::Texture* tex) {
            tex->setSourceFormat(GL_DEPTH_STENCIL_EXT);
            tex->setSourceType(SceneUtil::AutoDepth::depthSourceType());
            tex->setInternalFormat(SceneUtil::AutoDepth::depthInternalFormat());
        };

        setupDepth(textures[Tex_Depth]);
        setupDepth(textures[Tex_OpaqueDepth]);
        textures[Tex_OpaqueDepth]->setName("opaqueTexMap");

        auto& fbos = mFbos[frameId];

        fbos[FBO_Primary] = new osg::FrameBufferObject;
        fbos[FBO_Primary]->setAttachment(
            osg::Camera::COLOR_BUFFER0, Stereo::createMultiviewCompatibleAttachment(textures[Tex_Scene]));
        if (mNormals && mNormalsSupported)
            fbos[FBO_Primary]->setAttachment(
                osg::Camera::COLOR_BUFFER1, Stereo::createMultiviewCompatibleAttachment(textures[Tex_Normal]));
        fbos[FBO_Primary]->setAttachment(
            osg::Camera::PACKED_DEPTH_STENCIL_BUFFER, Stereo::createMultiviewCompatibleAttachment(textures[Tex_Depth]));

        fbos[FBO_FirstPerson] = new osg::FrameBufferObject;

        auto fpDepthRb = createFrameBufferAttachmentFromTemplate(
            Usage::RENDER_BUFFER, width, height, textures[Tex_Depth], effectiveSamples);
        fbos[FBO_FirstPerson]->setAttachment(osg::FrameBufferObject::BufferComponent::PACKED_DEPTH_STENCIL_BUFFER,
            osg::FrameBufferAttachment(fpDepthRb));

        if (effectiveSamples > 1)
        {
#ifdef __EMSCRIPTEN__
            // Proof that the chosen MSAA level actually reaches the scene render target: the scene
            // is drawn into this multisample FBO. Logged so 'antialiasing = N' can be confirmed as
            // live in the rendering engine (frame 0 build + on every live setSamples rebuild).
            Log(Debug::Info) << "MSAA: scene render target built with " << mSamples << "x multisampling";
#endif
            fbos[FBO_Multisample] = new osg::FrameBufferObject;
            fbos[FBO_Intercept] = new osg::FrameBufferObject;
            auto colorRB = createFrameBufferAttachmentFromTemplate(
                Usage::RENDER_BUFFER, width, height, textures[Tex_Scene], effectiveSamples);
            if (mNormals && mNormalsSupported)
            {
                auto normalRB = createFrameBufferAttachmentFromTemplate(
                    Usage::RENDER_BUFFER, width, height, textures[Tex_Normal], effectiveSamples);
                fbos[FBO_Multisample]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER1, normalRB);
                fbos[FBO_FirstPerson]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER1, normalRB);
                fbos[FBO_Intercept]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER1,
                    Stereo::createMultiviewCompatibleAttachment(textures[Tex_Normal]));
            }
            auto depthRB = createFrameBufferAttachmentFromTemplate(
                Usage::RENDER_BUFFER, width, height, textures[Tex_Depth], effectiveSamples);
            fbos[FBO_Multisample]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER0, colorRB);
            fbos[FBO_Multisample]->setAttachment(
                osg::FrameBufferObject::BufferComponent::PACKED_DEPTH_STENCIL_BUFFER, depthRB);
            fbos[FBO_FirstPerson]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER0, colorRB);

            fbos[FBO_Intercept]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER0,
                Stereo::createMultiviewCompatibleAttachment(textures[Tex_Scene]));
        }
        else
        {
            fbos[FBO_FirstPerson]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER0,
                Stereo::createMultiviewCompatibleAttachment(textures[Tex_Scene]));
            if (mNormals && mNormalsSupported)
                fbos[FBO_FirstPerson]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER1,
                    Stereo::createMultiviewCompatibleAttachment(textures[Tex_Normal]));
        }

        fbos[FBO_OpaqueDepth] = new osg::FrameBufferObject;
        fbos[FBO_OpaqueDepth]->setAttachment(osg::FrameBufferObject::BufferComponent::PACKED_DEPTH_STENCIL_BUFFER,
            Stereo::createMultiviewCompatibleAttachment(textures[Tex_OpaqueDepth]));

        fbos[FBO_Distortion] = new osg::FrameBufferObject;
        fbos[FBO_Distortion]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER0,
            Stereo::createMultiviewCompatibleAttachment(textures[Tex_Distortion]));

#ifdef __APPLE__
        if (textures[Tex_OpaqueDepth])
            fbos[FBO_OpaqueDepth]->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER,
                osg::FrameBufferAttachment(new osg::RenderBuffer(textures[Tex_OpaqueDepth]->getTextureWidth(),
                    textures[Tex_OpaqueDepth]->getTextureHeight(), textures[Tex_Scene]->getInternalFormat())));
#endif

        mCanvases[frameId]->dirty();
    }

    void PostProcessor::dirtyTechniques(bool dirtyAttachments)
    {
        size_t frameId = frame() % 2;

        mDirty = true;
        mDirtyFrameId = !frameId;

        mTemplateData = {};

        bool sunglare = true;
        mHDR = false;
        mNormals = false;
        mPassLights = false;

        std::vector<Fx::Types::RenderTarget> attachmentsToDirty;

        for (const auto& technique : mTechniques)
        {
            if (!technique->isValid())
                continue;

            if (technique->getGLSLVersion() > mGLSLVersion)
            {
                Log(Debug::Warning) << "Technique " << technique->getName() << " requires GLSL version "
                                    << technique->getGLSLVersion() << " which is unsupported by your hardware.";
                continue;
            }

            Fx::DispatchNode node;

            node.mFlags = technique->getFlags();

            if (technique->getHDR())
                mHDR = true;

            if (technique->getNormals())
                mNormals = true;

            if (technique->getLights())
                mPassLights = true;

            if (node.mFlags & Fx::Technique::Flag_Disable_SunGlare)
                sunglare = false;

            // required default samplers available to every shader pass
            node.mRootStateSet->addUniform(new osg::Uniform("omw_SamplerLastShader", Unit_LastShader));
            node.mRootStateSet->addUniform(new osg::Uniform("omw_SamplerLastPass", Unit_LastPass));
            node.mRootStateSet->addUniform(new osg::Uniform("omw_SamplerDepth", Unit_Depth));
            node.mRootStateSet->addUniform(new osg::Uniform("omw_SamplerDistortion", Unit_Distortion));

            if (mNormals)
                node.mRootStateSet->addUniform(new osg::Uniform("omw_SamplerNormals", Unit_Normals));

            if (technique->getHDR())
                node.mRootStateSet->addUniform(new osg::Uniform("omw_EyeAdaptation", Unit_EyeAdaptation));

            node.mRootStateSet->addUniform(new osg::Uniform("omw_SamplerDistortion", Unit_Distortion));

            int texUnit = Unit_NextFree;

            // user-defined samplers
            for (const osg::Texture* texture : technique->getTextures())
            {
                if (const auto* tex1D = dynamic_cast<const osg::Texture1D*>(texture))
                    node.mRootStateSet->setTextureAttribute(texUnit, new osg::Texture1D(*tex1D));
                else if (const auto* tex2D = dynamic_cast<const osg::Texture2D*>(texture))
                    node.mRootStateSet->setTextureAttribute(texUnit, new osg::Texture2D(*tex2D));
                else if (const auto* tex3D = dynamic_cast<const osg::Texture3D*>(texture))
                    node.mRootStateSet->setTextureAttribute(texUnit, new osg::Texture3D(*tex3D));

                node.mRootStateSet->addUniform(new osg::Uniform(texture->getName().c_str(), texUnit++));
            }

            // user-defined uniforms
            for (auto& uniform : technique->getUniformMap())
            {
                if (uniform->mSamplerType)
                    continue;

                if (auto type = uniform->getType())
                    uniform->setUniform(node.mRootStateSet->getOrCreateUniform(
                        uniform->mName, *type, static_cast<unsigned>(uniform->getNumElements())));
            }

            for (const auto& pass : technique->getPasses())
            {
                int subTexUnit = texUnit;
                Fx::DispatchNode::SubPass subPass;

                pass->prepareStateSet(subPass.mStateSet, technique->getName());

                node.mHandle = technique;

                if (!pass->getTarget().empty())
                {
                    // FIXME: https://gitlab.com/OpenMW/openmw/-/work_items/9034
                    std::string target = pass->getTarget();
                    auto& renderTarget = technique->getRenderTargetsMap()[target];
                    subPass.mSize = renderTarget.mSize;
                    subPass.mRenderTexture = renderTarget.mTarget;
                    subPass.mMipMap = renderTarget.mMipMap;

                    const auto [w, h] = renderTarget.mSize.get(renderWidth(), renderHeight());
                    subPass.mStateSet->setAttributeAndModes(new osg::Viewport(0, 0, w, h));

                    if (subPass.mMipMap)
                    {
                        subPass.mRenderTexture->setNumMipmapLevels(osg::Image::computeNumberOfMipmapLevels(w, h));
                    }
                    else
                    {
                        subPass.mRenderTexture->setNumMipmapLevels(0);
                    }
                    subPass.mRenderTexture->setTextureSize(w, h);
                    subPass.mRenderTexture->dirtyTextureObject();

                    subPass.mRenderTarget = new osg::FrameBufferObject;
                    subPass.mRenderTarget->setAttachment(osg::FrameBufferObject::BufferComponent::COLOR_BUFFER0,
                        osg::FrameBufferAttachment(subPass.mRenderTexture));

                    if (std::find_if(attachmentsToDirty.cbegin(), attachmentsToDirty.cend(),
                            [renderTarget](const auto& rt) { return renderTarget.mTarget == rt.mTarget; })
                        == attachmentsToDirty.cend())
                    {
                        attachmentsToDirty.push_back(Fx::Types::RenderTarget(renderTarget));
                    }
                }

                for (const auto& name : pass->getRenderTargets())
                {
                    if (name.empty())
                    {
                        continue;
                    }

                    auto& renderTarget = technique->getRenderTargetsMap()[name];
                    subPass.mStateSet->setTextureAttribute(subTexUnit, renderTarget.mTarget);
                    subPass.mStateSet->addUniform(new osg::Uniform(name.c_str(), subTexUnit));

                    if (std::find_if(attachmentsToDirty.cbegin(), attachmentsToDirty.cend(),
                            [renderTarget](const auto& rt) { return renderTarget.mTarget == rt.mTarget; })
                        == attachmentsToDirty.cend())
                    {
                        attachmentsToDirty.push_back(Fx::Types::RenderTarget(renderTarget));
                    }
                    subTexUnit++;
                }

                node.mPasses.emplace_back(std::move(subPass));
            }

            node.compile();

            mTemplateData.emplace_back(std::move(node));
        }

        mCanvases[frameId]->setPasses(Fx::DispatchArray(mTemplateData));

        if (auto hud = MWBase::Environment::get().getWindowManager()->getPostProcessorHud())
            hud->updateTechniques();

        if (mUsePostProcessing)
            mRendering.getSkyManager()->setSunglare(sunglare);

        if (dirtyAttachments)
            mCanvases[frameId]->setDirtyAttachments(attachmentsToDirty);
    }

    PostProcessor::Status PostProcessor::enableTechnique(
        std::shared_ptr<Fx::Technique> technique, std::optional<int> location)
    {
        if (technique->getLocked() || (location.has_value() && location.value() < 0))
            return Status_Error;

        disableTechnique(technique, false);

        size_t pos = std::min(location.value_or(mTechniques.size()) + mInternalTechniques.size(), mTechniques.size());

        mTechniques.insert(mTechniques.begin() + pos, technique);
        dirtyTechniques(Settings::ShaderManager::get().getMode() == Settings::ShaderManager::Mode::Debug);

        return Status_Toggled;
    }

    PostProcessor::Status PostProcessor::disableTechnique(std::shared_ptr<Fx::Technique> technique, bool dirty)
    {
        if (technique->getLocked())
            return Status_Error;

        auto it = std::find(mTechniques.begin(), mTechniques.end(), technique);
        if (it == std::end(mTechniques))
            return Status_Unchanged;

        mTechniques.erase(it);
        if (dirty)
            dirtyTechniques();

        return Status_Toggled;
    }

    bool PostProcessor::isTechniqueEnabled(const std::shared_ptr<Fx::Technique>& technique) const
    {
        if (auto it = std::find(mTechniques.begin(), mTechniques.end(), technique); it == mTechniques.end())
            return false;

        return technique->isValid();
    }

    std::shared_ptr<Fx::Technique> PostProcessor::loadTechnique(std::string_view name, bool loadNextFrame)
    {
        VFS::Path::Normalized path = Fx::Technique::makeFileName(name);
        return loadTechnique(VFS::Path::NormalizedView(path), loadNextFrame);
    }

    std::shared_ptr<Fx::Technique> PostProcessor::loadTechnique(VFS::Path::NormalizedView path, bool loadNextFrame)
    {
        for (const auto& technique : mTemplates)
            if (technique->getFileName() == path)
                return technique;

        for (const auto& technique : mQueuedTemplates)
            if (technique->getFileName() == path)
                return technique;

        std::string name;
        if (mTechniqueFiles.contains(path))
            name = mVFS->getStem(path);
        else
            name = path.stem();

        auto technique = std::make_shared<Fx::Technique>(*mVFS, *mRendering.getResourceSystem()->getImageManager(),
            path, std::move(name), renderWidth(), renderHeight(), mUBO, mNormalsSupported);

        technique->compile();

        if (technique->getStatus() != Fx::Technique::Status::File_Not_exists)
            technique->setLastModificationTime(mVFS->getLastModified(path));

        if (loadNextFrame)
        {
            mQueuedTemplates.push_back(technique);
            return technique;
        }

        mTemplates.push_back(std::move(technique));

        return mTemplates.back();
    }

    PostProcessor::TechniqueList PostProcessor::getChain()
    {
        return mTechniques;
    }

    void PostProcessor::loadChain()
    {
        mTechniques.clear();

        for (const auto& technique : mInternalTechniques)
        {
            mTechniques.push_back(technique);
        }

        for (const std::string& techniqueName : Settings::postProcessing().mChain.get())
        {
            if (techniqueName.empty())
                continue;

            mTechniques.push_back(loadTechnique(techniqueName));
        }

        dirtyTechniques();
    }

    void PostProcessor::saveChain()
    {
        std::vector<std::string> chain;

        for (const auto& technique : mTechniques)
        {
            if (technique->getDynamic() || technique->getInternal())
                continue;
            chain.push_back(technique->getName());
        }

        Settings::postProcessing().mChain.set(chain);
    }

    void PostProcessor::toggleMode()
    {
        for (auto& technique : mTemplates)
        {
            if (technique->getStatus() == Fx::Technique::Status::File_Not_exists)
                continue;
            technique->compile();
        }

        dirtyTechniques(true);
    }

    void PostProcessor::disableDynamicShaders()
    {
        auto erased = std::erase_if(mTechniques, [](const auto& technique) { return technique->getDynamic(); });

        if (erased)
            dirtyTechniques();
    }

    int PostProcessor::renderWidth() const
    {
        if (Stereo::getStereo())
            return Stereo::Manager::instance().eyeResolution().x();
        return mWidth;
    }

    int PostProcessor::renderHeight() const
    {
        if (Stereo::getStereo())
            return Stereo::Manager::instance().eyeResolution().y();
        return mHeight;
    }

    void PostProcessor::triggerShaderReload()
    {
        mTriggerShaderReload = true;
    }
}
