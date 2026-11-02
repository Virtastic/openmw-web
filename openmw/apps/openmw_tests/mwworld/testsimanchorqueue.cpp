#include "apps/openmw/mwworld/simanchorqueue.hpp"

#include <gtest/gtest.h>

#include <string>

namespace
{
    using Queue = MWWorld::SimAnchorLoadQueue<std::string>;
    using Ext = Queue::Exterior;
    using Clock = std::chrono::steady_clock;

    // A fake clock: every call advances by `step`, so N calls == N steps of "load time".
    struct FakeClock
    {
        Clock::time_point t{};
        std::chrono::milliseconds step;
        Clock::time_point operator()() { return t += step; }
    };

    TEST(MWWorldSimAnchorQueueTest, queuesExteriorsAndInteriorsWithoutDuplicates)
    {
        Queue q;
        q.setExteriors({ { 0, 0 }, { 1, 0 }, { 0, 0 } });
        q.setInteriors({ "Seyda Neen, Census and Excise Office", "Seyda Neen, Census and Excise Office" });
        EXPECT_EQ(q.size(), 3u);
    }

    TEST(MWWorldSimAnchorQueueTest, replacingTheWantedSetDropsCellsNoLongerWanted)
    {
        Queue q;
        q.setExteriors({ { 0, 0 }, { 1, 0 } });
        q.setInteriors({ "a", "b" });
        q.setExteriors({ { 1, 0 }, { 5, 5 } });
        q.setInteriors({ "b" });
        std::vector<Queue::Item> seen;
        FakeClock c{ {}, std::chrono::milliseconds(0) };
        q.drain(std::chrono::milliseconds(20), [&](const Queue::Item& i) { seen.push_back(i); return true; }, std::ref(c));
        ASSERT_EQ(seen.size(), 3u);
        EXPECT_EQ(std::get<Ext>(seen[0]), Ext(1, 0));
        EXPECT_EQ(std::get<std::string>(seen[1]), "b");
        EXPECT_EQ(std::get<Ext>(seen[2]), Ext(5, 5));
    }

    TEST(MWWorldSimAnchorQueueTest, drainStopsAtTheBudgetAndResumesNextFrame)
    {
        Queue q;
        std::vector<Ext> cells;
        for (int i = 0; i < 9 * 20; ++i) // 20 anchors' 3x3 grids: the cold-start shape
            cells.emplace_back(i, 0);
        q.setExteriors(cells);
        FakeClock c{ {}, std::chrono::milliseconds(5) }; // each cell costs ~5 ms
        std::size_t frames = 0, total = 0;
        while (!q.empty())
        {
            const std::size_t n = q.drain(std::chrono::milliseconds(20), [](const Queue::Item&) { return true; }, std::ref(c));
            EXPECT_LE(n, 4u);
            EXPECT_GE(n, 1u);
            total += n;
            ++frames;
        }
        EXPECT_EQ(total, cells.size());
        EXPECT_GT(frames, 1u);
    }

    TEST(MWWorldSimAnchorQueueTest, drainLoadsAtLeastOneEvenOverBudget)
    {
        Queue q;
        q.setExteriors({ { 0, 0 }, { 1, 0 } });
        FakeClock c{ {}, std::chrono::milliseconds(500) };
        EXPECT_EQ(q.drain(std::chrono::milliseconds(20), [](const Queue::Item&) { return true; }, std::ref(c)), 1u);
        EXPECT_EQ(q.size(), 1u);
    }

    TEST(MWWorldSimAnchorQueueTest, skippedItemsDoNotCountAsTheGuaranteedLoad)
    {
        Queue q;
        q.setInteriors({ "already loaded", "bad name", "real" });
        FakeClock c{ {}, std::chrono::milliseconds(500) };
        std::vector<std::string> loaded;
        q.drain(std::chrono::milliseconds(20),
            [&](const Queue::Item& i) {
                const auto& s = std::get<std::string>(i);
                if (s != "real")
                    return false;
                loaded.push_back(s);
                return true;
            },
            std::ref(c));
        EXPECT_EQ(loaded, std::vector<std::string>{ "real" });
        EXPECT_TRUE(q.empty());
    }
}
