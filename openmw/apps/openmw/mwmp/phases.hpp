#ifndef OPENMW_MWMP_PHASES_H
#define OPENMW_MWMP_PHASES_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include <components/esm3/refnum.hpp>

// PHASE TAGS ON THE SIM PEER (OT3-206/207/208, phasing-deep-dive #peer).
//
// The server keeps a base cell plus one overlay per phase key, and each player sees the
// version that matches their key. The peer simulates ONE copy of the cell, so it loads the
// base refs and every active overlay's refs side by side and tags each ref with the phase
// keys it is PRESENT in. A ref with no tag is a base ref present in every phase -- which is
// every ref in every unphased cell, so nothing here changes anything until the server sends
// a tag.
//
// Tags are interned to bits of a 64-bit mask so the physics threads can test two objects with
// one AND (mwphysics/phasefilter.hpp). A mask of 0 is "untagged": it meets everything. Two
// tagged objects meet when they share a phase. Past 64 keys live at once a key shares a bit
// with another (hashed), and the two phases then collide with each other -- today's
// behaviour, never a hole.
//
// Main thread only (Lua bindings, mechanics). Physics reads the mask cached on its PtrHolder.
namespace MWMP
{
    using PhaseMask = std::uint64_t;

    /** True when two masks share a phase, or either is untagged. */
    constexpr bool phaseMasksMeet(PhaseMask a, PhaseMask b)
    {
        return a == 0 || b == 0 || (a & b) != 0;
    }

    /** Tag a ref with the phase keys it is present in; an empty list clears the tag (base).
     *  Returns the ref's new mask. */
    PhaseMask setRefPhases(ESM::RefNum ref, const std::vector<std::string>& keys);

    /** The keys a ref is tagged with, sorted; empty for an untagged (base) ref. */
    std::vector<std::string> refPhases(ESM::RefNum ref);

    /** The ref's mask; 0 when untagged. */
    PhaseMask phaseMaskOf(ESM::RefNum ref);

    /** True when the two refs can see each other (share a phase, or either is untagged). */
    bool phasesMeet(ESM::RefNum a, ESM::RefNum b);

    /** How many refs carry a tag (OT3-80 measurement; 0 on an unphased world). */
    std::size_t phasedRefCount();

    /** Forget every tag -- session loss. */
    void clearPhases();
}

#endif
