// Added by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2026.
// See WASM_ADAPTATIONS.md at the repository root for details.
#include "luabindings.hpp"
#include "puppets.hpp"

#include <cstdlib>
#include <vector>

#include <osg/Vec2i>
#include <filesystem>
#include <fstream>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <components/debug/debuglog.hpp>
#include <components/esm/refid.hpp>
#include <components/esm3/loadbsgn.hpp>
#include <components/esm3/loadclas.hpp>
#include <components/esm3/loadrace.hpp>
#include <components/lua/luastate.hpp>
#include <components/lua/serialization.hpp>

#include "../mwbase/environment.hpp"
#include "../mwbase/inputmanager.hpp"
#include "../mwbase/mechanicsmanager.hpp"
#include "../mwbase/statemanager.hpp"
#include "../mwbase/windowmanager.hpp"
#include "../mwbase/world.hpp"

#include "../mwlua/context.hpp"
#include "../mwlua/luamanagerimp.hpp"
#include "../mwlua/object.hpp"

#include "../mwinput/actions.hpp"

#include "../mwmechanics/activespells.hpp"
#include "../mwmechanics/creaturestats.hpp"

#include "../mwworld/class.hpp"
#include "../mwworld/esmstore.hpp"

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
        // Phase 3 input tier: mp.sendInput{seq=,move=,side=,yaw=,pitch=,flags=} -> 0x0102.
        // The player's raw intent; the peer steers the avatar from it (avatar.lua).
        api["sendInput"] = [](const sol::table& t) {
            return NetManager::instance().sendInput(t.get_or("seq", 0u), t.get_or("move", 0.f),
                t.get_or("side", 0.f), t.get_or("yaw", 0.f), t.get_or("pitch", 0.f),
                static_cast<uint8_t>(t.get_or("flags", 0)));
        };

        // Phase 3, peer only: mp.sendAvatarMoveBatch(array of {id=,lastInputSeq=,x=,y=,z=,
        // yaw=,pitch=,flags=,animVel=}) -> 0x0105. The authoritative result of simulating
        // the avatars; the server fans it out (0x0101 to everyone, 0x0103 to each owner).
        api["sendAvatarMoveBatch"] = [](const sol::table& entries) {
            std::vector<NetManager::AvatarMoveEntry> out;
            out.reserve(entries.size());
            for (std::size_t i = 1; i <= entries.size(); ++i)
            {
                const sol::optional<sol::table> e = entries[i];
                if (!e)
                    continue;
                NetManager::AvatarMoveEntry entry;
                entry.mId = static_cast<uint16_t>((*e).get_or("id", 0));
                entry.mLastInputSeq = (*e).get_or("lastInputSeq", 0u);
                entry.mX = (*e).get_or("x", 0.f);
                entry.mY = (*e).get_or("y", 0.f);
                entry.mZ = (*e).get_or("z", 0.f);
                entry.mYaw = (*e).get_or("yaw", 0.f);
                entry.mPitch = (*e).get_or("pitch", 0.f);
                entry.mFlags = static_cast<uint8_t>((*e).get_or("flags", 0));
                entry.mAnimVel = (*e).get_or("animVel", 0.f);
                out.push_back(entry);
            }
            return NetManager::instance().sendAvatarMoveBatch(out);
        };

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
        // PUPPET REGISTRY (see puppets.hpp). Lua knows which actors a remote peer simulates;
        // the C++ magic-damage site needs that answer synchronously, because it applies damage
        // itself and there is no Lua veto on that path the way there is for melee.
        api["setPuppet"] = [](const sol::object& obj, bool on) {
            if (!obj.is<MWLua::Object>())
                return;
            setPuppet(obj.as<MWLua::Object>().id(), on);
        };
        api["clearPuppets"] = []() { clearPuppets(); };
        // AVATAR REGISTRY (see puppets.hpp). The mirror image of the puppet one: on the SIM
        // PEER these are the bodies real players drive, and engine code that reacts to "the
        // player" needs to find them, because getPlayer() there is the peer's own idle dummy.
        api["setAvatar"] = [](const sol::object& obj, bool on) {
            if (!obj.is<MWLua::Object>())
                return;
            setAvatar(obj.as<MWLua::Object>().id(), on);
        };
        // The owning player's bounty, mirrored onto their avatar so a guard has something real
        // to react to. Bounty is player-only in the engine's own API, which is why it lives in
        // the MP registry rather than on the avatar's NpcStats.
        api["setAvatarBounty"] = [](const sol::object& obj, int bounty) {
            if (!obj.is<MWLua::Object>())
                return;
            setAvatarBounty(obj.as<MWLua::Object>().id(), bounty);
        };
        api["clearAvatars"] = []() { clearAvatars(); };
        // Drain the harmful magic effects the engine declined to apply to THIS actor, so its
        // puppet script can forward them to whoever owns it. Per-object on purpose: the puppet
        // local script already has the object and already forwards melee the same way
        // (core.sendGlobalEvent 'mpCombatHit'), so this needs no RefNum-to-object lookup in Lua.
        // Returns an array of {effectId=string, magnitude=number, stat=0|1|2}
        // (0 health, 1 magicka, 2 fatigue).
        api["takeMagicHits"] = [](sol::this_state state, const sol::object& obj) {
            sol::table out(state, sol::create);
            if (!obj.is<MWLua::Object>())
                return out;
            int i = 1;
            for (const MagicHit& h : takeMagicHitsFor(obj.as<MWLua::Object>().id()))
            {
                sol::table e(state, sol::create);
                e["effectId"] = h.mEffectId;
                e["spellId"] = h.mSpellId;
                e["magnitude"] = h.mMagnitude;
                e["stat"] = h.mStat;
                out[i++] = e;
            }
            return out;
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
        // The character slot chosen on the HTML pre-boot tile screen (index.html sets
        // OPENMW_MP_CHARACTER from the #mpchar fragment). Empty = last-played default.
        api["getBootCharacter"] = []() { return getEnvString("OPENMW_MP_CHARACTER"); };
        // The player's OWN (solo/party) world. A world change reboots the page, so Lua state
        // dies and "the world we first landed in is ours" — true when a switch was an in-place
        // redial — became "the PUBLIC world is ours" on the rebooted page. Going Solo then
        // asked the public world to turn private and was refused. The launcher stamps this
        // into the boot fragment and every switch carries it through.
        api["getHomeUrl"] = []() { return getEnvString("OPENMW_MP_HOME"); };
        api["getEngineHash"] = []() { return getEnvString("OPENMW_MP_ENGINEHASH"); };
        api["vectorsEnabled"] = []() { return std::getenv("OPENMW_MP_VECTORS") != nullptr; };
        // Test seam for the multiplayer console gate. The harness cannot press a key (no SDL
        // injection), so without a way to REQUEST the console and then observe whether it
        // opened, the gate could only be eyeballed in a screenshot.
        //
        // requestConsole() deliberately routes through the same ActionManager::toggleConsole
        // the keybind uses, so the test exercises the real guard rather than a copy of it.
        api["requestConsole"] = []() {
            // A_Console == the console action id (mwinput/actions.hpp); executeAction is the
            // same entry point the keybind uses.
            MWBase::Environment::get().getInputManager()->executeAction(MWInput::A_Console);
        };
        api["isConsoleOpen"] = []() {
            return MWBase::Environment::get().getWindowManager()->isConsoleMode();
        };
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
            // THE NAME, which this restored everything BUT. A character created through
            // Morrowind's own chargen carries the name the player typed, but a restored one is
            // built by the skip-chargen boot path and keeps the engine's default ("player") —
            // so the save screen, and anything else reading the player record, showed that
            // instead of who they are. Invisible until a world change started rebooting the
            // page, which made EVERY switch a restore.
            std::string name = t.get_or<std::string>("name", "");
            bool isMale = t.get_or("isMale", true);
            luaManager->addAction(
                [=] {
                    MWBase::MechanicsManager* mechanics = MWBase::Environment::get().getMechanicsManager();
                    // Name first: setPlayerRace rebuilds the player record, and the same call
                    // chargen makes puts the name on it.
                    if (!name.empty())
                        mechanics->setPlayerName(name);
                    // RESOLVE BEFORE APPLYING. Every one of these ends in buildPlayer(), which
                    // looks the id up with Store::find() -- and find() THROWS when search()
                    // returns null. An id that does not resolve therefore does not degrade, it
                    // aborts this whole action, so everything sequenced AFTER the bad field
                    // (class, birthsign, name) silently never applies.
                    //
                    // This is reachable, not theoretical. snapAppearance fills an empty field
                    // from NPC.records['villager_00'] and falls back to the literal string
                    // "none" when that record is missing -- and villager_00 is a DEMO record
                    // present in NO retail data file (checked: absent from Morrowind.esm,
                    // Tribunal.esm and Bloodmoon.esm), and carries no class even where it does
                    // exist. "none" is not a missing value; it is an invalid record id.
                    //
                    // The fix belongs HERE and not in snapAppearance: the server REJECTS an
                    // appearance with any empty race/head/class/name (playerstate.ts
                    // handleAppearance), and a rejected appearance leaves doc.appearance unset,
                    // which withholds playerRecord on every join and loses the character's
                    // inventory and position. Sending "" instead of "none" would trade a
                    // recoverable cosmetic default for exactly that. So the placeholder stays,
                    // and the CONSUMER declines to apply what it cannot resolve.
                    const MWWorld::ESMStore& store = *MWBase::Environment::get().getESMStore();
                    const auto resolves = [&](const auto& recordStore, const std::string& id) {
                        return !id.empty() && recordStore.search(ESM::RefId::deserializeText(id)) != nullptr;
                    };
                    if (resolves(store.get<ESM::Race>(), race))
                        mechanics->setPlayerRace(ESM::RefId::deserializeText(race), isMale,
                            ESM::RefId::deserializeText(head), ESM::RefId::deserializeText(hair));
                    else if (!race.empty())
                        Log(Debug::Warning) << "[mp] chargen: unknown race '" << race << "', left as-is";
                    if (resolves(store.get<ESM::Class>(), cls))
                        mechanics->setPlayerClass(ESM::RefId::deserializeText(cls));
                    else if (!cls.empty())
                        Log(Debug::Warning) << "[mp] chargen: unknown class '" << cls << "', left as-is";
                    if (resolves(store.get<ESM::BirthSign>(), birthsign))
                        mechanics->setPlayerBirthsign(ESM::RefId::deserializeText(birthsign));
                    else if (!birthsign.empty())
                        Log(Debug::Warning) << "[mp] chargen: unknown birthsign '" << birthsign << "'";
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
        // Purge every active effect on the player. The rejoin restore REBUILDS a character in
        // place: applyChargen runs buildPlayer(), which grants this character its race and
        // birthsign abilities, and phase 2 then writes the saved spell set over the top.
        //
        // Nothing in that sequence takes the OLD effects off. Spells::clear() and removeSpell()
        // touch the spell LIST only -- neither purges what those spells already applied -- and
        // the Lua activeSpells:remove() refuses anything without Flag_Temporary, so a constant-
        // effect ability cannot be removed from script at all. So each rebuild layered another
        // copy of the birthsign ability on top of the last: a Lady's Favor character (Fortify
        // Endurance 25 + Fortify Personality 25) was seen at +175 on both and then +225 a few
        // minutes later -- 7 copies, then 9. The character sheet shows getModified(), and base
        // fatigue is recomputed from the MODIFIED attributes, which is why the fatigue bar
        // tracked the inflation exactly instead of contradicting it.
        //
        // This is the same primitive buildPlayer() already uses on the line below its spell
        // clear, exposed so the restore can reset to a clean slate before re-adding. The
        // engine re-applies each ability on the next update, guarded by isSpellActive, so the
        // count after a restore is exactly one and cannot climb.
        api["clearActiveSpells"] = [luaManager = context.mLuaManager]() {
            luaManager->addAction(
                [] {
                    MWWorld::Ptr player = MWBase::Environment::get().getWorld()->getPlayerPtr();
                    player.getClass().getCreatureStats(player).getActiveSpells().clear(player);
                },
                "MPClearActiveSpells");
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

        // E5/PHASE 3: mp.correctSelf(dx, dy, dz) — the smooth reconciliation primitive for
        // the LOCAL player. It accumulates a physics offset that the NEXT physics step
        // applies and collision-resolves (MWPhysics::Actor::adjustPosition); it never
        // teleports, never resets physics state, and never fires objectTeleported.
        //
        // THE CAP IS LOAD-BEARING, not a nicety: the offset itself does not respect
        // collision — the following step does — so an uncapped correction can push the
        // player through geometry before physics gets a say. Anything larger than the cap
        // is the hard-threshold snap's job (teleport, with puppet.lua's cooldowns).
        api["correctSelf"] = [luaManager = context.mLuaManager](float dx, float dy, float dz) {
            constexpr float maxCorrectPerCall = 48.f; // world units; ~15-30 Hz callers
            osg::Vec3f off(dx, dy, dz);
            const float len = off.length();
            if (!(len > 0.f)) // also rejects NaN payloads from the network
                return;
            if (len > maxCorrectPerCall)
                off *= maxCorrectPerCall / len;
            luaManager->addAction(
                [off] {
                    MWBase::World* world = MWBase::Environment::get().getWorld();
                    world->adjustActorPosition(world->getPlayerPtr(), off);
                },
                "MPCorrectSelf");
        };

        // SIM ANCHORS. The server tells this process which regions to keep simulated: one
        // anchor per player, as {x, y, z} WORLD POSITIONS (the player's live pose). Only the
        // sim peer is ever sent them — a normal client passes nothing and behaves exactly as
        // before, with the player as the sole anchor.
        //
        // Positions, not grid coordinates: a cell-centre anchor covered its own cell but
        // reached only ~3072 units into any neighbour against the 7168 processing range, so
        // a player near a cell edge sat beside loaded-but-frozen actors. Anchoring on the
        // player's actual position makes coverage identical to single-player.
        //
        // This is what lets ONE headless engine simulate several parts of the world. Without
        // it a peer can only ever hold the region its own avatar stands in, so covering players
        // spread across the map costs a whole ~450 MB engine process per region.
        // `interiors` is a second, optional list of interior cell NAMES. An interior has no
        // grid coordinate, so it cannot ride in the anchor list — and without it a peer could
        // only ever simulate the one room its own avatar stood in, which left every indoor
        // player unsimulated (Morrowind's opening is entirely indoors).
        api["setSimAnchors"] = [](const sol::table& anchors, const sol::optional<sol::table>& interiors) {
            std::vector<osg::Vec3f> out;
            out.reserve(anchors.size());
            for (std::size_t i = 1; i <= anchors.size(); ++i)
            {
                const sol::optional<sol::table> a = anchors[i];
                if (!a)
                    continue;
                const sol::optional<float> x = (*a)["x"];
                const sol::optional<float> y = (*a)["y"];
                const sol::optional<float> z = (*a)["z"];
                if (x && y)
                    out.emplace_back(*x, *y, z.value_or(0.f));
            }
            std::vector<ESM::RefId> rooms;
            if (interiors)
            {
                rooms.reserve(interiors->size());
                for (std::size_t i = 1; i <= interiors->size(); ++i)
                {
                    const sol::optional<std::string> name = (*interiors)[i];
                    if (name && !name->empty())
                        rooms.push_back(ESM::RefId::stringRefId(*name));
                }
            }
            MWBase::Environment::get().getWorld()->setSimAnchors(out, rooms);
        };

        // THE PAGE BRIDGE (PROTOCOL.md client contract). Three calls, all production:
        //   mp.set(key, value)      Lua -> page: one string in window.omw.state[key]; the page
        //                           polls and renders from it.
        //   mp.emit(name, json)     Lua -> page: an event (window.omw.emit), 'ack' among them.
        //   mp.pollCommands()       page -> Lua: drains window.omw.queue WHOLE and returns it
        //                           as a JSON array of {id, text}. Every entry is acked.
        // The old shape was a single Module.__omwMPCmd slot read once per frame, and a page
        // that queued two commands in one frame silently lost one -- s51's "my attacks do
        // nothing" was the harness overwriting its own hits. A queue cannot clobber, and an
        // ack tells the sender the command was actually run, not merely handed over.
#ifdef __EMSCRIPTEN__
        api["set"] = [](std::string_view key, std::string_view value) {
            std::string keyStr(key), valueStr(value);
            EM_ASM(
                {
                    try
                    {
                        var w = (typeof window !== 'undefined') ? window : self;
                        // No object literal here: EM_ASM is a variadic macro, and a comma
                        // at brace level splits the JavaScript into macro arguments.
                        if (!w.omw)
                            w.omw = {};
                        if (!w.omw.state)
                            w.omw.state = {};
                        w.omw.state[UTF8ToString($0)] = UTF8ToString($1);
                    }
                    catch (e)
                    {
                    }
                },
                keyStr.c_str(), valueStr.c_str());
        };
        api["emit"] = [](std::string_view name, std::string_view payload) {
            std::string nameStr(name), payloadStr(payload);
            EM_ASM(
                {
                    try
                    {
                        var w = (typeof window !== 'undefined') ? window : self;
                        if (w.omw && w.omw.emit)
                            w.omw.emit(UTF8ToString($0), JSON.parse(UTF8ToString($1)));
                    }
                    catch (e)
                    {
                    }
                },
                nameStr.c_str(), payloadStr.c_str());
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
        api["pollCommands"] = [](sol::this_state state) -> sol::object {
            // Drains window.omw.queue whole: a JSON array of {id, text}, or nil when empty.
            char* cmd = static_cast<char*>(EM_ASM_PTR({
                try
                {
                    var w = (typeof window !== 'undefined') ? window : self;
                    var q = w.omw && w.omw.queue;
                    if (!q || !q.length)
                        return 0;
                    var batch = q.splice(0, q.length);
                    return stringToNewUTF8(JSON.stringify(batch));
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
        api["set"] = [](std::string_view, std::string_view) {};
        api["emit"] = [](std::string_view, std::string_view) {};
        api["pollCommands"] = []() { return sol::nil; };
        api["setResumeToken"] = [](std::string_view) {};
        api["getResumeToken"] = []() { return std::string(); };
#endif

        return LuaUtil::makeReadOnly(api);
    }
}
