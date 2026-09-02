#ifndef OPENMW_MWMECHANICS_ACTORUTIL_H
#define OPENMW_MWMECHANICS_ACTORUTIL_H

#include <vector>

#include <osg/Vec3f>

#include <components/esm/attr.hpp>

namespace MWWorld
{
    class Ptr;
}

namespace MWMechanics
{
    MWWorld::Ptr getPlayer();
    bool isPlayerInCombat();
    bool canActorMoveByZAxis(const MWWorld::Ptr& actor);
    bool hasWaterWalking(const MWWorld::Ptr& actor);
    bool isTargetMagicallyHidden(const MWWorld::Ptr& actor);

    /** Squared distance from `actorPos` to the nearest simulation viewpoint: the player, or
     *  any sim anchor, whichever is closest. On a normal client there are no anchors, so this
     *  is exactly the vanilla player-distance check. Anchor comparisons are horizontal-plane
     *  only — anchors carry z=0, so height alone must never push an actor out of range.
     *
     *  THE ONE COPY. This reduction used to be pasted per call site, and the animation/
     *  movement gate was missed: NPCs in anchored cells got AI that decided to attack and a
     *  character controller that never moved anyone — frozen NPCs under a healthy holder.
     *  Every range gate calls this (or inSimProcessingRange below); never paste a third copy. */
    float nearestSimDistanceSqr(const osg::Vec3f& actorPos);

    /** Should this actor be processed at all? True inside `actors processing range` of the
     *  nearest simulation viewpoint, and ALWAYS for an actor in an interior the server holds:
     *  distance across a door is meaningless (the room may be a mile away in world units), so
     *  a range check would cull exactly the NPCs the server asked to simulate. */
    bool inSimProcessingRange(const MWWorld::Ptr& actor);

    /** MP (Phase 2): the werewolf stat swap, actor-generic. These used to live on
     *  MWWorld::Player (saveStats/setWerewolfStats/restoreStats), so only the singleton
     *  player could ever transform correctly; the snapshot now lives in the actor's own
     *  NpcStats. */
    void saveWerewolfStats(const MWWorld::Ptr& actor);
    void applyWerewolfStats(const MWWorld::Ptr& actor);
    void restoreWerewolfStats(const MWWorld::Ptr& actor);

    /** E5 (MP): apply a level-up to `actor` with the chosen attribute picks (typically 3).
     *  This is the APPLY half only — selection UI is the caller's problem — extracted from
     *  LevelupDialog::onOkButtonClicked so a headless peer can level a character at all:
     *  before this, the only code that could spend a level lived inside a MyGUI dialog. */
    void applyLevelup(const MWWorld::Ptr& actor, const std::vector<ESM::Attribute::AttributeID>& attributes);
}

#endif
