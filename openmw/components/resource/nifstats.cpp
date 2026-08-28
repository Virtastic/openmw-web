#include "nifstats.hpp"

#ifdef __EMSCRIPTEN__

#include <atomic>
#include <emscripten.h>

namespace Resource
{
    namespace
    {
        // Loading runs on the WorkQueue as well as the main thread, so these are atomic. Relaxed
        // ordering is fine: this is a counter read by a human through the console, not a fence.
        struct Bucket
        {
            std::atomic<uint64_t> mCount{ 0 };
            std::atomic<uint64_t> mNanos{ 0 };
        };

        Bucket sBuckets[5];
        std::atomic<uint64_t> sSincePublish{ 0 };

        // Publishing crosses into JS, so do it every 64 loads rather than every load -- the same
        // cadence imagemanager.cpp uses for __omwTexStats.
        constexpr uint64_t sPublishEvery = 64;
    }

    void nifStatAdd(NifStage stage, NifClock::time_point begin)
    {
        const auto elapsed
            = std::chrono::duration_cast<std::chrono::nanoseconds>(NifClock::now() - begin).count();

        Bucket& bucket = sBuckets[static_cast<int>(stage)];
        bucket.mCount.fetch_add(1, std::memory_order_relaxed);
        bucket.mNanos.fetch_add(static_cast<uint64_t>(elapsed), std::memory_order_relaxed);

        if (sSincePublish.fetch_add(1, std::memory_order_relaxed) % sPublishEvery != 0)
            return;

        const double parseMs = sBuckets[0].mNanos.load(std::memory_order_relaxed) / 1e6;
        const double buildMs = sBuckets[1].mNanos.load(std::memory_order_relaxed) / 1e6;
        const double bulletMs = sBuckets[2].mNanos.load(std::memory_order_relaxed) / 1e6;
        const double parseN = static_cast<double>(sBuckets[0].mCount.load(std::memory_order_relaxed));
        const double buildN = static_cast<double>(sBuckets[1].mCount.load(std::memory_order_relaxed));
        const double bulletN = static_cast<double>(sBuckets[2].mCount.load(std::memory_order_relaxed));
        const double geomMs = sBuckets[3].mNanos.load(std::memory_order_relaxed) / 1e6;
        const double geomN = static_cast<double>(sBuckets[3].mCount.load(std::memory_order_relaxed));
        const double texMs = sBuckets[4].mNanos.load(std::memory_order_relaxed) / 1e6;
        const double texN = static_cast<double>(sBuckets[4].mCount.load(std::memory_order_relaxed));

        // NB: no comma inside the EM_ASM code block -- the preprocessor splits the variadic macro
        // on commas. Assign fields one statement at a time (same trap as engine.cpp's phase stats).
        EM_ASM({
            var s = {};
            s.parseMs = $0;
            s.buildMs = $1;
            s.bulletMs = $2;
            s.parseCount = $3;
            s.buildCount = $4;
            s.bulletCount = $5;
            s.geomMs = $6;
            s.geomCount = $7;
            s.textureMs = $8;
            s.textureCount = $9;
            s.totalMs = $0 + $1 + $2;
            window.__omwNifStats = s;
        },
            parseMs, buildMs, bulletMs, parseN, buildN, bulletN, geomMs, geomN, texMs, texN);
    }
}

#endif
