#include "actorutil.hpp"

#include <algorithm>

#include "../mwbase/environment.hpp"
#include "../mwbase/world.hpp"

#include "../mwworld/class.hpp"
#include "../mwworld/esmstore.hpp"
#include "../mwworld/player.hpp"

#include <components/settings/values.hpp>

#include "../mwmechanics/creaturestats.hpp"
#include "../mwmechanics/npcstats.hpp"
#include "../mwmechanics/magiceffects.hpp"

#include <components/esm3/loadgmst.hpp>
#include <components/esm3/loadmgef.hpp>
#include <components/esm3/loadskil.hpp>

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

    void applyLevelup(const MWWorld::Ptr& actor, const std::vector<ESM::Attribute::AttributeID>& attributes)
    {
        MWMechanics::NpcStats& stats = actor.getClass().getNpcStats(actor);
        for (const ESM::Attribute::AttributeID attributeId : attributes)
        {
            MWMechanics::AttributeValue attribute = stats.getAttribute(attributeId);
            attribute.setBase(attribute.getBase() + stats.getLevelupAttributeMultiplier(attributeId));
            if (attribute.getBase() >= 100)
                attribute.setBase(100);
            stats.setAttribute(attributeId, attribute);
        }
        stats.levelUp();
    }

    void saveWerewolfStats(const MWWorld::Ptr& actor)
    {
        MWMechanics::NpcStats& stats = actor.getClass().getNpcStats(actor);
        auto& skills = stats.werewolfSaveSkills();
        auto& attributes = stats.werewolfSaveAttributes();
        for (size_t i = 0; i < skills.size(); ++i)
            skills[i] = stats.getSkill(ESM::Skill::indexToRefId(static_cast<int>(i))).getModified();
        for (size_t i = 0; i < attributes.size(); ++i)
            attributes[i] = stats.getAttribute(ESM::Attribute::indexToRefId(static_cast<int>(i))).getModified();
    }

    void applyWerewolfStats(const MWWorld::Ptr& actor)
    {
        const auto& store = MWBase::Environment::get().getESMStore();
        const MWWorld::Store<ESM::GameSetting>& gmst = store->get<ESM::GameSetting>();
        MWMechanics::CreatureStats& creatureStats = actor.getClass().getCreatureStats(actor);
        MWMechanics::NpcStats& npcStats = actor.getClass().getNpcStats(actor);
        MWMechanics::DynamicStat<float> health = creatureStats.getDynamic(0);
        creatureStats.setHealth(health.getBase() * gmst.find("fWereWolfHealth")->mValue.getFloat());
        for (const auto& attribute : store->get<ESM::Attribute>())
        {
            MWMechanics::AttributeValue value = npcStats.getAttribute(attribute.mId);
            value.setBase(value.getBase(), true);
            value.setModifier(attribute.mWerewolfValue - value.getBase());
            npcStats.setAttribute(attribute.mId, value);
        }
        for (const auto& skill : store->get<ESM::Skill>())
        {
            // Acrobatics is set separately for some reason.
            if (skill.mId == ESM::Skill::Acrobatics)
                continue;
            MWMechanics::SkillValue& value = npcStats.getSkill(skill.mId);
            value.setBase(value.getBase(), true);
            value.setModifier(skill.mWerewolfValue - value.getBase());
        }
    }

    void restoreWerewolfStats(const MWWorld::Ptr& actor)
    {
        const auto& store = MWBase::Environment::get().getESMStore();
        const MWWorld::Store<ESM::GameSetting>& gmst = store->get<ESM::GameSetting>();
        MWMechanics::CreatureStats& creatureStats = actor.getClass().getCreatureStats(actor);
        MWMechanics::NpcStats& npcStats = actor.getClass().getNpcStats(actor);
        const auto& skills = npcStats.werewolfSaveSkills();
        const auto& attributes = npcStats.werewolfSaveAttributes();
        MWMechanics::DynamicStat<float> health = creatureStats.getDynamic(0);
        creatureStats.setHealth(health.getBase() / gmst.find("fWereWolfHealth")->mValue.getFloat());
        for (size_t i = 0; i < skills.size(); ++i)
        {
            auto& skill = npcStats.getSkill(ESM::Skill::indexToRefId(static_cast<int>(i)));
            skill.restore(skill.getDamage());
            skill.setModifier(skills[i] - skill.getBase());
        }
        for (size_t i = 0; i < attributes.size(); ++i)
        {
            auto id = ESM::Attribute::indexToRefId(static_cast<int>(i));
            auto attribute = npcStats.getAttribute(id);
            attribute.restore(attribute.getDamage());
            attribute.setModifier(attributes[i] - attribute.getBase());
            npcStats.setAttribute(id, attribute);
        }
    }
}
