#include "apps/openmw/mwmp/phases.hpp"

#include <gtest/gtest.h>

namespace
{
    using namespace MWMP;

    ESM::RefNum ref(std::uint32_t index, std::int32_t file = 0)
    {
        return ESM::RefNum{ index, file };
    }

    struct MWMPPhasesTest : ::testing::Test
    {
        void SetUp() override { clearPhases(); }
        void TearDown() override { clearPhases(); }
    };

    TEST_F(MWMPPhasesTest, untaggedRefsMeetEverything)
    {
        EXPECT_EQ(phaseMaskOf(ref(1)), 0u);
        EXPECT_TRUE(phasesMeet(ref(1), ref(2)));
        setRefPhases(ref(2), { "a" });
        EXPECT_TRUE(phasesMeet(ref(1), ref(2)));
        EXPECT_EQ(phasedRefCount(), 1u);
    }

    TEST_F(MWMPPhasesTest, differentPhasesDoNotMeet)
    {
        setRefPhases(ref(1), { "a" });
        setRefPhases(ref(2), { "b" });
        setRefPhases(ref(3), { "base", "b" });
        EXPECT_FALSE(phasesMeet(ref(1), ref(2)));
        EXPECT_TRUE(phasesMeet(ref(2), ref(3)));
        EXPECT_FALSE(phasesMeet(ref(1), ref(3)));
    }

    TEST_F(MWMPPhasesTest, tagsAreSortedDedupedAndClearable)
    {
        setRefPhases(ref(1), { "b", "a", "b", "" });
        EXPECT_EQ(refPhases(ref(1)), (std::vector<std::string>{ "a", "b" }));
        EXPECT_EQ(setRefPhases(ref(1), {}), 0u);
        EXPECT_TRUE(refPhases(ref(1)).empty());
        EXPECT_EQ(phasedRefCount(), 0u);
    }

    TEST_F(MWMPPhasesTest, aKeptKeyKeepsItsBit)
    {
        const PhaseMask a = setRefPhases(ref(1), { "a" });
        const PhaseMask ab = setRefPhases(ref(1), { "a", "b" });
        EXPECT_EQ(ab & a, a);
    }

    TEST_F(MWMPPhasesTest, moreThanSixtyFourKeysShareBitsAndStillMeetThemselves)
    {
        for (std::uint32_t i = 0; i < 100; ++i)
            setRefPhases(ref(i + 1), { "k" + std::to_string(i) });
        for (std::uint32_t i = 0; i < 100; ++i)
            EXPECT_NE(phaseMaskOf(ref(i + 1)), 0u);
        EXPECT_FALSE(phasesMeet(ref(1), ref(2))); // the first 64 own their bits
    }

    TEST_F(MWMPPhasesTest, releasedBitsAreReused)
    {
        for (std::uint32_t i = 0; i < 64; ++i)
            setRefPhases(ref(i + 1), { "k" + std::to_string(i) });
        const PhaseMask freed = phaseMaskOf(ref(1));
        setRefPhases(ref(1), {});
        EXPECT_EQ(setRefPhases(ref(200), { "fresh" }), freed);
    }
}
