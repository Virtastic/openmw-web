// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#ifndef COMPONENTS_LUA_SERIALIZATION_H
#define COMPONENTS_LUA_SERIALIZATION_H

#include <sol/sol.hpp>

#include <components/esm3/cellref.hpp>

namespace LuaUtil
{

    // Note: it can contain \0
    using BinaryData = std::string;

    class UserdataSerializer
    {
    public:
        virtual ~UserdataSerializer() {}

        // Appends serialized sol::userdata to the end of BinaryData.
        // Returns false if this type of userdata is not supported by this serializer.
        virtual bool serialize(BinaryData&, const sol::userdata&) const = 0;

        // Deserializes userdata of type "typeName" from binaryData. Should push the result on stack using
        // sol::stack::push. Returns false if this type is not supported by this serializer.
        virtual bool deserialize(std::string_view typeName, std::string_view binaryData, lua_State*) const = 0;

    protected:
        static void append(BinaryData&, std::string_view typeName, const void* data, size_t dataSize);

        static constexpr std::string_view sRefNumTypeName = "o";
        static void appendRefNum(BinaryData&, ESM::RefNum);
        static ESM::RefNum loadRefNum(std::string_view data);
    };

    // Serializer that can load Lua data from content files and saved games, but doesn't depend on apps/openmw.
    // Instead of LObject/GObject (that are defined in apps/openmw) it loads refnums directly as ESM::RefNum.
    class BasicSerializer final : public UserdataSerializer
    {
    public:
        BasicSerializer() = default;
        explicit BasicSerializer(std::function<int(int)> adjustContentFileIndexFn)
            : mAdjustContentFilesIndexFn(std::move(adjustContentFileIndexFn))
        {
        }

    private:
        bool serialize(LuaUtil::BinaryData& out, const sol::userdata& data) const override;
        bool deserialize(std::string_view typeName, std::string_view binaryData, lua_State* lua) const override;

        std::function<int(int)> mAdjustContentFilesIndexFn;
    };

    BinaryData serialize(const sol::object&, const UserdataSerializer* customSerializer = nullptr);

#ifdef __EMSCRIPTEN__
    // Writing a table from parts that are already serialized (LuaStorage::save keeps every value serialized):
    // tableOpen starts the data (format version + a table), appendKey writes a string key, appendSerialized a value
    // as serialize() returned it (its version byte dropped), tableStart opens a nested table, tableClose ends one.
    void tableOpen(BinaryData& out);
    void tableStart(BinaryData& out);
    void tableClose(BinaryData& out);
    void appendKey(BinaryData& out, std::string_view key);
    void appendSerialized(BinaryData& out, std::string_view serialized);
#endif
    sol::object deserialize(lua_State* lua, std::string_view binaryData,
        const UserdataSerializer* customSerializer = nullptr, bool readOnly = false);

}

#endif // COMPONENTS_LUA_SERIALIZATION_H
