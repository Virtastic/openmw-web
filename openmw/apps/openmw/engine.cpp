// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "engine.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <osg/NodeVisitor>
#include <osg/DisplaySettings>
#include <osg/Geometry>
#include <osg/Group>
#include <osg/Geode>
#include <osg/Transform>
#include <osg/Camera>
#include <osg/Viewport>
#include <osg/Math>
#endif

#include <cerrno>
#include <chrono>
#include <future>
#include <system_error>

#include <osgDB/ReaderWriter>
#include <osgDB/Registry>
#include <osgViewer/ViewerEventHandlers>

#include <SDL.h>

#include <components/debug/debuglog.hpp>
#include <components/debug/gldebug.hpp>

#include <components/misc/rng.hpp>
#include <components/misc/strings/format.hpp>

#include <components/vfs/manager.hpp>
#include <components/vfs/registerarchives.hpp>

#include <components/sdlutil/imagetosurface.hpp>
#include <components/sdlutil/sdlgraphicswindow.hpp>

#include <components/resource/resourcesystem.hpp>
#include <components/resource/scenemanager.hpp>
#include <components/resource/stats.hpp>

#include <components/compiler/extensions0.hpp>

#include <components/stereo/stereomanager.hpp>

#include <components/sceneutil/glextensions.hpp>
#include <components/sceneutil/workqueue.hpp>

#include <components/files/configurationmanager.hpp>

#include <components/version/version.hpp>

#include <components/l10n/manager.hpp>

#include <components/loadinglistener/asynclistener.hpp>
#include <components/loadinglistener/loadinglistener.hpp>

#include <components/misc/frameratelimiter.hpp>

#include <components/sceneutil/color.hpp>
#include <components/sceneutil/depth.hpp>
#include <components/sceneutil/screencapture.hpp>
#include <components/sceneutil/unrefqueue.hpp>
#include <components/sceneutil/util.hpp>

#include <components/settings/shadermanager.hpp>
#include <components/settings/values.hpp>

#include "mwinput/inputmanagerimp.hpp"

#include "mwgui/windowmanagerimp.hpp"

#include "mwlua/luamanagerimp.hpp"
#include "mwlua/worker.hpp"

#include "mwscript/interpretercontext.hpp"
#include "mwscript/scriptmanagerimp.hpp"

#include "mwsound/constants.hpp"
#include "mwsound/soundmanagerimp.hpp"

#include "mwworld/class.hpp"
#include "mwworld/datetimemanager.hpp"
#include "mwworld/worldimp.hpp"
#include "mwworld/actionteleport.hpp"
#include "mwworld/globals.hpp"
#ifdef __EMSCRIPTEN__
#include "mwmechanics/drawstate.hpp"
#include "mwworld/inventorystore.hpp"
#include "mwworld/player.hpp"
#endif

#include <components/esm/util.hpp>
#include <components/esm3/loadcell.hpp>

#include "mwrender/vismask.hpp"
#include "mwrender/camera.hpp"
#include "mwbase/world.hpp"
#include "mwbase/environment.hpp"
#include "mwbase/mechanicsmanager.hpp"
#include "mwbase/windowmanager.hpp"
#include "mwgui/mode.hpp"

#include "mwclass/classes.hpp"

#include "mwdialogue/dialoguemanagerimp.hpp"
#include "mwdialogue/journalimp.hpp"
#include "mwdialogue/scripttest.hpp"

#include "mwmechanics/mechanicsmanagerimp.hpp"

#include "mwstate/statemanagerimp.hpp"

#include "profile.hpp"

namespace
{
    void checkSDLError(int ret)
    {
        if (ret != 0)
            Log(Debug::Error) << "SDL error: " << SDL_GetError();
    }

    void initStatsHandler(Resource::Profiler& profiler)
    {
        const osg::Vec4f textColor(1.f, 1.f, 1.f, 1.f);
        const osg::Vec4f barColor(1.f, 1.f, 1.f, 1.f);
        const float multiplier = 1000;
        const bool average = true;
        const bool averageInInverseSpace = false;
        const float maxValue = 10000;

        OMW::forEachUserStatsValue([&](const OMW::UserStats& v) {
            profiler.addUserStatsLine(v.mLabel, textColor, barColor, v.mTaken, multiplier, average,
                averageInInverseSpace, v.mBegin, v.mEnd, maxValue);
        });
        // the forEachUserStatsValue loop is "run" at compile time, hence the settings manager is not available.
        // Unconditionnally add the async physics stats, and then remove it at runtime if necessary
        if (Settings::physics().mAsyncNumThreads == 0)
            profiler.removeUserStatsLine(" -Async");
    }

    struct ScreenCaptureMessageBox
    {
        void operator()(std::string filePath) const
        {
            if (filePath.empty())
            {
                MWBase::Environment::get().getWindowManager()->scheduleMessageBox(
                    "#{OMWEngine:ScreenshotFailed}", MWGui::ShowInDialogueMode_Never);

                return;
            }

            auto l10n = MWBase::Environment::get().getL10nManager()->getContext("OMWEngine");
            std::string message = l10n->formatMessage("ScreenshotMade", { "file" }, { L10n::toUnicode(filePath) });

            MWBase::Environment::get().getWindowManager()->scheduleMessageBox(
                std::move(message), MWGui::ShowInDialogueMode_Never);
        }
    };

    struct IgnoreString
    {
        void operator()(std::string) const {}
    };

    class IdentifyOpenGLOperation : public osg::GraphicsOperation
    {
    public:
        IdentifyOpenGLOperation()
            : GraphicsOperation("IdentifyOpenGLOperation", false)
        {
        }

        void operator()(osg::GraphicsContext* graphicsContext) override
        {
            Log(Debug::Info) << "OpenGL Vendor: " << glGetString(GL_VENDOR);
            Log(Debug::Info) << "OpenGL Renderer: " << glGetString(GL_RENDERER);
            Log(Debug::Info) << "OpenGL Version: " << glGetString(GL_VERSION);
            glGetIntegerv(GL_MAX_TEXTURE_IMAGE_UNITS, &mMaxTextureImageUnits);
#ifdef __EMSCRIPTEN__
            // WebGL/GLES has no fixed-function pipeline. Let OSG rewrite gl_Vertex,
            // gl_*Matrix etc. in shader sources to bound attributes/uniforms.
            if (osg::State* state = graphicsContext->getState())
            {
                state->setUseModelViewAndProjectionUniforms(true);
                state->setUseVertexAttributeAliasing(true);
            }
#endif
        }

        int getMaxTextureImageUnits() const
        {
            if (mMaxTextureImageUnits == 0)
                throw std::logic_error("mMaxTextureImageUnits is not initialized");
            return mMaxTextureImageUnits;
        }

    private:
        int mMaxTextureImageUnits = 0;
    };

    void reportStats(unsigned frameNumber, osgViewer::Viewer& viewer, std::ostream& stream)
    {
        viewer.getViewerStats()->report(stream, frameNumber);
        osgViewer::Viewer::Cameras cameras;
        viewer.getCameras(cameras);
        for (osg::Camera* camera : cameras)
            camera->getStats()->report(stream, frameNumber);
    }
}

void OMW::Engine::executeLocalScripts()
{
    MWWorld::LocalScripts& localScripts = mWorld->getLocalScripts();

    localScripts.startIteration();
    std::pair<ESM::RefId, MWWorld::Ptr> script;
    while (localScripts.getNext(script))
    {
        MWScript::InterpreterContext interpreterContext(&script.second.getRefData().getLocals(), script.second);
        mScriptManager->run(script.first, interpreterContext);
    }
}

bool OMW::Engine::frame(unsigned frameNumber, float frametime)
{
    const osg::Timer_t frameStart = mViewer->getStartTick();
    const osg::Timer* const timer = osg::Timer::instance();
    osg::Stats* const stats = mViewer->getViewerStats();

    mEnvironment.setFrameDuration(frametime);

#ifdef __EMSCRIPTEN__
    // Cooperative video playback: WindowManager::playVideo returns immediately on this
    // platform (its native nested render loop would deadlock the browser main thread).
    // While a video is up, replace the game frame with the minimal video frame the native
    // loop would run — input + video decode + GUI render. Game simulation stays paused,
    // matching native playVideo semantics.
    if (mWindowManager->isPlayingVideo())
    {
        mWindowManager->updateVideoPlayback(frametime);
        // No background audio StreamThread on the web — refill the movie-audio stream
        // inline (the normal SoundManager::update path doesn't run during videos).
        mSoundManager->pumpAudioStreams();
        mViewer->eventTraversal();
        mViewer->updateTraversal();
        mViewer->renderingTraversals();
        return true;
    }
#endif

    try
    {
        // update input
        {
            ScopedProfile<UserStatsType::Input> profile(frameStart, frameNumber, *timer, *stats);
            mInputManager->update(frametime, false);
        }

        // When the window is minimized, pause the game. Currently this *has* to be here to work around a MyGUI bug.
        // If we are not currently rendering, then RenderItems will not be reused resulting in a memory leak upon
        // changing widget textures (fixed in MyGUI 3.3.2), and destroyed widgets will not be deleted (not fixed yet,
        // https://github.com/MyGUI/mygui/issues/21)
        {
            ScopedProfile<UserStatsType::Sound> profile(frameStart, frameNumber, *timer, *stats);

#ifdef __EMSCRIPTEN__
            // Emscripten's SDL port can report the canvas as hidden/minimized at startup,
            // which would pause the game forever. The requestAnimationFrame main loop already
            // stops ticking when the browser tab is hidden, so always render here.
            mSoundManager->resumePlayback();
#else
            if (!mWindowManager->isWindowVisible())
            {
                mSoundManager->pausePlayback();
                return false;
            }
            else
                mSoundManager->resumePlayback();
#endif

            // sound
            if (mUseSound)
                mSoundManager->update(frametime);
        }

        {
            ScopedProfile<UserStatsType::LuaSyncUpdate> profile(frameStart, frameNumber, *timer, *stats);
            // Should be called after input manager update and before any change to the game world.
            // It applies to the game world queued changes from the previous frame.
            mLuaManager->synchronizedUpdate();
        }

        // update game state
        {
            ScopedProfile<UserStatsType::State> profile(frameStart, frameNumber, *timer, *stats);
            mStateManager->update(frametime);
        }

        bool paused = mWorld->getTimeManager()->isPaused();

        {
            ScopedProfile<UserStatsType::Script> profile(frameStart, frameNumber, *timer, *stats);

            if (mStateManager->getState() != MWBase::StateManager::State_NoGame)
            {
                if (!mWindowManager->containsMode(MWGui::GM_MainMenu) || !paused)
                {
                    if (mWorld->getScriptsEnabled())
                    {
                        // local scripts
                        executeLocalScripts();

                        // global scripts
                        mScriptManager->getGlobalScripts().run();
                    }

                    mWorld->getWorldScene().markCellAsUnchanged();
                }

                if (!paused)
                {
                    double hours = (frametime * mWorld->getTimeManager()->getGameTimeScale()) / 3600.0;
                    mWorld->advanceTime(hours, true);
                    mWorld->rechargeItems(frametime, true);
                }
            }
        }

        // update mechanics
        {
            ScopedProfile<UserStatsType::Mechanics> profile(frameStart, frameNumber, *timer, *stats);

            if (mStateManager->getState() != MWBase::StateManager::State_NoGame)
            {
                mMechanicsManager->update(frametime, paused);
            }

            if (mStateManager->getState() == MWBase::StateManager::State_Running)
            {
                MWWorld::Ptr player = mWorld->getPlayerPtr();
                if (!paused && player.getClass().getCreatureStats(player).isDead())
                    mStateManager->endGame();
            }
        }

        // update physics
        {
            ScopedProfile<UserStatsType::Physics> profile(frameStart, frameNumber, *timer, *stats);

            if (mStateManager->getState() != MWBase::StateManager::State_NoGame)
            {
                mWorld->updatePhysics(frametime, paused, frameStart, frameNumber, *stats);
            }
        }

        // update world
        {
            ScopedProfile<UserStatsType::World> profile(frameStart, frameNumber, *timer, *stats);

            if (mStateManager->getState() != MWBase::StateManager::State_NoGame)
            {
                mWorld->update(frametime, paused);
            }
        }

        // update GUI
        {
            ScopedProfile<UserStatsType::Gui> profile(frameStart, frameNumber, *timer, *stats);
            mWindowManager->update(frametime);
        }
    }
    catch (const std::exception& e)
    {
        Log(Debug::Error) << "Error in frame: " << e.what();
    }

    const bool reportResource = stats->collectStats("resource");

    if (reportResource)
        stats->setAttribute(frameNumber, "UnrefQueue", static_cast<double>(mUnrefQueue->getSize()));

    mUnrefQueue->flush(*mWorkQueue);

    if (reportResource)
    {
        stats->setAttribute(frameNumber, "FrameNumber", frameNumber);

        mResourceSystem->reportStats(frameNumber, stats);

        stats->setAttribute(frameNumber, "WorkQueue", static_cast<double>(mWorkQueue->getNumItems()));
        stats->setAttribute(frameNumber, "WorkThread", static_cast<double>(mWorkQueue->getNumActiveThreads()));

        mMechanicsManager->reportStats(frameNumber, *stats);
        mWorld->reportStats(frameNumber, *stats);
        mLuaManager->reportStats(frameNumber, *stats);

        stats->setAttribute(frameNumber, "StringRefId Count", static_cast<double>(ESM::StringRefId::totalCount()));
    }

    mStereoManager->updateSettings(Settings::camera().mNearClip, Settings::camera().mViewingDistance);

    mViewer->eventTraversal();
    mViewer->updateTraversal();

    // HEADLESS: this is a full IntersectionVisitor descent of the scene graph, every frame,
    // for the sole purpose of deciding which object a crosshair is over so the GUI can draw a
    // tooltip. The sim peer has no crosshair and no GUI. Purely presentational — it has no
    // effect on AI, physics or scripts — so skipping it changes nothing about the simulation.
    static const bool sHeadless = std::getenv("OPENMW_HEADLESS") != nullptr;
#ifdef __EMSCRIPTEN__
    // ...and on the web, throttle it even when we DO have a crosshair. A tooltip does not need
    // 60Hz: at 20Hz the delay before an item name appears is under a frame of human perception,
    // and two thirds of the graph descents stop happening. The player cannot move far enough in
    // 33ms to make the answer stale.
    // Measure the cost first with ?perfstats=1: the Focus bucket already exists. If it is a
    // fraction of a millisecond, revert this -- it is only worth the asymmetry if it shows up.
    const bool skipFocusThisFrame = (frameNumber % 3 != 0);
#else
    constexpr bool skipFocusThisFrame = false;
#endif
    if (!sHeadless && !skipFocusThisFrame)
    {
        ScopedProfile<UserStatsType::Focus> profile(frameStart, frameNumber, *timer, *stats);
        mWorld->updateFocusObject();
    }

    // if there is a separate Lua thread, it starts the update now
    mLuaWorker->allowUpdate(frameStart, frameNumber, *stats);

    // H1 sim-peer spike: simulation (AI, physics, scripts) ran in updateTraversal() above;
    // drawing is this call alone. Skipping it is the entire headless saving — GL is paid
    // once at init and zero per frame. allowUpdate/finishUpdate stay paired around it.
    if (!sHeadless)
        mViewer->renderingTraversals();

#ifdef __EMSCRIPTEN__
    // ?perfstats=1 (QA): expose the per-frame CPU phase split (Cull vs Draw traversal, ms) to JS
    // as window.__omwPhase, WITHOUT the F3 stats HUD (which itself costs ~5ms and pollutes the
    // measurement). "rest" = window.__frameMs - cull - draw (update/physics/AI/GUI/Lua). Collection
    // is enabled once (takes effect from the next frame); GPU timer queries are omitted (unreliable
    // on WebGL2). Zero cost when the flag is off.
    {
        static int s_perf = getenv("OPENMW_PERF_STATS") ? 1 : 0;
        if (s_perf)
        {
            osgViewer::Viewer::Cameras cams;
            mViewer->getCameras(cams);
            // Re-arm EVERY frame rather than latching with a static. The latch version left
            // collectStats("engine") reading FALSE and the attribute map empty: whatever it armed
            // on the first perfstats frame was not what the ScopedProfiles later wrote through, so
            // every subsystem bucket stayed 0 while cull/draw worked. Both are idempotent map
            // assignments (osg/Stats:73), so re-arming is cheaper than reasoning about which
            // object won the race.
            for (osg::Camera* c : cams)
                if (c->getStats())
                    c->getStats()->collectStats("rendering", true);
            stats->collectStats("engine", true); // ScopedProfile buckets (prefix + "_time_taken")
            double cull = 0.0, draw = 0.0, v = 0.0;
            for (osg::Camera* c : cams)
            {
                osg::Stats* cs = c->getStats();
                if (!cs)
                    continue;
                if (cs->getAttribute(frameNumber, "Cull traversal time taken", v))
                    cull += v;
                if (cs->getAttribute(frameNumber, "Draw traversal time taken", v))
                    draw += v;
            }
            // DIAGNOSTIC (?perfkeys=1): the subsystem buckets below were reading zero while cull/draw
            // read fine, from this same osg::Stats. Rather than guess at the cause a fourth time,
            // publish the frame's actual attribute keys so the names and presence can be read
            // directly from the console. Costs a string build, so it is behind its own env flag.
            if (getenv("OPENMW_PERF_KEYS"))
            {
                std::string keys;
                for (const auto& [k, val] : stats->getAttributeMap(frameNumber))
                {
                    keys += k;
                    keys += '=';
                    keys += std::to_string(val);
                    keys += '\n';
                }
                const bool engineOn = stats->collectStats("engine");
                EM_ASM({ globalThis.__omwPhaseKeys = UTF8ToString($0); globalThis.__omwPhaseEngineOn = !!$1; },
                    keys.c_str(), engineOn ? 1 : 0);
            }

            // Rest-phase subsystem breakdown (engine ScopedProfile buckets, prefix + "_time_taken").
            // NB: Lua is inline on this build (see mwlua/worker.cpp), so UserStatsType::Lua never
            // fires and only LuaSyncUpdate does -- report the sum or the bucket reads a false 0.
            auto sub = [&](const char* key) { double x = 0.0; stats->getAttribute(frameNumber, key, x); return x * 1000.0; };
            // clang-format off
            // NB: no comma inside the EM_ASM code block — the C preprocessor would split it as a
            // macro argument. Build the object with separate statements instead.
            EM_ASM({
                globalThis.__omwPhase = {};
                globalThis.__omwPhase.cull = $0;
                globalThis.__omwPhase.draw = $1;
                globalThis.__omwPhase.physics = $2;
                globalThis.__omwPhase.mechanics = $3;
                globalThis.__omwPhase.world = $4;
                globalThis.__omwPhase.lua = $5;
                globalThis.__omwPhase.gui = $6;
                globalThis.__omwPhase.input = $7;
                globalThis.__omwPhase.sound = $8;
                globalThis.__omwPhase.script = $9;
            },
                cull * 1000.0, draw * 1000.0, sub("physics_time_taken"), sub("mechanics_time_taken"),
                sub("world_time_taken"), (sub("lua_time_taken") + sub("luasyncupdate_time_taken")), sub("gui_time_taken"),
                sub("input_time_taken"), sub("sound_time_taken"), sub("script_time_taken"));
            // clang-format on
        }
    }
#endif

    mLuaWorker->finishUpdate(frameStart, frameNumber, *stats);

    return true;
}

OMW::Engine::Engine(Files::ConfigurationManager& configurationManager)
    : mWindow(nullptr)
    , mEncoding(ToUTF8::WINDOWS_1252)
    , mScreenCaptureOperation(nullptr)
    , mSelectDepthFormatOperation(new SceneUtil::SelectDepthFormatOperation())
    , mSelectColorFormatOperation(new SceneUtil::Color::SelectColorFormatOperation())
    , mStereoManager(nullptr)
    , mSkipMenu(false)
    , mUseSound(true)
    , mCompileAll(false)
    , mCompileAllDialogue(false)
    , mWarningsMode(1)
    , mScriptConsoleMode(false)
    , mActivationDistanceOverride(-1)
    , mGrab(true)
    , mExportFonts(false)
    , mRandomSeed(0)
    , mNewGame(false)
    , mCfgMgr(configurationManager)
    , mGlMaxTextureImageUnits(0)
{
#if SDL_VERSION_ATLEAST(2, 24, 0)
    SDL_SetHint(SDL_HINT_MAC_OPENGL_ASYNC_DISPATCH, "1");
#endif
    SDL_SetHint(SDL_HINT_ACCELEROMETER_AS_JOYSTICK, "0"); // We use only gamepads

    Uint32 flags
        = SDL_INIT_VIDEO | SDL_INIT_NOPARACHUTE | SDL_INIT_GAMECONTROLLER | SDL_INIT_JOYSTICK | SDL_INIT_SENSOR;
    if (SDL_WasInit(flags) == 0)
    {
        SDL_SetMainReady();
        if (SDL_Init(flags) != 0)
        {
            throw std::runtime_error("Could not initialize SDL! " + std::string(SDL_GetError()));
        }
    }
}

OMW::Engine::~Engine()
{
    if (mScreenCaptureOperation != nullptr)
    {
        mScreenCaptureOperation->stop();
        mScreenCaptureOperation = nullptr;
    }
    mScreenCaptureHandler = nullptr;

    mMechanicsManager = nullptr;
    mDialogueManager = nullptr;
    mJournal = nullptr;
    mWindowManager = nullptr;
    mScriptManager = nullptr;
    mWorld = nullptr;
    mStereoManager = nullptr;
    mSoundManager = nullptr;
    mInputManager = nullptr;
    mStateManager = nullptr;
    mLuaWorker = nullptr;
    mLuaManager = nullptr;
    mL10nManager = nullptr;

    mScriptContext = nullptr;

    mUnrefQueue = nullptr;
    mWorkQueue = nullptr;

    mViewer = nullptr;

    mResourceSystem.reset();

    mEncoder = nullptr;

    if (mWindow)
    {
        SDL_DestroyWindow(mWindow);
        mWindow = nullptr;
    }

    SDL_Quit();

    Log(Debug::Info) << "Quitting peacefully.";
}

// Set data dir

void OMW::Engine::setDataDirs(const Files::PathContainer& dataDirs)
{
    mDataDirs = dataDirs;
    mDataDirs.insert(mDataDirs.begin(), mResDir / "vfs");
    mFileCollections = Files::Collections(mDataDirs);
}

// Add BSA archive
void OMW::Engine::addArchive(const std::string& archive)
{
    mArchives.push_back(archive);
}

// Set resource dir
void OMW::Engine::setResourceDir(const std::filesystem::path& parResDir)
{
    mResDir = parResDir;
    if (!Version::checkResourcesVersion(mResDir))
        Log(Debug::Error) << "Resources dir " << mResDir
                          << " doesn't match OpenMW binary, the game may work incorrectly.";
}

// Set start cell name
void OMW::Engine::setCell(const std::string& cellName)
{
    mCellName = cellName;
}

void OMW::Engine::addContentFile(const std::string& file)
{
    mContentFiles.push_back(file);
}

void OMW::Engine::addGroundcoverFile(const std::string& file)
{
    mGroundcoverFiles.emplace_back(file);
}

void OMW::Engine::setSkipMenu(bool skipMenu, bool newGame)
{
    mSkipMenu = skipMenu;
    mNewGame = newGame;
}

void OMW::Engine::createWindow()
{
    const int screen = Settings::video().mScreen;
#ifdef __EMSCRIPTEN__
    // The harness owns the canvas size (dpr + pixel budget, window.__renderW/H). Ignore any
    // persisted [Video] resolution: on web the only resolution dial is the SCENE render scale
    // ([Video] internal render scale, applied by the post-processor), and a small resolution
    // persisted by the pre-scale scheme must not shrink the canvas — that would blur the GUI.
    // clang-format off
    const int width = EM_ASM_INT({
        return Math.max(320, Math.round(globalThis.__renderW || ((globalThis.innerWidth || 1280) * (globalThis.devicePixelRatio || 1))));
    });
    const int height = EM_ASM_INT({
        return Math.max(240, Math.round(globalThis.__renderH || ((globalThis.innerHeight || 720) * (globalThis.devicePixelRatio || 1))));
    });
    // clang-format on
    Settings::video().mResolutionX.set(width);
    Settings::video().mResolutionY.set(height);
#else
    const int width = Settings::video().mResolutionX;
    const int height = Settings::video().mResolutionY;
#endif
    const Settings::WindowMode windowMode = Settings::video().mWindowMode;
    const bool windowBorder = Settings::video().mWindowBorder;
    const SDLUtil::VSyncMode vsync = Settings::video().mVsyncMode;
    unsigned antialiasing = static_cast<unsigned>(Settings::video().mAntialiasing);

    int posX = SDL_WINDOWPOS_CENTERED_DISPLAY(screen);
    int posY = SDL_WINDOWPOS_CENTERED_DISPLAY(screen);

    if (windowMode == Settings::WindowMode::Fullscreen || windowMode == Settings::WindowMode::WindowedFullscreen)
    {
        posX = SDL_WINDOWPOS_UNDEFINED_DISPLAY(screen);
        posY = SDL_WINDOWPOS_UNDEFINED_DISPLAY(screen);
    }

    Uint32 flags = SDL_WINDOW_OPENGL | SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI;
    if (windowMode == Settings::WindowMode::Fullscreen)
        flags |= SDL_WINDOW_FULLSCREEN;
    else if (windowMode == Settings::WindowMode::WindowedFullscreen)
        flags |= SDL_WINDOW_FULLSCREEN_DESKTOP;

    // Allows for Windows snapping features to properly work in borderless window
    SDL_SetHint("SDL_BORDERLESS_WINDOWED_STYLE", "1");
    SDL_SetHint("SDL_BORDERLESS_RESIZABLE_STYLE", "1");

    if (!windowBorder)
        flags |= SDL_WINDOW_BORDERLESS;

    SDL_SetHint(SDL_HINT_VIDEO_MINIMIZE_ON_FOCUS_LOSS, Settings::video().mMinimizeOnFocusLoss ? "1" : "0");

    checkSDLError(SDL_GL_SetAttribute(SDL_GL_RED_SIZE, 8));
    checkSDLError(SDL_GL_SetAttribute(SDL_GL_GREEN_SIZE, 8));
    checkSDLError(SDL_GL_SetAttribute(SDL_GL_BLUE_SIZE, 8));
    checkSDLError(SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 0));
    checkSDLError(SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24));
    if (Debug::shouldDebugOpenGL())
        checkSDLError(SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_DEBUG_FLAG));

    if (antialiasing > 0)
    {
        checkSDLError(SDL_GL_SetAttribute(SDL_GL_MULTISAMPLEBUFFERS, 1));
        checkSDLError(SDL_GL_SetAttribute(SDL_GL_MULTISAMPLESAMPLES, antialiasing));
    }

    // H1 sim-peer spike (Phase H): create the window HIDDEN and never render (frame()
    // skips renderingTraversals). A real GL context is still created so RenderingManager
    // constructs normally — the saving is per-frame, not at init. On a displayless Linux
    // box this becomes SDL_VIDEODRIVER=offscreen instead of a hidden window.
    if (std::getenv("OPENMW_HEADLESS") != nullptr)
        flags |= SDL_WINDOW_HIDDEN;

    osg::ref_ptr<SDLUtil::GraphicsWindowSDL2> graphicsWindow;
    while (!graphicsWindow || !graphicsWindow->valid())
    {
        while (!mWindow)
        {
            mWindow = SDL_CreateWindow("OpenMW", posX, posY, width, height, flags);
            if (!mWindow)
            {
                // Try with a lower AA
                if (antialiasing > 0)
                {
                    Log(Debug::Warning) << "Warning: " << antialiasing << "x antialiasing not supported, trying "
                                        << antialiasing / 2;
                    antialiasing /= 2;
                    Settings::video().mAntialiasing.set(antialiasing);
                    checkSDLError(SDL_GL_SetAttribute(SDL_GL_MULTISAMPLESAMPLES, antialiasing));
                    continue;
                }
                else
                {
                    std::stringstream error;
                    error << "Failed to create SDL window: " << SDL_GetError();
                    throw std::runtime_error(error.str());
                }
            }
        }

        // Since we use physical resolution internally, we have to create the window with scaled resolution,
        // but we can't get the scale before the window exists, so instead we have to resize aftewards.
        int w, h;
        SDL_GetWindowSize(mWindow, &w, &h);
        int dw, dh;
        SDL_GL_GetDrawableSize(mWindow, &dw, &dh);
        if (dw != w || dh != h)
        {
            // width / (dw/w) == width * w / dw. Computed in floating point and rounded: as integer
            // division, (dw/w) truncates a fractional device-pixel ratio (Windows 125%/150%, browser
            // zoom) to 1, so the window was never scaled down and the drawable stayed oversized —
            // and truncates to 0 when the drawable is smaller than the window, dividing by zero.
            const int sw = dw > 0 ? static_cast<int>(static_cast<double>(width) * w / dw + 0.5) : width;
            const int sh = dh > 0 ? static_cast<int>(static_cast<double>(height) * h / dh + 0.5) : height;
            SDL_SetWindowSize(mWindow, sw, sh);
        }

#ifndef __EMSCRIPTEN__
        // No OS window title bar in the browser (canvas only), and the PNG readerwriter isn't
        // built — skip the window icon load entirely (it would just log "no png readerwriter").
        setWindowIcon();
#endif

        osg::ref_ptr<osg::GraphicsContext::Traits> traits = new osg::GraphicsContext::Traits;
        SDL_GetWindowPosition(mWindow, &traits->x, &traits->y);
        SDL_GL_GetDrawableSize(mWindow, &traits->width, &traits->height);
        traits->windowName = SDL_GetWindowTitle(mWindow);
        traits->windowDecoration = !(SDL_GetWindowFlags(mWindow) & SDL_WINDOW_BORDERLESS);
        traits->screenNum = SDL_GetWindowDisplayIndex(mWindow);
        traits->vsync = 0;
        traits->inheritedWindowData = new SDLUtil::GraphicsWindowSDL2::WindowData(mWindow);

        graphicsWindow = new SDLUtil::GraphicsWindowSDL2(traits, vsync);
        if (!graphicsWindow->valid())
            throw std::runtime_error("Failed to create GraphicsContext");

        if (traits->samples < antialiasing)
        {
            Log(Debug::Warning) << "Warning: Framebuffer MSAA level is only " << traits->samples << "x instead of "
                                << antialiasing << "x. Trying " << antialiasing / 2 << "x instead.";
            graphicsWindow->closeImplementation();
            SDL_DestroyWindow(mWindow);
            mWindow = nullptr;
            antialiasing /= 2;
            Settings::video().mAntialiasing.set(antialiasing);
            checkSDLError(SDL_GL_SetAttribute(SDL_GL_MULTISAMPLESAMPLES, antialiasing));
            continue;
        }

        if (traits->red < 8)
            Log(Debug::Warning) << "Warning: Framebuffer only has a " << traits->red << " bit red channel.";
        if (traits->green < 8)
            Log(Debug::Warning) << "Warning: Framebuffer only has a " << traits->green << " bit green channel.";
        if (traits->blue < 8)
            Log(Debug::Warning) << "Warning: Framebuffer only has a " << traits->blue << " bit blue channel.";
        if (traits->depth < 24)
            Log(Debug::Warning) << "Warning: Framebuffer only has " << traits->depth << " bits of depth precision.";

        traits->alpha = 0; // set to 0 to stop ScreenCaptureHandler reading the alpha channel
    }

    osg::ref_ptr<osg::Camera> camera = mViewer->getCamera();
    camera->setGraphicsContext(graphicsWindow);
    camera->setViewport(0, 0, graphicsWindow->getTraits()->width, graphicsWindow->getTraits()->height);

    osg::ref_ptr<SceneUtil::OperationSequence> realizeOperations = new SceneUtil::OperationSequence(false);
    mViewer->setRealizeOperation(realizeOperations);
    osg::ref_ptr<IdentifyOpenGLOperation> identifyOp = new IdentifyOpenGLOperation();
    realizeOperations->add(identifyOp);
    realizeOperations->add(new SceneUtil::GetGLExtensionsOperation());

    if (Debug::shouldDebugOpenGL())
        realizeOperations->add(new Debug::EnableGLDebugOperation());

    realizeOperations->add(mSelectDepthFormatOperation);
    realizeOperations->add(mSelectColorFormatOperation);

    if (Stereo::getStereo())
    {
        Stereo::Settings settings;

        settings.mMultiview = Settings::stereo().mMultiview;
        settings.mAllowDisplayListsForMultiview = Settings::stereo().mAllowDisplayListsForMultiview;
        settings.mSharedShadowMaps = Settings::stereo().mSharedShadowMaps;

        if (Settings::stereo().mUseCustomView)
        {
            const osg::Vec3 leftEyeOffset(Settings::stereoView().mLeftEyeOffsetX,
                Settings::stereoView().mLeftEyeOffsetY, Settings::stereoView().mLeftEyeOffsetZ);

            const osg::Quat leftEyeOrientation(Settings::stereoView().mLeftEyeOrientationX,
                Settings::stereoView().mLeftEyeOrientationY, Settings::stereoView().mLeftEyeOrientationZ,
                Settings::stereoView().mLeftEyeOrientationW);

            const osg::Vec3 rightEyeOffset(Settings::stereoView().mRightEyeOffsetX,
                Settings::stereoView().mRightEyeOffsetY, Settings::stereoView().mRightEyeOffsetZ);

            const osg::Quat rightEyeOrientation(Settings::stereoView().mRightEyeOrientationX,
                Settings::stereoView().mRightEyeOrientationY, Settings::stereoView().mRightEyeOrientationZ,
                Settings::stereoView().mRightEyeOrientationW);

            settings.mCustomView = Stereo::CustomView{
                .mLeft = Stereo::View{
                    .pose = Stereo::Pose{
                        .position = leftEyeOffset,
                        .orientation = leftEyeOrientation,
                    },
                    .fov = Stereo::FieldOfView{
                        .angleLeft = Settings::stereoView().mLeftEyeFovLeft,
                        .angleRight = Settings::stereoView().mLeftEyeFovRight,
                        .angleUp = Settings::stereoView().mLeftEyeFovUp,
                        .angleDown = Settings::stereoView().mLeftEyeFovDown,
                    },
                },
                .mRight = Stereo::View{
                    .pose = Stereo::Pose{
                        .position = rightEyeOffset,
                        .orientation = rightEyeOrientation,
                    },
                    .fov = Stereo::FieldOfView{
                        .angleLeft = Settings::stereoView().mRightEyeFovLeft,
                        .angleRight = Settings::stereoView().mRightEyeFovRight,
                        .angleUp = Settings::stereoView().mRightEyeFovUp,
                        .angleDown = Settings::stereoView().mRightEyeFovDown,
                    },
                },
            };
        }

        if (Settings::stereo().mUseCustomEyeResolution)
            settings.mEyeResolution
                = osg::Vec2i(Settings::stereoView().mEyeResolutionX, Settings::stereoView().mEyeResolutionY);

        realizeOperations->add(new Stereo::InitializeStereoOperation(settings));
    }

    mViewer->realize();
    mGlMaxTextureImageUnits = identifyOp->getMaxTextureImageUnits();

    mViewer->getEventQueue()->getCurrentEventState()->setWindowRectangle(
        0, 0, graphicsWindow->getTraits()->width, graphicsWindow->getTraits()->height);
}

void OMW::Engine::setWindowIcon()
{
    std::ifstream windowIconStream;
    const auto windowIcon = mResDir / "openmw.png";
    windowIconStream.open(windowIcon, std::ios_base::in | std::ios_base::binary);
    if (windowIconStream.fail())
        Log(Debug::Error) << "Error: Failed to open " << windowIcon;
    osgDB::ReaderWriter* reader = osgDB::Registry::instance()->getReaderWriterForExtension("png");
    if (!reader)
    {
        Log(Debug::Error) << "Error: Failed to read window icon, no png readerwriter found";
        return;
    }
    osgDB::ReaderWriter::ReadResult result = reader->readImage(windowIconStream);
    if (!result.success())
        Log(Debug::Error) << "Error: Failed to read " << windowIcon << ": " << result.message() << " code "
                          << result.status();
    else
    {
        osg::ref_ptr<osg::Image> image = result.getImage();
        auto surface = SDLUtil::imageToSurface(image, true);
        SDL_SetWindowIcon(mWindow, surface.get());
    }
}

void OMW::Engine::prepareEngine()
{
    mStateManager = std::make_unique<MWState::StateManager>(mCfgMgr.getUserDataPath() / "saves", mContentFiles);
    mEnvironment.setStateManager(*mStateManager);

    const bool stereoEnabled = Settings::stereo().mStereoEnabled || osg::DisplaySettings::instance().get()->getStereo();
    mStereoManager = std::make_unique<Stereo::Manager>(
        mViewer, stereoEnabled, Settings::camera().mNearClip, Settings::camera().mViewingDistance);

    osg::ref_ptr<osg::Group> rootNode(new osg::Group);
    mViewer->setSceneData(rootNode);

    createWindow();

    mVFS = std::make_unique<VFS::Manager>();

    VFS::registerArchives(mVFS.get(), mFileCollections, mArchives, true, &mEncoder.get()->getStatelessEncoder());

    mResourceSystem = std::make_unique<Resource::ResourceSystem>(
        mVFS.get(), Settings::cells().mCacheExpiryDelay, &mEncoder.get()->getStatelessEncoder());
    mResourceSystem->getSceneManager()->getShaderManager().setMaxTextureUnits(mGlMaxTextureImageUnits);
    mResourceSystem->getSceneManager()->setUnRefImageDataAfterApply(
        false); // keep to Off for now to allow better state sharing
    mResourceSystem->getSceneManager()->setFilterSettings(Settings::general().mTextureMagFilter,
        Settings::general().mTextureMinFilter, Settings::general().mTextureMipmap,
        static_cast<float>(Settings::general().mAnisotropy));
    mEnvironment.setResourceSystem(*mResourceSystem);

    mWorkQueue = new SceneUtil::WorkQueue(Settings::cells().mPreloadNumThreads);
    mUnrefQueue = std::make_unique<SceneUtil::UnrefQueue>();

    mScreenCaptureOperation = new SceneUtil::AsyncScreenCaptureOperation(mWorkQueue,
        new SceneUtil::WriteScreenshotToFileOperation(mCfgMgr.getScreenshotPath(),
            Settings::general().mScreenshotFormat,
            Settings::general().mNotifyOnSavedScreenshot ? std::function<void(std::string)>(ScreenCaptureMessageBox{})
                                                         : std::function<void(std::string)>(IgnoreString{})));

    mScreenCaptureHandler = new osgViewer::ScreenCaptureHandler(mScreenCaptureOperation);

    mViewer->addEventHandler(mScreenCaptureHandler);

    mL10nManager = std::make_unique<L10n::Manager>(mVFS.get());
    mL10nManager->setPreferredLocales(Settings::general().mPreferredLocales, Settings::general().mGmstOverridesL10n);
    mEnvironment.setL10nManager(*mL10nManager);

    mLuaManager = std::make_unique<MWLua::LuaManager>(mVFS.get(), mResDir / "lua_libs");
    mEnvironment.setLuaManager(*mLuaManager);

    // Create input and UI first to set up a bootstrapping environment for
    // showing a loading screen and keeping the window responsive while doing so

    const auto keybinderUser = mCfgMgr.getUserConfigPath() / "input_v3.xml";
    bool keybinderUserExists = std::filesystem::exists(keybinderUser);
    if (!keybinderUserExists)
    {
        const auto input2 = (mCfgMgr.getUserConfigPath() / "input_v2.xml");
        if (std::filesystem::exists(input2))
        {
            keybinderUserExists = std::filesystem::copy_file(input2, keybinderUser);
            Log(Debug::Info) << "Loading keybindings file: " << keybinderUser;
        }
    }
    else
        Log(Debug::Info) << "Loading keybindings file: " << keybinderUser;

    const auto userdefault = mCfgMgr.getUserConfigPath() / "gamecontrollerdb.txt";
    const auto localdefault = mCfgMgr.getLocalPath() / "gamecontrollerdb.txt";

    std::filesystem::path userGameControllerdb;
    if (std::filesystem::exists(userdefault))
        userGameControllerdb = userdefault;

    std::filesystem::path gameControllerdb;
    if (std::filesystem::exists(localdefault))
        gameControllerdb = localdefault;
    else if (!mCfgMgr.getGlobalPath().empty())
    {
        const auto globaldefault = mCfgMgr.getGlobalPath() / "gamecontrollerdb.txt";
        if (std::filesystem::exists(globaldefault))
            gameControllerdb = globaldefault;
    }
    // else if it doesn't exist, pass in an empty path

    // gui needs our shaders path before everything else
    mResourceSystem->getSceneManager()->setShaderPath(mResDir / "shaders");

    osg::GLExtensions& exts = SceneUtil::getGLExtensions();

#if OSG_VERSION_LESS_THAN(3, 6, 6)
    // hack fix for https://github.com/openscenegraph/OpenSceneGraph/issues/1028
    if (!osg::isGLExtensionSupported(exts.contextID, "NV_framebuffer_multisample_coverage"))
        exts.glRenderbufferStorageMultisampleCoverageNV = nullptr;
#endif

    osg::ref_ptr<osg::Group> guiRoot = new osg::Group;
    guiRoot->setName("GUI Root");
    guiRoot->setNodeMask(MWRender::Mask_GUI);
    mStereoManager->disableStereoForNode(guiRoot);
    rootNode->addChild(guiRoot);

    mWindowManager = std::make_unique<MWGui::WindowManager>(mWindow, mViewer, guiRoot, mResourceSystem.get(),
        mWorkQueue.get(), mCfgMgr.getLogPath(), mScriptConsoleMode, mTranslationDataStorage, mEncoding, mExportFonts,
        Version::getOpenmwVersionDescription(), mCfgMgr);
    mEnvironment.setWindowManager(*mWindowManager);

    mInputManager = std::make_unique<MWInput::InputManager>(mWindow, mViewer, mScreenCaptureHandler, keybinderUser,
        keybinderUserExists, userGameControllerdb, gameControllerdb, mGrab);
    mEnvironment.setInputManager(*mInputManager);

    // Create sound system
    mSoundManager = std::make_unique<MWSound::SoundManager>(mVFS.get(), mUseSound);
    mEnvironment.setSoundManager(*mSoundManager);

    // Create the world
    mWorld = std::make_unique<MWWorld::World>(
        mResourceSystem.get(), mActivationDistanceOverride, mCellName, mCfgMgr.getUserDataPath());
    mEnvironment.setWorld(*mWorld);
    mEnvironment.setWorldModel(mWorld->getWorldModel());
    mEnvironment.setESMStore(mWorld->getStore());

    const MWWorld::Store<ESM::GameSetting>* gmst = &mWorld->getStore().get<ESM::GameSetting>();
    mL10nManager->setGmstLoader([gmst, misses = std::set<std::string, Misc::StringUtils::CiComp>()](
                                    std::string_view gmstName) mutable -> const std::string* {
        const ESM::GameSetting* res = gmst->search(gmstName);
        if (res && res->mValue.getType() == ESM::VT_String)
            return &res->mValue.getString();
        if (misses.emplace(gmstName).second)
            Log(Debug::Error) << "GMST " << gmstName << " not found";
        return nullptr;
    });

    mWindowManager->setStore(mWorld->getStore());

    // Load translation data
    mTranslationDataStorage.setEncoder(mEncoder.get());
    for (auto& mContentFile : mContentFiles)
        mTranslationDataStorage.loadTranslationData(mFileCollections, mContentFile);

    Compiler::registerExtensions(mExtensions);

    // Create script system
    mScriptContext = std::make_unique<MWScript::CompilerContext>(MWScript::CompilerContext::Type_Full);
    mScriptContext->setExtensions(&mExtensions);

    mScriptManager = std::make_unique<MWScript::ScriptManager>(mWorld->getStore(), *mScriptContext, mWarningsMode);
    mEnvironment.setScriptManager(*mScriptManager);

    // Create game mechanics system
    mMechanicsManager = std::make_unique<MWMechanics::MechanicsManager>();
    mEnvironment.setMechanicsManager(*mMechanicsManager);

    // Create dialog system
    mJournal = std::make_unique<MWDialogue::Journal>();
    mEnvironment.setJournal(*mJournal);

    mDialogueManager = std::make_unique<MWDialogue::DialogueManager>(mExtensions, mTranslationDataStorage);
    mEnvironment.setDialogueManager(*mDialogueManager);

    mLuaManager->loadPermanentStorage(mCfgMgr.getUserConfigPath());
    mLuaManager->initPreLoad();

    Loading::Listener* listener = MWBase::Environment::get().getWindowManager()->getLoadingScreen();
    Loading::AsyncListener asyncListener(*listener);

    if (!mSkipMenu)
    {
        std::string_view logo = Fallback::Map::getString("Movies_Company_Logo");
        if (!logo.empty())
            mWindowManager->playVideo(logo, true);
    }

    listener->loadingOn();
#ifdef __EMSCRIPTEN__
    // No background-thread data loading on the web: spinning the main thread on a
    // std::async future deadlocks/stalls against worker->main GL proxying. Load
    // synchronously on the main thread instead (blocks during load, then proceeds).
    mWorld->loadData(mFileCollections, mContentFiles, mGroundcoverFiles, mEncoder.get(), &asyncListener);
#else
    auto dataLoading = std::async(std::launch::async,
        [&] { mWorld->loadData(mFileCollections, mContentFiles, mGroundcoverFiles, mEncoder.get(), &asyncListener); });
    {
        using namespace std::chrono_literals;
        while (dataLoading.wait_for(50ms) != std::future_status::ready)
            asyncListener.update();
        dataLoading.get();
    }
#endif
    listener->loadingOff();

    mWorld->init(mMaxRecastLogLevel, mViewer, std::move(rootNode), mWorkQueue.get(), *mUnrefQueue);
    mEnvironment.setWorldScene(mWorld->getWorldScene());
    mWorld->setupPlayer();
    mWorld->setRandomSeed(mRandomSeed);
    mWindowManager->initUI();
    mLuaManager->initPostLoad();

    // scripts
#ifdef __EMSCRIPTEN__
    // F27, first slice. MWScript is lexed and parsed at RUNTIME, lazily, the first time each
    // script executes (scriptmanagerimp.cpp:39 pulls mScriptText out of the store, wraps it in an
    // istringstream and runs the full Compiler::Scanner). GOTY ships ~2000 of them, so the normal
    // experience is: play, trip a script, pay for a lexer -- unpredictably, on the main thread,
    // during play.
    //
    // The real fix is to bake bytecode offline and drop components/compiler (5,005 lines) out of
    // the wasm entirely. That needs a serialisation format for mParser.getProgram() plus the
    // locals table, and a loader; it is the rest of F27.
    //
    // This is the part that is one line: compile them all up front instead. It does not remove the
    // work, it MOVES it -- out of unpredictable mid-play stalls and into the loading screen, where
    // a stall is free and the player is already waiting. That is the same trade every other Phase 2
    // bake makes, just paid at boot rather than at build time, and it is a strict improvement on
    // paying it at a random moment while walking through Balmora.
    //
    // MEASURED, and left OFF because of what the number said. Booting with retail data and
    // window.__omwBoot (F24), comparing post-runtime boot work (firstFrame - runtimeInit, because
    // the wasm compile itself varies by seconds between runs depending on the HTTP cache):
    //
    //     lazy          4505 - 362  = 4143ms      "compiled 1206 of 1207 scripts"
    //     compile-all   7733 - 2078 = 5655ms      => ~1.5s added to boot
    //
    // 1.5s is too much to spend on a loading screen for a game whose whole delivery pitch is a
    // URL -- F24 exists because time-to-playable is the number this product is judged on. So this
    // does not move the work to a better place, it moves it to the worst place.
    //
    // What the measurement actually establishes is that the REST of F27 is worth doing: 1.5s of
    // lexing and parsing, for a result that is identical on every machine and every run, is
    // exactly the thing an offline bake deletes rather than relocates. Serialise
    // mParser.getProgram() plus the locals table, ship it, drop components/compiler (5,005 lines)
    // out of the wasm, and the 1.5s goes to zero instead of moving.
    //
    // OPENMW_COMPILE_ALL=1 opts in, for anyone who would rather take the boot cost than the
    // mid-play stalls until that lands.
    if (std::getenv("OPENMW_COMPILE_ALL") != nullptr)
        mCompileAll = true;
#endif
    if (mCompileAll)
    {
        std::pair<int, int> result = mScriptManager->compileAll();
        if (result.first)
            Log(Debug::Info) << "compiled " << result.second << " of " << result.first << " scripts ("
                             << 100 * static_cast<double>(result.second) / result.first << "%)";
    }
    if (mCompileAllDialogue)
    {
        std::pair<int, int> result = MWDialogue::ScriptTest::compileAll(&mExtensions, mWarningsMode);
        if (result.first)
            Log(Debug::Info) << "compiled " << result.second << " of " << result.first << " dialogue scripts ("
                             << 100 * static_cast<double>(result.second) / result.first << "%)";
    }

    // starts a separate lua thread if "lua num threads" > 0
    mLuaWorker = std::make_unique<MWLua::Worker>(*mLuaManager);
}

#ifdef __EMSCRIPTEN__
// A hidden/backgrounded browser tab throttles setTimeout (and freezes requestAnimationFrame),
// which stalls the emscripten main loop. Expose a pump so JS can drive frames from a
// MessageChannel (which is NOT throttled in hidden tabs), keeping the game running/interactive.
namespace
{
    void (*g_emTick)(void*) = nullptr;
    void* g_emArg = nullptr;
}
extern "C" EMSCRIPTEN_KEEPALIVE void omw_pump_frame()
{
    // Re-entrancy guard: a long frame can spin the browser event loop (e.g. via a proxied
    // main-thread call), which dispatches a queued MessageChannel message and would call this
    // again mid-frame — recursively re-locking OpenMW's non-recursive mutexes → pthread deadlock.
    static bool inTick = false;
    if (inTick)
        return;
    if (g_emTick && g_emArg)
    {
        // Exception-safe: if a frame throws (C++ or a foreign/JS exception unwinding out of a
        // JS library call), the guard MUST reset — the JS pump swallows the exception and keeps
        // calling, so a stuck inTick=true turns every later pump into an instant no-op: the
        // header keeps counting "60fps" of 0ms skips while the game is permanently frozen.
        // Catch here (the engine's cooperative video branch runs outside Engine::frame's own
        // try/catch), log the cause, and let the next frame carry on.
        inTick = true;
        try
        {
            g_emTick(g_emArg);
        }
        catch (const std::exception& e)
        {
            printf("omw_pump_frame: frame threw: %s\n", e.what());
        }
        catch (...)
        {
            printf("omw_pump_frame: frame threw a non-C++ (likely JS) exception\n");
        }
        inTick = false;
    }
}

// Flush user settings to the persistent config (called from index.html's pagehide/hidden
// lifecycle handlers). Without this, changing settings and refreshing the page loses them:
// the Options window only saves on CLOSE, and even then the async IDBFS sync needs a beat.
extern "C" EMSCRIPTEN_KEEPALIVE void omw_save_settings()
{
    try
    {
        Settings::Manager::saveUser("/userdata/config/openmw/settings.cfg");
    }
    catch (const std::exception& e)
    {
        printf("omw_save_settings: %s\n", e.what());
    }
}

// Change the render resolution at runtime (Options -> Video Apply, and the harness's debounced
// browser-window-resize handler). Goes through SDL so the canvas drawing buffer resizes and
// SDL_WINDOWEVENT_SIZE_CHANGED fires -> OpenMW::windowResized() resizes viewport/FBOs/GUI —
// exactly the desktop window-resize path.
extern "C" EMSCRIPTEN_KEEPALIVE void omw_set_resolution(int w, int h)
{
    if (w < 320 || h < 240 || w > 16384 || h > 16384)
        return;
    SDL_Window* window = SDL_GL_GetCurrentWindow();
    if (window)
        SDL_SetWindowSize(window, w, h);
    // Keep the [Video] resolution setting in sync with the actual drawing-buffer size so the
    // Options resolution list highlights the real current size. On emscripten the normal
    // SDL_WINDOWEVENT_SIZE_CHANGED -> WindowManager::windowResized() -> mResolutionX/Y.set() path
    // is unreliable (SDL_SetWindowSize doesn't always dispatch it), which left the setting stale
    // after a browser-window resize -> list/highlight mismatch. Setting it directly is idempotent
    // with windowResized() when that does fire.
    Settings::video().mResolutionX.set(w);
    Settings::video().mResolutionY.set(h);
}

// Scene render-scale bridge (QA/harness; the Options resolution tiers set the same setting from
// C++). Renders the 3D scene at `s` × the canvas resolution via the post-processor chain; the
// canvas and GUI stay native. Dispatches the change immediately (mirrors SettingsWindow::apply()).
extern "C" EMSCRIPTEN_KEEPALIVE void omw_set_render_scale(float s)
{
    if (!(s >= 0.2f && s <= 1.f))
        return;
    Settings::video().mInternalRenderScale.set(s);
    // Only valid once the game is running (like omw_debug_look); boot-time seeding goes through
    // the ?rs= settings layer instead.
    MWBase::Environment::get().getWorld()->processChangedSettings(Settings::Manager::getPendingChanges());
    Settings::Manager::resetPendingChanges();
}

// OS-clipboard -> SDL bridge: the harness's document 'paste' listener pushes the real browser
// clipboard text here so the in-game Ctrl+V (which reads SDL's internal clipboard) sees it.
extern "C" EMSCRIPTEN_KEEPALIVE void omw_set_clipboard(const char* text)
{
    if (text)
        SDL_SetClipboardText(text);
}

// Debug: point the camera (yaw/pitch in degrees) so we can verify object rendering without mouse-look.
extern "C" EMSCRIPTEN_KEEPALIVE void omw_debug_look(float yawDeg, float pitchDeg)
{
    auto world = MWBase::Environment::get().getWorld();
    MWRender::Camera* cam = world->getCamera();
    if (cam)
    {
        cam->setYaw(osg::DegreesToRadians(yawDeg), true);
        cam->setPitch(osg::DegreesToRadians(pitchDeg), true);
    }
}

// Debug: teleport the player to an absolute world position (within the loaded worldspace).
extern "C" EMSCRIPTEN_KEEPALIVE void omw_debug_teleport(float x, float y, float z)
{
    auto world = MWBase::Environment::get().getWorld();
    MWWorld::Ptr p = world->getPlayerPtr();
    if (!p.isEmpty())
        world->moveObject(p, osg::Vec3f(x, y, z), true, true);
}

// Debug: start dialogue with the nearest NPC (same as pointing at it and pressing Activate).
// Returns the number of NPCs found in range (0 = none nearby).
extern "C" EMSCRIPTEN_KEEPALIVE int omw_debug_activate()
{
    auto world = MWBase::Environment::get().getWorld();
    MWWorld::Ptr player = world->getPlayerPtr();
    if (player.isEmpty())
        return -1;
    const float* pp = player.getRefData().getPosition().pos;
    osg::Vec3f pos(pp[0], pp[1], pp[2]);
    std::vector<MWWorld::Ptr> actors;
    MWBase::Environment::get().getMechanicsManager()->getActorsInRange(pos, 8000.f, actors);
    MWWorld::Ptr target;
    float best = std::numeric_limits<float>::max();
    int npcCount = 0;
    for (MWWorld::Ptr& a : actors)
    {
        if (a == player || !a.getClass().isNpc())
            continue;
        npcCount++;
        const float* ap = a.getRefData().getPosition().pos;
        float d = (osg::Vec3f(ap[0], ap[1], ap[2]) - pos).length2();
        if (d < best)
        {
            best = d;
            target = a;
        }
    }
    if (!target.isEmpty())
        MWBase::Environment::get().getWindowManager()->pushGuiMode(MWGui::GM_Dialogue, target);
    return npcCount;
}

// Debug: set the in-game hour (0-24) — e.g. 12 = noon. For verifying time-of-day rendering.
extern "C" EMSCRIPTEN_KEEPALIVE void omw_debug_sethour(float hour)
{
    // Same path the vanilla console/scripts use: set the GameHour global.
    MWBase::Environment::get().getWorld()->setGlobalFloat(MWWorld::Globals::sGameHour, hour);
}

// Debug: teleport the player to an exterior cell (like the console "COE x y"). Triggers a full
// exterior worldspace load — used to repro/validate the navmesh cell-load path from JS.
extern "C" EMSCRIPTEN_KEEPALIVE void omw_debug_coe(int x, int y)
{
    MWBase::World* world = MWBase::Environment::get().getWorld();
    MWWorld::Ptr player = world->getPlayerPtr();
    if (player.isEmpty())
        return;
    ESM::Position pos;
    const osg::Vec2f posFromIndex
        = ESM::indexToPosition(ESM::ExteriorCellLocation(x, y, ESM::Cell::sDefaultWorldspaceId), true);
    pos.pos[0] = posFromIndex.x();
    pos.pos[1] = posFromIndex.y();
    pos.pos[2] = 0;
    pos.rot[0] = pos.rot[1] = pos.rot[2] = 0;
    MWWorld::ActionTeleport(ESM::RefId::esm3ExteriorCell(x, y), pos, false).execute(player);
    player = world->getPlayerPtr();
    world->adjustPosition(player, false);
}

// Debug: give the player a fresh weapon, equip it, and draw it. Reproduces/validates the
// gear-equip path — a cache-miss weapon mesh loaded on the main thread — that used to freeze
// the browser (WorkQueue worker/main contention). Returns 1 on success, 0/-1 on failure.
extern "C" EMSCRIPTEN_KEEPALIVE int omw_debug_giveweapon()
{
    MWBase::World* world = MWBase::Environment::get().getWorld();
    MWWorld::Ptr player = world->getPlayerPtr();
    if (player.isEmpty())
        return -1;
    MWWorld::InventoryStore& store = player.getClass().getInventoryStore(player);
    // Qualify: InventoryStore::add(ConstPtr,…) name-hides the RefId convenience overload.
    MWWorld::ContainerStoreIterator it
        = store.MWWorld::ContainerStore::add(ESM::RefId::stringRefId("iron dagger"), 1, false);
    if (it == store.end())
        return 0;
    store.equip(MWWorld::InventoryStore::Slot_CarriedRight, it);
    world->getPlayer().setDrawState(MWMechanics::DrawState::Weapon);
    return 1;
}
#endif

// Initialise and enter main loop.
void OMW::Engine::go()
{
    assert(!mContentFiles.empty());

    Log(Debug::Info) << "OSG version: " << osgGetVersion();
    SDL_version sdlVersion;
    SDL_GetVersion(&sdlVersion);
    Log(Debug::Info) << "SDL version: " << (int)sdlVersion.major << "." << (int)sdlVersion.minor << "."
                     << (int)sdlVersion.patch;

    Misc::Rng::init(mRandomSeed);

    Settings::ShaderManager::get().load(mCfgMgr.getUserConfigPath() / "shaders.yaml");

    MWClass::registerClasses();

    // Create encoder
    mEncoder = std::make_unique<ToUTF8::Utf8Encoder>(mEncoding);

    // Setup viewer
    mViewer = new osgViewer::Viewer;
    mViewer->setReleaseContextAtEndOfFrameHint(false);
#ifdef __EMSCRIPTEN__
    // OSG defaults to DrawThreadPerContext, running draw + GL-object compilation on a
    // separate thread from the GL context. Under emscripten that proxies GL calls to a
    // null GL thread and aborts. Force everything onto the single GL thread.
    mViewer->setThreadingModel(osgViewer::ViewerBase::SingleThreaded);

    // F48 -- MEASURED AND CLOSED 2026-08-28. Nothing to do here; the call that used to sit on
    // this line was a no-op, and the interesting result is why.
    //
    // The finding said OSG force-enables VAO *support* but never sets the per-drawable flag, so
    // State.cpp's test
    //     _forceVertexArrayObject || (_isVertexArrayObjectSupported && drawable->_useVertexArrayObject)
    // was false for every draw. The proposed fix was DisplaySettings::VERTEX_ARRAY_OBJECT, which
    // sets _forceVertexBufferObject and _forceVertexArrayObject. But osg-emscripten.patch ALREADY
    // sets both, unconditionally, in State::State() under `#elif defined(__EMSCRIPTEN__)`. The
    // hint was assigning flags that were already true.
    //
    // A/B in Balmora (Chrome, RTX 4080, ~726 draws/frame), behind ?forcevao=1 so both arms ran the
    // same binary: every counter came back identical to one decimal place -- total 4385.3,
    // bindVertexArray 501.4, vertexAttribPointer 237.4, enableVertexAttribArray 236.5. Not close;
    // the same. That is the signature of a flag that was already set.
    //
    // A follow-up measurement corrected a wrong reading of those numbers, recorded here because it
    // was nearly written up as a new finding. The 501 binds/frame against only 237
    // vertexAttribPointer looked like "VAOs bound but re-specified anyway = pure overhead". It is
    // the opposite. osg::Drawable::draw sets `vas->setRequiresSetArrays(getDataVariance()==DYNAMIC)`
    // after each draw, and Geometry::drawImplementation early-returns on !getRequiresSetArrays() --
    // so a STATIC drawable specifies its attributes once and every later frame is bind-and-draw.
    // A cold drawable issues 3-5 attrib pointers; measured steady state is 0.64 per bind, i.e.
    // roughly 80-85% of bound drawables are skipping re-specification. The binds are what BUY that
    // skip. VAO reuse is working as designed.
    //
    // Remaining headroom here is small and bounded: attribute calls are 501 of 4385 GL calls per
    // frame (~11%), and only the share belonging to genuinely-static geometry is recoverable. Worth
    // a look only after the uniform traffic (43%) is dealt with.
    // The `null function` this path used to trap on was real: OSG was configured
    // OPENGL_PROFILE=GLES2 against a WebGL2/ES3 target, so isVAOSupported could never resolve
    // honestly. build-osg.sh now says GLES2+GLES3 (F50) and OSG_GLES3_FEATURES is 1.
#endif

    // Do not try to outsmart the OS thread scheduler (see bug #4785).
    mViewer->setUseConfigureAffinity(false);

    mEnvironment.setFrameRateLimit(Settings::video().mFramerateLimit);

    prepareEngine();

#ifdef _WIN32
    const auto* statsFile = _wgetenv(L"OPENMW_OSG_STATS_FILE");
#else
    const auto* statsFile = std::getenv("OPENMW_OSG_STATS_FILE");
#endif

    std::filesystem::path path;
    if (statsFile != nullptr)
        path = statsFile;

    std::ofstream stats;
    if (!path.empty())
    {
        stats.open(path, std::ios_base::out);
        if (stats.is_open())
            Log(Debug::Info) << "OSG stats will be written to: " << path;
        else
            Log(Debug::Warning) << "Failed to open file to write OSG stats \"" << path
                                << "\": " << std::generic_category().message(errno);
    }

    // Setup profiler
    osg::ref_ptr<Resource::Profiler> statsHandler = new Resource::Profiler(stats.is_open(), *mVFS);

    initStatsHandler(*statsHandler);

    mViewer->addEventHandler(statsHandler);

    osg::ref_ptr<Resource::StatsHandler> resourcesHandler = new Resource::StatsHandler(stats.is_open(), *mVFS);
    mViewer->addEventHandler(resourcesHandler);

    if (stats.is_open())
        Resource::collectStatistics(*mViewer);

    // Start the game
    if (!mSaveGameFile.empty())
    {
        mStateManager->loadGame(mSaveGameFile);
    }
    else if (!mSkipMenu)
    {
        // start in main menu
        mWindowManager->pushGuiMode(MWGui::GM_MainMenu);

        if (mVFS->exists(MWSound::titleMusic))
            mSoundManager->streamMusic(MWSound::titleMusic, MWSound::MusicType::Normal);
        else
            Log(Debug::Warning) << "Title music not found";

        std::string_view logo = Fallback::Map::getString("Movies_Morrowind_Logo");
        if (!logo.empty())
            mWindowManager->playVideo(logo, /*allowSkipping*/ true, /*overrideSounds*/ false);
    }
    else
    {
        mStateManager->newGame(!mNewGame);
#ifdef __EMSCRIPTEN__
        // The example-suite starts at midnight, so the freshly-loaded world is pitch black.
        // Jump to mid-morning so the world is immediately lit and visible on boot. (chargen is
        // auto-confirmed in charactercreation.cpp; together this drops the player straight into
        // a visible, playable daytime world without any throttle-dependent GUI interaction.)
        // Gated to the example suite only (OPENMW_EXAMPLE_SUITE set by the harness for ?nomw):
        // retail Morrowind must keep its authored start time — 1:1 behavior.
        if (getenv("OPENMW_EXAMPLE_SUITE") != nullptr
            && mStateManager->getState() == MWState::StateManager::State_Running)
        {
            mWorld->advanceTime(10.0);
        }
#endif
    }

    if (!mStartupScript.empty() && mStateManager->getState() == MWState::StateManager::State_Running)
    {
        mWindowManager->executeInConsole(mStartupScript);
    }

    // Start the main rendering loop
    MWWorld::DateTimeManager& timeManager = *mWorld->getTimeManager();
    Misc::FrameRateLimiter frameRateLimiter = Misc::makeFrameRateLimiter(mEnvironment.getFrameRateLimit());
    const std::chrono::steady_clock::duration maxSimulationInterval(std::chrono::milliseconds(200));

#ifdef __EMSCRIPTEN__
    // A browser owns the event loop and we must never block the main thread, or no
    // rendered frame is ever presented to the compositor. Drive one simulation frame
    // per requestAnimationFrame tick via emscripten_set_main_loop and yield back.
    struct EmscriptenLoop
    {
        OMW::Engine* engine;
        MWWorld::DateTimeManager* timeManager;
        Misc::FrameRateLimiter* frameRateLimiter;
        std::chrono::steady_clock::duration maxSimulationInterval;

        static void tick(void* arg)
        {
            auto& ctx = *static_cast<EmscriptenLoop*>(arg);
            OMW::Engine* self = ctx.engine;
            MWWorld::DateTimeManager& timeManager = *ctx.timeManager;
            if (self->mViewer->done() || self->mStateManager->hasQuitRequest())
            {
                // Browser-correct quit: a silently-cancelled loop leaves a frozen tab. Sync the
                // IDBFS state and hand the page a clear end-of-session overlay (__omwOnQuit).
                // clang-format off
                EM_ASM({
                    try { if (globalThis.__omwSyncfs) globalThis.__omwSyncfs(); else if (typeof FS !== 'undefined' && FS.syncfs) FS.syncfs(false, function(){}); } catch(e){}
                    try { Module.__omwRunning = 0; } catch(e){}
                    try { if (globalThis.__omwOnQuit) globalThis.__omwOnQuit(); } catch(e){}
                });
                // clang-format on
                g_emTick = nullptr; // stop future pump ticks
                emscripten_cancel_main_loop();
                return;
            }
            // Expose "a game is in progress" to the harness: drives the unsaved-progress
            // tab-close guard (registered only while running, to stay bfcache-friendly).
            {
                static int lastRunning = -1;
                const int running = self->mStateManager->getState() == MWBase::StateManager::State_Running ? 1 : 0;
                if (running != lastRunning)
                {
                    lastRunning = running;
                    EM_ASM({ Module.__omwRunning = $0; }, running);
                }
            }
            const double dt = std::chrono::duration_cast<std::chrono::duration<double>>(
                                  std::min(ctx.frameRateLimiter->getLastFrameDuration(), ctx.maxSimulationInterval))
                                  .count()
                * timeManager.getSimulationTimeScale();
            self->mViewer->advance(timeManager.getRenderingSimulationTime());
            const unsigned frameNumber = self->mViewer->getFrameStamp()->getFrameNumber();
            if (!self->frame(frameNumber, static_cast<float>(dt)))
                return;
            timeManager.updateIsPaused();
            if (!timeManager.isPaused())
            {
                timeManager.setSimulationTime(timeManager.getSimulationTime() + dt);
                timeManager.setRenderingSimulationTime(timeManager.getRenderingSimulationTime() + dt);
            }
            ctx.frameRateLimiter->limit();

        }
    };
    // Heap-allocated: emscripten_set_main_loop with simulate_infinite_loop unwinds this
    // stack frame, so the context must outlive go().
    auto* loop = new EmscriptenLoop{ this, &timeManager,
        new Misc::FrameRateLimiter(Misc::makeFrameRateLimiter(mEnvironment.getFrameRateLimit())),
        maxSimulationInterval };
    g_emTick = &EmscriptenLoop::tick;
    g_emArg = loop;
    // SINGLE frame driver: the MessageChannel pump in index.html calls omw_pump_frame()
    // (-> this tick). The pump paces itself with requestAnimationFrame while the tab is
    // visible (vsync-aligned) and free-runs unthrottled when hidden. We deliberately do NOT
    // also register emscripten_set_main_loop — the dual-driver setup ticked the engine twice
    // per vsync (rAF loop + pump), wasting CPU and jittering pacing. go() simply returns;
    // main() exits; the runtime stays alive (EXIT_RUNTIME=0) and the engine object is leaked
    // in main() so the pump can keep ticking it.
    return;
#else
    // E3 (MP): FIXED simulation timestep, HEADLESS ONLY. The wall-clock dt makes physics
    // adaptively non-deterministic under load by design (calculateStepConfig abandons the
    // fixed step on overrun), so AI and movement resolution silently degrade when the host
    // is busy — the "some NPCs behave differently under load" class of bug, which on an
    // authoritative peer becomes everyone's bug at once. The peer is paced by its own
    // framerate limit (settings.cfg, 20 fps), so a fixed dt of 1/limit keeps game time
    // honest while making each tick simulate the same amount.
    //
    // MUST stay headless-only: a fixed dt in single-player makes game time run slow on a
    // struggling machine — the 200 ms hitch clamp exists precisely to prevent that. This
    // buys CONSISTENCY, not replay determinism (Misc::Rng stays process-global).
    static const bool headlessFixedDt = std::getenv("OPENMW_HEADLESS") != nullptr;
    const double fixedDt = 1.0 / std::max(1.0f, Settings::video().mFramerateLimit.get());
    while (!mViewer->done() && !mStateManager->hasQuitRequest())
    {
        const double dt = (headlessFixedDt
                              ? fixedDt
                              : std::chrono::duration_cast<std::chrono::duration<double>>(
                                    std::min(frameRateLimiter.getLastFrameDuration(), maxSimulationInterval))
                                    .count())
            * timeManager.getSimulationTimeScale();

        mViewer->advance(timeManager.getRenderingSimulationTime());

        const unsigned frameNumber = mViewer->getFrameStamp()->getFrameNumber();

        if (!frame(frameNumber, static_cast<float>(dt)))
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
            continue;
        }
        timeManager.updateIsPaused();
        if (!timeManager.isPaused())
        {
            timeManager.setSimulationTime(timeManager.getSimulationTime() + dt);
            timeManager.setRenderingSimulationTime(timeManager.getRenderingSimulationTime() + dt);
        }

        if (stats)
        {
            // The delay is required because rendering happens in parallel to the main thread and stats from there is
            // available with delay.
            constexpr unsigned statsReportDelay = 3;
            if (frameNumber >= statsReportDelay)
            {
                // Viewer frame number can be different from frameNumber because of loading screens which render new
                // frames inside a simulation frame.
                const unsigned currentFrameNumber = mViewer->getFrameStamp()->getFrameNumber();
                for (unsigned i = frameNumber; i <= currentFrameNumber; ++i)
                    reportStats(i - statsReportDelay, *mViewer, stats);
            }
        }

        frameRateLimiter.limit();
    }

    mLuaWorker->join();
#endif

    // Save user settings
    Settings::Manager::saveUser(mCfgMgr.getUserConfigPath() / "settings.cfg");
    Settings::ShaderManager::get().save();
    mLuaManager->savePermanentStorage(mCfgMgr.getUserConfigPath());
}

void OMW::Engine::setCompileAll(bool all)
{
    mCompileAll = all;
}

void OMW::Engine::setCompileAllDialogue(bool all)
{
    mCompileAllDialogue = all;
}

void OMW::Engine::setSoundUsage(bool soundUsage)
{
    mUseSound = soundUsage;
}

void OMW::Engine::setEncoding(const ToUTF8::FromType& encoding)
{
    mEncoding = encoding;
}

void OMW::Engine::setScriptConsoleMode(bool enabled)
{
    mScriptConsoleMode = enabled;
}

void OMW::Engine::setStartupScript(const std::filesystem::path& path)
{
    mStartupScript = path;
}

void OMW::Engine::setActivationDistanceOverride(int distance)
{
    mActivationDistanceOverride = distance;
}

void OMW::Engine::setWarningsMode(int mode)
{
    mWarningsMode = mode;
}

void OMW::Engine::enableFontExport(bool exportFonts)
{
    mExportFonts = exportFonts;
}

void OMW::Engine::setSaveGameFile(const std::filesystem::path& savegame)
{
    mSaveGameFile = savegame;
}

void OMW::Engine::setRandomSeed(unsigned int seed)
{
    mRandomSeed = seed;
}
