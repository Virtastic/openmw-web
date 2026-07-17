// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#ifndef OPENMW_MWGUI_VIDEOWIDGET_H
#define OPENMW_MWGUI_VIDEOWIDGET_H

#include <memory>

#include <MyGUI_Widget.h>

namespace Video
{
    class VideoPlayer;
}

namespace VFS
{
    class Manager;
}

namespace MWGui
{

    /**
     * Widget that plays a video.
     */
    class VideoWidget : public MyGUI::Widget
    {
    public:
        MYGUI_RTTI_DERIVED(VideoWidget)

        VideoWidget();

        ~VideoWidget();

        /// Set the VFS (virtual file system) to find the videos on.
        void setVFS(const VFS::Manager* vfs);

        void playVideo(const std::string& video);

        int getVideoWidth();
        int getVideoHeight();

        /// @return Is the video still playing?
        bool update();

        /// Return true if a video is currently playing and it has an audio stream.
        bool hasAudioStream();

        /// Stop video and free resources (done automatically on destruction)
        void stop();

        void pause();
        void resume();
        bool isPaused() const;

        /// Adjust the coordinates of this video widget relative to its parent,
        /// based on the dimensions of the playing video.
        /// @param stretch Stretch the video to fill the whole screen? If false,
        ///                black bars may be added to fix the aspect ratio.
        void autoResize(bool stretch);

    private:
        const VFS::Manager* mVFS;
        std::unique_ptr<MyGUI::ITexture> mTexture;
        std::unique_ptr<Video::VideoPlayer> mPlayer;
#ifdef __EMSCRIPTEN__
        // The osg::Texture2D currently wrapped by mTexture. Used by the cooperative update()
        // to detect when a new video's texture has appeared (including a menu->intro swap,
        // where the previous video's texture is still attached) and re-bind it.
        void* mAttachedTexture = nullptr;
        void attachCurrentTexture();

    public:
        // Monotonic per-frame upload counter of the current video texture (0 if none).
        // Lets the cooperative driver detect a decoder that claims to be playing but has
        // stopped producing frames (end-of-stream clock stall) and force-end it.
        unsigned getFrameCounter() const;

    private:
#endif
    };

}

#endif
