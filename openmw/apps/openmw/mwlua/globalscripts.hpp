#ifndef MWLUA_GLOBALSCRIPTS_H
#define MWLUA_GLOBALSCRIPTS_H

#include <string>
#include <string_view>

#include <components/lua/luastate.hpp>
#include <components/lua/scriptscontainer.hpp>

#include "object.hpp"

namespace MWLua
{

    class GlobalScripts : public LuaUtil::ScriptsContainer
    {
    public:
        GlobalScripts(LuaUtil::LuaState* lua)
            : LuaUtil::ScriptsContainer(lua, "Global")
        {
            registerEngineHandlers({
                &mObjectActiveHandlers,
                &mActorActiveHandlers,
                &mItemActiveHandlers,
                &mNewGameHandlers,
                &mPlayerAddedHandlers,
                &mOnActivateHandlers,
                &mOnUseItemHandlers,
                &mOnNewExteriorHandlers,
                &mOnGlobalVariableChangedHandlers,
                &mOnItemTransferredHandlers,
            });
        }

        void newGameStarted() { callEngineHandlers(mNewGameHandlers); }
        void objectActive(const GObject& obj) { callEngineHandlers(mObjectActiveHandlers, obj); }
        void actorActive(const GObject& obj) { callEngineHandlers(mActorActiveHandlers, obj); }
        void itemActive(const GObject& obj) { callEngineHandlers(mItemActiveHandlers, obj); }
        void playerAdded(const GObject& obj) { callEngineHandlers(mPlayerAddedHandlers, obj); }
        void onActivate(const GObject& obj, const GObject& actor)
        {
            callEngineHandlers(mOnActivateHandlers, obj, actor);
        }
        void onUseItem(const GObject& obj, const GObject& actor, bool force)
        {
            callEngineHandlers(mOnUseItemHandlers, obj, actor, force);
        }
        void onNewExterior(const GCell& cell) { callEngineHandlers(mOnNewExteriorHandlers, cell); }
        // MP (E5): an MWScript global was written. Name is lowercased by the engine's own
        // storage; value is the numeric value as written.
        void onGlobalVariableChanged(std::string_view name, float value)
        {
            callEngineHandlers(mOnGlobalVariableChangedHandlers, std::string(name), value);
        }
        // MP (E5): a containerstore transaction — an item stack entered or left a store.
        void onItemTransferred(
            const sol::optional<GObject>& container, const std::string& recordId, int count, bool added)
        {
            callEngineHandlers(mOnItemTransferredHandlers, container, recordId, count, added);
        }

    private:
        EngineHandlerList mObjectActiveHandlers{ "onObjectActive" };
        EngineHandlerList mActorActiveHandlers{ "onActorActive" };
        EngineHandlerList mItemActiveHandlers{ "onItemActive" };
        EngineHandlerList mNewGameHandlers{ "onNewGame" };
        EngineHandlerList mPlayerAddedHandlers{ "onPlayerAdded" };
        EngineHandlerList mOnActivateHandlers{ "onActivate" };
        EngineHandlerList mOnUseItemHandlers{ "_onUseItem" };
        EngineHandlerList mOnNewExteriorHandlers{ "onNewExterior" };
        EngineHandlerList mOnGlobalVariableChangedHandlers{ "_onGlobalVariableChanged" };
        EngineHandlerList mOnItemTransferredHandlers{ "_onItemTransferred" };
    };

}

#endif // MWLUA_GLOBALSCRIPTS_H
