#ifndef OPENMW_MWPHYSICS_ACTORCONVEXCALLBACK_H
#define OPENMW_MWPHYSICS_ACTORCONVEXCALLBACK_H

#include <BulletCollision/CollisionDispatch/btCollisionWorld.h>

#include "phasefilter.hpp"

class btCollisionObject;

namespace MWPhysics
{
    class ActorConvexCallback : public btCollisionWorld::ClosestConvexResultCallback
    {
    public:
        explicit ActorConvexCallback(const btCollisionObject* me, const btVector3& motion, btScalar minCollisionDot,
            const btCollisionWorld* world)
            : btCollisionWorld::ClosestConvexResultCallback(btVector3(0.0, 0.0, 0.0), btVector3(0.0, 0.0, 0.0))
            , mMe(me)
            , mMotion(motion)
            , mMinCollisionDot(minCollisionDot)
            , mWorld(world)
        {
        }

        btScalar addSingleResult(btCollisionWorld::LocalConvexResult& convexResult, bool normalInWorldSpace) override;

        // OT3-207: a ref only present in another phase is not there for this actor.
        bool needsCollision(btBroadphaseProxy* proxy) const override
        {
            return btCollisionWorld::ClosestConvexResultCallback::needsCollision(proxy) && phasesCollide(mMe, proxy);
        }

    protected:
        const btCollisionObject* mMe;
        const btVector3 mMotion;
        const btScalar mMinCollisionDot;
        const btCollisionWorld* mWorld;
    };
}

#endif
