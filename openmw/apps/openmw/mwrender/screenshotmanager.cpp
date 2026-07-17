// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "screenshotmanager.hpp"

#include <condition_variable>
#include <mutex>

#include <components/stereo/multiview.hpp>
#include <components/stereo/stereomanager.hpp>

#include "../mwbase/environment.hpp"
#include "../mwbase/world.hpp"

#include "postprocessor.hpp"

namespace MWRender
{

    class NotifyDrawCompletedCallback : public osg::Camera::DrawCallback
    {
    public:
        NotifyDrawCompletedCallback()
            : mDone(false)
            , mFrame(0)
        {
        }

        void operator()(osg::RenderInfo& renderInfo) const override
        {
            std::lock_guard<std::mutex> lock(mMutex);
            if (renderInfo.getState()->getFrameStamp()->getFrameNumber() >= mFrame && !mDone)
            {
                mDone = true;
                mCondition.notify_one();
            }
        }

        void waitTillDone()
        {
            std::unique_lock<std::mutex> lock(mMutex);
            if (mDone)
                return;
            mCondition.wait(lock);
        }

        void reset(unsigned int frame)
        {
            std::lock_guard<std::mutex> lock(mMutex);
            mDone = false;
            mFrame = frame;
        }

        mutable std::condition_variable mCondition;
        mutable std::mutex mMutex;
        mutable bool mDone;
        unsigned int mFrame;
    };

    class ReadImageFromFramebufferCallback : public osg::Drawable::DrawCallback
    {
    public:
        ReadImageFromFramebufferCallback(osg::Image* image, int width, int height)
            : mWidth(width)
            , mHeight(height)
            , mImage(image)
        {
        }
        void drawImplementation(osg::RenderInfo& renderInfo, const osg::Drawable* /*drawable*/) const override
        {
            int screenW = static_cast<int>(renderInfo.getCurrentCamera()->getViewport()->width());
            int screenH = static_cast<int>(renderInfo.getCurrentCamera()->getViewport()->height());
            if (Stereo::getStereo())
            {
                auto eyeRes = Stereo::Manager::instance().eyeResolution();
                screenW = eyeRes.x();
                screenH = eyeRes.y();
            }
            double imageaspect = double(mWidth) / double(mHeight);
            int leftPadding = std::max(0, static_cast<int>(screenW - screenH * imageaspect) / 2);
            int topPadding = std::max(0, static_cast<int>(screenH - screenW / imageaspect) / 2);
            int width = screenW - leftPadding * 2;
            int height = screenH - topPadding * 2;

#ifdef __EMSCRIPTEN__
            // WebGL2/ANGLE: glReadPixels only guarantees GL_RGBA+GL_UNSIGNED_BYTE; GL_RGB is an
            // invalid format/type combination (GL_INVALID_OPERATION), which broke the saved-game
            // thumbnail readback. Read RGBA (the safe combo) then drop alpha into a GL_RGB image so
            // the downstream jpg (save thumbnail) and png (F12 screenshot) writers — which only
            // accept GL_RGB here — get exactly the format they expect. data(x,y) accounts for any
            // row padding, so this is alignment-safe.
            osg::ref_ptr<osg::Image> rgba = new osg::Image;
            rgba->readPixels(leftPadding, topPadding, width, height, GL_RGBA, GL_UNSIGNED_BYTE);
            mImage->allocateImage(width, height, 1, GL_RGB, GL_UNSIGNED_BYTE);
            for (int y = 0; y < height; ++y)
            {
                const unsigned char* src = rgba->data(0, y);
                unsigned char* dst = mImage->data(0, y);
                for (int x = 0; x < width; ++x)
                {
                    dst[x * 3 + 0] = src[x * 4 + 0];
                    dst[x * 3 + 1] = src[x * 4 + 1];
                    dst[x * 3 + 2] = src[x * 4 + 2];
                }
            }
#else
            mImage->readPixels(leftPadding, topPadding, width, height, GL_RGB, GL_UNSIGNED_BYTE);
#endif
            mImage->scaleImage(mWidth, mHeight, 1);
        }

    private:
        int mWidth;
        int mHeight;
        osg::ref_ptr<osg::Image> mImage;
    };

    ScreenshotManager::ScreenshotManager(osgViewer::Viewer* viewer)
        : mViewer(viewer)
        , mDrawCompleteCallback(new NotifyDrawCompletedCallback)
    {
    }

    ScreenshotManager::~ScreenshotManager() {}

    void ScreenshotManager::screenshot(osg::Image* image, int w, int h)
    {
        osg::Camera* camera = MWBase::Environment::get().getWorld()->getPostProcessor()->getHUDCamera();
        osg::ref_ptr<osg::Drawable> tempDrw = new osg::Drawable;
        tempDrw->setDrawCallback(new ReadImageFromFramebufferCallback(image, w, h));
        tempDrw->setCullingActive(false);
        tempDrw->getOrCreateStateSet()->setRenderBinDetails(100, "RenderBin",
            osg::StateSet::USE_RENDERBIN_DETAILS); // so its after all scene bins but before POST_RENDER gui camera
        camera->addChild(tempDrw);

        // Ref https://gitlab.com/OpenMW/openmw/-/issues/6013
        mDrawCompleteCallback->reset(mViewer->getFrameStamp()->getFrameNumber());
        mViewer->getCamera()->setFinalDrawCallback(mDrawCompleteCallback);
        mViewer->eventTraversal();
        mViewer->updateTraversal();
        mViewer->renderingTraversals();
        mDrawCompleteCallback->waitTillDone();

        // now that we've "used up" the current frame, get a fresh frame number for the next frame() following after the
        // screenshot is completed
        mViewer->advance(mViewer->getFrameStamp()->getSimulationTime());
        camera->removeChild(tempDrw);
    }
}
