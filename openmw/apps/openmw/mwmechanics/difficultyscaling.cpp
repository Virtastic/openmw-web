#include "difficultyscaling.hpp"

#include <components/settings/values.hpp>

#include "../mwbase/environment.hpp"
#include "../mwworld/esmstore.hpp"
#include "../mwworld/ptr.hpp"

#include "actorutil.hpp"

#include "../mwmp/puppets.hpp"

float scaleDamage(float damage, const MWWorld::Ptr& attacker, const MWWorld::Ptr& victim)
{
    const MWWorld::Ptr& player = MWMechanics::getPlayer();

    static const float fDifficultyMult
        = MWBase::Environment::get().getESMStore()->get<ESM::GameSetting>().find("fDifficultyMult")->mValue.getFloat();

    const float difficultyTerm = 0.01f * Settings::game().mDifficulty;

    // MP: an AVATAR is a player for difficulty purposes. On the sim peer `player` is the peer's
    // own idle dummy, so without this no real player's damage was ever scaled -- silently
    // ignoring the difficulty slider for everyone in multiplayer. (No effect at the default
    // difficulty of 0, where the term is zero either way.)
    const auto isPlayerSide = [&player](const MWWorld::Ptr& p) {
        return p == player || (!p.isEmpty() && MWMP::isAvatar(p.getCellRef().getRefNum()));
    };

    float x = 0;
    if (isPlayerSide(victim))
    {
        if (difficultyTerm > 0)
            x = fDifficultyMult * difficultyTerm;
        else
            x = difficultyTerm / fDifficultyMult;
    }
    else if (isPlayerSide(attacker))
    {
        if (difficultyTerm > 0)
            x = -difficultyTerm / fDifficultyMult;
        else
            x = fDifficultyMult * (-difficultyTerm);
    }

    damage *= 1 + x;
    return damage;
}
