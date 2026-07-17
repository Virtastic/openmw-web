// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "videoplayer.hpp"

#include <iostream>

#include <osg/Notify>
#include <osg/Texture2D>

#include "audiofactory.hpp"
#include "videostate.hpp"

namespace Video
{

VideoPlayer::VideoPlayer()
    : mState(nullptr)
{

}

VideoPlayer::~VideoPlayer()
{
    if(mState)
        close();
}

void VideoPlayer::setAudioFactory(MovieAudioFactory *factory)
{
    mAudioFactory.reset(factory);
}

void VideoPlayer::playVideo(std::unique_ptr<std::istream>&& inputstream, const std::string& name)
{
    if(mState)
        close();

    try {
        mState = new VideoState;
        mState->setAudioFactory(mAudioFactory.get());
        mState->init(std::move(inputstream), name);

#ifndef __EMSCRIPTEN__
        // wait until we have the first picture
        // (Under emscripten this busy-wait can starve/deadlock the browser main thread
        // while the decode pthreads spin up. The caller polls update() cooperatively and
        // VideoWidget attaches the texture as soon as the first frame lands instead.)
        while (mState->video_st && !mState->mTexture.get())
        {
            if (!mState->update())
                break;
        }
#endif
    }
    catch(std::exception& e) {
        OSG_FATAL << "Failed to play video: " << e.what() << std::endl;
        close();
    }
}

bool VideoPlayer::update ()
{
    if(mState)
        return mState->update();
    return false;
}

osg::ref_ptr<osg::Texture2D> VideoPlayer::getVideoTexture()
{
    if (mState)
        return mState->mTexture;
    return osg::ref_ptr<osg::Texture2D>();
}

int VideoPlayer::getVideoWidth()
{
    int width=0;
    if (mState && mState->mTexture.get() && mState->mTexture->getImage())
        width = mState->mTexture->getImage()->s();
    return width;
}

int VideoPlayer::getVideoHeight()
{
    int height=0;
    if (mState && mState->mTexture.get() && mState->mTexture->getImage())
        height = mState->mTexture->getImage()->t();
    return height;
}

void VideoPlayer::close()
{
    if(mState)
    {
        mState->deinit();

        delete mState;
        mState = nullptr;
    }
}

bool VideoPlayer::hasAudioStream()
{
    return mState && mState->audio_st != nullptr;
}

void VideoPlayer::play()
{
    if (mState)
        mState->setPaused(false);
}

void VideoPlayer::pause()
{
    if (mState)
        mState->setPaused(true);
}

bool VideoPlayer::isPaused()
{
    if (mState)
        return mState->mPaused;
    return true;
}

double VideoPlayer::getCurrentTime()
{
    if (mState)
        return mState->get_master_clock();
    return 0.0;
}

void VideoPlayer::seek(double time)
{
    if (mState)
        mState->seekTo(time);
}

double VideoPlayer::getDuration()
{
    if (mState)
        return mState->getDuration();
    return 0.0;
}

}
