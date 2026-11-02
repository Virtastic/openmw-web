#ifndef OPENMW_MWPHYSICS_PROJECTILECONVEXCALLBACK_H
#define OPENMW_MWPHYSICS_PROJECTILECONVEXCALLBACK_H

#include <BulletCollision/CollisionDispatch/btCollisionWorld.h>

#include "phasefilter.hpp"

class btCollisionObject;

namespace MWPhysics
{
    class Projectile;

    class ProjectileConvexCallback : public btCollisionWorld::ClosestConvexResultCallback
    {
    public:
        explicit ProjectileConvexCallback(const btCollisionObject* caster, const btCollisionObject* me,
            const btVector3& from, const btVector3& to, Projectile& projectile)
            : btCollisionWorld::ClosestConvexResultCallback(from, to)
            , mCaster(caster)
            , mMe(me)
            , mProjectile(projectile)
        {
        }

        btScalar addSingleResult(btCollisionWorld::LocalConvexResult& result, bool normalInWorldSpace) override;

        // OT3-208: a shot flies in its caster's phase: it passes through another phase's refs
        // and actors.
        bool needsCollision(btBroadphaseProxy* proxy) const override
        {
            return btCollisionWorld::ClosestConvexResultCallback::needsCollision(proxy)
                && (mCaster == nullptr || phasesCollide(mCaster, proxy));
        }

    private:
        const btCollisionObject* mCaster;
        const btCollisionObject* mMe;
        Projectile& mProjectile;
    };
}

#endif
