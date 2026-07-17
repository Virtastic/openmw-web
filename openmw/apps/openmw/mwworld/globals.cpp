// Modified by Virtastic (https://virtastic.app) for the OpenMW-Web port, 2025-2026.
// See WASM_ADAPTATIONS.md at the repository root for details of the changes.
#include "globals.hpp"

#include <stdexcept>

#include <components/debug/debuglog.hpp>
#include <components/esm3/esmreader.hpp>
#include <components/esm3/esmwriter.hpp>

#include "esmstore.hpp"

namespace MWWorld
{
    // Tolerate references to globals not defined by the loaded content. Base Morrowind defines many
    // globals (crime/werewolf/etc.) that minimal or example-suite content omits; the engine and
    // dialogue/scripts reference them by name and would otherwise throw "unknown global variable".
    // Create the missing global lazily as a numeric 0 (Morrowind's lenient default) instead.
    Globals::Collection::iterator Globals::findOrCreate(std::string_view name) const
    {
        Collection::iterator iter = mVariables.find(name);
        if (iter != mVariables.end())
            return iter;
        Log(Debug::Warning) << "Undefined global variable '" << name << "' referenced; defaulting to 0";
        ESM::Global global;
        global.blank();
        global.mId = ESM::RefId::stringRefId(name);
        global.mValue = ESM::Variant(0);
        return mVariables.emplace(global.mId, std::move(global)).first;
    }

    Globals::Collection::const_iterator Globals::find(std::string_view name) const
    {
        return findOrCreate(name);
    }

    Globals::Collection::iterator Globals::find(std::string_view name)
    {
        return findOrCreate(name);
    }

    void Globals::fill(const MWWorld::ESMStore& store)
    {
        mVariables.clear();

        const MWWorld::Store<ESM::Global>& globals = store.get<ESM::Global>();

        for (const ESM::Global& esmGlobal : globals)
        {
            mVariables.emplace(esmGlobal.mId, esmGlobal);
        }
    }

    const ESM::Variant& Globals::operator[](GlobalVariableName name) const
    {
        return find(name.getValue())->second.mValue;
    }

    ESM::Variant& Globals::operator[](GlobalVariableName name)
    {
        return find(name.getValue())->second.mValue;
    }

    char Globals::getType(GlobalVariableName name) const
    {
        Collection::const_iterator iter = mVariables.find(name.getValue());

        if (iter == mVariables.end())
            return ' ';

        switch (iter->second.mValue.getType())
        {
            case ESM::VT_Short:
                return 's';
            case ESM::VT_Long:
                return 'l';
            case ESM::VT_Float:
                return 'f';

            default:
                return ' ';
        }
    }

    size_t Globals::countSavedGameRecords() const
    {
        return mVariables.size();
    }

    void Globals::write(ESM::ESMWriter& writer, Loading::Listener& progress) const
    {
        for (const auto& variable : mVariables)
        {
            writer.startRecord(ESM::REC_GLOB);
            variable.second.save(writer);
            writer.endRecord(ESM::REC_GLOB);
        }
    }

    bool Globals::readRecord(ESM::ESMReader& reader, uint32_t type)
    {
        if (type == ESM::REC_GLOB)
        {
            ESM::Global global;
            bool isDeleted = false;

            // This readRecord() method is used when reading a saved game.
            // Deleted globals can't appear there, so isDeleted will be ignored here.
            global.load(reader, isDeleted);

            if (const auto iter = mVariables.find(global.mId); iter != mVariables.end())
                iter->second = std::move(global);

            return true;
        }

        return false;
    }
}
