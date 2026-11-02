#ifndef GAME_MWWORLD_SIMANCHORQUEUE_H
#define GAME_MWWORLD_SIMANCHORQUEUE_H

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <deque>
#include <functional>
#include <utility>
#include <variant>
#include <vector>

namespace MWWorld
{
    // MP: INCREMENTAL SIM-ANCHOR LOADING (OT3-123).
    //
    // A sim peer used to load every cell an anchor change asked for in one call: a 3x3 grid per
    // exterior anchor plus every occupied interior. A cold start with players spread over the
    // map took ~17 s inside one frame, and the peer's fixed 1/20 s step stalled for everyone.
    //
    // Now an anchor change only says WHAT should be loaded; this queue holds the cells still
    // missing and Scene::update loads them a few at a time against a wall-clock budget, so a
    // frame spends at most about one cell's load past the budget. The player's own grid is not
    // queued (it stays synchronous, as in vanilla); only the extra cells the server asked for.
    //
    // Pure (no engine types) so it is unit-tested on its own; Interior is ESM::RefId in the game.
    template <class Interior>
    class SimAnchorLoadQueue
    {
    public:
        using Exterior = std::pair<int, int>;
        using Item = std::variant<Exterior, Interior>;

        /// Replace the wanted exterior set. Pending exteriors no longer wanted are dropped (an
        /// anchor that walked away before its cells loaded costs nothing); new ones are queued
        /// in the order given (the caller sorts nearest-first). Interiors are untouched.
        void setExteriors(const std::vector<Exterior>& wanted)
        {
            std::erase_if(mPending, [&](const Item& it) {
                const Exterior* e = std::get_if<Exterior>(&it);
                return e != nullptr && std::find(wanted.begin(), wanted.end(), *e) == wanted.end();
            });
            for (const Exterior& e : wanted)
                pushUnique(Item(e));
        }

        /// Replace the wanted interior set, same rules as setExteriors.
        void setInteriors(const std::vector<Interior>& wanted)
        {
            std::erase_if(mPending, [&](const Item& it) {
                const Interior* i = std::get_if<Interior>(&it);
                return i != nullptr && std::find(wanted.begin(), wanted.end(), *i) == wanted.end();
            });
            for (const Interior& i : wanted)
                pushUnique(Item(i));
        }

        void clear() { mPending.clear(); }
        bool empty() const { return mPending.empty(); }
        std::size_t size() const { return mPending.size(); }

        /// Load queued cells until `budget` has elapsed (always at least one, so the queue
        /// drains even when a single cell costs more than the budget). `load` returns true if
        /// it really loaded something; an item already loaded or unknown returns false and does
        /// not count toward the "at least one". Returns how many were loaded.
        template <class Clock = std::chrono::steady_clock>
        std::size_t drain(std::chrono::nanoseconds budget, const std::function<bool(const Item&)>& load,
            const std::function<typename Clock::time_point()>& now = &Clock::now)
        {
            const auto start = now();
            std::size_t loaded = 0;
            while (!mPending.empty())
            {
                if (loaded > 0 && now() - start >= budget)
                    break;
                const Item item = std::move(mPending.front());
                mPending.pop_front();
                if (load(item))
                    ++loaded;
            }
            return loaded;
        }

    private:
        void pushUnique(Item&& item)
        {
            if (std::find(mPending.begin(), mPending.end(), item) == mPending.end())
                mPending.push_back(std::move(item));
        }

        std::deque<Item> mPending;
    };
}

#endif
