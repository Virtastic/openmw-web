#ifndef OPENMW_MWMP_PUPPETS_H
#define OPENMW_MWMP_PUPPETS_H

#include <cstdint>
#include <string>
#include <vector>

#include <components/esm3/refnum.hpp>

// WHO OWNS AN ACTOR'S DAMAGE, asked synchronously from C++.
//
// In multiplayer an actor a remote peer simulates is a PUPPET here: its position and stats are
// pushed to us, and anything we do to it locally is a guess that the owner will overwrite. For
// MELEE that is already handled in Lua — the engine hands damage application to
// `omw/combat/local.lua` via the `Hit` event, so `scripts/mp/puppet.lua` intercepts it, returns
// false to cancel, and forwards the raw attack to the owner.
//
// MAGIC HAS NO SUCH SEAM. `mwmechanics/spelleffects.cpp` applies harmful effects in C++ with
// `adjustDynamicStat`, and the only Lua notification on that path (`Class::onHit`) returns void
// and is queued, so a script cannot veto it. The result was that spell damage never travelled:
// the caster's client damaged its own puppet copy, the owner never heard, and the health bar
// snapped back on the next stats push. Casting at anything did nothing.
//
// This is the missing seam, and it is deliberately a QUERY rather than a callback: the damage
// site needs an answer in the same call, and LuaManager's event path is asynchronous. Lua marks
// puppets as it attaches and detaches them; the damage site asks, skips its local application,
// and leaves the effect here for Lua to drain and forward on the next frame.
namespace MWMP
{
    /** Mark/unmark an actor as remotely simulated. Called from `mp.setPuppet` in Lua. */
    void setPuppet(ESM::RefNum ref, bool on);

    /** True when this actor's damage belongs to somebody else. Safe to call every effect tick. */
    bool isPuppet(ESM::RefNum ref);

    /** Forget every puppet — session loss, world switch. */
    void clearPuppets();

    // AVATARS: THE OTHER HALF OF THE SAME IDEA.
    //
    // On the SIM PEER a player's body is an AVATAR -- an NPC object driven by that player's
    // input. Engine code that reacts to "the player" finds `getPlayer()`, which on the peer is
    // its own idle dummy standing wherever it was parked, so nothing in the world ever reacts
    // to a real person. Crime pursuit was the visible case: a player could rob a shop in front
    // of a guard and be ignored, because the guard checked a bounty belonging to nobody.
    //
    // The bounty is kept HERE rather than on the avatar's NpcStats because bounty is a
    // player-only concept in the engine (`types.Player.setCrimeLevel` is global-context and
    // player-only in Lua, and NpcStats::setBounty is not exposed for arbitrary actors). This
    // registry is the MP-shaped place for an MP-shaped fact.

    /** Mark/unmark an actor as a player's avatar. Called from `mp.setAvatar` in Lua. */
    void setAvatar(ESM::RefNum ref, bool on);

    /** True when this actor is a player's avatar on the sim peer. */
    bool isAvatar(ESM::RefNum ref);

    /** That avatar's crime bounty, 0 when unknown. Safe to call every frame. */
    int avatarBounty(ESM::RefNum ref);

    /** Record an avatar's bounty, mirrored from the owning player's CrimeUpdate. */
    void setAvatarBounty(ESM::RefNum ref, int bounty);

    /** Forget every avatar — session loss, world switch. */
    void clearAvatars();

    /** One harmful magic effect that was NOT applied locally, waiting to be forwarded. */
    struct MagicHit
    {
        ESM::RefNum mTarget;
        ESM::RefNum mCaster;
        // Serialized RefId ("magiceffect:firedamage"-ish); the wire and the scripts both
        // want a name, and mEffectId is an ESM::RefId rather than an enum.
        std::string mEffectId;
        // The SPELL this effect came from. The owner applies the spell record by id
        // (combat.lua's MP_CombatSpellHit does `core.magic.spells.records[spellId]`), so the
        // effect id alone is not enough to reproduce it there.
        std::string mSpellId;
        float mMagnitude;
        // 0 = health, 1 = magicka, 2 = fatigue. Matches the order spelleffects.cpp picks.
        int mStat;
    };

    /** Record an effect the damage site declined to apply. Bounded; excess is dropped. */
    void recordMagicHit(const MagicHit& hit);

    /** Drain everything recorded for ONE actor since the last call. */
    std::vector<MagicHit> takeMagicHitsFor(ESM::RefNum target);
}

#endif
