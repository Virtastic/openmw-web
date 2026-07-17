// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "transparentpass.hpp"

#include <osg/AlphaFunc>
#include <osg/BlendFunc>
#include <osg/Material>
#include <osg/Texture2D>
#include <osg/Texture2DArray>

#include <osgUtil/RenderStage>

#include <components/sceneutil/depth.hpp>
#include <components/shader/shadermanager.hpp>
#include <components/stereo/multiview.hpp>
#include <components/stereo/stereomanager.hpp>

#include "vismask.hpp"

namespace MWRender
{
    TransparentDepthBinCallback::TransparentDepthBinCallback(Shader::ShaderManager& shaderManager, bool postPass)
        : mStateSet(new osg::StateSet)
        , mPostPass(postPass)
    {
        osg::ref_ptr<osg::Image> image = new osg::Image;
        image->allocateImage(1, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE);
        image->setColor(osg::Vec4(1, 1, 1, 1), 0, 0);

        osg::ref_ptr<osg::Texture2D> dummyTexture = new osg::Texture2D(image);
        dummyTexture->setWrap(osg::Texture::WRAP_S, osg::Texture::CLAMP_TO_EDGE);
        dummyTexture->setWrap(osg::Texture::WRAP_T, osg::Texture::CLAMP_TO_EDGE);

        constexpr osg::StateAttribute::OverrideValue modeOff = osg::StateAttribute::OFF | osg::StateAttribute::OVERRIDE;
        constexpr osg::StateAttribute::OverrideValue modeOn = osg::StateAttribute::ON | osg::StateAttribute::OVERRIDE;

        mStateSet->setTextureAttributeAndModes(0, dummyTexture);

        Shader::ShaderManager::DefineMap defines;
        Stereo::shaderStereoDefines(defines);

        mStateSet->setAttributeAndModes(new osg::BlendFunc, modeOff);
        mStateSet->setAttributeAndModes(shaderManager.getProgram("depthclipped", defines), modeOn);
        mStateSet->setAttributeAndModes(new SceneUtil::AutoDepth, modeOn);

        for (unsigned int unit = 1; unit < 8; ++unit)
            mStateSet->setTextureMode(unit, GL_TEXTURE_2D, modeOff);
    }

    void TransparentDepthBinCallback::drawImplementation(
        osgUtil::RenderBin* bin, osg::RenderInfo& renderInfo, osgUtil::RenderLeaf*& previous)
    {
#ifdef __EMSCRIPTEN__
        // WebGL2: the depth-buffer glBlitFramebuffer between the scene FBO and the opaque-depth
        // FBO raises GL_INVALID_OPERATION every frame (spamming the log AND corrupting the depth
        // buffer -> geometry z-fights / disappears). So we skip the depth-copy dance and draw the
        // bin normally, which fixes both the spam and the render corruption.
        // KNOWN LIMITATION: this leaves Tex_OpaqueDepth unwritten. Post-processing is now DEFAULT-ON
        // (not "disabled here" as this comment used to claim) and soft particles + underwater/heat-haze
        // distortion sample that texture — so depth-based soft fade and distortion masking read a
        // cleared buffer (particles can pop at surfaces; distortion mask is effectively off). Proper
        // fix (TODO): populate Tex_OpaqueDepth via a WebGL2-legal path, or point the PP depth sampler
        // at the main scene depth (Tex_Depth) on web.
        bin->drawImplementation(renderInfo, previous);
        return;
#endif

        osg::State& state = *renderInfo.getState();
        osg::GLExtensions* ext = state.get<osg::GLExtensions>();

        bool validFbo = false;
        unsigned int frameId = state.getFrameStamp()->getFrameNumber() % 2;

        const auto& fbo = mFbo[frameId];
        const auto& msaaFbo = mMsaaFbo[frameId];
        const auto& opaqueFbo = mOpaqueFbo[frameId];

        if (bin->getStage()->getMultisampleResolveFramebufferObject()
            && bin->getStage()->getMultisampleResolveFramebufferObject() == fbo)
            validFbo = true;
        else if (bin->getStage()->getFrameBufferObject()
            && (bin->getStage()->getFrameBufferObject() == fbo || bin->getStage()->getFrameBufferObject() == msaaFbo))
            validFbo = true;

        if (!validFbo)
        {
            bin->drawImplementation(renderInfo, previous);
            return;
        }

        const osg::Texture* tex
            = opaqueFbo->getAttachment(osg::FrameBufferObject::BufferComponent::PACKED_DEPTH_STENCIL_BUFFER)
                  .getTexture();

        if (Stereo::getMultiview())
        {
            if (!mMultiviewResolve[frameId])
            {
                mMultiviewResolve[frameId] = std::make_unique<Stereo::MultiviewFramebufferResolve>(
                    msaaFbo ? msaaFbo : fbo, opaqueFbo, GL_DEPTH_BUFFER_BIT);
            }
            else
            {
                mMultiviewResolve[frameId]->setResolveFbo(opaqueFbo);
                mMultiviewResolve[frameId]->setMsaaFbo(msaaFbo ? msaaFbo : fbo);
            }
            mMultiviewResolve[frameId]->resolveImplementation(state);
        }
        else
        {
            opaqueFbo->apply(state, osg::FrameBufferObject::DRAW_FRAMEBUFFER);
            ext->glBlitFramebuffer(0, 0, tex->getTextureWidth(), tex->getTextureHeight(), 0, 0, tex->getTextureWidth(),
                tex->getTextureHeight(), GL_DEPTH_BUFFER_BIT, GL_NEAREST);
        }

        msaaFbo ? msaaFbo->apply(state, osg::FrameBufferObject::DRAW_FRAMEBUFFER)
                : fbo->apply(state, osg::FrameBufferObject::DRAW_FRAMEBUFFER);

        // draws scene into primary attachments
        bin->drawImplementation(renderInfo, previous);

        if (!mPostPass)
            return;

        opaqueFbo->apply(state, osg::FrameBufferObject::DRAW_FRAMEBUFFER);

        // draw transparent post-pass to populate a postprocess friendly depth texture with alpha-clipped geometry

        unsigned int numToPop = previous ? osgUtil::StateGraph::numToPop(previous->_parent) : 0;
        if (numToPop > 1)
            numToPop--;
        unsigned int insertStateSetPosition = state.getStateSetStackSize() - numToPop;

        state.insertStateSet(insertStateSetPosition, mStateSet);
        for (auto rit = bin->getRenderLeafList().begin(); rit != bin->getRenderLeafList().end(); rit++)
        {
            osgUtil::RenderLeaf* rl = *rit;
            const osg::StateSet* ss = rl->_parent->getStateSet();

            if (rl->_drawable->getNodeMask() == Mask_ParticleSystem)
                continue;

            if (ss->getAttribute(osg::StateAttribute::MATERIAL))
            {
                const osg::Material* mat
                    = static_cast<const osg::Material*>(ss->getAttribute(osg::StateAttribute::MATERIAL));
                if (mat->getDiffuse(osg::Material::FRONT).a() < 0.5)
                    continue;
            }

            rl->render(renderInfo, previous);
            previous = rl;
        }
        state.removeStateSet(insertStateSetPosition);

        msaaFbo ? msaaFbo->apply(state, osg::FrameBufferObject::DRAW_FRAMEBUFFER)
                : fbo->apply(state, osg::FrameBufferObject::DRAW_FRAMEBUFFER);
        state.checkGLErrors("after TransparentDepthBinCallback::drawImplementation");
    }
}
