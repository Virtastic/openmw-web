// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "videowidget.hpp"

#include <osg-ffmpeg-videoplayer/videoplayer.hpp>

#include <MyGUI_RenderManager.h>

#include <osg/Texture2D>

#include <components/debug/debuglog.hpp>
#include <components/myguiplatform/myguitexture.hpp>
#include <components/vfs/manager.hpp>

#include "../mwsound/movieaudiofactory.hpp"

namespace MWGui
{

    VideoWidget::VideoWidget()
        : mVFS(nullptr)
    {
        mPlayer = std::make_unique<Video::VideoPlayer>();
        setNeedKeyFocus(true);
    }

    VideoWidget::~VideoWidget() = default;

    void VideoWidget::setVFS(const VFS::Manager* vfs)
    {
        mVFS = vfs;
    }

    void VideoWidget::playVideo(const std::string& video)
    {
        mPlayer->setAudioFactory(new MWSound::MovieAudioFactory());

        Files::IStreamPtr videoStream;
        try
        {
            videoStream = mVFS->get(video);
        }
        catch (std::exception& e)
        {
            Log(Debug::Error) << "Failed to open video: " << e.what();
            return;
        }

        mPlayer->playVideo(std::move(videoStream), video);

#ifdef __EMSCRIPTEN__
        // On this platform the first frame may not be decoded yet when playVideo returns, so
        // getVideoTexture() can be null here; update() attaches it once it lands. Crucially we
        // must forget any texture from a previously played video (e.g. the menu background),
        // otherwise the stale texture keeps rendering and the new video appears frozen.
        mAttachedTexture = nullptr;
        attachCurrentTexture();
#else
        osg::ref_ptr<osg::Texture2D> texture = mPlayer->getVideoTexture();
        if (!texture)
            return;

        mTexture = std::make_unique<MyGUIPlatform::OSGTexture>(texture);

        setRenderItemTexture(mTexture.get());
        // Both the widget and the video frame are Y-down, so this UV is not inverted
        getSubWidgetMain()->_setUVSet(MyGUI::FloatRect(0.f, 0.f, 1.f, 1.f));
#endif
    }

    int VideoWidget::getVideoWidth()
    {
        return mPlayer->getVideoWidth();
    }

    int VideoWidget::getVideoHeight()
    {
        return mPlayer->getVideoHeight();
    }

    bool VideoWidget::update()
    {
#ifdef __EMSCRIPTEN__
        // Cooperative playback skips the first-frame wait in VideoPlayer::playVideo, so the
        // texture may not exist yet when playVideo returns — attach it on the tick it lands.
        // We compare the underlying osg::Texture2D pointer (not just !mTexture) so a swap from
        // one video to the next (menu background -> mw_intro) re-binds instead of leaving the
        // previous, now-stale texture on screen (which looked like a frozen first frame).
        attachCurrentTexture();
#endif
        return mPlayer->update();
    }

#ifdef __EMSCRIPTEN__
    void VideoWidget::attachCurrentTexture()
    {
        osg::ref_ptr<osg::Texture2D> texture = mPlayer->getVideoTexture();
        if (texture.get() == mAttachedTexture)
            return; // already attached (or still null)

        mAttachedTexture = texture.get();
        if (!texture)
            return;

        mTexture = std::make_unique<MyGUIPlatform::OSGTexture>(texture);
        setRenderItemTexture(mTexture.get());
        // Both the widget and the video frame are Y-down, so this UV is not inverted
        getSubWidgetMain()->_setUVSet(MyGUI::FloatRect(0.f, 0.f, 1.f, 1.f));
    }
#endif

#ifdef __EMSCRIPTEN__
    unsigned VideoWidget::getFrameCounter() const
    {
        // NOTE: the decoder installs a brand-new osg::Image on the texture for every video
        // frame (VideoState::video_display), so getModifiedCount() alone is CONSTANT during
        // healthy playback — hash the image pointer in so the value changes per frame.
        osg::ref_ptr<osg::Texture2D> texture = mPlayer->getVideoTexture();
        if (texture && texture->getImage())
            return static_cast<unsigned>(reinterpret_cast<uintptr_t>(texture->getImage()))
                ^ texture->getImage()->getModifiedCount();
        return 0;
    }
#endif

    void VideoWidget::stop()
    {
        mPlayer->close();
    }

    void VideoWidget::pause()
    {
        mPlayer->pause();
    }

    void VideoWidget::resume()
    {
        mPlayer->play();
    }

    bool VideoWidget::isPaused() const
    {
        return mPlayer->isPaused();
    }

    bool VideoWidget::hasAudioStream()
    {
        return mPlayer->hasAudioStream();
    }

    void VideoWidget::autoResize(bool stretch)
    {
        MyGUI::IntSize screenSize = MyGUI::RenderManager::getInstance().getViewSize();
        if (getParent())
            screenSize = getParent()->getSize();

        if (getVideoHeight() > 0 && !stretch)
        {
            double imageaspect = static_cast<double>(getVideoWidth()) / getVideoHeight();

            int leftPadding = std::max(0, static_cast<int>(screenSize.width - screenSize.height * imageaspect) / 2);
            int topPadding = std::max(0, static_cast<int>(screenSize.height - screenSize.width / imageaspect) / 2);

            setCoord(leftPadding, topPadding, screenSize.width - leftPadding * 2, screenSize.height - topPadding * 2);
        }
        else
            setCoord(0, 0, screenSize.width, screenSize.height);
    }

}
