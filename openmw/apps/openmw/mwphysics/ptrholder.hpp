#ifndef OPENMW_MWPHYSICS_PTRHOLDER_H
#define OPENMW_MWPHYSICS_PTRHOLDER_H

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <utility>

#include <osg/Vec3d>

#include <BulletCollision/CollisionDispatch/btCollisionObject.h>

#include "../mwworld/ptr.hpp"

namespace MWPhysics
{
    class PtrHolder
    {
    public:
        explicit PtrHolder(const MWWorld::Ptr& ptr, const osg::Vec3f& position)
            : mPtr(ptr)
            , mSimulationPosition(position)
            , mPosition(position)
            , mPreviousPosition(position)
        {
        }

        virtual ~PtrHolder() = default;

        void updatePtr(const MWWorld::Ptr& updated) { mPtr = updated; }

        MWWorld::Ptr getPtr() const { return mPtr; }

        btCollisionObject* getCollisionObject() const { return mCollisionObject.get(); }

        void setVelocity(osg::Vec3f velocity) { mVelocity = velocity; }

        osg::Vec3f velocity() { return std::exchange(mVelocity, osg::Vec3f()); }

        void setSimulationPosition(const osg::Vec3f& position) { mSimulationPosition = position; }

        osg::Vec3f getSimulationPosition() const { return mSimulationPosition; }

        void setPosition(const osg::Vec3f& position)
        {
            mPreviousPosition = mPosition;
            mPosition = position;
        }

        osg::Vec3d getPosition() const { return mPosition; }

        osg::Vec3d getPreviousPosition() const { return mPreviousPosition; }

        /// OT3-207: the phases this object is present in (mwmp/phases.hpp); 0 = untagged, which
        /// meets everything. Atomic: set on the main thread, read by the physics workers.
        void setPhaseMask(std::uint64_t mask) { mPhaseMask.store(mask, std::memory_order_relaxed); }

        std::uint64_t getPhaseMask() const { return mPhaseMask.load(std::memory_order_relaxed); }

    protected:
        MWWorld::Ptr mPtr;
        std::unique_ptr<btCollisionObject> mCollisionObject;
        osg::Vec3f mVelocity;
        osg::Vec3f mSimulationPosition;
        osg::Vec3d mPosition;
        osg::Vec3d mPreviousPosition;
        std::atomic<std::uint64_t> mPhaseMask{ 0 };
    };
}

#endif
