#include "actorutil.hpp"

#include <algorithm>

#include "../mwbase/environment.hpp"
#include "../mwbase/world.hpp"

#include "../mwworld/class.hpp"
#include "../mwworld/player.hpp"

#include <components/settings/values.hpp>

#include "../mwmechanics/creaturestats.hpp"
#include "../mwmechanics/magiceffects.hpp"

#include <components/esm3/loadmgef.hpp>

namespace MWMechanics
{
    MWWorld::Ptr getPlayer()
    {
        return MWBase::Environment::get().getWorld()->getPlayerPtr();
    }

    bool isPlayerInCombat()
    {
        return MWBase::Environment::get().getWorld()->getPlayer().isInCombat();
    }

    bool canActorMoveByZAxis(const MWWorld::Ptr& actor)
    {
        MWBase::World* world = MWBase::Environment::get().getWorld();
        return (actor.getClass().canSwim(actor) && world->isSwimming(actor)) || world->isFlying(actor);
    }

    bool hasWaterWalking(const MWWorld::Ptr& actor)
    {
        const MWMechanics::MagicEffects& effects = actor.getClass().getCreatureStats(actor).getMagicEffects();
        return effects.getOrDefault(ESM::MagicEffect::WaterWalking).getMagnitude() > 0;
    }

    bool isTargetMagicallyHidden(const MWWorld::Ptr& actor)
    {
        const MagicEffects& magicEffects = actor.getClass().getCreatureStats(actor).getMagicEffects();
        return (magicEffects.getOrDefault(ESM::MagicEffect::Invisibility).getMagnitude() > 0)
            || (magicEffects.getOrDefault(ESM::MagicEffect::Chameleon).getMagnitude() >= 75);
    }

    float nearestSimDistanceSqr(const osg::Vec3f& actorPos)
    {
        MWBase::World* world = MWBase::Environment::get().getWorld();
        float best = (world->getPlayerPtr().getRefData().getPosition().asVec3() - actorPos).length2();
        for (const osg::Vec3f& anchor : world->getSimAnchorPositions())
        {
            // Horizontal plane only: an actor up a tower or down a cave must not read as out
            // of range on height alone.
            const float dx = anchor.x() - actorPos.x();
            const float dy = anchor.y() - actorPos.y();
            best = std::min(best, dx * dx + dy * dy);
        }
        return best;
    }

    bool inSimProcessingRange(const MWWorld::Ptr& actor)
    {
        MWBase::World* world = MWBase::Environment::get().getWorld();
        if (world->isAnchoredInterior(actor.getCell()))
            return true;
        const float range = static_cast<float>(Settings::game().mActorsProcessingRange);
        return nearestSimDistanceSqr(actor.getRefData().getPosition().asVec3()) <= range * range;
    }
}
