// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#include "luabindings.hpp"

#include <cstdlib>
#include <filesystem>
#include <fstream>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <components/esm/refid.hpp>
#include <components/lua/luastate.hpp>
#include <components/lua/serialization.hpp>

#include "../mwbase/environment.hpp"
#include "../mwbase/mechanicsmanager.hpp"
#include "../mwbase/statemanager.hpp"
#include "../mwbase/windowmanager.hpp"
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
        // stringRefId, NOT deserializeText: Lua hands us a plain record id ("fargoth"), while
        // deserializeText parses the *serialized* RefId form and so never matched a real
        // record — every lookup silently returned 0. Same constructor mwlua/contentbindings
        // uses for record ids.
        api["getDeadCount"] = [](std::string_view recordId) {
            return MWBase::Environment::get().getMechanicsManager()->countDeaths(
                ESM::RefId::stringRefId(recordId));
        };
        api["setDeadCount"] = [luaManager = context.mLuaManager](std::string_view recordId, int count) {
            ESM::RefId id = ESM::RefId::stringRefId(recordId);
            luaManager->addAction(
                [id, count] { MWBase::Environment::get().getMechanicsManager()->setDeaths(id, count); },
                "MPSetDeadCount");
        };
        api["isEnabled"] = []() { return std::getenv("OPENMW_MP_URL") != nullptr; };
        api["getUrl"] = []() { return getEnvString("OPENMW_MP_URL"); };
        api["getName"] = []() { return getEnvString("OPENMW_MP_NAME"); };
        api["getPassword"] = []() { return getEnvString("OPENMW_MP_PASS"); };
        // Phase H: a headless simulation peer sets OPENMW_MP_SYSTEM=1. It declares system so
        // the server keeps it out of the player list / count / maxPlayers. A normal client
        // never sets it (getenv null), so this is false for every human.
        api["isSystem"] = []() { return std::getenv("OPENMW_MP_SYSTEM") != nullptr; };
        // Phase B SSO: a one-time login ticket the boot JS lifted out of the URL fragment
        // after the provider round trip. Empty when signing in with a password.
        api["getLoginTicket"] = []() { return getEnvString("OPENMW_MP_TICKET"); };
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
        // M7 WorldMapExplored (PROTOCOL.md §M7): mark an exterior cell as discovered on the
        // world map. There is no Lua binding for map state in 0.52, and the only reachable
        // surface is GUI-side: WindowManager::addVisitedLocation (mwbase/windowmanager.hpp:243)
        // -> MapWindow, which is what the engine itself calls when the player enters a named
        // exterior cell (mwgui/windowmanagerimp.cpp:1181).
        //
        // NOTE the deliberate limit: the sibling call there, MapWindow::cellExplored, paints
        // the global-map fog from `mLocalMapRender->getMapTexture(x, y)` — a texture that only
        // exists for cells THIS client has actually rendered. A peer's exploration therefore
        // transfers as the discovered-location marker, not as uncovered fog; the fog is not
        // transferable without shipping the map texture itself.
        api["setMapExplored"]
            = [luaManager = context.mLuaManager](std::string_view cellName, int gridX, int gridY) {
                  std::string name(cellName);
                  luaManager->addAction(
                      [name, gridX, gridY] {
                          MWBase::Environment::get().getWindowManager()->addVisitedLocation(name, gridX, gridY);
                      },
                      "MPSetMapExplored");
              };

        // M8 ConsoleCommand (PROTOCOL.md §M8): run MWScript console text on this client.
        // There is NO vanilla Lua binding for that — onConsoleCommand is a *handler* for
        // commands the player types, not an executor — and the only public entry point is
        // WindowManager::executeInConsole(path), which runs a file line by line. So write
        // the payload to a scratch file (MEMFS under emscripten) and hand it over: the
        // engine's own compiler and error reporting stay in charge.
        api["runConsole"] = [](std::string_view script) {
            std::filesystem::path path = std::filesystem::temp_directory_path() / "omwmp_console.txt";
            {
                std::ofstream out(path, std::ios::binary | std::ios::trunc);
                if (!out)
                    throw std::runtime_error("cannot open the console scratch file");
                out << script << "\n";
            }
            MWBase::Environment::get().getWindowManager()->executeInConsole(path);
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
        // M8 session resume: the ticket has to outlive the PAGE, not just the socket —
        // a browser reload is the canonical "rejoin in place" case. localStorage is the
        // only store that survives it, and the token is a short-lived, single-use,
        // server-revocable credential scoped to this origin.
        api["setResumeToken"] = [](std::string_view token) {
            std::string tokenStr(token);
            EM_ASM(
                {
                    try
                    {
                        var t = UTF8ToString($0);
                        if (t)
                            localStorage.setItem('omwmp:resume', t);
                        else
                            localStorage.removeItem('omwmp:resume');
                    }
                    catch (e)
                    {
                    }
                },
                tokenStr.c_str());
        };
        api["getResumeToken"] = []() -> std::string {
            char* token = static_cast<char*>(EM_ASM_PTR({
                try
                {
                    var t = localStorage.getItem('omwmp:resume');
                    return t ? stringToNewUTF8(t) : 0;
                }
                catch (e)
                {
                    return 0;
                }
            }));
            if (!token)
                return {};
            std::string out(token);
            std::free(token);
            return out;
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
        api["setResumeToken"] = [](std::string_view) {};
        api["getResumeToken"] = []() { return std::string(); };
#endif

        return LuaUtil::makeReadOnly(api);
    }
}
