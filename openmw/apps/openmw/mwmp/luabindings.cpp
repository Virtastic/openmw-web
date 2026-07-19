// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#include "luabindings.hpp"

#include <cstdlib>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <components/lua/luastate.hpp>
#include <components/lua/serialization.hpp>

#include "../mwlua/context.hpp"

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
        api["isEnabled"] = []() { return std::getenv("OPENMW_MP_URL") != nullptr; };
        api["getUrl"] = []() { return getEnvString("OPENMW_MP_URL"); };
        api["getName"] = []() { return getEnvString("OPENMW_MP_NAME"); };
        api["getPassword"] = []() { return getEnvString("OPENMW_MP_PASS"); };
        api["getEngineHash"] = []() { return getEnvString("OPENMW_MP_ENGINEHASH"); };
        api["vectorsEnabled"] = []() { return std::getenv("OPENMW_MP_VECTORS") != nullptr; };
        // Session-tier state is decided in Lua (scripts/mp/net.lua); mirror it into NetManager.
        api["_setState"] = [](std::string_view name) { NetManager::instance().setSessionState(name); };
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
