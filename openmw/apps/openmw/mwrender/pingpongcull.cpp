#include "pingpongcull.hpp"

#include <osg/Camera>
#include <osg/FrameBufferObject>
#include <osg/Texture2DArray>
#include <osg/Texture>
#include <osgUtil/CullVisitor>

#include <components/stereo/multiview.hpp>
#include <components/stereo/stereomanager.hpp>

#include "postprocessor.hpp"

namespace MWRender
{

    PingPongCull::PingPongCull(PostProcessor* pp)
        : mViewportStateset(nullptr)
        , mPostProcessor(pp)
    {
#ifdef __EMSCRIPTEN__
        // Scene render-scale (web): like stereo, the scene renders at a resolution different from
        // the window (renderWidth/renderHeight = a fraction of the canvas). Overriding the
        // RenderStage viewport here — at the same place the scene FBO is bound — is the one spot
        // that authoritatively controls the scene rasterization extent; the master camera (and the
        // GUI, which sizes itself from it) stays at native canvas size. At scale 1 the override
        // equals the camera viewport and is a no-op.
        const bool needViewportOverride = true;
#else
        const bool needViewportOverride = Stereo::getStereo();
#endif
        if (needViewportOverride)
        {
            mViewportStateset = new osg::StateSet();
            mViewport = new osg::Viewport;
            mViewportStateset->setAttribute(mViewport);
        }
    }

    PingPongCull::~PingPongCull()
    {
        // Instantiate osg::ref_ptr<> destructor
    }

    void PingPongCull::operator()(osg::Node* node, osgUtil::CullVisitor* cv)
    {
        osgUtil::RenderStage* renderStage = cv->getCurrentRenderStage();
        unsigned frame = cv->getTraversalNumber();
        unsigned frameId = frame % 2;

        if (Stereo::getStereo())
        {
            auto& sm = Stereo::Manager::instance();
            auto view = sm.getEye(cv);
            int index = view == Stereo::Eye::Right ? 1 : 0;
            auto projectionMatrix = sm.computeEyeProjection(index, true);
            mPostProcessor->getStateUpdater()->setProjectionMatrix(projectionMatrix);
        }

        mPostProcessor->getStateUpdater()->setViewMatrix(cv->getCurrentCamera()->getViewMatrix());
        mPostProcessor->getStateUpdater()->setPrevViewMatrix(mLastViewMatrix[0]);
        mLastViewMatrix[0] = cv->getCurrentCamera()->getViewMatrix();

        mPostProcessor->getStateUpdater()->setEyePos(cv->getEyePoint());
        mPostProcessor->getStateUpdater()->setEyeVec(cv->getLookVectorLocal());

        if (!mPostProcessor->getFbo(PostProcessor::FBO_Multisample, frameId))
        {
            renderStage->setFrameBufferObject(mPostProcessor->getFbo(PostProcessor::FBO_Primary, frameId));
        }
        else
        {
            renderStage->setMultisampleResolveFramebufferObject(
                mPostProcessor->getFbo(PostProcessor::FBO_Primary, frameId));
            renderStage->setFrameBufferObject(mPostProcessor->getFbo(PostProcessor::FBO_Multisample, frameId));

            // The MultiView patch has a bug where it does not update resolve layers if the resolve framebuffer is
            // changed. So we do blit manually in this case
            if (Stereo::getMultiview() && !renderStage->getDrawCallback())
                Stereo::setMultiviewMSAAResolveCallback(renderStage);
        }

        if (mViewportStateset)
        {
            mViewport->setViewport(0, 0, mPostProcessor->renderWidth(), mPostProcessor->renderHeight());
            renderStage->setViewport(mViewport);
#ifdef __EMSCRIPTEN__
            {
                static int rsDbgN = 0;
                static const bool rsDbg = getenv("OPENMW_RS_DEBUG") != nullptr;
                if (rsDbg && (rsDbgN++ % 120) == 0)
                {
                    const osg::Viewport* camVp = cv->getCurrentCamera()->getViewport();
                    printf("[rs] cull: stageVp=%dx%d camVp=%dx%d\n",
                        static_cast<int>(mViewport->width()), static_cast<int>(mViewport->height()),
                        camVp ? static_cast<int>(camVp->width()) : -1,
                        camVp ? static_cast<int>(camVp->height()) : -1);
                }
            }
#endif
            cv->pushStateSet(mViewportStateset.get());
            traverse(node, cv);
            cv->popStateSet();
        }
        else
            traverse(node, cv);
    }
}
