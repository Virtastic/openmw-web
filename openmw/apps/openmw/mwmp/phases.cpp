#include "phases.hpp"

#include <algorithm>
#include <array>
#include <functional>
#include <unordered_map>

namespace
{
    constexpr int sBits = 64;

    struct Interned
    {
        int mBit = 0;
        std::size_t mRefs = 0; // how many tagged refs list this key
    };

    struct Registry
    {
        std::unordered_map<std::string, Interned> mKeys;
        std::array<std::size_t, sBits> mBitUsers{}; // keys mapped to each bit
        std::unordered_map<ESM::RefNum, std::vector<std::string>> mRefs;
        std::unordered_map<ESM::RefNum, MWMP::PhaseMask> mMasks;
    };

    Registry& registry()
    {
        static Registry sRegistry;
        return sRegistry;
    }

    int acquire(Registry& r, const std::string& key)
    {
        auto it = r.mKeys.find(key);
        if (it == r.mKeys.end())
        {
            int bit = -1;
            for (int i = 0; i < sBits; ++i)
                if (r.mBitUsers[i] == 0)
                {
                    bit = i;
                    break;
                }
            if (bit < 0) // full: share a bit (those two phases collide, as today)
                bit = static_cast<int>(std::hash<std::string>()(key) % sBits);
            ++r.mBitUsers[bit];
            it = r.mKeys.emplace(key, Interned{ bit, 0 }).first;
        }
        ++it->second.mRefs;
        return it->second.mBit;
    }

    void release(Registry& r, const std::string& key)
    {
        auto it = r.mKeys.find(key);
        if (it == r.mKeys.end())
            return;
        if (--it->second.mRefs == 0)
        {
            --r.mBitUsers[it->second.mBit];
            r.mKeys.erase(it);
        }
    }
}

namespace MWMP
{
    PhaseMask setRefPhases(ESM::RefNum ref, const std::vector<std::string>& keys)
    {
        Registry& r = registry();
        std::vector<std::string> sorted;
        for (const std::string& k : keys)
            if (!k.empty())
                sorted.push_back(k);
        std::sort(sorted.begin(), sorted.end());
        sorted.erase(std::unique(sorted.begin(), sorted.end()), sorted.end());

        // Acquire the new keys before releasing the old, so a key kept across the change keeps
        // its bit (a cached physics mask stays valid until it is refreshed).
        PhaseMask mask = 0;
        for (const std::string& k : sorted)
            mask |= PhaseMask(1) << acquire(r, k);
        if (auto old = r.mRefs.find(ref); old != r.mRefs.end())
        {
            for (const std::string& k : old->second)
                release(r, k);
            r.mRefs.erase(old);
            r.mMasks.erase(ref);
        }
        if (sorted.empty())
            return 0;
        r.mRefs.emplace(ref, std::move(sorted));
        r.mMasks.emplace(ref, mask);
        return mask;
    }

    std::vector<std::string> refPhases(ESM::RefNum ref)
    {
        const Registry& r = registry();
        auto it = r.mRefs.find(ref);
        return it == r.mRefs.end() ? std::vector<std::string>() : it->second;
    }

    PhaseMask phaseMaskOf(ESM::RefNum ref)
    {
        const Registry& r = registry();
        if (r.mMasks.empty())
            return 0;
        auto it = r.mMasks.find(ref);
        return it == r.mMasks.end() ? 0 : it->second;
    }

    bool phasesMeet(ESM::RefNum a, ESM::RefNum b)
    {
        return phaseMasksMeet(phaseMaskOf(a), phaseMaskOf(b));
    }

    std::size_t phasedRefCount()
    {
        return registry().mRefs.size();
    }

    void clearPhases()
    {
        registry() = Registry();
    }
}
