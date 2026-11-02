#include "apps/openmw/mwphysics/mtphysics.hpp"

#include <gtest/gtest.h>

namespace
{
    using namespace MWPhysics;

    // OT3-213: the 0 / 1 / 2 comparison. What each setting turns into on a Bullet built without
    // BT_THREADSAFE (the default wasm build: max supported threads <= 1) and with it.
    TEST(MWPhysicsAsyncPhysics, zeroRunsOnTheMainThread)
    {
        for (unsigned max : { 0u, 1u, 8u })
        {
            const AsyncPhysicsConfig c = resolveAsyncPhysics(0, max);
            EXPECT_EQ(c.mLockingPolicy, LockingPolicy::NoLocks);
            EXPECT_EQ(c.mNumThreads, 0u);
        }
        EXPECT_EQ(resolveAsyncPhysics(-3, 8).mNumThreads, 0u);
    }

    TEST(MWPhysicsAsyncPhysics, withoutThreadSafeBulletAnythingAboveZeroIsOneExclusiveWorker)
    {
        for (int requested : { 1, 2, 7 })
        {
            const AsyncPhysicsConfig c = resolveAsyncPhysics(requested, 1);
            EXPECT_EQ(c.mLockingPolicy, LockingPolicy::ExclusiveLocksOnly);
            EXPECT_EQ(c.mNumThreads, 1u);
        }
    }

    TEST(MWPhysicsAsyncPhysics, withThreadSafeBulletTheRequestIsClampedToWhatItSupports)
    {
        EXPECT_EQ(resolveAsyncPhysics(1, 4).mLockingPolicy, LockingPolicy::AllowSharedLocks);
        EXPECT_EQ(resolveAsyncPhysics(1, 4).mNumThreads, 1u);
        EXPECT_EQ(resolveAsyncPhysics(2, 4).mNumThreads, 2u);
        EXPECT_EQ(resolveAsyncPhysics(9, 4).mNumThreads, 4u);
    }
}
