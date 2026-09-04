#include "puppets.hpp"

#include <components/debug/debuglog.hpp>

#include <unordered_map>
#include <unordered_set>

namespace
{
    struct RefNumHash
    {
        std::size_t operator()(const ESM::RefNum& r) const noexcept
        {
            return std::hash<uint64_t>()((static_cast<uint64_t>(r.mContentFile) << 32) ^ r.mIndex);
        }
    };
    struct RefNumEq
    {
        bool operator()(const ESM::RefNum& a, const ESM::RefNum& b) const noexcept
        {
            return a.mIndex == b.mIndex && a.mContentFile == b.mContentFile;
        }
    };

    std::unordered_set<ESM::RefNum, RefNumHash, RefNumEq>& puppets()
    {
        static std::unordered_set<ESM::RefNum, RefNumHash, RefNumEq> sPuppets;
        return sPuppets;
    }

    // refnum -> bounty. Presence in the map IS the "this is an avatar" flag, so a body with no
    // bounty yet is still known to be a player's, which is what the pursuit check needs.
    std::unordered_map<ESM::RefNum, int, RefNumHash, RefNumEq>& avatars()
    {
        static std::unordered_map<ESM::RefNum, int, RefNumHash, RefNumEq> sAvatars;
        return sAvatars;
    }

    std::vector<MWMP::MagicHit>& pending()
    {
        static std::vector<MWMP::MagicHit> sPending;
        return sPending;
    }

    // A cell full of puppets standing in a fire field generates one of these per effect tick per
    // actor. Lua drains every frame, so this only ever fills if the script side has stopped —
    // in which case dropping is right and unbounded growth is not.
    constexpr std::size_t sMaxPending = 256;
}

namespace MWMP
{
    void setPuppet(ESM::RefNum ref, bool on)
    {
        if (on)
            puppets().insert(ref);
        else
            puppets().erase(ref);
    }

    bool isPuppet(ESM::RefNum ref)
    {
        return !puppets().empty() && puppets().find(ref) != puppets().end();
    }

    void clearPuppets()
    {
        puppets().clear();
        pending().clear();
    }

    void setAvatar(ESM::RefNum ref, bool on)
    {
        if (on)
            avatars().emplace(ref, 0);
        else
            avatars().erase(ref);
        Log(Debug::Info) << "[mp] avatar registry " << ref.mIndex << (on ? " +" : " -")
                         << " (now " << avatars().size() << ")";
    }

    bool isAvatar(ESM::RefNum ref)
    {
        return avatars().find(ref) != avatars().end();
    }

    int avatarBounty(ESM::RefNum ref)
    {
        const auto it = avatars().find(ref);
        return it == avatars().end() ? 0 : it->second;
    }

    void setAvatarBounty(ESM::RefNum ref, int bounty)
    {
        // Only for a KNOWN avatar: a bounty arriving for a body that has not been marked yet
        // (or has just been detached) must not resurrect it as a pursuit target.
        const auto it = avatars().find(ref);
        if (it == avatars().end() || it->second == bounty)
            return;
        it->second = bounty;
        // Logged because it is the far end of a long chain -- the owner's crime level, their
        // client's CrimeUpdate, the server relay, and this registry -- and when a guard fails to
        // react it is the one place that says whether the bounty ever arrived at all.
        Log(Debug::Info) << "[mp] avatar bounty " << ref.mIndex << " = " << bounty;
    }

    void clearAvatars()
    {
        avatars().clear();
    }

    void recordMagicHit(const MagicHit& hit)
    {
        if (pending().size() >= sMaxPending)
            return;
        pending().push_back(hit);
    }

    std::vector<MagicHit> takeMagicHitsFor(ESM::RefNum target)
    {
        std::vector<MagicHit> out;
        auto& q = pending();
        for (auto it = q.begin(); it != q.end();)
        {
            if (it->mTarget.mIndex == target.mIndex && it->mTarget.mContentFile == target.mContentFile)
            {
                out.push_back(*it);
                it = q.erase(it);
            }
            else
                ++it;
        }
        return out;
    }
}
