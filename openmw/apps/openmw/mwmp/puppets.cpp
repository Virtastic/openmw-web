#include "puppets.hpp"

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
