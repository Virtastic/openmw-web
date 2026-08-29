#include "sdlgraphicswindow.hpp"

#include <SDL_video.h>
#ifdef OPENMW_PROXY_GL
#include <emscripten/html5_webgl.h>
#endif

#ifdef OPENMW_GL4ES_MANUAL_INIT
#include "gl4esinit.h"
#endif

namespace SDLUtil
{

    GraphicsWindowSDL2::~GraphicsWindowSDL2()
    {
        close(true);
    }

    GraphicsWindowSDL2::GraphicsWindowSDL2(osg::GraphicsContext::Traits* traits, VSyncMode vsyncMode)
        : mWindow(nullptr)
        , mContext(nullptr)
        , mValid(false)
        , mRealized(false)
        , mOwnsWindow(false)
        , mVSyncMode(vsyncMode)
    {
        _traits = traits;

        init();
        if (GraphicsWindowSDL2::valid())
        {
            setState(new osg::State);
            getState()->setGraphicsContext(this);

            if (_traits.valid() && _traits->sharedContext.valid())
            {
                getState()->setContextID(_traits->sharedContext->getState()->getContextID());
                incrementContextIDUsageCount(getState()->getContextID());
            }
            else
            {
                getState()->setContextID(osg::GraphicsContext::createNewContextID());
            }
        }
    }

    bool GraphicsWindowSDL2::setWindowDecorationImplementation(bool flag)
    {
        if (!mWindow)
            return false;

        SDL_SetWindowBordered(mWindow, flag ? SDL_TRUE : SDL_FALSE);
        return true;
    }

    bool GraphicsWindowSDL2::setWindowRectangleImplementation(int x, int y, int width, int height)
    {
        if (!mWindow)
            return false;

        int w, h;
        SDL_GetWindowSize(mWindow, &w, &h);
        int dw, dh;
        SDL_GL_GetDrawableSize(mWindow, &dw, &dh);

        SDL_SetWindowPosition(mWindow, x, y);
        // Floating point: integer (dw/w) truncates a fractional device-pixel ratio to 1 (no scaling)
        // and truncates to 0 when the drawable is smaller than the window (div by zero).
        SDL_SetWindowSize(mWindow, dw > 0 ? static_cast<int>(static_cast<double>(width) * w / dw + 0.5) : width,
            dh > 0 ? static_cast<int>(static_cast<double>(height) * h / dh + 0.5) : height);
        return true;
    }

    void GraphicsWindowSDL2::setWindowName(const std::string& name)
    {
        if (!mWindow)
            return;

        SDL_SetWindowTitle(mWindow, name.c_str());
        _traits->windowName = name;
    }

    void GraphicsWindowSDL2::setCursor(MouseCursor mouseCursor)
    {
        _traits->useCursor = false;
    }

    void GraphicsWindowSDL2::init()
    {
        if (mValid)
            return;

        if (!_traits.valid())
            return;

        WindowData* inheritedWindowData = dynamic_cast<WindowData*>(_traits->inheritedWindowData.get());
        mWindow = inheritedWindowData ? inheritedWindowData->mWindow : nullptr;

        mOwnsWindow = (mWindow == nullptr);
        if (mOwnsWindow)
        {
            OSG_FATAL << "Error: No SDL window provided." << std::endl;
            return;
        }

        // SDL will change the current context when it creates a new one, so we
        // have to get the current one to be able to restore it afterward.
        SDL_Window* oldWin = SDL_GL_GetCurrentWindow();
        SDL_GLContext oldCtx = SDL_GL_GetCurrentContext();

#if defined(ANDROID) || defined(OPENMW_GL4ES_MANUAL_INIT)
        int major = 1;
        int minor = 1;
        char* ver = getenv("OPENMW_GLES_VERSION");

        if (ver && strcmp(ver, "2") == 0)
        {
            major = 2;
            minor = 0;
        }
        else if (ver && strcmp(ver, "3") == 0)
        {
            major = 3;
            minor = 2;
        }

        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, major);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, minor);
#endif

#ifdef OPENMW_PROXY_GL
        // F10: create the WebGL context OURSELVES against the OffscreenCanvas, on this thread.
        //
        // SDL2's emscripten backend creates GL through EGL, and emscripten's EGL is hard-wired to
        // the MAIN-THREAD canvas. Proven by stack trace under -sPROXY_TO_PTHREAD:
        //     _eglCreateContext -> Browser.createContext -> getContext  (on the game canvas)
        // which throws 'Cannot get context from a canvas that has transferred its control to
        // offscreen' the moment the canvas belongs to the worker. There is no OffscreenCanvas
        // support anywhere in SDL2's src/video/emscripten, so this cannot be configured around.
        //
        // THE FOUR ATTRIBUTES BELOW ARE NOT DEFAULTS -- they are the play/index.html getContext
        // wrapper, which patches HTMLCanvasElement.prototype and therefore does NOTHING for a
        // context created here. Each fixes a real bug and must travel with the context:
        //   alpha=false            an alpha canvas composites the PAGE BACKGROUND through any
        //                          fragment with dst-alpha<1 -- halos on particles, weather and
        //                          GUI edges -- and treats pixels as premultiplied while OpenMW
        //                          blends straight alpha. Desktop renders opaque; so must we.
        //   powerPreference=high   dual-GPU laptops otherwise render on the iGPU.
        //   antialias=false        OpenMW does its own AA; the default would cost a resolve.
        //   depth/stencil          OSG expects a packed depth-stencil target.
        // The two getExtension() calls the wrapper also made (EXT_texture_filter_anisotropic,
        // EXT_color_buffer_float) are enabled after makeCurrent below, for the same reason.
        EmscriptenWebGLContextAttributes attrs;
        emscripten_webgl_init_context_attributes(&attrs);
        attrs.majorVersion = 2; // WebGL2 == GLES 3.0, which is what the engine targets
        attrs.minorVersion = 0;
        attrs.alpha = EM_FALSE;
        attrs.premultipliedAlpha = EM_FALSE;
        attrs.antialias = EM_FALSE;
        attrs.depth = EM_TRUE;
        attrs.stencil = EM_TRUE;
        attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
        // Render into the canvas this thread owns. With -sOFFSCREENCANVASES_TO_PTHREAD=#canvas
        // the transfer already happened; we are just naming the same target.
        attrs.explicitSwapControl = EM_FALSE;
        const EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx = emscripten_webgl_create_context("#canvas", &attrs);
        if (ctx <= 0)
        {
            OSG_FATAL << "Error: emscripten_webgl_create_context failed for #canvas (handle "
                      << ctx << "). Under PROXY_TO_PTHREAD the canvas must have been transferred"
                         " with -sOFFSCREENCANVASES_TO_PTHREAD." << std::endl;
            return;
        }
        if (emscripten_webgl_make_context_current(ctx) != EMSCRIPTEN_RESULT_SUCCESS)
        {
            OSG_FATAL << "Error: emscripten_webgl_make_context_current failed" << std::endl;
            return;
        }
        // See the attribute note above: these two were enabled by the index.html wrapper.
        // EXT_texture_filter_anisotropic -- WebGL2 advertises anisotropy in the extension string,
        // so OSG believes it usable, but GL_TEXTURE_MAX_ANISOTROPY_EXT is only ACCEPTED after
        // getExtension(); without this glTexParameterf raises GL_INVALID_ENUM.
        // EXT_color_buffer_float -- makes RGBA16F/32F colour-renderable, else post-processing
        // float targets are FBO-incomplete and render black.
        emscripten_webgl_enable_extension(ctx, "EXT_texture_filter_anisotropic");
        emscripten_webgl_enable_extension(ctx, "EXT_color_buffer_float");
        mProxyGlContext = ctx;
        // SDL still owns the window (input, sizing); it just does not own the GL context.
        mContext = nullptr;
#else
        mContext = SDL_GL_CreateContext(mWindow);
#endif
#ifndef OPENMW_PROXY_GL
        // Proxy path deliberately leaves mContext null: SDL owns the window, not the context.
        if (!mContext)
        {
            OSG_FATAL << "Error: Unable to create OpenGL graphics context: " << SDL_GetError() << std::endl;
            return;
        }
#endif

#ifdef OPENMW_GL4ES_MANUAL_INIT
        openmw_gl4es_init(mWindow);
#endif

        setSwapInterval(mVSyncMode);

        // Update traits with what we've actually been given
        // Use intermediate to avoid signed/unsigned mismatch
        int intermediateLocation;
        SDL_GL_GetAttribute(SDL_GL_RED_SIZE, &intermediateLocation);
        _traits->red = intermediateLocation;
        SDL_GL_GetAttribute(SDL_GL_GREEN_SIZE, &intermediateLocation);
        _traits->green = intermediateLocation;
        SDL_GL_GetAttribute(SDL_GL_BLUE_SIZE, &intermediateLocation);
        _traits->blue = intermediateLocation;
        SDL_GL_GetAttribute(SDL_GL_ALPHA_SIZE, &intermediateLocation);
        _traits->alpha = intermediateLocation;
        SDL_GL_GetAttribute(SDL_GL_DEPTH_SIZE, &intermediateLocation);
        _traits->depth = intermediateLocation;
        SDL_GL_GetAttribute(SDL_GL_STENCIL_SIZE, &intermediateLocation);
        _traits->stencil = intermediateLocation;

        SDL_GL_GetAttribute(SDL_GL_DOUBLEBUFFER, &intermediateLocation);
        _traits->doubleBuffer = intermediateLocation;
        SDL_GL_GetAttribute(SDL_GL_MULTISAMPLEBUFFERS, &intermediateLocation);
        _traits->sampleBuffers = intermediateLocation;
        SDL_GL_GetAttribute(SDL_GL_MULTISAMPLESAMPLES, &intermediateLocation);
        _traits->samples = intermediateLocation;

        SDL_GL_MakeCurrent(oldWin, oldCtx);

        mValid = true;

        getEventQueue()->syncWindowRectangleWithGraphicsContext();
    }

    bool GraphicsWindowSDL2::realizeImplementation()
    {
        if (mRealized)
        {
            OSG_NOTICE << "GraphicsWindowSDL2::realizeImplementation() Already realized" << std::endl;
            return true;
        }

        if (!mValid)
            init();
        if (!mValid)
            return false;

        SDL_ShowWindow(mWindow);

        getEventQueue()->syncWindowRectangleWithGraphicsContext();

        mRealized = true;

        return true;
    }

    bool GraphicsWindowSDL2::makeCurrentImplementation()
    {
        if (!mRealized)
        {
            OSG_WARN << "Warning: GraphicsWindow not realized, cannot do makeCurrent." << std::endl;
            return false;
        }

#ifdef OPENMW_PROXY_GL
        // The context is ours, not SDL's (see makeCurrentImplementation above).
        return emscripten_webgl_make_context_current(mProxyGlContext) == EMSCRIPTEN_RESULT_SUCCESS;
#else
        return SDL_GL_MakeCurrent(mWindow, mContext) == 0;
#endif
    }

    bool GraphicsWindowSDL2::releaseContextImplementation()
    {
        if (!mRealized)
        {
            OSG_WARN << "Warning: GraphicsWindow not realized, cannot do releaseContext." << std::endl;
            return false;
        }

#ifdef OPENMW_PROXY_GL
        // 0 is emscripten's "no context"; releasing is how OSG hands the thread off.
        return emscripten_webgl_make_context_current(0) == EMSCRIPTEN_RESULT_SUCCESS;
#else
        return SDL_GL_MakeCurrent(nullptr, nullptr) == 0;
#endif
    }

    void GraphicsWindowSDL2::closeImplementation()
    {
        if (mContext)
            SDL_GL_DeleteContext(mContext);
        mContext = nullptr;

        if (mWindow && mOwnsWindow)
            SDL_DestroyWindow(mWindow);
        mWindow = nullptr;

        mValid = false;
        mRealized = false;
    }

    void GraphicsWindowSDL2::swapBuffersImplementation()
    {
        if (!mRealized)
            return;

#ifdef OPENMW_PROXY_GL
        // With explicitSwapControl=false the browser presents when the frame callback returns,
        // so there is nothing to swap -- and SDL_GL_SwapWindow would drive SDL's EGL, which does
        // not own this context. Deliberately a no-op rather than an omission.
#else
        SDL_GL_SwapWindow(mWindow);
#endif
    }

    void GraphicsWindowSDL2::setSyncToVBlank(bool on)
    {
        throw std::runtime_error(
            "setSyncToVBlank with bool argument is not supported. Use the VSyncMode argument instead.");
    }

    void GraphicsWindowSDL2::setSyncToVBlank(VSyncMode mode)
    {
        SDL_Window* oldWin = SDL_GL_GetCurrentWindow();
        SDL_GLContext oldCtx = SDL_GL_GetCurrentContext();

        SDL_GL_MakeCurrent(mWindow, mContext);

        setSwapInterval(mode);

        SDL_GL_MakeCurrent(oldWin, oldCtx);
    }

    void GraphicsWindowSDL2::setSwapInterval(VSyncMode mode)
    {
        mVSyncMode = mode;

        if (mode == VSyncMode::Adaptive)
        {
            if (SDL_GL_SetSwapInterval(-1) == -1)
            {
                OSG_NOTICE << "Adaptive vsync unsupported" << std::endl;
                setSwapInterval(VSyncMode::Enabled);
            }
        }
        else if (mode == VSyncMode::Enabled)
        {
            if (SDL_GL_SetSwapInterval(1) == -1)
            {
                OSG_NOTICE << "Vertical synchronization unsupported, disabling" << std::endl;
                setSwapInterval(VSyncMode::Disabled);
            }
        }
        else
        {
            SDL_GL_SetSwapInterval(0);
        }
    }

    void GraphicsWindowSDL2::raiseWindow()
    {
        SDL_RaiseWindow(mWindow);
    }

}
