#ifndef OPENMW_COMPONENTS_RESOURCE_NIFSTATS_H
#define OPENMW_COMPONENTS_RESOURCE_NIFSTATS_H

// F16 instrumentation: where does mesh loading actually spend its time?
//
// F16 proposes replacing the NIF pipeline with a baked mesh/collision format, and four other
// findings (F20, F35, F36, F37) hang off it. It is the largest item in the plan and the one with
// the least evidence behind it -- the estimate came from reading ~14,000 lines of nif/nifosg/
// nifbullet, not from a profile. Four of the five findings measured so far turned out to be wrong,
// so this exists to size F16 before anything is rewritten.
//
// Three stages are timed separately because they would be replaced by different things:
//   Parse  -- Nif::Reader::parse, file bytes -> Nif record tree. A baked format deletes this.
//   Build  -- NifOsg::Loader::load, record tree -> osg scene graph. A baked format turns this into
//             read + fixup + upload, so the saving is the part that is not already I/O.
//   Bullet -- BulletNifLoader::load, record tree -> btCollisionShape. Pre-serialisable, and the
//             native sim peer consumes this too, so it is the half that has a second consumer.
//   Geom   -- handleNiGeometry, a SUBSET of Build: the vertex/index conversion a baked format
//             turns into a memcpy. This is the upper bound on what baking removes from Build;
//             the rest of Build is osg Node/StateSet/controller construction that survives.
//   Texture -- ImageManager::getImage called from INSIDE the NIF build (nifloader.cpp:1088).
//             Also a subset of Build, and the reason Build cannot be read as CPU time: this is a
//             blocking VFS read through streamfs plus a DDS decode. If it dominates, no mesh
//             format helps -- the lever is texture delivery, not mesh representation.
//
// Web-only on purpose: the peer image builds this same tree natively and must not pay for it.

#ifdef __EMSCRIPTEN__

#include <chrono>

namespace Resource
{
    enum class NifStage
    {
        Parse,
        Build,
        Bullet,
        Geom,
        Texture,
    };

    using NifClock = std::chrono::steady_clock;

    // Accumulate one stage sample and publish to window.__omwNifStats periodically.
    void nifStatAdd(NifStage stage, NifClock::time_point begin);
}

#define OPENMW_NIF_STAT_BEGIN(var) const auto var = ::Resource::NifClock::now()
#define OPENMW_NIF_STAT_END(stage, var) ::Resource::nifStatAdd(stage, var)

#else

#define OPENMW_NIF_STAT_BEGIN(var)
#define OPENMW_NIF_STAT_END(stage, var)

#endif

#endif
