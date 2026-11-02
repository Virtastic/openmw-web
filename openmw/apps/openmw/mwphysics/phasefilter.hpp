#ifndef OPENMW_MWPHYSICS_PHASEFILTER_H
#define OPENMW_MWPHYSICS_PHASEFILTER_H

#include <BulletCollision/BroadphaseCollision/btBroadphaseProxy.h>
#include <BulletCollision/CollisionDispatch/btCollisionObject.h>

#include "ptrholder.hpp"

namespace MWPhysics
{
    // OT3-207: PER-VIEWER COLLISION. On the sim peer a cell holds every active phase side by side
    // (mwmp/phases.hpp), so an actor must only touch what is present in its own phase. Each
    // PtrHolder caches its phase mask; two objects collide when either is untagged (mask 0, every
    // ref in an unphased world) or they share a phase. The moving object is tested first, so an
    // untagged mover pays one atomic load and nothing else.
    inline std::uint64_t phaseMaskOf(const btCollisionObject* object)
    {
        const auto* holder = static_cast<const PtrHolder*>(object->getUserPointer());
        return holder != nullptr ? holder->getPhaseMask() : 0;
    }

    inline bool phasesCollide(const btCollisionObject* me, const btCollisionObject* other)
    {
        const std::uint64_t mine = phaseMaskOf(me);
        if (mine == 0)
            return true;
        const std::uint64_t theirs = phaseMaskOf(other);
        return theirs == 0 || (mine & theirs) != 0;
    }

    inline bool phasesCollide(const btCollisionObject* me, const btBroadphaseProxy* proxy)
    {
        return phasesCollide(me, static_cast<const btCollisionObject*>(proxy->m_clientObject));
    }
}

#endif
