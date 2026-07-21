// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#include "luabindings.hpp"

#include <cstdlib>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <components/esm/refid.hpp>
#include <components/lua/luastate.hpp>
#include <components/lua/serialization.hpp>

#include "../mwbase/environment.hpp"
#include "../mwbase/mechanicsmanager.hpp"
#include "../mwbase/statemanager.hpp"
#include "../mwbase/world.hpp"

#include "../mwlua/context.hpp"
#include "../mwlua/luamanagerimp.hpp"
#include "../mwlua/object.hpp"

#include "netmanager.hpp"

namespace MWMP
{
    namespace
    {
        std::string getEnvString(const char* name)
        {
            const char* value = std::getenv(name);
            return value ? value : "";
        }

        std::string base64Encode(std::string_view data)
        {
            static constexpr char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            std::string out;
            out.reserve((data.size() + 2) / 3 * 4);
            size_t i = 0;
            for (; i + 2 < data.size(); i += 3)
            {
                uint32_t v = (static_cast<uint8_t>(data[i]) << 16) | (static_cast<uint8_t>(data[i + 1]) << 8)
                    | static_cast<uint8_t>(data[i + 2]);
                out.push_back(table[(v >> 18) & 63]);
                out.push_back(table[(v >> 12) & 63]);
                out.push_back(table[(v >> 6) & 63]);
                out.push_back(table[v & 63]);
            }
            if (i + 1 == data.size())
            {
                uint32_t v = static_cast<uint8_t>(data[i]) << 16;
                out.push_back(table[(v >> 18) & 63]);
                out.push_back(table[(v >> 12) & 63]);
                out.append("==");
            }
            else if (i + 2 == data.size())
            {
                uint32_t v = (static_cast<uint8_t>(data[i]) << 16) | (static_cast<uint8_t>(data[i + 1]) << 8);
                out.push_back(table[(v >> 18) & 63]);
                out.push_back(table[(v >> 12) & 63]);
                out.push_back(table[(v >> 6) & 63]);
                out.push_back('=');
            }
            return out;
        }
    }

    sol::table initMPPackage(const MWLua::Context& context)
    {
        sol::state_view lua = context.sol();
        sol::table api(lua, sol::create);

        api["connect"] = [](std::string_view url) { return NetManager::instance().connect(std::string(url)); };
        api["disconnect"] = []() { NetManager::instance().disconnect(); };
        api["status"] = [](sol::this_state state) {
            const NetManager& net = NetManager::instance();
            const NetManager::Stats& stats = net.stats();
            sol::table res(state, sol::create);
            res["state"] = net.stateName();
            res["bytesIn"] = stats.mBytesIn;
            res["bytesOut"] = stats.mBytesOut;
            res["msgsIn"] = stats.mMsgsIn;
            res["msgsOut"] = stats.mMsgsOut;
            res["droppedInbound"] = stats.mDroppedInbound;
            res["malformed"] = stats.mMalformed;
            res["buffered"] = net.bufferedAmount();
            res["closeCode"] = net.lastCloseCode();
            res["closeReason"] = net.lastCloseReason();
            return res;
        };
        api["sendEvent"] = [serializer = context.mSerializer](std::string_view name, const sol::object& data) {
            return NetManager::instance().sendEvent(name, LuaUtil::serialize(data, serializer));
        };
        api["sendJson"] = [](std::string_view json) { return NetManager::instance().sendJson(std::string(json)); };
        // Movement tier (M1): mp.sendMove{x=,y=,z=,yaw=,pitch=,flags=,animVel=} -> 0x0100.
        api["sendMove"] = [](const sol::table& t) {
            return NetManager::instance().sendMove(t.get_or("x", 0.f), t.get_or("y", 0.f), t.get_or("z", 0.f),
                t.get_or("yaw", 0.f), t.get_or("pitch", 0.f),
                static_cast<uint8_t>(t.get_or("flags", 0)), t.get_or("animVel", 0.f));
        };
        // Actor authority tier (M4): mp.sendActorMoveBatch(epoch, {{obj=,x=,y=,z=,yaw=,pitch=,
        // flags=,animVel=}, ...}) -> 0x0200. `obj` is a GObject; its RefNum is the wire ref.
        api["sendActorMoveBatch"] = [](uint32_t epoch, const sol::table& list) {
            std::vector<NetManager::ActorMoveEntry> entries;
            entries.reserve(list.size());
            for (auto& [_, value] : list)
            {
                sol::table e = value.as<sol::table>();
                sol::object obj = e["obj"];
                if (!obj.is<MWLua::Object>())
                    continue;
                ESM::RefNum ref = obj.as<MWLua::Object>().id();
                entries.push_back({ ref.mIndex, ref.mContentFile, e.get_or("x", 0.f), e.get_or("y", 0.f),
                    e.get_or("z", 0.f), e.get_or("yaw", 0.f), e.get_or("pitch", 0.f), e.get_or("animVel", 0.f),
                    static_cast<uint8_t>(e.get_or("flags", 0)) });
            }
            return NetManager::instance().sendActorMoveBatch(epoch, entries);
        };
        // Shared kill tally (M4 WorldKillCount; also M6 quest gates): mirror the engine's
        // per-record death counter across clients so GetDeadCount is consistent for everyone.
        api["getDeadCount"] = [](std::string_view recordId) {
            return MWBase::Environment::get().getMechanicsManager()->countDeaths(
                ESM::RefId::deserializeText(recordId));
        };
        api["setDeadCount"] = [luaManager = context.mLuaManager](std::string_view recordId, int count) {
            ESM::RefId id = ESM::RefId::deserializeText(recordId);
            luaManager->addAction(
                [id, count] { MWBase::Environment::get().getMechanicsManager()->setDeaths(id, count); },
                "MPSetDeadCount");
        };
        api["isEnabled"] = []() { return std::getenv("OPENMW_MP_URL") != nullptr; };
        api["getUrl"] = []() { return getEnvString("OPENMW_MP_URL"); };
        api["getName"] = []() { return getEnvString("OPENMW_MP_NAME"); };
        api["getPassword"] = []() { return getEnvString("OPENMW_MP_PASS"); };
        api["getEngineHash"] = []() { return getEnvString("OPENMW_MP_ENGINEHASH"); };
        api["vectorsEnabled"] = []() { return std::getenv("OPENMW_MP_VECTORS") != nullptr; };
        // Session-tier state is decided in Lua (scripts/mp/net.lua); mirror it into NetManager.
        api["_setState"] = [](std::string_view name) { NetManager::instance().setSessionState(name); };
        // M2 rejoin restore: re-run the chargen record edits outside the chargen GUI.
        // setPlayerRace already does the NpcAnimation rebuild (World::renderPlayer) +
        // buildPlayer; deferred via addAction so the record/scene edits run in
        // synchronizedUpdate like every other Lua-initiated world mutation.
        api["applyChargen"] = [luaManager = context.mLuaManager](const sol::table& t) {
            std::string race = t.get_or<std::string>("race", "");
            std::string head = t.get_or<std::string>("head", "");
            std::string hair = t.get_or<std::string>("hair", "");
            std::string cls = t.get_or<std::string>("class", "");
            std::string birthsign = t.get_or<std::string>("birthsign", "");
            bool isMale = t.get_or("isMale", true);
            luaManager->addAction(
                [=] {
                    MWBase::MechanicsManager* mechanics = MWBase::Environment::get().getMechanicsManager();
                    if (!race.empty())
                        mechanics->setPlayerRace(ESM::RefId::deserializeText(race), isMale,
                            ESM::RefId::deserializeText(head), ESM::RefId::deserializeText(hair));
                    if (!cls.empty())
                        mechanics->setPlayerClass(ESM::RefId::deserializeText(cls));
                    if (!birthsign.empty())
                        mechanics->setPlayerBirthsign(ESM::RefId::deserializeText(birthsign));
                },
                "MPApplyChargen");
        };
        // M2 respawn: same path as the console `resurrect` (statsextensions.cpp OpResurrect) —
        // there is no vanilla Lua API to revive the player.
        api["resurrect"] = [luaManager = context.mLuaManager]() {
            luaManager->addAction(
                [] {
                    MWWorld::Ptr player = MWBase::Environment::get().getWorld()->getPlayerPtr();
                    MWBase::Environment::get().getMechanicsManager()->resurrect(player);
                    if (MWBase::Environment::get().getStateManager()->getState() == MWBase::StateManager::State_Ended)
                        MWBase::Environment::get().getStateManager()->resumeGame();
                },
                "MPResurrect");
        };
        // Golden-vector dump (server codec tests): LSER-encode any serializable value -> base64.
        api["debugSerialize"] = [serializer = context.mSerializer](const sol::object& data) {
            return base64Encode(LuaUtil::serialize(data, serializer));
        };

        // Test/automation surface for wasm-build/mp-harness.mjs (PROTOCOL.md client contract).
#ifdef __EMSCRIPTEN__
        api["testSet"] = [](std::string_view key, std::string_view value) {
            std::string keyStr(key), valueStr(value);
            EM_ASM(
                {
                    try
                    {
                        var w = (typeof window !== 'undefined') ? window : self;
                        w.__omwMP = w.__omwMP || {};
                        w.__omwMP[UTF8ToString($0)] = UTF8ToString($1);
                    }
                    catch (e)
                    {
                    }
                },
                keyStr.c_str(), valueStr.c_str());
        };
        api["testPollCommand"] = [](sol::this_state state) -> sol::object {
            // Reads-and-clears Module.__omwMPCmd (set by harness JS via window.__omwMP.sendChat).
            char* cmd = static_cast<char*>(EM_ASM_PTR({
                try
                {
                    var c = Module.__omwMPCmd;
                    if (!c)
                        return 0;
                    Module.__omwMPCmd = null;
                    return stringToNewUTF8(c);
                }
                catch (e)
                {
                    return 0;
                }
            }));
            if (!cmd)
                return sol::nil;
            sol::object res = sol::make_object(state, std::string_view(cmd));
            std::free(cmd);
            return res;
        };
#else
        api["testSet"] = [](std::string_view, std::string_view) {};
        api["testPollCommand"] = []() { return sol::nil; };
#endif

        return LuaUtil::makeReadOnly(api);
    }
}
